/**
 * An inert correlation bridge from a completed agent-change decision to a workforce result.
 * It deliberately does not authenticate a run or execute, persist, or authorise a mutation.
 */
import {
	AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION,
	LEDGER_COMMAND_VERSION,
	type AgentChangeDecisionLedgerCommand,
	type LedgerReceipt,
} from "./ledger.js";
import type {
	AgentChangeProposal,
	AgentChangeProposalDecision,
} from "./agent-change-proposal.js";
import {
	WORKFORCE_SCHEMA_VERSION,
	canonicalWorkforcePreimageV1,
	compareCanonicalWorkforcePreimagesV1,
	digestWorkforcePreimageV1,
	type EventId,
	type NonEmptyString,
	type ResultObservedEvent,
	type RunRef,
	type ScheduleOccurrenceRef,
	type Sequence,
} from "./workforce.js";

export const RUN_IDENTITY_VERSION = "athenaeum.workforce-run-identity.v1" as const;
export const WORKFORCE_MUTATION_PROVENANCE_VERSION =
	"athenaeum.workforce-mutation-provenance.v1" as const;
export const WORKFORCE_MUTATION_BRIDGE_INPUT_VERSION =
	"athenaeum.workforce-mutation-bridge-input.v1" as const;
export const WORKFORCE_MUTATION_BRIDGE_OUTPUT_VERSION =
	"athenaeum.workforce-mutation-bridge-output.v1" as const;

export type RunIdentity = {
	readonly version: typeof RUN_IDENTITY_VERSION;
	readonly run: RunRef;
	readonly occurrence: ScheduleOccurrenceRef;
};

/** Provenance is correlation evidence only; it conveys no authority or authenticity. */
export type WorkforceMutationProvenance = {
	readonly version: typeof WORKFORCE_MUTATION_PROVENANCE_VERSION;
	readonly sourceProvenance: NonEmptyString;
	readonly runIdentity: RunIdentity;
};

export type WorkforceMutationBridgeRecord = {
	readonly proposal: AgentChangeProposal;
	readonly decision: AgentChangeProposalDecision;
	readonly command: AgentChangeDecisionLedgerCommand;
	readonly receipt: LedgerReceipt;
	readonly provenance: WorkforceMutationProvenance;
};

export type WorkforceMutationBridgeInput = {
	readonly version: typeof WORKFORCE_MUTATION_BRIDGE_INPUT_VERSION;
	readonly workspaceId: string;
	readonly records: readonly WorkforceMutationBridgeRecord[];
};

export type WorkforceMutationBridgeDiagnostic = {
	readonly code:
		| "inputVersionMismatch"
		| "invalidWorkspace"
		| "invalidProvenance"
		| "invalidRunIdentity"
		| "invalidRecord"
		| "correlationMismatch"
		| "conflicted"
		| "eventIdentityConflict"
		| "integerOverflow";
};

export type WorkforceMutationBridgeOutput = {
	readonly version: typeof WORKFORCE_MUTATION_BRIDGE_OUTPUT_VERSION;
	readonly candidates: readonly ResultObservedEvent[];
	readonly diagnostics: readonly WorkforceMutationBridgeDiagnostic[];
};

const diagnostic = (code: WorkforceMutationBridgeDiagnostic["code"]): WorkforceMutationBridgeDiagnostic => ({ code });
const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) return false;
	return Object.getOwnPropertyNames(value).length === actual.length && actual.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor !== undefined && "value" in descriptor;
	});
};
const ownDataFields = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) && keys.every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor !== undefined && "value" in descriptor;
	});
const hasCycle = (value: unknown, visiting = new WeakSet<object>(), visited = new WeakSet<object>()): boolean => {
	if (value === null || typeof value !== "object") return false;
	if (visiting.has(value)) return true;
	if (visited.has(value)) return false;
	visiting.add(value);
	try {
		return Object.keys(value).some((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return !descriptor || !("value" in descriptor) || hasCycle(descriptor.value, visiting, visited);
		});
	}
	finally { visiting.delete(value); visited.add(value); }
};
const gregorianDate = (value: unknown): value is string => {
	if (typeof value !== "string") return false;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
	if (!Number.isSafeInteger(year) || month < 1 || month > 12 || day < 1) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= days[month - 1]!;
};
const definitionRef = (value: unknown, kind: string): boolean =>
	exactKeys(value, ["kind", "id", "version"]) &&
		value.kind === kind && isNonEmpty(value.id) && isNonEmpty(value.version);
