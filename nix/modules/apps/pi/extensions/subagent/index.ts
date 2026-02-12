/**
 * Subagent Tool - Delegate tasks to specialized agents with isolated context.
 *
 * Spawns a separate `pi` process per invocation.
 * Modes: single (agent + task), parallel (tasks[]), chain (sequential with {previous}).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function countToolCalls(messages: Message[]): number {
	let count = 0;
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "toolCall") count++;
			}
		}
	}
	return count;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await fn(items[i], i);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

function writePromptTempFile(
	name: string,
	prompt: string,
): { dir: string; path: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(
		dir,
		`prompt-${name.replace(/[^\w.-]+/g, "_")}.md`,
	);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, path: filePath };
}

type OnUpdate = (partial: AgentToolResult<SubagentDetails>) => void;

async function runAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdate | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available: ${available}.`,
			usage: emptyUsage(),
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;

	const result: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step,
	};

	const emit = () => {
		onUpdate?.({
			content: [
				{
					type: "text",
					text: getFinalOutput(result.messages) || "(running...)",
				},
			],
			details: makeDetails([result]),
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptTempFile(agent.name, agent.systemPrompt);
			tmpDir = tmp.dir;
			tmpPath = tmp.path;
			args.push("--append-system-prompt", tmpPath);
		}

		args.push(`Task: ${task}`);
		let aborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buf = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}

				if (ev.type === "message_end" && ev.message) {
					const msg = ev.message as Message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.usage.turns++;
						const u = msg.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							result.usage.contextTokens = u.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emit();
				}

				if (ev.type === "tool_result_end" && ev.message) {
					result.messages.push(ev.message as Message);
					emit();
				}
			};

			proc.stdout.on("data", (d: Buffer) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const l of lines) processLine(l);
			});

			proc.stderr.on("data", (d: Buffer) => {
				result.stderr += d.toString();
			});

			proc.on("close", (code: number | null) => {
				if (buf.trim()) processLine(buf);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					aborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (aborted) throw new Error("Subagent aborted");
		return result;
	} finally {
		if (tmpPath)
			try {
				fs.unlinkSync(tmpPath);
			} catch {}
		if (tmpDir)
			try {
				fs.rmSync(tmpDir, { recursive: true });
			} catch {}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description:
				'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
			default: "user",
		}),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const disc = discoverAgents(ctx.cwd, agentScope);
			const agents = disc.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: disc.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available =
					agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Security: confirm project-local agents
			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requested = new Set<string>();
				if (params.chain) for (const s of params.chain) requested.add(s.agent);
				if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
				if (params.agent) requested.add(params.agent);

				const projectAgents = Array.from(requested)
					.map((n) => agents.find((a) => a.name === n))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgents.length > 0) {
					const names = projectAgents.map((a) => a.name).join(", ");
					const dir = disc.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: makeDetails(
								hasChain ? "chain" : hasTasks ? "parallel" : "single",
							)([]),
						};
				}
			}

			// Chain mode
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(
						/\{previous\}/g,
						previousOutput,
					);

					const chainUpdate: OnUpdate | undefined = onUpdate
						? (partial) => {
								const cur = partial.details?.results[0];
								if (cur)
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")([...results, cur]),
									});
							}
						: undefined;

					const result = await runAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 ||
						result.stopReason === "error" ||
						result.stopReason === "aborted";
					if (isError) {
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [
						{
							type: "text",
							text:
								getFinalOutput(results[results.length - 1].messages) ||
								"(no output)",
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			// Parallel mode
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = params.tasks.map((t) => ({
					agent: t.agent,
					agentSource: "unknown" as const,
					task: t.task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: emptyUsage(),
				}));

				const emitParallel = () => {
					if (!onUpdate) return;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					const running = allResults.length - done;
					onUpdate({
						content: [
							{
								type: "text",
								text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
							},
						],
						details: makeDetails("parallel")([...allResults]),
					});
				};

				const results = await mapWithConcurrency(
					params.tasks,
					MAX_CONCURRENCY,
					async (t, idx) => {
						const result = await runAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[idx] = partial.details.results[0];
									emitParallel();
								}
							},
							makeDetails("parallel"),
						);
						allResults[idx] = result;
						emitParallel();
						return result;
					},
				);

				const ok = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const out = getFinalOutput(r.messages);
					const preview = out.slice(0, 100) + (out.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "ok" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// Single mode
			if (params.agent && params.task) {
				const result = await runAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError =
					result.exitCode !== 0 ||
					result.stopReason === "error" ||
					result.stopReason === "aborted";
				if (isError) {
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: getFinalOutput(result.messages) || "(no output)",
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none"}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const clean = step.task.replace(/\{previous\}/g, "").trim();
					const preview =
						clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview =
						t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", agentName) +
					theme.fg("muted", ` [${scope}]`) +
					`\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(
					text?.type === "text" ? text.text : "(no output)",
					0,
					0,
				);
			}

			const mdTheme = getMarkdownTheme();

			const renderSingleResult = (r: SingleResult, showExpanded: boolean) => {
				const isRunning = r.exitCode === -1;
				const isError =
					!isRunning &&
					(r.exitCode !== 0 ||
						r.stopReason === "error" ||
						r.stopReason === "aborted");
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");

				const tools = countToolCalls(r.messages);
				const toolInfo = tools > 0 ? ` (${tools} tool calls)` : "";
				const header =
					`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}` +
					theme.fg("muted", ` (${r.agentSource})`) +
					theme.fg("dim", toolInfo);

				const output = getFinalOutput(r.messages);
				const usage = formatUsage(r.usage, r.model);

				if (showExpanded) {
					const container = new Container();
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(
							new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
						);
					if (r.step !== undefined)
						container.addChild(
							new Text(
								theme.fg("muted", `Task: `) + theme.fg("dim", r.task),
								0,
								0,
							),
						);
					container.addChild(new Spacer(1));
					if (output) {
						container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(
							new Text(
								theme.fg("muted", isRunning ? "(running...)" : "(no output)"),
								0,
								0,
							),
						);
					}
					if (usage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usage), 0, 0));
					}
					return container;
				}

				// Collapsed
				let text = header;
				if (isError && r.errorMessage)
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (output) {
					const preview = output.split("\n").slice(0, 3).join("\n");
					text += `\n${theme.fg("toolOutput", preview)}`;
					if (output.split("\n").length > 3) text += theme.fg("muted", "\n...");
				} else {
					text += `\n${theme.fg("muted", isRunning ? "(running...)" : "(no output)")}`;
				}
				if (usage) text += `\n${theme.fg("dim", usage)}`;
				return new Text(text, 0, 0);
			};

			// Single mode
			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleResult(details.results[0], expanded);
			}

			// Multi-result modes (chain / parallel)
			const results = details.results;
			const ok = results.filter((r) => r.exitCode === 0).length;
			const running = results.filter((r) => r.exitCode === -1).length;
			const isStillRunning = running > 0;

			const modeLabel =
				details.mode === "chain"
					? `chain ${ok}/${results.length} steps`
					: `parallel ${ok}/${results.length} tasks`;
			const modeIcon = isStillRunning
				? theme.fg("warning", "⏳")
				: ok === results.length
					? theme.fg("success", "✓")
					: theme.fg("warning", "◐");

			if (expanded && !isStillRunning) {
				const container = new Container();
				container.addChild(
					new Text(
						`${modeIcon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", modeLabel)}`,
						0,
						0,
					),
				);
				for (const r of results) {
					container.addChild(new Spacer(1));
					const label =
						r.step !== undefined ? `Step ${r.step}: ${r.agent}` : r.agent;
					container.addChild(
						new Text(
							theme.fg("muted", "─── ") + theme.fg("accent", label),
							0,
							0,
						),
					);
					container.addChild(renderSingleResult(r, true) as Container);
				}
				const total = formatUsage(aggregateUsage(results));
				if (total) {
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("dim", `Total: ${total}`), 0, 0),
					);
				}
				return container;
			}

			// Collapsed or still running
			let text = `${modeIcon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", modeLabel)}`;
			for (const r of results) {
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
				const label =
					r.step !== undefined ? `Step ${r.step}: ${r.agent}` : r.agent;
				const out = getFinalOutput(r.messages);
				const preview = out
					? out.split("\n")[0].slice(0, 80) + (out.length > 80 ? "..." : "")
					: r.exitCode === -1
						? "(running...)"
						: "(no output)";
				text += `\n${rIcon} ${theme.fg("accent", label)} ${theme.fg("dim", preview)}`;
			}
			if (!isStillRunning) {
				const total = formatUsage(aggregateUsage(results));
				if (total) text += `\n${theme.fg("dim", `Total: ${total}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
