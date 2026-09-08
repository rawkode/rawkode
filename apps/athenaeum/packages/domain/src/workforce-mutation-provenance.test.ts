import { describe, expect, it } from "vitest";
import {
	AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION,
	LEDGER_COMMAND_VERSION,
	RUN_IDENTITY_VERSION,
	WORKFORCE_MUTATION_BRIDGE_INPUT_VERSION,
	WORKFORCE_MUTATION_PROVENANCE_VERSION,
	bridgeWorkforceMutationProvenance,
	projectWorkforceStandup,
	type WorkforceStandupInput,
	type WorkforceMutationBridgeInput,
} from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const ref = (kind: string) => ({ kind, id, version: "v1" });
const record = (state: "accepted" | "rejected" = "accepted", decision = state === "accepted" ? "accept" : "reject") => ({
	proposal: { proposalId: id, workspaceId: id, chatId: id, operation: "merge", rangeBoundary: 0, requestId: "proposal-request", requestCanonicalPayload: new Uint8Array(), requestFingerprint: "proposal-fingerprint", actor: "actor", provenance: "source", capturedAt: "2026-08-26T00:00:00.000Z", snapshot: [] },
	decision: { proposalId: id, state },
	command: { version: LEDGER_COMMAND_VERSION, requestId: "command-request", fingerprint: "command-fingerprint", type: "agentChangeDecision", workspaceId: id, proposalId: id, decision, principal: "principal", provenance: "source", capability: "build", policy: "policy", messageDerivationVersion: AGENT_CHANGE_DECISION_MESSAGE_DERIVATION_VERSION, message: "reason", payload: { opaque: true }, createdAt: "2026-08-26T00:00:00.000Z" },
	receipt: { version: LEDGER_COMMAND_VERSION, requestId: "command-request", fingerprint: "command-fingerprint", commandKey: "agent-change-decision:command-request", nodeId: id, output: { opaque: true } },
	provenance: { version: WORKFORCE_MUTATION_PROVENANCE_VERSION, sourceProvenance: "source", runIdentity: { version: RUN_IDENTITY_VERSION, run: { microEmployee: ref("microEmployee"), job: ref("job"), workflow: ref("workflow"), runId: "run" }, occurrence: { schedule: ref("schedule"), occurrenceId: "occurrence", civilDate: "2026-08-26" } } },
});
const input = (...records: ReturnType<typeof record>[]): WorkforceMutationBridgeInput => ({
	version: WORKFORCE_MUTATION_BRIDGE_INPUT_VERSION,
	workspaceId: id,
	records: records as unknown as WorkforceMutationBridgeInput["records"],
});
const standupFor = (event: unknown, version = "v1"): WorkforceStandupInput => {
	const workforceRef = (kind: string) => ({ kind, id, version });
	const occurrence = { schedule: workforceRef("schedule"), occurrenceId: "occurrence", civilDate: "2026-08-26" };
	return {
		microEmployees: { state: "known", values: [{ schemaVersion: "athenaeum.workforce.v1", kind: "microEmployee", id, version, label: "Employee", role: "role", jobRefs: [workforceRef("job")] }] },
		jobs: { state: "known", values: [{ schemaVersion: "athenaeum.workforce.v1", kind: "job", id, version, label: "Job", workflowRef: workforceRef("workflow") }] },
		workflows: { state: "known", values: [{ schemaVersion: "athenaeum.workforce.v1", kind: "workflow", id, version, label: "Workflow", scheduleRef: workforceRef("schedule"), councilRefs: [] }] },
		schedules: { state: "known", values: [{ schemaVersion: "athenaeum.workforce.v1", kind: "schedule", id, version, label: "Schedule", civilTimeZone: "UTC", occurrenceIds: ["occurrence"] }] },
		councils: { state: "known", values: [] }, events: { state: "known", values: [event] }, runFacts: { state: "known", values: [] }, civilScope: occurrence,
	} as unknown as WorkforceStandupInput;
};

