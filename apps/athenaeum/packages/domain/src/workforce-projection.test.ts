import { describe, expect, it } from "vitest";
import {
	WORKFORCE_SCHEMA_VERSION,
	canonicalWorkforcePreimageV1,
	digestWorkforcePreimageV1,
	type WorkforceStandupInput,
} from "./workforce.js";
import { projectWorkforceStandup } from "./workforce-projection.js";

const ref = (kind: string, id: string, version = "v1") => ({ kind, id, version });
const scope = {
	schedule: ref("schedule", "daily"),
	occurrenceId: "morning",
	civilDate: "2026-08-26",
};
const run = {
	microEmployee: ref("microEmployee", "assistant"),
	job: ref("job", "enrich"),
	workflow: ref("workflow", "daily"),
	runId: "run-1",
};

const baseInput = (): WorkforceStandupInput => ({
	microEmployees: { state: "known", values: [{
		schemaVersion: WORKFORCE_SCHEMA_VERSION,
		kind: "microEmployee", id: "assistant", version: "v1", label: "Assistant", role: "assistant",
		jobRefs: [ref("job", "enrich")],
	}] },
	jobs: { state: "known", values: [{
		schemaVersion: WORKFORCE_SCHEMA_VERSION,
		kind: "job", id: "enrich", version: "v1", label: "Enrich", workflowRef: ref("workflow", "daily"),
	}] },
	workflows: { state: "known", values: [{
		schemaVersion: WORKFORCE_SCHEMA_VERSION,
		kind: "workflow", id: "daily", version: "v1", label: "Daily", scheduleRef: ref("schedule", "daily"), councilRefs: [],
	}] },
	schedules: { state: "known", values: [{
		schemaVersion: WORKFORCE_SCHEMA_VERSION,
		kind: "schedule", id: "daily", version: "v1", label: "Daily", civilTimeZone: "UTC", occurrenceIds: ["morning"],
	}] },
	councils: { state: "known", values: [] },
	events: { state: "known", values: [{
		schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "runObserved", eventId: "event-1", sequence: 0, run, occurrence: scope,
	}] },
	runFacts: { state: "known", values: [] },
	civilScope: scope,
} as unknown as WorkforceStandupInput);

