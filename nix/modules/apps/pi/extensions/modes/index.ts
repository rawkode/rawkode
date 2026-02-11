import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const require = createRequire(import.meta.url);

function loadXState() {
	const candidates = [
		join(process.cwd(), ".pi", "npm", "node_modules", "xstate"),
		join(os.homedir(), ".pi", "agent", "npm", "node_modules", "xstate"),
	];

	try {
		const globalNpmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
		if (globalNpmRoot) {
			candidates.push(join(globalNpmRoot, "xstate"));
		}
	} catch {
		// Ignore and continue with other candidates.
	}

	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch {
			// Try next location.
		}
	}

	try {
		return require("xstate");
	} catch {
		throw new Error(
			'Unable to resolve xstate. Install via `packages: ["npm:xstate"]` in .pi/settings.json and reload Pi.',
		);
	}
}

const { assign, createActor, createMachine } = loadXState();

type Mode = "normal" | "plan" | "council" | "build";
type AutoStage = "plan" | "build" | "council";
type CouncilVerdict = "done" | "build" | "plan";

interface ModeState {
	mode: Mode;
}

interface AutoRunState {
	objective: string;
	stage: AutoStage;
	loopCount: number;
	planPath?: string;
	councilPath?: string;
	councilVerdict?: CouncilVerdict;
}

interface AutoRunStateEntry {
	active: true;
	objective: string;
	stageIndex: number;
	awaitingPhaseResult: boolean;
	loopCount: number;
	planPath?: string;
	councilPath?: string;
	councilVerdict?: CouncilVerdict;
}

interface AutoRunInactiveState {
	active: false;
}

interface MachineContext {
	mode: Mode;
	auto: AutoRunState | null;
}

type ModeEvent =
	| { type: "SET_MODE"; mode: Mode }
	| { type: "START_AUTO"; objective: string }
	| { type: "STOP_AUTO" }
	| { type: "PHASE_PLAN_COMPLETE"; planPath?: string }
	| { type: "PHASE_BUILD_COMPLETE" }
	| { type: "COUNCIL_VERDICT"; verdict: CouncilVerdict; feedbackPath?: string }
	| { type: "RESTORE"; mode: Mode; auto: AutoRunState | null };

const STATE_CUSTOM_TYPE = "rawko-mode";
const AUTO_STATE_CUSTOM_TYPE = "rawko-mode-auto";
const CONTEXT_CUSTOM_TYPE = "rawko-mode-context";

const MODE_ORDER: Mode[] = ["normal", "plan", "council", "build"];
const AUTO_STAGE_ORDER: AutoStage[] = ["plan", "build", "council"];
const COUNCIL_SUBAGENT_AGENTS = [
	"council-claude",
	"council-openai",
	"council-google",
];
const COUNCIL_SUBAGENT_SCOPE = "both";

