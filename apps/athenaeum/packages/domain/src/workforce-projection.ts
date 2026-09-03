import {
	WORKFORCE_EVENT_CANONICAL_VERSION,
	WORKFORCE_STANDUP_PROJECTION_VERSION,
	canonicalWorkforcePreimageV1,
	canonicalWorkforceValueV1,
	compareCanonicalWorkforcePreimagesV1,
	digestWorkforcePreimageV1,
	type Availability,
	type DefinitionKind,
	type DefinitionRef,
	type WorkforceDefinition,
	type WorkforceEvent,
	type WorkforceInputName,
	type WorkforceRunFact,
	type WorkforceStandupInput,
	type Utf8Digest,
} from "./workforce.js";

export type WorkforceProjectionDiagnostic =
	| { readonly code: "inputUnavailable"; readonly input: WorkforceInputName; readonly reason: "notLoaded" | "sourceUnavailable" }
	| { readonly code: "definitionUnavailable"; readonly ref: DefinitionRef; readonly input: WorkforceInputName; readonly reason: "notLoaded" | "sourceUnavailable" }
	| { readonly code: "definitionMissing"; readonly ref: DefinitionRef }
	| { readonly code: "definitionVersionMismatch"; readonly ref: DefinitionRef; readonly availableVersions: readonly string[] }
	| { readonly code: "definitionConflict"; readonly ref: DefinitionRef }
	| { readonly code: "eventConflict"; readonly eventId: string }
	| { readonly code: "runFactConflict"; readonly factId: string }
	| {
			readonly code: "causeUnavailable" | "causeMissing" | "causeAmbiguous" | "causeCrossScope";
			readonly dependentKind: WorkforceEvent["kind"] | WorkforceRunFact["kind"];
			readonly dependentId: string;
			readonly causedByEventId: string;
		}
	| { readonly code: "causalCycle"; readonly eventIds: readonly string[] };

export type WorkforceStandupProjection = {
	readonly version: typeof WORKFORCE_STANDUP_PROJECTION_VERSION;
	readonly civilScope: WorkforceStandupInput["civilScope"];
	readonly resolvedDefinitions: readonly WorkforceDefinition[];
	readonly events: readonly WorkforceEvent[];
	readonly runFacts: readonly WorkforceRunFact[];
	readonly diagnostics: readonly WorkforceProjectionDiagnostic[];
	readonly digest: Utf8Digest;
};

type DefinitionInput = Exclude<WorkforceInputName, "events" | "runFacts">;
type AnyData = Record<string, unknown> | readonly unknown[];

const definitionInputs: readonly DefinitionInput[] = [
	"microEmployees",
	"jobs",
	"workflows",
	"schedules",
	"councils",
];

const inputForKind: Record<DefinitionKind, DefinitionInput> = {
	microEmployee: "microEmployees",
	job: "jobs",
	workflow: "workflows",
	schedule: "schedules",
	council: "councils",
};

const compareBytes = compareCanonicalWorkforcePreimagesV1;
const bytes = (value: unknown) =>
	canonicalWorkforcePreimageV1(value as never);
const canonical = (value: unknown) => canonicalWorkforceValueV1(value as never);
const keyOf = (value: unknown) => canonical(value);

const compareStrings = (a: string, b: string) =>
	compareBytes(bytes(a), bytes(b));
const sortByCanonical = <T>(values: readonly T[], value: (x: T) => unknown) =>
	[...values].sort((a, b) => compareBytes(bytes(value(a)), bytes(value(b))));

const deepCopy = <T>(value: T): T =>
	JSON.parse(canonical(value)) as T;

const occurrenceKey = (value: WorkforceStandupInput["civilScope"]) => keyOf(value);
const sameOccurrence = (
	a: WorkforceStandupInput["civilScope"],
	b: WorkforceStandupInput["civilScope"],
) => occurrenceKey(a) === occurrenceKey(b);

