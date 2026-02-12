import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { loadPackage } from "./load-package.js";
import {
	discoverAndLoadWorkflows,
	type WorkflowDefinition,
	type WorkflowDiscoveryResult,
	type WorkflowStateDefinition,
} from "./workflows.js";

const { assign, createActor, createMachine } = loadPackage("xstate") as any;

const STATE_CUSTOM_TYPE = "rawko-workflow-state";
const CONTEXT_CUSTOM_TYPE = "rawko-workflow-context";
const MAX_STATE_TRANSITIONS = 50;

interface RunState {
	workflowName: string;
	objective: string;
	currentState: string;
	awaitingResult: boolean;
	transitionCount: number;
}

interface MachineContext {
	run: RunState | null;
}

type MachineEvent =
	| {
			type: "START";
			workflowName: string;
			objective: string;
			initialState: string;
	  }
	| { type: "ADVANCE"; nextState: string }
	| { type: "COMPLETE" }
	| { type: "STOP" }
	| { type: "DISPATCHED" }
	| { type: "RESTORE"; run: RunState | null };

const workflowMachine = createMachine({
	types: {} as { context: MachineContext; events: MachineEvent },
	id: "workflow",
	initial: "idle",
	context: { run: null },
	states: {
		idle: {
			on: {
				START: {
					target: "running",
					actions: assign({
						run: ({
							event,
						}: {
							event: Extract<MachineEvent, { type: "START" }>;
						}) => ({
							workflowName: event.workflowName,
							objective: event.objective,
							currentState: event.initialState,
							awaitingResult: false,
							transitionCount: 0,
						}),
					}),
				},
				RESTORE: [
					{
						guard: ({
							event,
						}: {
							event: Extract<MachineEvent, { type: "RESTORE" }>;
						}) => event.run !== null,
						target: "running",
						actions: assign({
							run: ({
								event,
							}: {
								event: Extract<MachineEvent, { type: "RESTORE" }>;
							}) => event.run,
						}),
					},
					{ target: "idle" },
				],
			},
		},
		running: {
			on: {
				DISPATCHED: {
					actions: assign({
						run: ({ context }: { context: MachineContext }) =>
							context.run ? { ...context.run, awaitingResult: true } : null,
					}),
				},
				ADVANCE: {
					actions: assign({
						run: ({
							context,
							event,
						}: {
							context: MachineContext;
							event: Extract<MachineEvent, { type: "ADVANCE" }>;
						}) =>
							context.run
								? {
										...context.run,
										currentState: event.nextState,
										awaitingResult: false,
										transitionCount: (context.run.transitionCount ?? 0) + 1,
									}
								: null,
					}),
				},
				COMPLETE: {
					target: "idle",
					actions: assign({ run: () => null }),
				},
				STOP: {
					target: "idle",
					actions: assign({ run: () => null }),
				},
				RESTORE: [
					{
						guard: ({
							event,
						}: {
							event: Extract<MachineEvent, { type: "RESTORE" }>;
						}) => event.run !== null,
						actions: assign({
							run: ({
								event,
							}: {
								event: Extract<MachineEvent, { type: "RESTORE" }>;
							}) => event.run,
						}),
					},
					{
						target: "idle",
						actions: assign({ run: () => null }),
					},
				],
			},
		},
	},
});

function getLatestAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

function parseVerdict(
	text: string,
	verdicts: Record<string, string | null>,
): string | null | undefined {
	const keys = Object.keys(verdicts);
	const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pattern = new RegExp(`verdict:\\s*(${escaped.join("|")})\\b`, "i");
	const match = text.match(pattern);
	if (!match?.[1]) return undefined;
	const key = keys.find((k) => k.toLowerCase() === match[1].toLowerCase());
	return key !== undefined ? verdicts[key] : undefined;
}

function resolveNextState(
	workflow: WorkflowDefinition,
	currentState: string,
): string | null {
	const state = workflow.states?.[currentState];
	if (state?.next) return state.next;
	const order = workflow.stateOrder ?? Object.keys(workflow.states ?? {});
	const idx = order.indexOf(currentState);
	if (idx >= 0 && idx + 1 < order.length) return order[idx + 1];
	return null;
}

function getInitialState(workflow: WorkflowDefinition): string | undefined {
	return (
		workflow.initialState ??
		workflow.stateOrder?.[0] ??
		Object.keys(workflow.states ?? {})[0]
	);
}