const MODE_TOOLS: Record<Mode, string[]> = {
	normal: [],
	plan: ["read", "bash", "grep", "find", "ls"],
	council: ["read", "bash", "grep", "find", "ls", "subagent"],
	build: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

const MODE_STATUS_TEXT: Record<Mode, string> = {
	normal: "NORMAL",
	plan: "PLAN",
	council: "COUNCIL",
	build: "BUILD",
};

const MODE_PROMPT: Partial<Record<Mode, string>> = {
	plan: `[MODE: PLAN]
You are in planning mode.

Rules:
- Focus on analysis and planning.
- Do not perform implementation.
- Prefer read-only inspection and concrete, ordered plans.
- When useful, propose clear acceptance criteria.
`,
	council: `[MODE: COUNCIL]
You are in council review mode.

Rules:
- Act as a critical reviewer.
- Challenge assumptions and identify risks, regressions, and gaps.
- Do not perform implementation or write files.
- Prefer explicit verdicts with evidence and next checks.
`,
	build: `[MODE: BUILD]
You are in build mode.

Rules:
- Execute implementation tasks with concrete changes.
- Prefer minimal, correct diffs and clear verification steps.
- Keep momentum; avoid speculative redesign unless required.
`,
};

const MUTATING_COMMAND =
	/(^|\s)(rm|mv|cp|mkdir|touch|chmod|chown|tee|sed\s+-i|git\s+(add|commit|push|merge|rebase|reset|checkout|switch)|npm\s+(install|update|uninstall)|yarn\s+(add|remove|install)|pnpm\s+(add|remove|install)|pip\s+install|poetry\s+add|cargo\s+add|go\s+mod|sudo|kill|pkill|reboot|shutdown)\b/i;

function councilFeedbackPathFromEvent(event: ModeEvent): string | undefined {
	if (event.type !== "COUNCIL_VERDICT") {
		return undefined;
	}
	return event.feedbackPath;
}

function councilVerdictFromEvent(event: ModeEvent): CouncilVerdict | undefined {
	if (event.type !== "COUNCIL_VERDICT") {
		return undefined;
	}
	return event.verdict;
}

const modeMachine = createMachine({
	types: {} as {
		context: MachineContext;
		events: ModeEvent;
	},
	id: "rawkoModes",
	initial: "manual",
	context: {
		mode: "normal",
		auto: null,
	},
	states: {
		manual: {
			on: {
				SET_MODE: {
					actions: assign({
						mode: ({ event }) => event.mode,
					}),
				},
				START_AUTO: {
					target: "auto",
					actions: assign({
						mode: () => "plan",
						auto: ({ event }) => ({
							objective: event.objective,
							stage: "plan",
							loopCount: 0,
							planPath: undefined,
							councilPath: undefined,
							councilVerdict: undefined,
						}),
					}),
				},
				RESTORE: [
					{
						guard: ({ event }) => event.auto !== null,
						target: "auto",
						actions: assign({
							mode: ({ event }) => event.mode,
							auto: ({ event }) => event.auto,
						}),
					},
					{
						target: "manual",
						actions: assign({
							mode: ({ event }) => event.mode,
							auto: () => null,
						}),
					},
				],
			},
		},
		auto: {
			on: {
				STOP_AUTO: {
					target: "manual",
					actions: assign({
						mode: () => "normal",
						auto: () => null,
					}),
				},
				SET_MODE: {
					target: "manual",
					actions: assign({
						mode: ({ event }) => event.mode,
						auto: () => null,
					}),
				},
				PHASE_PLAN_COMPLETE: {
					guard: ({ context }) => context.auto?.stage === "plan",
					actions: assign({
						mode: () => "build",
						auto: ({ context, event }) => {
							if (!context.auto) {
								return null;
							}
							return {
								...context.auto,
								stage: "build",
								planPath: event.planPath ?? context.auto.planPath,
							};
						},
					}),
				},
				PHASE_BUILD_COMPLETE: {
					guard: ({ context }) => context.auto?.stage === "build",
					actions: assign({
						mode: () => "council",
						auto: ({ context }) => {
							if (!context.auto) {
								return null;
							}
							return {
								...context.auto,
								stage: "council",
							};
						},
					}),
				},
				COUNCIL_VERDICT: [
					{
						guard: ({ context, event }) =>
							context.auto?.stage === "council" && event.verdict === "done",
						target: "manual",
						actions: assign({
							mode: () => "normal",
							auto: () => null,
						}),
					},
					{
						guard: ({ context, event }) =>
							context.auto?.stage === "council" && event.verdict === "build",
						actions: assign({
							mode: () => "build",
							auto: ({ context, event }) => {
								if (!context.auto) {
									return null;
								}
								const feedbackPath = councilFeedbackPathFromEvent(event);
								const verdict = councilVerdictFromEvent(event);
								return {
									...context.auto,
									stage: "build",
									loopCount: context.auto.loopCount + 1,
									councilPath: feedbackPath ?? context.auto.councilPath,
									councilVerdict: verdict ?? context.auto.councilVerdict,
								};
							},
						}),
					},
					{
						guard: ({ context, event }) =>
							context.auto?.stage === "council" && event.verdict === "plan",
						actions: assign({
							mode: () => "plan",
							auto: ({ context, event }) => {
								if (!context.auto) {
									return null;
								}
								const feedbackPath = councilFeedbackPathFromEvent(event);
								const verdict = councilVerdictFromEvent(event);
								return {
									...context.auto,
									stage: "plan",
									loopCount: context.auto.loopCount + 1,
									councilPath: feedbackPath ?? context.auto.councilPath,
									councilVerdict: verdict ?? context.auto.councilVerdict,
								};
							},
						}),
					},
				],
				RESTORE: [
					{
						guard: ({ event }) => event.auto !== null,
						target: "auto",
						actions: assign({
							mode: ({ event }) => event.mode,
							auto: ({ event }) => event.auto,
						}),
					},
					{
						target: "manual",
						actions: assign({
							mode: ({ event }) => event.mode,
							auto: () => null,
						}),
					},
				],
			},
		},
	},
});

function normalizeMode(value: string): Mode | undefined {
	const raw = value.trim().toLowerCase();
	if (!raw) {
		return undefined;
	}
	if (raw === "n" || raw === "normal") {
		return "normal";
	}
	if (raw === "p" || raw === "plan") {
		return "plan";
	}
	if (raw === "c" || raw === "council" || raw === "review") {
		return "council";
	}
	if (raw === "b" || raw === "build" || raw === "implement") {
		return "build";
	}
	return undefined;
}

function isMutatingBash(command: string): boolean {
	return MUTATING_COMMAND.test(command);
}

function modeLabel(mode: Mode): string {
	return MODE_STATUS_TEXT[mode];
}

function applyModeTools(pi: ExtensionAPI, mode: Mode): string[] {
	const allNames = pi.getAllTools().map((tool) => tool.name);
	const available = new Set(allNames);
	const selected =
		mode === "normal"
			? allNames
			: MODE_TOOLS[mode].filter((name) => available.has(name));
	pi.setActiveTools(selected);
	return selected;
}

function stageIndex(stage: AutoStage): number {
	const idx = AUTO_STAGE_ORDER.indexOf(stage);
	return idx < 0 ? 1 : idx + 1;
}

function hasTool(pi: ExtensionAPI, name: string): boolean {
	return pi.getAllTools().some((tool) => tool.name === name);
}

function buildCouncilSharedReviewTask(
	autoRun: AutoRunState,
	planContext: string,
): string {
	const councilContext = autoRun.councilPath?.trim()
		? `Prior council feedback file: ${autoRun.councilPath}`
		: "Prior council feedback file: (none)";
	return [
		`Objective: ${autoRun.objective}`,
		planContext,
		councilContext,
		"Review implementation quality and whether the implementation follows the plan.",
		"Return a strict verdict and evidence.",
		"Use this exact verdict line format:",
		"VERDICT: DONE",
		"or",
		"VERDICT: BUILD",
		"or",
		"VERDICT: PLAN",
	].join("\n");
}

function buildAutoPhasePrompt(
	autoRun: AutoRunState,
	useCouncilSubagents: boolean,
): string {
	const stage = autoRun.stage;
	const stageNumber = stageIndex(stage);
	const planPath = autoRun.planPath?.trim();
	const planContext = planPath
		? `Shared plan file: ${planPath}`
		: "Shared plan file: (not available yet)";
	const councilPath = autoRun.councilPath?.trim();
	const councilContext = councilPath
		? `Shared council feedback file: ${councilPath}`
		: "Shared council feedback file: (not available yet)";
	const prefix = [
		`Objective: ${autoRun.objective}`,
		`Auto cycle: ${autoRun.loopCount + 1}`,
		`Phase ${stageNumber}/3: ${stage.toUpperCase()}`,
		"",
	];

	if (stage === "plan") {
		const lines = [
			...prefix,
			planContext,
			councilContext,
			...(councilPath
				? [
						"Read council feedback first and revise the plan to address every actionable issue.",
						"Include a short mapping from each council issue to a plan step.",
					]
				: []),
			...[
				"Create a concise numbered plan to accomplish the objective.",
				"Call out assumptions and gaps.",
				"End with a short section: `Plan ready for build.`",
			],
		];
		return lines.join("\n");
	}

	if (stage === "build") {
		return prefix
			.concat([
				planContext,
				councilContext,
				"Read the shared plan file first and execute against that plan.",
				"If council feedback is available, address each actionable item during implementation.",
				"Execute the plan and implement the required changes.",
				"Run verification commands where possible.",
				"Summarize what changed and remaining risks.",
			])
			.join("\n");
	}

	if (useCouncilSubagents) {
		const sharedTask = buildCouncilSharedReviewTask(autoRun, planContext);
		const payload = {
			tasks: COUNCIL_SUBAGENT_AGENTS.map((agent) => ({
				agent,
				task: sharedTask,
			})),
			agentScope: COUNCIL_SUBAGENT_SCOPE,
			confirmProjectAgents: false,
		};
		return prefix
			.concat([
				planContext,
				councilContext,
				"Run a multi-model council using the `subagent` tool in parallel.",
				"Use this payload exactly:",
				"```json",
				JSON.stringify(payload, null, 2),
				"```",
				"After the three council outputs return, synthesize them as the primary model.",
				"Synthesis must include a section `## Council Feedback` with actionable bullets for next phase.",
				"Resolve disagreements explicitly and choose one final next state.",
				"Include exactly one final verdict line:",
				"VERDICT: DONE",
				"or",
				"VERDICT: BUILD",
				"or",
				"VERDICT: PLAN",
			])
			.join("\n");
	}

	return prefix
		.concat([
			planContext,
			councilContext,
			"Read the shared plan file first and review implementation against it.",
			"Review the result critically as a council.",
			"Include a section `## Council Feedback` with actionable bullets for next phase.",
			"Decide the next state and include exactly one line:",
			"VERDICT: DONE",
			"or",
			"VERDICT: BUILD",
			"or",
			"VERDICT: PLAN",
			"",
			"If DONE, objective is complete.",
			"If BUILD, request another implementation pass.",
			"If PLAN, request a revised plan first.",
		])
		.join("\n");
}

function getLatestAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
			continue;
		}
		const text = msg.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) {
			return text;
		}
	}
	return "";
}