const refKey = (ref: Pick<DefinitionRef, "kind" | "id" | "version">) =>
	keyOf({ kind: ref.kind, id: ref.id, version: ref.version });

type Group<T> = {
	readonly values: readonly T[];
	readonly conflict: boolean;
};

type DefinitionGroups = Record<DefinitionKind, Map<string, Group<WorkforceDefinition>>>;

const makeDefinitionGroups = (input: WorkforceStandupInput): DefinitionGroups => {
	const groups = {} as DefinitionGroups;
	for (const kind of ["microEmployee", "job", "workflow", "schedule", "council"] as const) {
		const source = input[inputForKind[kind]];
		const byIdentity = new Map<string, { values: WorkforceDefinition[]; bodies: Set<string> }>();
		if (source.state === "known") {
			for (const definition of source.values) {
				const identity = refKey(definition);
				const group = byIdentity.get(identity) ?? { values: [], bodies: new Set<string>() };
				const body = canonical(definition);
				if (!group.bodies.has(body)) group.values.push(definition);
				group.bodies.add(body);
				byIdentity.set(identity, group);
			}
		}
		groups[kind] = new Map(
			[...byIdentity.entries()].map(([identity, group]) => [identity, {
				values: group.values,
				conflict: group.bodies.size > 1,
			}]),
		);
	}
	return groups;
};

type RecordGroup<T> = { readonly values: readonly T[]; readonly conflict: boolean };

const makeRecordGroups = <T extends { readonly [key: string]: unknown }>(
	values: readonly T[],
	idField: string,
) => {
	const result = new Map<string, RecordGroup<T>>();
	for (const value of values) {
		const id = String(value[idField]);
		const group = result.get(id);
		if (!group) {
			result.set(id, { values: [value], conflict: false });
			continue;
		}
		if (group.values.some((existing) => canonical(existing) === canonical(value))) continue;
		result.set(id, { values: [...group.values, value], conflict: true });
	}
	return result;
};

const occurrenceOf = (record: WorkforceEvent | WorkforceRunFact) => record.occurrence;
const eventCause = (event: WorkforceEvent): string | null =>
	event.kind === "resultObserved" || event.kind === "claimObserved"
		? event.causedByEventId
		: null;

const refsOfEvent = (event: WorkforceEvent): readonly DefinitionRef[] => {
	const refs: DefinitionRef[] = [];
	if (event.kind !== "diagnosticObserved") {
		refs.push(event.run.microEmployee, event.run.job, event.run.workflow, event.occurrence.schedule);
		if (event.kind === "claimObserved") {
			refs.push(event.claim.owner, event.claim.job, event.claim.workflow);
			refs.push(event.claim.run.microEmployee, event.claim.run.job, event.claim.run.workflow);
		}
	} else if (event.occurrence) {
		refs.push(event.occurrence.schedule);
	}
	return refs;
};

const refsOfFact = (fact: WorkforceRunFact): readonly DefinitionRef[] => [
	fact.run.microEmployee,
	fact.run.job,
	fact.run.workflow,
	fact.occurrence.schedule,
];

const refsOfDefinition = (definition: WorkforceDefinition): readonly DefinitionRef[] => {
	switch (definition.kind) {
		case "microEmployee": return definition.jobRefs;
		case "job": return [definition.workflowRef];
		case "workflow": return [
			...(definition.scheduleRef ? [definition.scheduleRef] : []),
			...definition.councilRefs,
		];
		case "schedule": return [];
		case "council": return definition.memberRefs;
	}
};