describe("projectWorkforceStandup", () => {
	it("is permutation independent, collapses identical records, and deep-copies output", () => {
		const input = baseInput() as any;
		const duplicate = { ...input.events.values[0]! };
		input.events = { state: "known", values: [duplicate, input.events.values[0]!] };
		const first = projectWorkforceStandup(input);
		input.events = { state: "known", values: [...input.events.values].reverse() };
		const second = projectWorkforceStandup(input);
		expect(second).toEqual(first);
		expect(first.events).toHaveLength(1);
		(input.events.values[0] as { eventId: string }).eventId = "mutated";
		expect(first.events[0]!.eventId).toBe("event-1");
	});

	it("reports exact identity conflicts and version mismatch without importing unrelated records", () => {
		const input = baseInput() as any;
		const conflicting = { ...input.schedules.values[0]!, label: "Different" };
		input.schedules = { state: "known", values: [input.schedules.values[0]!, conflicting] };
		const projection = projectWorkforceStandup(input);
		expect(projection.resolvedDefinitions.some((x) => x.kind === "schedule")).toBe(false);
		expect(projection.diagnostics).toContainEqual({ code: "definitionConflict", ref: scope.schedule });

		const mismatch = baseInput() as any;
		mismatch.civilScope = { ...scope, schedule: ref("schedule", "daily", "v2") };
		const mismatchProjection = projectWorkforceStandup(mismatch);
		expect(mismatchProjection.diagnostics).toContainEqual({
			code: "definitionVersionMismatch", ref: mismatch.civilScope.schedule, availableVersions: ["v1"],
		});
	});

	it("takes unavailable sources before missing diagnostics and quarantines causes", () => {
		const input = baseInput() as any;
		input.events = { state: "unavailable", reason: "notLoaded" };
		const projection = projectWorkforceStandup(input);
		expect(projection.diagnostics).toContainEqual({ code: "inputUnavailable", input: "events", reason: "notLoaded" });
		expect(projection.events).toEqual([]);

		const causeInput = baseInput() as any;
		causeInput.events = { state: "known", values: [
			{ ...(baseInput() as any).events.values[0]!, eventId: "root" },
			{
				schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "resultObserved", eventId: "dependent", sequence: 1,
				run, occurrence: scope, result: { kind: "completed", summary: "done" }, causedByEventId: "missing",
			},
		] };
		const causeProjection = projectWorkforceStandup(causeInput);
		expect(causeProjection.events.map((event) => event.eventId)).toEqual(["root"]);
		expect(causeProjection.diagnostics).toContainEqual({
			code: "causeMissing", dependentKind: "resultObserved", dependentId: "dependent", causedByEventId: "missing",
		});
	});

	it("removes causal cycles while retaining valid definition cycles", () => {
		const input = baseInput() as any;
		input.events = { state: "known", values: [
			{ ...(baseInput() as any).events.values[0]!, eventId: "a" },
			{
				schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "resultObserved", eventId: "b", sequence: 1,
				run, occurrence: scope, result: { kind: "completed", summary: "b" }, causedByEventId: "c",
			},
			{
				schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "resultObserved", eventId: "c", sequence: 2,
				run, occurrence: scope, result: { kind: "completed", summary: "c" }, causedByEventId: "b",
			},
		] };
		const projection = projectWorkforceStandup(input);
		expect(projection.events.map((event) => event.eventId)).toEqual(["a"]);
		expect(projection.diagnostics).toContainEqual({ code: "causalCycle", eventIds: ["b", "c"] });

		const defs = baseInput() as any;
		defs.workflows = { state: "known", values: [{
			schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "workflow", id: "daily", version: "v1", label: "Daily",
			scheduleRef: ref("schedule", "daily"), councilRefs: [{ kind: "council", id: "loop", version: "v1" }],
		}] };
		defs.councils = { state: "known", values: [{
			schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "council", id: "loop", version: "v1", label: "Loop",
			memberRefs: [ref("microEmployee", "assistant")],
		}] };
		expect(projectWorkforceStandup(defs).diagnostics.filter((d) => d.code === "causalCycle")).toEqual([]);
	});

	it("fail-closes a reachable definition cycle with a missing edge independent of input order", () => {
		const input = baseInput() as any;
		input.microEmployees = { state: "known", values: [
			{
				schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "microEmployee", id: "assistant", version: "v1",
				label: "Assistant", role: "assistant", jobRefs: [ref("job", "enrich"), ref("job", "missing")],
			},
			{
				schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "microEmployee", id: "helper", version: "v1",
				label: "Helper", role: "helper", jobRefs: [ref("job", "support")],
			},
		] };
		input.jobs = { state: "known", values: [
			{ schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "job", id: "enrich", version: "v1", label: "Enrich", workflowRef: ref("workflow", "daily") },
			{ schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "job", id: "support", version: "v1", label: "Support", workflowRef: ref("workflow", "daily") },
		] };
		input.workflows = { state: "known", values: [{
			schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "workflow", id: "daily", version: "v1", label: "Daily",
			scheduleRef: ref("schedule", "daily"), councilRefs: [ref("council", "loop")],
		}] };
		input.councils = { state: "known", values: [{
			schemaVersion: WORKFORCE_SCHEMA_VERSION, kind: "council", id: "loop", version: "v1", label: "Loop",
			memberRefs: [ref("microEmployee", "assistant"), ref("microEmployee", "helper")],
		}] };
		input.events = { state: "known", values: [
			{ ...(baseInput() as any).events.values[0]!, eventId: "assistant-event", run: { ...run, microEmployee: ref("microEmployee", "assistant"), job: ref("job", "enrich") } },
			{ ...(baseInput() as any).events.values[0]!, eventId: "helper-event", run: { ...run, microEmployee: ref("microEmployee", "helper"), job: ref("job", "support") } },
		] };

		const permuted = {
			...input,
			microEmployees: { ...input.microEmployees, values: [...input.microEmployees.values].reverse() },
			jobs: { ...input.jobs, values: [...input.jobs.values].reverse() },
			events: { ...input.events, values: [...input.events.values].reverse() },
		};
		const first = projectWorkforceStandup(input);
		const second = projectWorkforceStandup(permuted);
		expect(second).toEqual(first);
		expect(second.digest).toBe(first.digest);
		expect(first.events).toEqual([]);
		expect(first.resolvedDefinitions.map((definition) => `${definition.kind}:${definition.id}`)).toEqual(["schedule:daily"]);
		expect(first.diagnostics).toContainEqual({ code: "definitionMissing", ref: ref("job", "missing") });
	});

	it("computes the digest over the digest-free canonical projection preimage", () => {
		const projection = projectWorkforceStandup(baseInput());
		const preimage = {
			canonicalVersion: "athenaeum.workforce-canonical-json.v1",
			version: "athenaeum.workforce-standup-projection.v1",
			civilScope: projection.civilScope,
			resolvedDefinitions: projection.resolvedDefinitions,
			events: projection.events,
			runFacts: projection.runFacts,
			diagnostics: projection.diagnostics,
		};
		expect(projection.digest).toBe(digestWorkforcePreimageV1(canonicalWorkforcePreimageV1(preimage as never)));
	});
});