function parseCouncilVerdict(text: string): CouncilVerdict | undefined {
	const normalized = text.toLowerCase();
	const match = normalized.match(/verdict:\s*(done|build|plan)\b/);
	if (!match?.[1]) {
		return undefined;
	}
	if (match[1] === "done" || match[1] === "build" || match[1] === "plan") {
		return match[1];
	}
	return undefined;
}

function getUserCacheDir(): string {
	if (process.platform === "win32") {
		return process.env.LOCALAPPDATA || join(os.homedir(), "AppData", "Local");
	}
	if (process.platform === "darwin") {
		return join(os.homedir(), "Library", "Caches");
	}
	return process.env.XDG_CACHE_HOME || join(os.homedir(), ".cache");
}

function getRawkoPlansDir(): string {
	return join(getUserCacheDir(), ".rawko", "plans");
}

function getRawkoCouncilDir(): string {
	return join(getUserCacheDir(), ".rawko", "council");
}

async function writePlanToCacheFile(
	objective: string,
	planText: string,
): Promise<string> {
	const plansDir = getRawkoPlansDir();
	await fs.mkdir(plansDir, { recursive: true });
	const name = `plan-${randomUUID()}.md`;
	const filePath = join(plansDir, name);
	const content = [
		"# Rawko Plan",
		"",
		`- createdAt: ${new Date().toISOString()}`,
		`- objective: ${objective}`,
		"",
		"## Plan",
		"",
		planText.trim() || "(empty)",
		"",
	].join("\n");
	await fs.writeFile(filePath, content, "utf8");
	return filePath;
}