const runIdentity = (value: unknown): value is RunIdentity => {
	if (!exactKeys(value, ["version", "run", "occurrence"]) || value.version !== RUN_IDENTITY_VERSION) return false;
	const run = value.run;
	const occurrence = value.occurrence;
	return exactKeys(run, ["microEmployee", "job", "workflow", "runId"])
		&& definitionRef(run.microEmployee, "microEmployee")
		&& definitionRef(run.job, "job")
		&& definitionRef(run.workflow, "workflow")
		&& isNonEmpty(run.runId)
		&& exactKeys(occurrence, ["schedule", "occurrenceId", "civilDate"])
		&& definitionRef(occurrence.schedule, "schedule")
		&& isNonEmpty(occurrence.occurrenceId)
		&& gregorianDate(occurrence.civilDate);
};
const validProvenance = (value: unknown): value is WorkforceMutationProvenance =>
	!hasCycle(value)
		&& exactKeys(value, ["version", "sourceProvenance", "runIdentity"])
		&& value.version === WORKFORCE_MUTATION_PROVENANCE_VERSION
		&& isNonEmpty(value.sourceProvenance)
		&& runIdentity(value.runIdentity);

const bytes = (value: string): Uint8Array => {
	const output: number[] = [];
	for (let index = 0; index < value.length; index++) {
		let code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const low = value.charCodeAt(index + 1);
			if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00; index++; }
		}
		if (code < 0x80) output.push(code);
		else if (code < 0x800) output.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		else if (code < 0x10000) output.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		else output.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
	}
	return new Uint8Array(output);
};
/** Unambiguous, ordered length-prefixed fields; no JSON object or positional encoding participates. */
const preimage = (domain: string, fields: readonly string[]): Uint8Array => {
	const parts = [bytes(domain), ...fields.map(bytes)];
	let length = 0;
	for (const part of parts) {
		if (!Number.isSafeInteger(part.length) || part.length > 0xffff_ffff || length > Number.MAX_SAFE_INTEGER - 4 - part.length)
			throw new RangeError("workforce mutation preimage length overflow");
		length += 4 + part.length;
	}
	if (length > 0xffff_ffff) throw new RangeError("workforce mutation preimage length overflow");
	const output = new Uint8Array(length);
	const view = new DataView(output.buffer);
	let offset = 0;
	for (const part of parts) {
		view.setUint32(offset, part.length);
		offset += 4;
		output.set(part, offset);
		offset += part.length;
	}
	return output;
};
const eventPreimage = (workspaceId: string, proposalId: string, outcome: "accepted" | "rejected") =>
	preimage("athenaeum.workforce-mutation-event-id.v1", [WORKFORCE_MUTATION_BRIDGE_OUTPUT_VERSION, workspaceId, proposalId, outcome]);
const eventId = (event: Uint8Array): EventId =>
	digestWorkforcePreimageV1(event) as unknown as EventId;
const sequence = (event: Uint8Array): Sequence => {
	const digest = digestWorkforcePreimageV1(preimage("athenaeum.workforce-mutation-sequence.v1", [Array.from(event, (byte) => byte.toString(16).padStart(2, "0")).join("")]));
	const value = Number.parseInt(digest.slice(0, 12), 16);
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("workforce mutation sequence overflow");
	return value as Sequence;
};
const copyRef = <T extends { readonly kind: string; readonly id: unknown; readonly version: unknown }>(value: T): T =>
	({ kind: value.kind, id: value.id, version: value.version } as T);
const copyRun = (value: RunRef): RunRef => ({ microEmployee: copyRef(value.microEmployee), job: copyRef(value.job), workflow: copyRef(value.workflow), runId: value.runId });
const copyOccurrence = (value: ScheduleOccurrenceRef): ScheduleOccurrenceRef => ({ schedule: copyRef(value.schedule), occurrenceId: value.occurrenceId, civilDate: value.civilDate });
const candidate = (record: WorkforceMutationBridgeRecord): ResultObservedEvent | null => {
	const { proposal, decision, command, receipt, provenance } = record;
	if (!validProvenance(provenance)) return null;
	if (decision.state === "conflicted") return null;
	if (decision.state === "accepted" && command.decision === "accept") {
		const image = eventPreimage(command.workspaceId, proposal.proposalId, "accepted");
		return { schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "resultObserved", eventId: eventId(image), sequence: sequence(image), run: copyRun(provenance.runIdentity.run), occurrence: copyOccurrence(provenance.runIdentity.occurrence), result: { kind: "completed", summary: "Agent change proposal accepted." as NonEmptyString }, causedByEventId: null };
	}
	if (decision.state === "rejected" && command.decision === "reject") {
		const image = eventPreimage(command.workspaceId, proposal.proposalId, "rejected");
		return { schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "resultObserved", eventId: eventId(image), sequence: sequence(image), run: copyRun(provenance.runIdentity.run), occurrence: copyOccurrence(provenance.runIdentity.occurrence), result: { kind: "skipped", summary: "Agent change proposal rejected." as NonEmptyString }, causedByEventId: null };
	}
	return null;
};
const body = (value: ResultObservedEvent): Uint8Array => canonicalWorkforcePreimageV1(value as never);
const compareEvents = (a: ResultObservedEvent, b: ResultObservedEvent) => compareCanonicalWorkforcePreimagesV1(body(a), body(b));