export const projectWorkforceStandup = (
	input: WorkforceStandupInput,
): WorkforceStandupProjection => {
	const groups = makeDefinitionGroups(input);
	const diagnostics: WorkforceProjectionDiagnostic[] = [];
	const diagnosticKeys = new Set<string>();
	const addDiagnostic = (diagnostic: WorkforceProjectionDiagnostic) => {
		const key = canonical(diagnostic);
		if (!diagnosticKeys.has(key)) {
			diagnosticKeys.add(key);
			diagnostics.push(diagnostic);
		}
	};

	for (const name of [
		...definitionInputs,
		"events",
		"runFacts",
	] as const) {
		const source = input[name];
		if (source.state === "unavailable")
			addDiagnostic({ code: "inputUnavailable", input: name, reason: source.reason });
	}

	type DefinitionNode = {
		readonly ref: DefinitionRef;
		readonly definition: WorkforceDefinition | null;
		readonly children: readonly DefinitionRef[];
		readonly intrinsicallyValid: boolean;
	};

	/*
	 * Definition resolution is a graph problem, rather than a recursive tree walk.
	 * In particular, a back-edge is not evidence that a definition is valid: a
	 * cycle is valid only when every node in it (and every node it reaches) is
	 * valid.  Keep the reachable graph and compute its invalid set to a fixed
	 * point so the result cannot depend on which event happened to be visited
	 * first.
	 */
	const definitionNodes = new Map<string, DefinitionNode>();
	const invalidDefinitionIds = new Set<string>();
	const resolved = new Map<string, WorkforceDefinition>();
	const ensureDefinitionGraph = (root: DefinitionRef) => {
		const pending: DefinitionRef[] = [root];
		const queued = new Set<string>([refKey(root)]);
		while (pending.length > 0) {
			const ref = pending.pop()!;
			const identity = refKey(ref);
			if (definitionNodes.has(identity)) continue;
			const inputName = inputForKind[ref.kind];
			const source = input[inputName];
			if (source.state === "unavailable") {
				addDiagnostic({ code: "definitionUnavailable", ref, input: inputName, reason: source.reason });
				definitionNodes.set(identity, { ref, definition: null, children: [], intrinsicallyValid: false });
				continue;
			}
			const group = groups[ref.kind].get(identity);
			if (!group) {
				const versions = new Set<string>();
				for (const candidate of source.values) {
					if (candidate.kind === ref.kind && candidate.id === ref.id) versions.add(candidate.version);
				}
				if (versions.size > 0) {
					addDiagnostic({
						code: "definitionVersionMismatch",
						ref,
						availableVersions: sortByCanonical([...versions], (version) => version),
					});
				} else addDiagnostic({ code: "definitionMissing", ref });
				definitionNodes.set(identity, { ref, definition: null, children: [], intrinsicallyValid: false });
				continue;
			}
			if (group.conflict) {
				addDiagnostic({ code: "definitionConflict", ref });
				definitionNodes.set(identity, { ref, definition: null, children: [], intrinsicallyValid: false });
				continue;
			}
			const definition = group.values[0]!;
			const children = sortByCanonical(refsOfDefinition(definition), (child) => child);
			definitionNodes.set(identity, { ref, definition, children, intrinsicallyValid: true });
			for (const child of children) {
				const childIdentity = refKey(child);
				if (!queued.has(childIdentity)) {
					queued.add(childIdentity);
					pending.push(child);
				}
			}
		}
	};

	const recomputeDefinitionClosure = () => {
		invalidDefinitionIds.clear();
		for (const [identity, node] of definitionNodes) {
			if (!node.intrinsicallyValid) invalidDefinitionIds.add(identity);
		}
		let changed = true;
		while (changed) {
			changed = false;
			for (const [identity, node] of definitionNodes) {
				if (invalidDefinitionIds.has(identity)) continue;
				if (node.children.some((child) => invalidDefinitionIds.has(refKey(child)))) {
					invalidDefinitionIds.add(identity);
					changed = true;
				}
			}
		}
		resolved.clear();
		for (const [identity, node] of definitionNodes) {
			if (!invalidDefinitionIds.has(identity) && node.definition !== null) {
				resolved.set(identity, node.definition);
			}
		}
	};

	const resolveDefinition = (ref: DefinitionRef): boolean => {
		ensureDefinitionGraph(ref);
		recomputeDefinitionClosure();
		return !invalidDefinitionIds.has(refKey(ref));
	};

	// The civil scope schedule is itself a reachable definition root.
	resolveDefinition(input.civilScope.schedule);

	const eventsSource = input.events;
	const factsSource = input.runFacts;
	const eventGroups = eventsSource.state === "known"
		? makeRecordGroups(eventsSource.values as readonly (WorkforceEvent & { readonly [key: string]: unknown })[], "eventId")
		: new Map<string, RecordGroup<WorkforceEvent>>();
	const factGroups = factsSource.state === "known"
		? makeRecordGroups(factsSource.values as readonly (WorkforceRunFact & { readonly [key: string]: unknown })[], "factId")
		: new Map<string, RecordGroup<WorkforceRunFact>>();

	const inScope = (record: WorkforceEvent | WorkforceRunFact) => {
		const occurrence = occurrenceOf(record);
		return occurrence !== null && sameOccurrence(occurrence, input.civilScope);
	};
const eventGroupInScope = (group: RecordGroup<WorkforceEvent>) =>
		group.values.some((event) =>
			event.kind === "diagnosticObserved" && event.occurrence === null
				? false
				: inScope(event));

	const selectedEvents = new Map<string, WorkforceEvent>();
	if (eventsSource.state === "known") {
		for (const [eventId, group] of eventGroups) {
			if (group.conflict) {
				if (eventGroupInScope(group)) addDiagnostic({ code: "eventConflict", eventId });
				continue;
			}
			const event = group.values[0]!;
			if (event.kind === "diagnosticObserved" && event.occurrence === null) continue;
			if (inScope(event)) selectedEvents.set(eventId, event);
		}
	}

	if (factsSource.state === "known") {
		for (const [factId, group] of factGroups) {
			if (group.conflict) {
				if (group.values.some(inScope)) addDiagnostic({ code: "runFactConflict", factId });
			}
		}
	}

	type EventState = "visiting" | "valid" | "invalid" | "cycle";
	const eventStates = new Map<string, EventState>();
	const stack: string[] = [];
	const cycleKeys = new Set<string>();
	const causeDiagnostic = (
		code: "causeUnavailable" | "causeMissing" | "causeAmbiguous" | "causeCrossScope",
		dependent: WorkforceEvent | WorkforceRunFact,
		causedByEventId: string,
	) => addDiagnostic({
		code,
		dependentKind: dependent.kind,
		dependentId: dependent.kind === "runFactObserved" ? dependent.factId : dependent.eventId,
		causedByEventId,
	});
	const allDefinitionsValid = (refs: readonly DefinitionRef[]) => {
		let valid = true;
		for (const ref of refs) {
			if (!resolveDefinition(ref)) valid = false;
		}
		return valid;
	};

	const visitEvent = (eventId: string): EventState => {
		const previous = eventStates.get(eventId);
		if (previous === "valid" || previous === "invalid" || previous === "cycle") return previous;
		if (previous === "visiting") {
			const start = stack.indexOf(eventId);
			const cycleIds = stack.slice(start);
			const sorted = sortByCanonical([...new Set(cycleIds)], (id) => id);
			const cycleKey = canonical(sorted);
			if (!cycleKeys.has(cycleKey)) {
				cycleKeys.add(cycleKey);
				addDiagnostic({ code: "causalCycle", eventIds: sorted });
			}
			for (const id of cycleIds) eventStates.set(id, "cycle");
			return "cycle";
		}
		const event = selectedEvents.get(eventId);
		if (!event) return "invalid";
		eventStates.set(eventId, "visiting");
		stack.push(eventId);
		let state: EventState = "valid";
		const cause = eventCause(event);
		if (cause !== null) {
			if (eventsSource.state === "unavailable") {
				causeDiagnostic("causeUnavailable", event, cause);
				state = "invalid";
			} else {
				const target = eventGroups.get(cause);
				if (!target) {
					causeDiagnostic("causeMissing", event, cause);
					state = "invalid";
				} else if (target.conflict) {
					addDiagnostic({ code: "eventConflict", eventId: cause });
					causeDiagnostic("causeAmbiguous", event, cause);
					state = "invalid";
				} else {
					const causeEvent = target.values[0]!;
					if (causeEvent.kind === "diagnosticObserved" && causeEvent.occurrence === null || !inScope(causeEvent)) {
						causeDiagnostic("causeCrossScope", event, cause);
						state = "invalid";
					} else {
						const targetState = visitEvent(cause);
						if (targetState === "cycle") state = "cycle";
						else if (targetState !== "valid") state = "invalid";
					}
				}
			}
		}
		if (state === "valid" && !allDefinitionsValid(refsOfEvent(event))) state = "invalid";
		stack.pop();
		if (eventStates.get(eventId) !== "cycle") eventStates.set(eventId, state);
		return eventStates.get(eventId)!;
	};

	const outputEvents: WorkforceEvent[] = [];
	for (const event of selectedEvents.values()) {
		if (visitEvent(event.eventId) === "valid") outputEvents.push(event);
	}

	const outputFacts: WorkforceRunFact[] = [];
	if (factsSource.state === "known") {
		for (const [factId, group] of factGroups) {
			if (group.conflict) continue;
			const fact = group.values[0]!;
			if (!inScope(fact)) continue;
			if (eventsSource.state === "unavailable") {
				causeDiagnostic("causeUnavailable", fact, fact.causedByEventId);
				continue;
			}
			const target = eventGroups.get(fact.causedByEventId);
			if (!target) {
				causeDiagnostic("causeMissing", fact, fact.causedByEventId);
				continue;
			}
			if (target.conflict) {
				addDiagnostic({ code: "eventConflict", eventId: fact.causedByEventId });
				causeDiagnostic("causeAmbiguous", fact, fact.causedByEventId);
				continue;
			}
			const causeEvent = target.values[0]!;
			if (causeEvent.kind === "diagnosticObserved" && causeEvent.occurrence === null || !inScope(causeEvent)) {
				causeDiagnostic("causeCrossScope", fact, fact.causedByEventId);
				continue;
			}
			if (visitEvent(fact.causedByEventId) !== "valid") continue;
			if (allDefinitionsValid(refsOfFact(fact))) outputFacts.push(fact);
		}
	}

	const resolvedDefinitions = sortByCanonical([...resolved.values()], (definition) => definition);
	const events = [...outputEvents].sort((a, b) =>
		a.sequence - b.sequence || compareStrings(a.eventId, b.eventId) || compareBytes(bytes(a), bytes(b)));
	const runFacts = [...outputFacts].sort((a, b) =>
		a.sequence - b.sequence || compareStrings(a.factId, b.factId) || compareBytes(bytes(a), bytes(b)));
	const sortedDiagnostics = sortByCanonical(diagnostics, (diagnostic) => diagnostic);
	const civilScope = deepCopy(input.civilScope);
	const preimage = {
		canonicalVersion: WORKFORCE_EVENT_CANONICAL_VERSION,
		version: WORKFORCE_STANDUP_PROJECTION_VERSION,
		civilScope,
		resolvedDefinitions,
		events,
		runFacts,
		diagnostics: sortedDiagnostics,
	} as const;
	const projection = {
		version: WORKFORCE_STANDUP_PROJECTION_VERSION,
		civilScope,
		resolvedDefinitions,
		events,
		runFacts,
		diagnostics: sortedDiagnostics,
		digest: digestWorkforcePreimageV1(canonicalWorkforcePreimageV1(preimage as never)),
	};
	return deepCopy(projection);
};
