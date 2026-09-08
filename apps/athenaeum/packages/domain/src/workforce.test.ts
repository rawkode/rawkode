import { describe, expect, it } from "vitest";
import {
	canonicalWorkforcePreimageV1,
	canonicalWorkforceValueV1,
	decodeWorkforceStandupInput,
	digestWorkforcePreimageV1,
	type WorkforceDecodeError,
} from "./workforce.js";

const ref = (kind: string, id: string, version = "v1") => ({
	kind,
	id,
	version,
});
const occurrence = {
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

const validInput = () => ({
	microEmployees: {
		state: "known",
		values: [
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "microEmployee",
				id: "assistant",
				version: "v1",
				label: "Executive assistant",
				role: "assistant",
				jobRefs: [ref("job", "enrich")],
			},
		],
	},
	jobs: {
		state: "known",
		values: [
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "job",
				id: "enrich",
				version: "v1",
				label: "Enrich people",
				workflowRef: ref("workflow", "daily"),
			},
		],
	},
	workflows: {
		state: "known",
		values: [
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "workflow",
				id: "daily",
				version: "v1",
				label: "Daily enrichment",
				scheduleRef: ref("schedule", "daily"),
				councilRefs: [ref("council", "review")],
			},
		],
	},
	schedules: {
		state: "known",
		values: [
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "schedule",
				id: "daily",
				version: "v1",
				label: "Daily",
				civilTimeZone: "not-runtime-validated",
				occurrenceIds: ["morning"],
			},
		],
	},
	councils: {
		state: "known",
		values: [
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "council",
				id: "review",
				version: "v1",
				label: "Review council",
				memberRefs: [ref("microEmployee", "assistant")],
			},
		],
	},
	events: {
		state: "known",
		values: [
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "runObserved",
				eventId: "event-1",
				sequence: 0,
				run,
				occurrence,
			},
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "resultObserved",
				eventId: "event-2",
				sequence: 1,
				run,
				occurrence,
				result: { kind: "completed", summary: "Profile enriched" },
				causedByEventId: null,
			},
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "claimObserved",
				eventId: "event-3",
				sequence: 2,
				run,
				occurrence,
				claim: {
					kind: "commitment",
					subject: "Publish the daily brief",
					owner: ref("microEmployee", "assistant"),
					job: ref("job", "enrich"),
					workflow: ref("workflow", "daily"),
					run,
				},
				causedByEventId: "event-2",
			},
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "diagnosticObserved",
				eventId: "event-4",
				sequence: 3,
				diagnostic: {
					code: "externalObservation",
					summary: "Calendar source was reachable",
				},
				occurrence: null,
			},
		],
	},
	runFacts: {
		state: "known",
		values: [
			{
				schemaVersion: "athenaeum.workforce.v1",
				kind: "runFactObserved",
				factId: "fact-1",
				sequence: 4,
				run,
				occurrence,
				causedByEventId: "event-2",
				observation: {
					kind: "result",
					result: { kind: "completed", summary: "Profile enriched" },
				},
			},
		],
	},
	civilScope: occurrence,
});

const errorCode = (value: unknown) => {
	const result = decodeWorkforceStandupInput(value);
	expect(result._tag).toBe("Left");
	return (result as { _tag: "Left"; left: WorkforceDecodeError }).left.code;
};

describe("workforce domain vocabulary", () => {
	it("canonicalizes recursively by UTF-16 key order and hashes UTF-8 bytes", () => {
		const value = { z: [3, { b: "two", a: "one" }], a: true };
		expect(canonicalWorkforceValueV1(value)).toBe(
			'{"a":true,"z":[3,{"a":"one","b":"two"}]}',
		);
		expect(
			canonicalWorkforceValueV1(
				Object.assign(Object.create(null), { b: 2, a: 1 }),
			),
		).toBe('{"a":1,"b":2}');
		expect(canonicalWorkforceValueV1({ lone: "\ud800" })).toBe(
			'{"lone":"\\ud800"}',
		);
		const preimage = canonicalWorkforcePreimageV1("abc");
		expect(Array.from(preimage)).toEqual([34, 97, 98, 99, 34]);
		expect(digestWorkforcePreimageV1(new Uint8Array([97, 98, 99]))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		const cyclic = {} as { self?: unknown };
		cyclic.self = cyclic;
		expect(() => canonicalWorkforceValueV1(cyclic as never)).toThrow(
			"cyclic canonical value",
		);
		const sparse = [1] as unknown as { [key: string]: unknown; length: number };
		sparse.length = 2;
		sparse.extra = 2;
		expect(() => canonicalWorkforceValueV1(sparse as never)).toThrow(
			"dense data array required",
		);
		class ArraySubclass extends Array<number> {}
		expect(() =>
			canonicalWorkforceValueV1(new ArraySubclass(1) as never),
		).toThrow("dense data array required");
	});

	it("decodes all inert definition, event, and run-fact variants", () => {
		const result = decodeWorkforceStandupInput(validInput());
		expect(result._tag).toBe("Right");
		if (result._tag === "Right") {
			expect(result.right.microEmployees.state).toBe("known");
			expect(
				result.right.events.state === "known" && result.right.events.values,
			).toHaveLength(4);
			expect(
				result.right.runFacts.state === "known" && result.right.runFacts.values,
			).toHaveLength(1);
		}
	});

	it("preserves unavailable source states without inventing empty data", () => {
		const value = {
			...validInput(),
			events: { state: "unavailable", reason: "sourceUnavailable" },
			runFacts: { state: "unavailable", reason: "notLoaded" },
		};
		const result = decodeWorkforceStandupInput(value);
		expect(result._tag).toBe("Right");
		if (result._tag === "Right") {
			expect(result.right.events).toEqual({
				state: "unavailable",
				reason: "sourceUnavailable",
			});
			expect(result.right.runFacts).toEqual({
				state: "unavailable",
				reason: "notLoaded",
			});
		}
	});

	it("rejects unknown, forbidden, version, date, and non-data object shapes", () => {
		expect(errorCode({ ...validInput(), extra: true })).toBe("unknownField");
		expect(
			errorCode({
				...validInput(),
				microEmployees: {
					state: "known",
					values: [validInput().jobs.values[0]],
				},
			}),
		).toBe("invalidScalar");
		expect(
			errorCode({
				...validInput(),
				events: {
					state: "known",
					values: [{ ...validInput().events.values[0], execute: true }],
				},
			}),
		).toBe("forbiddenField");
		expect(
			errorCode({
				...validInput(),
				civilScope: { ...occurrence, civilDate: "2026-02-30" },
			}),
		).toBe("invalidScalar");
		expect(
			errorCode({
				...validInput(),
				microEmployees: {
					state: "known",
					values: [
						{
							...validInput().microEmployees.values[0],
							schemaVersion: "wrong",
						},
					],
				},
			}),
		).toBe("invalidVersion");
		const symbolValue = validInput();
		Object.defineProperty(symbolValue, Symbol("hidden"), { value: true });
		expect(errorCode(symbolValue)).toBe("invalidShape");
		const accessorValue = validInput();
		Object.defineProperty(accessorValue, "hidden", {
			get: () => true,
			enumerable: true,
		});
		expect(errorCode(accessorValue)).toBe("invalidShape");
		const cyclicValue = validInput() as unknown as { self?: unknown };
		cyclicValue.self = cyclicValue;
		expect(errorCode(cyclicValue)).toBe("invalidShape");
	});
});