describe("bridgeWorkforceMutationProvenance", () => {
	it("projects accepted and rejected decisions with fixed summaries", () => {
		const output = bridgeWorkforceMutationProvenance(input(record("accepted"), record("rejected")));
		expect(output.candidates.map((event) => event.result.kind).sort()).toEqual([
			"completed",
			"skipped",
		]);
	});

	it("is replay and permutation stable, and collapses exact duplicates", () => {
		const accepted = record();
		const rejected = record("rejected");
		expect(bridgeWorkforceMutationProvenance(input(accepted, rejected))).toEqual(
			bridgeWorkforceMutationProvenance(input(rejected, accepted)),
		);
		expect(bridgeWorkforceMutationProvenance(input(accepted, accepted)).candidates).toHaveLength(1);
	});

	it("drops the event-id group when observational run identity changes", () => {
		const left = record();
		const right = record();
		right.provenance.runIdentity.run.runId = "other-run";
		const output = bridgeWorkforceMutationProvenance(input(left, right));
		expect(output.candidates).toEqual([]);
		expect(output.diagnostics).toEqual([{ code: "eventIdentityConflict" }]);
	});

	it("does not project pending, reverted, conflicted, or cross-paired records", () => {
		const reserved = record(); reserved.decision.state = "reserved" as typeof reserved.decision.state;
		const reverted = record(); reverted.decision.state = "reverted" as typeof reverted.decision.state;
		const conflicted = record(); conflicted.decision.state = "conflicted" as typeof conflicted.decision.state;
		const crossPair = record(); crossPair.command.decision = "reject";
		const output = bridgeWorkforceMutationProvenance(input(reserved, reverted, conflicted, crossPair));
		expect(output.candidates).toEqual([]);
		expect(output.diagnostics).toEqual([{ code: "conflicted" }]);
	});

	it("does not mutate its input and ignores an unknown lifecycle state", () => {
		const value = record();
		value.decision.state = "unknown" as typeof value.decision.state;
		const fixture = input(value);
		const before = {
			state: value.decision.state,
			runId: value.provenance.runIdentity.run.runId,
			requestBytes: Array.from(value.proposal.requestCanonicalPayload),
		};
		expect(bridgeWorkforceMutationProvenance(fixture).candidates).toEqual([]);
		expect({
			state: value.decision.state,
			runId: value.provenance.runIdentity.run.runId,
			requestBytes: Array.from(value.proposal.requestCanonicalPayload),
		}).toEqual(before);
	});

	it("ignores opaque proposal and receipt content", () => {
		const value = record();
		value.receipt.output = { changed: ["arbitrarily", "opaque"] } as unknown as typeof value.receipt.output;
		value.proposal.requestCanonicalPayload = new Uint8Array([99]);
		value.command.payload = { arbitrary: { opaque: "data" } } as unknown as typeof value.command.payload;
		expect(bridgeWorkforceMutationProvenance(input(value)).candidates).toHaveLength(1);
	});

	it("rejects correlation mismatches", () => {
		const value = record();
		value.command.fingerprint = "different";
		const output = bridgeWorkforceMutationProvenance(input(value));
		expect(output.candidates).toEqual([]);
		expect(output.diagnostics).toEqual([{ code: "correlationMismatch" }]);
	});

	it("requires every correlation field without consulting proposal request evidence", () => {
		const mutations: readonly ((value: ReturnType<typeof record>) => void)[] = [
			(value) => { value.proposal.workspaceId = "other"; },
			(value) => { value.command.workspaceId = "other"; },
			(value) => { value.decision.proposalId = "other"; },
			(value) => { value.command.proposalId = "other"; },
			(value) => { value.command.provenance = "other"; },
			(value) => { value.provenance.sourceProvenance = "other"; },
			(value) => { value.command.version = "other" as typeof value.command.version; },
			(value) => { value.command.type = "other" as typeof value.command.type; },
			(value) => { value.command.messageDerivationVersion = "other" as typeof value.command.messageDerivationVersion; },
			(value) => { value.receipt.version = "other" as typeof value.receipt.version; },
			(value) => { value.receipt.requestId = "other"; },
			(value) => { value.receipt.fingerprint = "other"; },
			(value) => { value.receipt.commandKey = "other"; },
		];
		for (const mutate of mutations) {
			const value = record();
			mutate(value);
			expect(bridgeWorkforceMutationProvenance(input(value)).diagnostics).toEqual([{ code: "correlationMismatch" }]);
		}
	});

	it("rejects malformed and unsupported provenance identities", () => {
		const unsupported = record();
		unsupported.provenance.runIdentity.version = "unsupported" as typeof unsupported.provenance.runIdentity.version;
		expect(bridgeWorkforceMutationProvenance(input(unsupported)).diagnostics).toEqual([{ code: "invalidRunIdentity" }]);
		const malformed = record();
		malformed.provenance.sourceProvenance = "";
		expect(bridgeWorkforceMutationProvenance(input(malformed)).diagnostics).toEqual([{ code: "invalidProvenance" }]);
		const invalidDate = record();
		invalidDate.provenance.runIdentity.occurrence.civilDate = "2025-02-29";
		expect(bridgeWorkforceMutationProvenance(input(invalidDate)).diagnostics).toEqual([{ code: "invalidRunIdentity" }]);
		const withSymbol = record();
		Object.defineProperty(withSymbol.provenance.runIdentity, Symbol("hidden"), { value: "no" });
		expect(bridgeWorkforceMutationProvenance(input(withSymbol)).diagnostics).toEqual([{ code: "invalidRunIdentity" }]);
		const accessor = record();
		Object.defineProperty(accessor.provenance.runIdentity, "runId", { get: () => "run", enumerable: true });
		expect(bridgeWorkforceMutationProvenance(input(accessor)).diagnostics).toEqual([{ code: "invalidRunIdentity" }]);
	});

	it("feeds a resolved workforce fixture and keeps definition-version mismatch visible", () => {
		const event = bridgeWorkforceMutationProvenance(input(record())).candidates[0]!;
		expect(projectWorkforceStandup(standupFor(event)).events).toHaveLength(1);
		const mismatch = standupFor(event, "v2") as unknown as { schedules: { state: "known"; values: Array<{ version: string }> } };
		mismatch.schedules.values[0]!.version = "v1";
		const projection = projectWorkforceStandup(mismatch as unknown as WorkforceStandupInput);
		expect(projection.events).toEqual([]);
		expect(projection.diagnostics.some((value) => value.code === "definitionVersionMismatch")).toBe(true);
	});
});
