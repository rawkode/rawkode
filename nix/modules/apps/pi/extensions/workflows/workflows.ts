import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadPackage } from "./load-package.js";

const { parse: parseYaml } = loadPackage("yaml") as {
	parse: (s: string) => unknown;
};

export interface WorkflowStateDefinition {
	instructions?: string;
	systemPrompt?: string;
	tools?: string[];
	next?: string;
	verdicts?: Record<string, string | null>;
}

export interface WorkflowDefinition {
	description?: string;
	initialState?: string;
	stateOrder?: string[];
	states?: Record<string, WorkflowStateDefinition>;
}

export interface WorkflowDiscoveryResult {
	defaultWorkflow?: string;
	workflows: Record<string, WorkflowDefinition>;
	workflowSources: Record<string, string[]>;
	files: string[];
	warnings: string[];
}

const PROJECT_FILE_CANDIDATES = [
	join(".pi", "workflows.yaml"),
	join(".pi", "workflows.yml"),
];

const GLOBAL_FILE_CANDIDATES = [
	join(os.homedir(), ".pi", "agent", "workflows.yaml"),
	join(os.homedir(), ".pi", "agent", "workflows.yml"),
];

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}

function str(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t.length > 0 ? t : undefined;
}

function strArray(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const items = v
		.map((i) => (typeof i === "string" ? i.trim() : ""))
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function normalizeState(v: unknown): WorkflowStateDefinition | undefined {
	const r = asRecord(v);
	if (!r) return undefined;
	const def: WorkflowStateDefinition = {};
	const instructions = str(r.instructions);
	if (instructions) def.instructions = instructions;
	const systemPrompt = str(r.systemPrompt);
	if (systemPrompt) def.systemPrompt = systemPrompt;
	const tools = strArray(r.tools);
	if (tools) def.tools = tools;
	const next = str(r.next);
	if (next) def.next = next;
	const verdictsRaw = asRecord(r.verdicts);
	if (verdictsRaw) {
		const verdicts: Record<string, string | null> = {};
		for (const [k, val] of Object.entries(verdictsRaw)) {
			const key = str(k);
			if (!key) continue;
			verdicts[key] = val === null ? null : (str(String(val)) ?? null);
		}
		if (Object.keys(verdicts).length > 0) def.verdicts = verdicts;
	}
	return def;
}

function normalizeWorkflow(v: unknown): WorkflowDefinition | undefined {
	const r = asRecord(v);
	if (!r) return undefined;
	const def: WorkflowDefinition = {};
	const desc = str(r.description);
	if (desc) def.description = desc;
	const initial = str(r.initialState);
	if (initial) def.initialState = initial;

	const statesRaw = asRecord(r.states);
	if (statesRaw) {
		const states: Record<string, WorkflowStateDefinition> = {};
		const order: string[] = [];
		for (const [name, raw] of Object.entries(statesRaw)) {
			const n = str(name);
			if (!n) continue;
			const s = normalizeState(raw);
			if (!s) continue;
			states[n] = s;
			order.push(n);
		}
		if (order.length > 0) {
			def.states = states;
			def.stateOrder = strArray(r.stateOrder) ?? order;
		}
	}

	return def;
}

function mergeStates(
	base: WorkflowStateDefinition,
	over: WorkflowStateDefinition,
): WorkflowStateDefinition {
	return {
		instructions: over.instructions ?? base.instructions,
		systemPrompt: over.systemPrompt ?? base.systemPrompt,
		tools: over.tools ?? base.tools,
		next: over.next ?? base.next,
		verdicts: over.verdicts
			? base.verdicts
				? { ...base.verdicts, ...over.verdicts }
				: over.verdicts
			: base.verdicts,
	};
}

function mergeWorkflows(
	base: WorkflowDefinition,
	over: WorkflowDefinition,
): WorkflowDefinition {
	const merged: WorkflowDefinition = {
		description: over.description ?? base.description,
		initialState: over.initialState ?? base.initialState,
	};

	const states: Record<string, WorkflowStateDefinition> = {};
	for (const [n, s] of Object.entries(base.states ?? {})) states[n] = s;
	for (const [n, s] of Object.entries(over.states ?? {}))
		states[n] = states[n] ? mergeStates(states[n], s) : s;

	if (Object.keys(states).length > 0) {
		merged.states = states;
		const allNames = Object.keys(states);
		const seen = new Set<string>();
		const order: string[] = [];
		for (const n of over.stateOrder ?? []) {
			if (allNames.includes(n) && !seen.has(n)) {
				seen.add(n);
				order.push(n);
			}
		}
		for (const n of base.stateOrder ?? []) {
			if (allNames.includes(n) && !seen.has(n)) {
				seen.add(n);
				order.push(n);
			}
		}
		for (const n of allNames) {
			if (!seen.has(n)) {
				seen.add(n);
				order.push(n);
			}
		}
		merged.stateOrder = order;
	}

	return merged;
}

function resolveGitRoot(cwd: string): string | undefined {
	try {
		return resolve(
			execSync("git rev-parse --show-toplevel", {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim(),
		);
	} catch {
		return undefined;
	}
}

function searchDirs(cwd: string): string[] {
	const resolved = resolve(cwd);
	const gitRoot = resolveGitRoot(resolved);
	if (!gitRoot || !resolved.startsWith(gitRoot)) return [resolved];
	const dirs: string[] = [];
	let cur = resolved;
	while (true) {
		dirs.push(cur);
		if (cur === gitRoot) break;
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return dirs.reverse();
}

function findGlobalFile(): string | undefined {
	return GLOBAL_FILE_CANDIDATES.find((f) => existsSync(f));
}

function findProjectFiles(cwd: string): string[] {
	const files: string[] = [];
	for (const dir of searchDirs(cwd)) {
		const found = PROJECT_FILE_CANDIDATES.map((c) => join(dir, c)).find((f) =>
			existsSync(f),
		);
		if (found) files.push(found);
	}
	return files;
}

function parseFile(filePath: string): {
	defaultWorkflow?: string;
	workflows: Record<string, WorkflowDefinition>;
	warnings: string[];
} {
	const warnings: string[] = [];
	const workflows: Record<string, WorkflowDefinition> = {};

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (e) {
		warnings.push(`Cannot read: ${e instanceof Error ? e.message : e}`);
		return { workflows, warnings };
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (e) {
		warnings.push(`Invalid YAML: ${e instanceof Error ? e.message : e}`);
		return { workflows, warnings };
	}

	const root = asRecord(parsed);
	if (!root) {
		warnings.push("YAML root must be an object.");
		return { workflows, warnings };
	}

	const defaultWorkflow = str(root.defaultWorkflow);
	const wfMap = asRecord(root.workflows);
	if (!wfMap) {
		warnings.push("Missing `workflows` key.");
		return { defaultWorkflow, workflows, warnings };
	}

	for (const [name, value] of Object.entries(wfMap)) {
		const n = str(name);
		if (!n) continue;
		const wf = normalizeWorkflow(value);
		if (!wf) {
			warnings.push(`Ignored workflow '${n}': not an object.`);
			continue;
		}
		workflows[n] = wf;
	}

	return { defaultWorkflow, workflows, warnings };
}

export function discoverAndLoadWorkflows(cwd: string): WorkflowDiscoveryResult {
	const files: string[] = [];
	const globalFile = findGlobalFile();
	if (globalFile) files.push(globalFile);
	files.push(...findProjectFiles(cwd));

	const workflows: Record<string, WorkflowDefinition> = {};
	const workflowSources: Record<string, string[]> = {};
	const warnings: string[] = [];
	let defaultWorkflow: string | undefined;

	for (const file of files) {
		const result = parseFile(file);
		for (const w of result.warnings) warnings.push(`${file}: ${w}`);
		if (result.defaultWorkflow) defaultWorkflow = result.defaultWorkflow;
		for (const [name, def] of Object.entries(result.workflows)) {
			workflows[name] = workflows[name]
				? mergeWorkflows(workflows[name], def)
				: def;
			(workflowSources[name] ??= []).push(file);
		}
	}

	return { defaultWorkflow, workflows, workflowSources, files, warnings };
}