export default function workflowsExtension(pi: ExtensionAPI): void {
	const actor = createActor(workflowMachine);
	actor.start();

	let discovery: WorkflowDiscoveryResult = {
		workflows: {},
		workflowSources: {},
		files: [],
		warnings: [],
	};
	let selectedWorkflow: string | undefined;

	function getRun(): RunState | null {
		return actor.getSnapshot().context.run;
	}

	function isRunning(): boolean {
		return actor.getSnapshot().matches("running") && getRun() !== null;
	}

	function getWorkflow(name?: string): WorkflowDefinition | undefined {
		return discovery.workflows[name ?? selectedWorkflow ?? ""];
	}

	function getState(
		workflow: WorkflowDefinition,
		name: string,
	): WorkflowStateDefinition | undefined {
		return workflow.states?.[name];
	}

	function refresh(ctx?: ExtensionContext): void {
		discovery = discoverAndLoadWorkflows(ctx?.cwd ?? process.cwd());
		if (discovery.warnings.length > 0 && ctx) {
			ctx.ui.notify(
				`Workflow warnings:\n${discovery.warnings.slice(0, 5).join("\n")}`,
				"warning",
			);
		}
		if (selectedWorkflow && !discovery.workflows[selectedWorkflow]) {
			selectedWorkflow = undefined;
		}
	}

	function persist(): void {
		const run = getRun();
		pi.appendEntry(STATE_CUSTOM_TYPE, {
			selectedWorkflow,
			run: run ? { ...run } : null,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		const run = getRun();
		if (!run) {
			const name = selectedWorkflow ?? "none";
			ctx.ui.setStatus(
				"rawko-workflow",
				ctx.ui.theme.fg("muted", `WF: ${name}`),
			);
			return;
		}
		ctx.ui.setStatus(
			"rawko-workflow",
			ctx.ui.theme.fg(
				"accent",
				`◉ WF ${run.workflowName} · ${run.currentState}`,
			),
		);
	}

	function applyToolRestrictions(run: RunState): void {
		const workflow = getWorkflow(run.workflowName);
		if (!workflow) return;
		const state = getState(workflow, run.currentState);
		if (!state?.tools || state.tools.length === 0) {
			pi.setActiveTools(pi.getAllTools().map((t) => t.name));
			return;
		}
		const available = new Set(pi.getAllTools().map((t) => t.name));
		pi.setActiveTools(state.tools.filter((t) => available.has(t)));
	}

	function syncState(ctx: ExtensionContext): void {
		const run = getRun();
		if (run) applyToolRestrictions(run);
		else pi.setActiveTools(pi.getAllTools().map((t) => t.name));
		persist();
		updateStatus(ctx);
	}

	function dispatch(ctx: ExtensionContext): void {
		const run = getRun();
		if (!run || !isRunning()) return;
		if (run.transitionCount >= MAX_STATE_TRANSITIONS) {
			actor.send({ type: "STOP" });
			syncState(ctx);
			ctx.ui.notify(
				`Workflow stopped: exceeded ${MAX_STATE_TRANSITIONS} state transitions. Possible loop.`,
				"error",
			);
			return;
		}
		const workflow = getWorkflow(run.workflowName);
		if (!workflow) {
			actor.send({ type: "STOP" });
			syncState(ctx);
			ctx.ui.notify(`Workflow '${run.workflowName}' not found.`, "error");
			return;
		}
		const state = getState(workflow, run.currentState);
		const instructions =
			state?.instructions ?? `Complete state '${run.currentState}'.`;

		const lines = [
			`Objective: ${run.objective}`,
			`Workflow: ${run.workflowName}`,
			`State: ${run.currentState}`,
			"",
			instructions,
		];

		if (state?.verdicts && Object.keys(state.verdicts).length > 0) {
			lines.push(
				"",
				`When complete, emit exactly one verdict line: VERDICT: ${Object.keys(state.verdicts).join(" | ")}`,
			);
		}

		actor.send({ type: "DISPATCHED" });
		syncState(ctx);
		pi.sendUserMessage(lines.join("\n"));
	}

	function isValidRunState(v: unknown): v is RunState {
		if (!v || typeof v !== "object") return false;
		const r = v as Record<string, unknown>;
		return (
			typeof r.workflowName === "string" &&
			typeof r.objective === "string" &&
			typeof r.currentState === "string" &&
			typeof r.awaitingResult === "boolean"
		);
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		let restored: {
			selectedWorkflow?: string;
			run: unknown;
		} | null = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
				restored = entry.data as typeof restored;
			}
		}
		if (
			restored?.selectedWorkflow &&
			discovery.workflows[restored.selectedWorkflow]
		) {
			selectedWorkflow = restored.selectedWorkflow;
		}
		const run = isValidRunState(restored?.run)
			? {
					...restored!.run,
					transitionCount: restored!.run.transitionCount ?? 0,
				}
			: null;
		actor.send({ type: "RESTORE", run });
		syncState(ctx);
	}

	// Commands
	pi.registerCommand("workflow", {
		description: "Select active workflow",
		getArgumentCompletions: (prefix) => {
			const names = Object.keys(discovery.workflows);
			const items = names
				.filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
				.map((n) => ({ value: n, label: n }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			refresh(ctx);
			const name = args.trim();
			if (name) {
				if (!discovery.workflows[name]) {
					ctx.ui.notify(`Unknown workflow: ${name}`, "warning");
					return;
				}
				selectedWorkflow = name;
				syncState(ctx);
				ctx.ui.notify(`Workflow: ${name}`, "info");
				return;
			}
			const names = Object.keys(discovery.workflows);
			if (names.length === 0) {
				ctx.ui.notify(
					"No workflows defined. Add workflows to .pi/workflows.yaml",
					"info",
				);
				return;
			}
			const choice = await ctx.ui.select("Select Workflow", names);
			if (!choice) return;
			selectedWorkflow = choice;
			syncState(ctx);
			ctx.ui.notify(`Workflow: ${choice}`, "info");
		},
	});

	pi.registerCommand("workflow-status", {
		description: "Show workflow status",
		handler: async (_args, ctx) => {
			const names = Object.keys(discovery.workflows);
			const run = getRun();
			const lines = [
				`Selected: ${selectedWorkflow ?? "none"}`,
				`Available: ${names.join(", ") || "none"}`,
				`Files: ${discovery.files.join(", ") || "none"}`,
				run
					? `Run: ${run.workflowName} · state: ${run.currentState} · awaiting: ${run.awaitingResult}`
					: "Run: inactive",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("workflow-reload", {
		description: "Reload workflows from YAML",
		handler: async (_args, ctx) => {
			refresh(ctx);
			syncState(ctx);
			ctx.ui.notify(
				`Reloaded. ${Object.keys(discovery.workflows).length} workflow(s) found.`,
				"info",
			);
		},
	});

	pi.registerCommand("workflow-run", {
		description: "Run objective through workflow states",
		handler: async (args, ctx) => {
			const objective = args.trim();
			if (!objective) {
				ctx.ui.notify("Usage: /workflow-run <objective>", "info");
				return;
			}
			if (isRunning()) {
				ctx.ui.notify("Already running. Use /workflow-stop first.", "warning");
				return;
			}
			if (!selectedWorkflow || !getWorkflow()) {
				ctx.ui.notify("No workflow selected. Use /workflow first.", "warning");
				return;
			}
			const workflow = getWorkflow()!;
			const initial = getInitialState(workflow);
			if (!initial) {
				ctx.ui.notify("Workflow has no states.", "error");
				return;
			}
			actor.send({
				type: "START",
				workflowName: selectedWorkflow,
				objective,
				initialState: initial,
			});
			syncState(ctx);
			ctx.ui.notify(
				`Starting '${selectedWorkflow}' at state '${initial}'.`,
				"info",
			);
			dispatch(ctx);
		},
	});

	pi.registerCommand("workflow-stop", {
		description: "Stop active workflow run",
		handler: async (_args, ctx) => {
			if (!isRunning()) {
				ctx.ui.notify("No active run.", "info");
				return;
			}
			actor.send({ type: "STOP" });
			syncState(ctx);
			ctx.ui.notify("Workflow stopped.", "info");
		},
	});

	// Events
	pi.on("session_start", async (_event, ctx) => {
		refresh(ctx);
		restoreFromBranch(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refresh();
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refresh();
		restoreFromBranch(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		refresh();
		restoreFromBranch(ctx);
	});

	pi.on("context", async (event) => ({
		messages: event.messages.filter((m) => {
			const custom = m as { customType?: string };
			return custom.customType !== CONTEXT_CUSTOM_TYPE;
		}),
	}));

	pi.on("before_agent_start", async () => {
		const run = getRun();
		if (!run) return;
		const workflow = getWorkflow(run.workflowName);
		if (!workflow) return;
		const state = getState(workflow, run.currentState);
		const prompt = state?.systemPrompt;
		if (!prompt?.trim()) return;
		return {
			message: {
				customType: CONTEXT_CUSTOM_TYPE,
				content: prompt,
				display: false,
			},
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		const run = getRun();
		if (!run || !isRunning() || !run.awaitingResult) return;

		const workflow = getWorkflow(run.workflowName);
		if (!workflow) {
			actor.send({ type: "STOP" });
			syncState(ctx);
			return;
		}

		const state = getState(workflow, run.currentState);

		// Verdict-gated transition
		if (state?.verdicts && Object.keys(state.verdicts).length > 0) {
			const text = getLatestAssistantText(event.messages);
			const next = parseVerdict(text, state.verdicts);
			if (next === undefined) {
				ctx.ui.notify(
					`No verdict found. Expected: VERDICT: ${Object.keys(state.verdicts).join(" | ")}`,
					"warning",
				);
				actor.send({ type: "STOP" });
				syncState(ctx);
				return;
			}
			if (next === null) {
				actor.send({ type: "COMPLETE" });
				syncState(ctx);
				ctx.ui.notify("Workflow complete.", "info");
				return;
			}
			actor.send({ type: "ADVANCE", nextState: next });
			syncState(ctx);
			dispatch(ctx);
			return;
		}

		// Auto-advance
		const next = resolveNextState(workflow, run.currentState);
		if (!next) {
			actor.send({ type: "COMPLETE" });
			syncState(ctx);
			ctx.ui.notify("Workflow complete.", "info");
			return;
		}
		actor.send({ type: "ADVANCE", nextState: next });
		syncState(ctx);
		dispatch(ctx);
	});
}