/**
 * Projects only exact, completed correlation rows. This is observational: the typed run identity
 * is copied to the event and is never treated as execution or authority evidence.
 */
export const bridgeWorkforceMutationProvenance = (input: WorkforceMutationBridgeInput): WorkforceMutationBridgeOutput => {
	const diagnostics: WorkforceMutationBridgeDiagnostic[] = [];
	if (!input || input.version !== WORKFORCE_MUTATION_BRIDGE_INPUT_VERSION) return { version: WORKFORCE_MUTATION_BRIDGE_OUTPUT_VERSION, candidates: [], diagnostics: [diagnostic("inputVersionMismatch")] };
	if (!isNonEmpty(input.workspaceId) || !Array.isArray(input.records)) return { version: WORKFORCE_MUTATION_BRIDGE_OUTPUT_VERSION, candidates: [], diagnostics: [diagnostic("invalidWorkspace")] };
	const values: ResultObservedEvent[] = [];
	for (const rawRecord of input.records) {
		if (!exactKeys(rawRecord, ["proposal", "decision", "command", "receipt", "provenance"])) { diagnostics.push(diagnostic("invalidRecord")); continue; }
		const record = rawRecord as WorkforceMutationBridgeRecord;
		if (!ownDataFields(record.proposal, ["proposalId", "workspaceId", "chatId", "operation", "rangeBoundary", "requestId", "requestCanonicalPayload", "requestFingerprint", "actor", "provenance", "capturedAt", "snapshot"]) || !ownDataFields(record.decision, ["proposalId", "state"]) || !ownDataFields(record.command, ["version", "requestId", "fingerprint", "type", "workspaceId", "proposalId", "decision", "principal", "provenance", "capability", "policy", "messageDerivationVersion", "message", "payload", "createdAt"]) || !ownDataFields(record.receipt, ["version", "requestId", "fingerprint", "commandKey", "nodeId", "output"])) { diagnostics.push(diagnostic("invalidRecord")); continue; }
		if (!validProvenance(record.provenance)) {
			const provenance = record.provenance as unknown;
			const hasShape = exactKeys(provenance, ["version", "sourceProvenance", "runIdentity"]);
			diagnostics.push(diagnostic(hasShape && (provenance as Record<string, unknown>).version === WORKFORCE_MUTATION_PROVENANCE_VERSION && isNonEmpty((provenance as Record<string, unknown>).sourceProvenance) ? "invalidRunIdentity" : "invalidProvenance"));
			continue;
		}
		const { proposal, decision, command, receipt, provenance } = record;
		if (decision.state === "conflicted") { diagnostics.push(diagnostic("conflicted")); continue; }
		if (proposal.workspaceId !== input.workspaceId || command.workspaceId !== input.workspaceId || proposal.proposalId !== decision.proposalId || proposal.proposalId !== command.proposalId || proposal.provenance !== command.provenance || proposal.provenance !== provenance.sourceProvenance || command.version !== LEDGER_COMMAND_VERSION || command.type !== "agentChangeDecision" || command.messageDerivationVersion !== AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION || receipt.version !== LEDGER_COMMAND_VERSION || receipt.requestId !== command.requestId || receipt.fingerprint !== command.fingerprint || receipt.commandKey !== `agent-change-decision:${command.requestId}`) {
			diagnostics.push(diagnostic("correlationMismatch"));
			continue;
		}
		try { const event = candidate(record); if (event) values.push(event); } catch (error) { if (error instanceof RangeError) diagnostics.push(diagnostic("integerOverflow")); else throw error; }
	}
	const grouped = new Map<string, ResultObservedEvent[]>();
	for (const value of values) grouped.set(value.eventId, [...(grouped.get(value.eventId) ?? []), value]);
	const candidates: ResultObservedEvent[] = [];
	for (const [id, group] of grouped) {
		const ordered = [...group].sort(compareEvents);
		if (ordered.length > 1 && compareEvents(ordered[0]!, ordered[ordered.length - 1]!) !== 0) { diagnostics.push(diagnostic("eventIdentityConflict")); continue; }
		candidates.push(ordered[0]!);
	}
	candidates.sort(compareEvents);
	diagnostics.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
	return { version: WORKFORCE_MUTATION_BRIDGE_OUTPUT_VERSION, candidates, diagnostics };
};