async function writeCouncilToCacheFile(
	objective: string,
	verdict: CouncilVerdict,
	councilText: string,
): Promise<string> {
	const councilDir = getRawkoCouncilDir();
	await fs.mkdir(councilDir, { recursive: true });
	const name = `council-${randomUUID()}.md`;
	const filePath = join(councilDir, name);
	const content = [
		"# Rawko Council Feedback",
		"",
		`- createdAt: ${new Date().toISOString()}`,
		`- objective: ${objective}`,
		`- verdict: ${verdict.toUpperCase()}`,
		"",
		"## Feedback",
		"",
		councilText.trim() || "(empty)",
		"",
	].join("\n");
	await fs.writeFile(filePath, content, "utf8");
	return filePath;
}

export default function modeSwitchExtension(pi: ExtensionAPI): void {
	const modeActor = createActor(modeMachine);
	modeActor.start();
	let awaitingPhaseResult = false;

	function getMode(): Mode {
		return modeActor.getSnapshot().context.mode;
	}

	function getAutoRun(): AutoRunState | null {
		return modeActor.getSnapshot().context.auto;
	}

	function isAutoActive(): boolean {
		return modeActor.getSnapshot().matches("auto") && getAutoRun() !== null;
	}

	function persistModeState(): void {
		pi.appendEntry<ModeState>(STATE_CUSTOM_TYPE, { mode: getMode() });
	}

	function persistAutoState(): void {
		const auto = getAutoRun();
		if (auto) {
			pi.appendEntry<AutoRunStateEntry>(AUTO_STATE_CUSTOM_TYPE, {
				active: true,
				objective: auto.objective,
				stageIndex: stageIndex(auto.stage) - 1,
				awaitingPhaseResult,
				loopCount: auto.loopCount,
				planPath: auto.planPath,
				councilPath: auto.councilPath,
				councilVerdict: auto.councilVerdict,
			});
			return;
		}
		pi.appendEntry<AutoRunInactiveState>(AUTO_STATE_CUSTOM_TYPE, {
			active: false,
		});
	}

	function persistState(): void {
		persistModeState();
		persistAutoState();
	}

	function updateStatus(ctx: ExtensionContext): void {
		const mode = getMode();
		const label = modeLabel(mode);
		const color =
			mode === "build" ? "success" : mode === "council" ? "warning" : "accent";
		const auto = getAutoRun();
		const autoSuffix = auto ? ` AUTO ${stageIndex(auto.stage)}/3` : "";
		ctx.ui.setStatus(
			"rawko-mode",
			ctx.ui.theme.fg(color, `◉ ${label}${autoSuffix}`),
		);
	}

	function syncState(ctx: ExtensionContext, notifyModeChange = false): void {
		const mode = getMode();
		const tools = applyModeTools(pi, mode);
		persistState();
		updateStatus(ctx);
		if (notifyModeChange) {
			ctx.ui.notify(
				`Mode: ${modeLabel(mode)}. Active tools: ${tools.join(", ") || "(none)"}`,
				"info",
			);
		}
	}

	function dispatchCurrentAutoStage(ctx: ExtensionContext): void {
		const auto = getAutoRun();
		if (!auto || !isAutoActive()) {
			return;
		}
		const useCouncilSubagents =
			auto.stage === "council" && hasTool(pi, "subagent");
		if (auto.stage === "council" && !useCouncilSubagents) {
			ctx.ui.notify(
				"Council fan-out disabled: `subagent` tool not available. Using single-model council.",
				"warning",
			);
		}
		awaitingPhaseResult = true;
		persistAutoState();
		updateStatus(ctx);
		pi.sendUserMessage(buildAutoPhasePrompt(auto, useCouncilSubagents));
	}

	function stopAutoRun(ctx: ExtensionContext, reason?: string): void {
		if (!isAutoActive()) {
			return;
		}
		modeActor.send({ type: "STOP_AUTO" });
		awaitingPhaseResult = false;
		syncState(ctx);
		if (reason) {
			ctx.ui.notify(reason, "info");
		}
	}

	function setMode(
		mode: Mode,
		ctx: ExtensionContext,
		notify = true,
		source: "manual" | "auto" = "manual",
	): void {
		const wasAuto = isAutoActive();
		if (source === "manual" && wasAuto) {
			ctx.ui.notify(
				"Stopped automatic flow because mode changed manually.",
				"info",
			);
		}
		modeActor.send({ type: "SET_MODE", mode });
		awaitingPhaseResult = false;
		syncState(ctx, notify);
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		let restoredMode: Mode | undefined;
		let restoredAuto: AutoRunState | null = null;
		let restoredAwaitingPhaseResult = false;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") {
				continue;
			}

			if (entry.customType === STATE_CUSTOM_TYPE) {
				const data = entry.data as ModeState | undefined;
				const parsed = normalizeMode(String(data?.mode ?? ""));
				if (parsed) {
					restoredMode = parsed;
				}
			}

			if (entry.customType === AUTO_STATE_CUSTOM_TYPE) {
				const data = entry.data as
					| AutoRunStateEntry
					| AutoRunInactiveState
					| undefined;
				if (data?.active === false) {
					restoredAuto = null;
					restoredAwaitingPhaseResult = false;
				}
				if (data?.active === true) {
					const rawIndex = Number.isFinite(data.stageIndex)
						? Math.max(
								0,
								Math.min(AUTO_STAGE_ORDER.length - 1, data.stageIndex),
							)
						: 0;
					const stage = AUTO_STAGE_ORDER[rawIndex] ?? "plan";
					restoredAuto = {
						objective: String(data.objective ?? ""),
						stage,
						loopCount: Number.isFinite(data.loopCount)
							? Math.max(0, data.loopCount)
							: 0,
						planPath:
							typeof data.planPath === "string" ? data.planPath : undefined,
						councilPath:
							typeof data.councilPath === "string"
								? data.councilPath
								: undefined,
						councilVerdict:
							data.councilVerdict === "done" ||
							data.councilVerdict === "build" ||
							data.councilVerdict === "plan"
								? data.councilVerdict
								: undefined,
					};
					restoredAwaitingPhaseResult = Boolean(data.awaitingPhaseResult);
				}
			}
		}

		if (!restoredMode && restoredAuto) {
			restoredMode = restoredAuto.stage;
		}

		modeActor.send({
			type: "RESTORE",
			mode: restoredMode ?? "normal",
			auto: restoredAuto,
		});
		awaitingPhaseResult = restoredAuto ? restoredAwaitingPhaseResult : false;
		syncState(ctx);
	}

	function startAutoRun(objective: string, ctx: ExtensionContext): void {
		modeActor.send({ type: "START_AUTO", objective });
		awaitingPhaseResult = false;
		syncState(ctx);
		dispatchCurrentAutoStage(ctx);
	}

	pi.registerFlag("rawko-mode", {
		description: "Start in a specific mode: normal, plan, council, or build",
		type: "string",
	});

	pi.registerCommand("mode", {
		description: "Switch orchestration mode: /mode normal|plan|council|build",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trim().toLowerCase();
			const items = MODE_ORDER.filter((mode) => mode.startsWith(needle)).map(
				(mode) => ({ value: mode, label: mode }),
			);
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = normalizeMode(args);
			if (parsed) {
				setMode(parsed, ctx, true, "manual");
				return;
			}

			if (!args.trim()) {
				const choice = await ctx.ui.select("Select Mode", MODE_ORDER);
				const selected = normalizeMode(choice ?? "");
				if (selected) {
					setMode(selected, ctx, true, "manual");
					return;
				}
			}

			ctx.ui.notify(
				`Current mode: ${modeLabel(getMode())}. Use /mode normal|plan|council|build`,
				"info",
			);
		},
	});

	pi.registerCommand("mode-status", {
		description: "Show current mode and auto-flow status",
		handler: async (_args, ctx) => {
			const active = pi.getActiveTools();
			const auto = getAutoRun();
			const autoText = auto
				? `Auto flow: active (${stageIndex(auto.stage)}/3), loops=${auto.loopCount + 1}${
						auto.planPath ? `, plan=${auto.planPath}` : ""
					}${auto.councilPath ? `, council=${auto.councilPath}` : ""}${
						auto.councilVerdict
							? `, lastVerdict=${auto.councilVerdict.toUpperCase()}`
							: ""
					}${awaitingPhaseResult ? ", awaiting_result=true" : ""}`
				: "Auto flow: inactive";
			ctx.ui.notify(
				`Mode: ${modeLabel(getMode())}\nTools: ${active.join(", ") || "(none)"}\n${autoText}`,
				"info",
			);
		},
	});

	pi.registerCommand("mode-auto", {
		description:
			"Run objective automatically: plan -> build -> council -> done|build|plan",
		handler: async (args, ctx) => {
			const objective = args.trim();
			if (!objective) {
				ctx.ui.notify("Usage: /mode-auto <objective>", "info");
				return;
			}
			if (isAutoActive()) {
				ctx.ui.notify(
					"Automatic flow already running. Use /mode-stop first.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				"Starting automatic flow: PLAN -> BUILD -> COUNCIL",
				"info",
			);
			startAutoRun(objective, ctx);
		},
	});

	pi.registerCommand("mode-stop", {
		description: "Stop automatic mode flow",
		handler: async (_args, ctx) => {
			if (!isAutoActive()) {
				ctx.ui.notify("No active automatic flow.", "info");
				return;
			}
			stopAutoRun(ctx, "Stopped automatic flow.");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Switch to plan mode",
		handler: async (ctx) => setMode("plan", ctx, true, "manual"),
	});

	pi.registerShortcut(Key.ctrlAlt("c"), {
		description: "Switch to council mode",
		handler: async (ctx) => setMode("council", ctx, true, "manual"),
	});

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: "Switch to build mode",
		handler: async (ctx) => setMode("build", ctx, true, "manual"),
	});

	pi.on("session_start", async (_event, ctx) => {
		const fromFlag = normalizeMode(String(pi.getFlag("rawko-mode") ?? ""));
		if (fromFlag) {
			modeActor.send({ type: "RESTORE", mode: fromFlag, auto: null });
			awaitingPhaseResult = false;
			syncState(ctx);
			return;
		}
		restoreFromBranch(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => {
				const custom = message as { customType?: string };
				return custom.customType !== CONTEXT_CUSTOM_TYPE;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		const prompt = MODE_PROMPT[getMode()];
		if (!prompt) {
			return;
		}
		return {
			message: {
				customType: CONTEXT_CUSTOM_TYPE,
				content: prompt,
				display: false,
			},
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		const auto = getAutoRun();
		if (!auto || !isAutoActive() || !awaitingPhaseResult) {
			return;
		}

		awaitingPhaseResult = false;

		if (auto.stage === "plan") {
			let planPath = auto.planPath;
			const planText = getLatestAssistantText(event.messages);
			if (planText) {
				try {
					planPath = await writePlanToCacheFile(auto.objective, planText);
					ctx.ui.notify(`Saved plan: ${planPath}`, "info");
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to save plan file: ${message}`, "warning");
				}
			}
			modeActor.send({ type: "PHASE_PLAN_COMPLETE", planPath });
			syncState(ctx);
			dispatchCurrentAutoStage(ctx);
			return;
		}

		if (auto.stage === "build") {
			modeActor.send({ type: "PHASE_BUILD_COMPLETE" });
			syncState(ctx);
			dispatchCurrentAutoStage(ctx);
			return;
		}

		const councilText = getLatestAssistantText(event.messages);
		const verdict = parseCouncilVerdict(councilText);
		const resolvedVerdict: CouncilVerdict = verdict ?? "build";
		if (!verdict) {
			ctx.ui.notify(
				"Council verdict not found. Defaulting to VERDICT: BUILD.",
				"warning",
			);
		}

		let councilPath = auto.councilPath;
		if (councilText) {
			try {
				councilPath = await writeCouncilToCacheFile(
					auto.objective,
					resolvedVerdict,
					councilText,
				);
				ctx.ui.notify(`Saved council feedback: ${councilPath}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Failed to save council feedback file: ${message}`,
					"warning",
				);
			}
		}

		modeActor.send({
			type: "COUNCIL_VERDICT",
			verdict: resolvedVerdict,
			feedbackPath: councilPath,
		});
		syncState(ctx);

		if (resolvedVerdict === "done") {
			ctx.ui.notify("Council verdict: DONE. Automatic flow completed.", "info");
			return;
		}

		dispatchCurrentAutoStage(ctx);
	});

	pi.on("tool_call", async (event) => {
		const mode = getMode();
		if (mode === "build" || mode === "normal") {
			return;
		}

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason: `${modeLabel(mode)} mode blocks file writes. Switch with /mode build or /mode normal.`,
			};
		}

		if (isToolCallEventType("bash", event)) {
			const command = String(event.input.command ?? "");
			if (isMutatingBash(command)) {
				return {
					block: true,
					reason: `${modeLabel(mode)} mode blocks mutating bash command: ${command}`,
				};
			}
		}
	});
}
