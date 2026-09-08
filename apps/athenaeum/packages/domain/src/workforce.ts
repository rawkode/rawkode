/** Inert, strictly decoded workforce vocabulary.  Projection and authority live elsewhere. */
export const WORKFORCE_SCHEMA_VERSION = "athenaeum.workforce.v1" as const;
export const WORKFORCE_EVENT_CANONICAL_VERSION =
	"athenaeum.workforce-canonical-json.v1" as const;
export const WORKFORCE_STANDUP_PROJECTION_VERSION =
	"athenaeum.workforce-standup-projection.v1" as const;

declare const brand: unique symbol;
type Brand<T, N extends string> = T & { readonly [brand]: N };
export type NonEmptyString = Brand<string, "NonEmptyString">;
export type Version = Brand<string, "Version">;
export type MicroEmployeeId = Brand<string, "MicroEmployeeId">;
export type JobId = Brand<string, "JobId">;
export type WorkflowId = Brand<string, "WorkflowId">;
export type ScheduleId = Brand<string, "ScheduleId">;
export type CouncilId = Brand<string, "CouncilId">;
export type OccurrenceId = Brand<string, "OccurrenceId">;
export type RunId = Brand<string, "RunId">;
export type EventId = Brand<string, "EventId">;
export type FactId = Brand<string, "FactId">;
export type LocalDate = Brand<string, "LocalDate">;
export type CivilTimeZone = Brand<string, "CivilTimeZone">;
export type Sequence = Brand<number, "Sequence">;
export type Utf8Digest = Brand<string, "Utf8Digest">;
/** @deprecated Use Utf8Digest. */
export type WorkforceDigest = Utf8Digest;
export type DefinitionKind =
	"microEmployee" | "job" | "workflow" | "schedule" | "council";
export type DefinitionIdByKind = {
	microEmployee: MicroEmployeeId;
	job: JobId;
	workflow: WorkflowId;
	schedule: ScheduleId;
	council: CouncilId;
};
export type DefinitionRef<K extends DefinitionKind = DefinitionKind> = {
	readonly kind: K;
	readonly id: DefinitionIdByKind[K];
	readonly version: Version;
};
type Base<K extends DefinitionKind> = {
	readonly schemaVersion: typeof WORKFORCE_SCHEMA_VERSION;
	readonly kind: K;
	readonly id: DefinitionIdByKind[K];
	readonly version: Version;
	readonly label: NonEmptyString;
};
export type MicroEmployeeDefinition = Base<"microEmployee"> & {
	readonly role: NonEmptyString;
	readonly jobRefs: readonly DefinitionRef<"job">[];
};
export type JobDefinition = Base<"job"> & {
	readonly workflowRef: DefinitionRef<"workflow">;
};
export type WorkflowDefinition = Base<"workflow"> & {
	readonly scheduleRef: DefinitionRef<"schedule"> | null;
	readonly councilRefs: readonly DefinitionRef<"council">[];
};
export type ScheduleDefinition = Base<"schedule"> & {
	readonly civilTimeZone: CivilTimeZone;
	readonly occurrenceIds: readonly OccurrenceId[];
};
export type CouncilDefinition = Base<"council"> & {
	readonly memberRefs: readonly DefinitionRef<"microEmployee">[];
};
export type WorkforceDefinition =
	| MicroEmployeeDefinition
	| JobDefinition
	| WorkflowDefinition
	| ScheduleDefinition
	| CouncilDefinition;
export type ScheduleOccurrenceRef = {
	readonly schedule: DefinitionRef<"schedule">;
	readonly occurrenceId: OccurrenceId;
	readonly civilDate: LocalDate;
};
export type RunRef = {
	readonly microEmployee: DefinitionRef<"microEmployee">;
	readonly job: DefinitionRef<"job">;
	readonly workflow: DefinitionRef<"workflow">;
	readonly runId: RunId;
};
export type WorkforceResult = {
	readonly kind: "completed" | "blocked" | "failed" | "skipped";
	readonly summary: NonEmptyString;
};
export type WorkforceClaim = {
	readonly kind: "decision" | "handoff" | "commitment";
	readonly subject: NonEmptyString;
	readonly owner: DefinitionRef<"microEmployee">;
	readonly job: DefinitionRef<"job">;
	readonly workflow: DefinitionRef<"workflow">;
	readonly run: RunRef;
};
export type ExternalDiagnostic = {
	readonly code: "externalObservation";
	readonly summary: NonEmptyString;
};
type EventBase<K extends string> = {
	readonly schemaVersion: typeof WORKFORCE_SCHEMA_VERSION;
	readonly kind: K;
	readonly eventId: EventId;
	readonly sequence: Sequence;
};
export type RunObservedEvent = EventBase<"runObserved"> & {
	readonly run: RunRef;
	readonly occurrence: ScheduleOccurrenceRef;
};
export type ResultObservedEvent = EventBase<"resultObserved"> & {
	readonly run: RunRef;
	readonly occurrence: ScheduleOccurrenceRef;
	readonly result: WorkforceResult;
	readonly causedByEventId: EventId | null;
};
export type ClaimObservedEvent = EventBase<"claimObserved"> & {
	readonly run: RunRef;
	readonly occurrence: ScheduleOccurrenceRef;
	readonly claim: WorkforceClaim;
	readonly causedByEventId: EventId | null;
};
export type DiagnosticObservedEvent = EventBase<"diagnosticObserved"> & {
	readonly diagnostic: ExternalDiagnostic;
	readonly occurrence: ScheduleOccurrenceRef | null;
};
export type WorkforceEvent =
	| RunObservedEvent
	| ResultObservedEvent
	| ClaimObservedEvent
	| DiagnosticObservedEvent;
export type WorkforceRunFact = {
	readonly schemaVersion: typeof WORKFORCE_SCHEMA_VERSION;
	readonly kind: "runFactObserved";
	readonly factId: FactId;
	readonly sequence: Sequence;
	readonly run: RunRef;
	readonly occurrence: ScheduleOccurrenceRef;
	readonly causedByEventId: EventId;
	readonly observation: {
		readonly kind: "result";
		readonly result: WorkforceResult;
	};
};
export type Availability<T> =
	| { readonly state: "known"; readonly values: readonly T[] }
	| {
			readonly state: "unavailable";
			readonly reason: "notLoaded" | "sourceUnavailable";
	  };
export type WorkforceInputName =
	| "microEmployees"
	| "jobs"
	| "workflows"
	| "schedules"
	| "councils"
	| "events"
	| "runFacts";
export type InputName = WorkforceInputName;
export type WorkforceStandupInput = {
	readonly microEmployees: Availability<MicroEmployeeDefinition>;
	readonly jobs: Availability<JobDefinition>;
	readonly workflows: Availability<WorkflowDefinition>;
	readonly schedules: Availability<ScheduleDefinition>;
	readonly councils: Availability<CouncilDefinition>;
	readonly events: Availability<WorkforceEvent>;
	readonly runFacts: Availability<WorkforceRunFact>;
	readonly civilScope: ScheduleOccurrenceRef;
};
export type WorkforceDecodeError = {
	readonly tag: "WorkforceDecodeError";
	readonly path: readonly string[];
	readonly code:
		| "invalidShape"
		| "unknownField"
		| "invalidScalar"
		| "invalidVersion"
		| "forbiddenField";
	readonly message: string;
};
export type Either<L, R> =
	| { readonly _tag: "Left"; readonly left: L }
	| { readonly _tag: "Right"; readonly right: R };
export type CanonicalWorkforceValue =
	| null
	| boolean
	| string
	| number
	| readonly CanonicalWorkforceValue[]
	| { readonly [key: string]: CanonicalWorkforceValue };

type Obj = Record<string, unknown>;
const forbidden = new Set([
	"approve",
	"approval",
	"accept",
	"revert",
	"execute",
	"execution",
	"retry",
	"schedulenow",
	"scheduleNow",
	"command",
	"mutation",
	"permission",
	"token",
	"endpoint",
	"callback",
	"credential",
	"tool",
	"client",
]);
const pathParts = (path: string): readonly string[] =>
	path === "$"
		? []
		: path
				.replace(/^\$\.?/, "")
				.replace(/\[(\d+)\]/g, ".$1")
				.split(".")
				.filter(Boolean);
const bad = (
	path: string,
	code: WorkforceDecodeError["code"],
	message: string,
): Either<WorkforceDecodeError, never> => ({
	_tag: "Left",
	left: { tag: "WorkforceDecodeError", path: pathParts(path), code, message },
});
const good = <T>(right: T): Either<never, T> => ({ _tag: "Right", right });

const hasCycle = (root: unknown): boolean => {
	const visiting = new WeakSet<object>();
	const visited = new WeakSet<object>();
	const visit = (value: unknown): boolean => {
		if (value === null || typeof value !== "object") return false;
		if (visiting.has(value)) return true;
		if (visited.has(value)) return false;
		visiting.add(value);
		try {
			for (const key of Object.keys(value)) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (descriptor && "value" in descriptor && visit(descriptor.value))
					return true;
			}
			return false;
		} catch {
			return true;
		} finally {
			visiting.delete(value);
			visited.add(value);
		}
	};
	return visit(root);
};
const object = (
	value: unknown,
	path: string,
): Either<WorkforceDecodeError, Obj> => {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null) ||
		Object.getOwnPropertySymbols(value).length ||
		Object.getOwnPropertyNames(value).length !== Object.keys(value).length
	)
		return bad(path, "invalidShape", "plain enumerable object required");
	const result: Obj = {};
	for (const key of Object.keys(value)) {
		if (forbidden.has(key.toLowerCase()))
			return bad(`${path}.${key}`, "forbiddenField", `forbidden field: ${key}`);
		const d = Object.getOwnPropertyDescriptor(value, key);
		if (!d || !("value" in d))
			return bad(`${path}.${key}`, "invalidShape", "data field required");
		result[key] = d.value;
	}
	return good(result);
};
const fields = (
	value: unknown,
	path: string,
	expected: readonly string[],
): Either<WorkforceDecodeError, Obj> => {
	const o = object(value, path);
	if (o._tag === "Left") return o;
	const unknown = Object.keys(o.right).find((x) => !expected.includes(x));
	if (unknown)
		return bad(
			`${path}.${unknown}`,
			"unknownField",
			`unknown field: ${unknown}`,
		);
	const missing = expected.find((x) => !(x in o.right));
	return missing
		? bad(`${path}.${missing}`, "invalidShape", `missing field: ${missing}`)
		: o;
};
const string = (v: unknown, p: string): Either<WorkforceDecodeError, string> =>
	typeof v === "string" ? good(v) : bad(p, "invalidScalar", "string required");
const ne = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, NonEmptyString> => {
	const x = string(v, p);
	return x._tag === "Left"
		? x
		: x.right
			? good(x.right as NonEmptyString)
			: bad(p, "invalidScalar", "non-empty string required");
};
const version = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, Version> => {
	const x = ne(v, p);
	return x._tag === "Left"
		? bad(p, "invalidVersion", "non-empty version required")
		: good(x.right as unknown as Version);
};
const ident = <N extends string>(
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, Brand<string, N>> => {
	const x = ne(v, p);
	return x._tag === "Left" ? x : good(x.right as Brand<string, N>);
};
const one = <T extends string>(
	v: unknown,
	p: string,
	xs: readonly T[],
): Either<WorkforceDecodeError, T> =>
	typeof v === "string" && xs.includes(v as T)
		? good(v as T)
		: bad(p, "invalidScalar", `expected one of: ${xs.join(", ")}`);
const seq = (v: unknown, p: string): Either<WorkforceDecodeError, Sequence> =>
	typeof v === "number" &&
	Number.isSafeInteger(v) &&
	v >= 0 &&
	!Object.is(v, -0)
		? good(v as Sequence)
		: bad(p, "invalidScalar", "non-negative safe integer required");
const list = <T>(
	v: unknown,
	p: string,
	f: (v: unknown, p: string) => Either<WorkforceDecodeError, T>,
): Either<WorkforceDecodeError, readonly T[]> => {
	if (
		!Array.isArray(v) ||
		Object.getPrototypeOf(v) !== Array.prototype ||
		Object.keys(v).length !== v.length
	)
		return bad(p, "invalidShape", "dense array required");
	const names = Object.getOwnPropertyNames(v);
	if (
		Object.getOwnPropertySymbols(v).length > 0 ||
		names.length !== Object.keys(v).length + 1 ||
		!names.includes("length")
	)
		return bad(p, "invalidShape", "data array required");
	for (let i = 0; i < v.length; i++) {
		if (!Object.prototype.hasOwnProperty.call(v, String(i)))
			return bad(`${p}[${i}]`, "invalidShape", "dense array required");
	}
	for (const key of Object.keys(v)) {
		const descriptor = Object.getOwnPropertyDescriptor(v, key);
		if (!descriptor || !("value" in descriptor))
			return bad(`${p}[${key}]`, "invalidShape", "data field required");
	}
	const a: T[] = [];
	for (let i = 0; i < v.length; i++) {
		const x = f(v[i], `${p}[${i}]`);
		if (x._tag === "Left") return x;
		a.push(x.right);
	}
	return good(a);
};
const date = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, LocalDate> => {
	const x = string(v, p);
	if (x._tag === "Left") return x;
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x.right);
	if (!m) return bad(p, "invalidScalar", "Gregorian local date required");
	const y = +m[1],
		mo = +m[2],
		d = +m[3],
		leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0),
		days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return mo > 0 && mo < 13 && d > 0 && d <= days[mo - 1]!
		? good(x.right as LocalDate)
		: bad(p, "invalidScalar", "Gregorian local date required");
};
const zone = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, CivilTimeZone> => {
	const x = ne(v, p);
	return x._tag === "Left" ? x : good(x.right as unknown as CivilTimeZone);
};

const ref = <K extends DefinitionKind>(
	v: unknown,
	p: string,
	expected?: K,
): Either<WorkforceDecodeError, DefinitionRef<K>> => {
	const o = fields(v, p, ["kind", "id", "version"]);
	if (o._tag === "Left") return o;
	const options: readonly DefinitionKind[] = expected
		? [expected]
		: ["microEmployee", "job", "workflow", "schedule", "council"];
	const k = one<DefinitionKind>(o.right.kind, `${p}.kind`, options);
	const i = ident<string>(o.right.id, `${p}.id`),
		ver = version(o.right.version, `${p}.version`);
	if (k._tag === "Left") return k;
	if (i._tag === "Left") return i;
	return ver._tag === "Left"
		? ver
		: good({
				kind: k.right as K,
				id: i.right as DefinitionIdByKind[K],
				version: ver.right,
			});
};
const occurrence = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, ScheduleOccurrenceRef> => {
	const o = fields(v, p, ["schedule", "occurrenceId", "civilDate"]);
	if (o._tag === "Left") return o;
	const s = ref(o.right.schedule, `${p}.schedule`, "schedule"),
		i = ident<"OccurrenceId">(o.right.occurrenceId, `${p}.occurrenceId`),
		d = date(o.right.civilDate, `${p}.civilDate`);
	if (s._tag === "Left") return s;
	if (i._tag === "Left") return i;
	return d._tag === "Left"
		? d
		: good({
				schedule: s.right,
				occurrenceId: i.right as OccurrenceId,
				civilDate: d.right,
			});
};
const run = (v: unknown, p: string): Either<WorkforceDecodeError, RunRef> => {
	const o = fields(v, p, ["microEmployee", "job", "workflow", "runId"]);
	if (o._tag === "Left") return o;
	const m = ref(o.right.microEmployee, `${p}.microEmployee`, "microEmployee"),
		j = ref(o.right.job, `${p}.job`, "job"),
		w = ref(o.right.workflow, `${p}.workflow`, "workflow"),
		r = ident<"RunId">(o.right.runId, `${p}.runId`);
	if (m._tag === "Left") return m;
	if (j._tag === "Left") return j;
	if (w._tag === "Left") return w;
	return r._tag === "Left"
		? r
		: good({
				microEmployee: m.right,
				job: j.right,
				workflow: w.right,
				runId: r.right as RunId,
			});
};
const result = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, WorkforceResult> => {
	const o = fields(v, p, ["kind", "summary"]);
	if (o._tag === "Left") return o;
	const k = one(o.right.kind, `${p}.kind`, [
			"completed",
			"blocked",
			"failed",
			"skipped",
		] as const),
		s = ne(o.right.summary, `${p}.summary`);
	if (k._tag === "Left") return k;
	return s._tag === "Left" ? s : good({ kind: k.right, summary: s.right });
};
const claim = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, WorkforceClaim> => {
	const o = fields(v, p, [
		"kind",
		"subject",
		"owner",
		"job",
		"workflow",
		"run",
	]);
	if (o._tag === "Left") return o;
	const k = one(o.right.kind, `${p}.kind`, [
			"decision",
			"handoff",
			"commitment",
		] as const),
		s = ne(o.right.subject, `${p}.subject`),
		own = ref(o.right.owner, `${p}.owner`, "microEmployee"),
		j = ref(o.right.job, `${p}.job`, "job"),
		w = ref(o.right.workflow, `${p}.workflow`, "workflow"),
		r = run(o.right.run, `${p}.run`);
	if (k._tag === "Left") return k;
	if (s._tag === "Left") return s;
	if (own._tag === "Left") return own;
	if (j._tag === "Left") return j;
	if (w._tag === "Left") return w;
	return r._tag === "Left"
		? r
		: good({
				kind: k.right,
				subject: s.right,
				owner: own.right,
				job: j.right,
				workflow: w.right,
				run: r.right,
			});
};
const definition = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, WorkforceDefinition> => {
	const probe = object(v, p);
	if (probe._tag === "Left") return probe;
	const k = probe.right.kind;
	const base = (kind: DefinitionKind, extra: string[]) =>
		fields(v, p, ["schemaVersion", "kind", "id", "version", "label", ...extra]);
	if (k === "microEmployee") {
		const o = base(k, ["role", "jobRefs"]);
		if (o._tag === "Left") return o;
		const i = ident<"MicroEmployeeId">(o.right.id, `${p}.id`),
			ver = version(o.right.version, `${p}.version`),
			label = ne(o.right.label, `${p}.label`),
			role = ne(o.right.role, `${p}.role`),
			jobs = list(o.right.jobRefs, `${p}.jobRefs`, (x, q) => ref(x, q, "job"));
		if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
			return bad(
				`${p}.schemaVersion`,
				"invalidVersion",
				"unsupported workforce schema version",
			);
		if (i._tag === "Left") return i;
		if (ver._tag === "Left") return ver;
		if (label._tag === "Left") return label;
		if (role._tag === "Left") return role;
		return jobs._tag === "Left"
			? jobs
			: good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: "microEmployee",
					id: i.right as MicroEmployeeId,
					version: ver.right,
					label: label.right,
					role: role.right,
					jobRefs: jobs.right,
				});
	}
	if (k === "job") {
		const o = base(k, ["workflowRef"]);
		if (o._tag === "Left") return o;
		const i = ident<"JobId">(o.right.id, `${p}.id`),
			ver = version(o.right.version, `${p}.version`),
			label = ne(o.right.label, `${p}.label`),
			w = ref(o.right.workflowRef, `${p}.workflowRef`, "workflow");
		if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
			return bad(
				`${p}.schemaVersion`,
				"invalidVersion",
				"unsupported workforce schema version",
			);
		if (i._tag === "Left") return i;
		if (ver._tag === "Left") return ver;
		if (label._tag === "Left") return label;
		return w._tag === "Left"
			? w
			: good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: "job",
					id: i.right as JobId,
					version: ver.right,
					label: label.right,
					workflowRef: w.right,
				});
	}
	if (k === "workflow") {
		const o = base(k, ["scheduleRef", "councilRefs"]);
		if (o._tag === "Left") return o;
		const i = ident<"WorkflowId">(o.right.id, `${p}.id`),
			ver = version(o.right.version, `${p}.version`),
			label = ne(o.right.label, `${p}.label`),
			s =
				o.right.scheduleRef === null
					? good(null)
					: ref(o.right.scheduleRef, `${p}.scheduleRef`, "schedule"),
			cs = list(o.right.councilRefs, `${p}.councilRefs`, (x, q) =>
				ref(x, q, "council"),
			);
		if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
			return bad(
				`${p}.schemaVersion`,
				"invalidVersion",
				"unsupported workforce schema version",
			);
		if (i._tag === "Left") return i;
		if (ver._tag === "Left") return ver;
		if (label._tag === "Left") return label;
		if (s._tag === "Left") return s;
		return cs._tag === "Left"
			? cs
			: good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: "workflow",
					id: i.right as WorkflowId,
					version: ver.right,
					label: label.right,
					scheduleRef: s.right,
					councilRefs: cs.right,
				});
	}
	if (k === "schedule") {
		const o = base(k, ["civilTimeZone", "occurrenceIds"]);
		if (o._tag === "Left") return o;
		const i = ident<"ScheduleId">(o.right.id, `${p}.id`),
			ver = version(o.right.version, `${p}.version`),
			label = ne(o.right.label, `${p}.label`),
			z = zone(o.right.civilTimeZone, `${p}.civilTimeZone`),
			os = list(o.right.occurrenceIds, `${p}.occurrenceIds`, (x, q) =>
				ident<"OccurrenceId">(x, q),
			);
		if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
			return bad(
				`${p}.schemaVersion`,
				"invalidVersion",
				"unsupported workforce schema version",
			);
		if (i._tag === "Left") return i;
		if (ver._tag === "Left") return ver;
		if (label._tag === "Left") return label;
		if (z._tag === "Left") return z;
		return os._tag === "Left"
			? os
			: good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: "schedule",
					id: i.right as ScheduleId,
					version: ver.right,
					label: label.right,
					civilTimeZone: z.right,
					occurrenceIds: os.right as readonly OccurrenceId[],
				});
	}
	if (k === "council") {
		const o = base(k, ["memberRefs"]);
		if (o._tag === "Left") return o;
		const i = ident<"CouncilId">(o.right.id, `${p}.id`),
			ver = version(o.right.version, `${p}.version`),
			label = ne(o.right.label, `${p}.label`),
			ms = list(o.right.memberRefs, `${p}.memberRefs`, (x, q) =>
				ref(x, q, "microEmployee"),
			);
		if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
			return bad(
				`${p}.schemaVersion`,
				"invalidVersion",
				"unsupported workforce schema version",
			);
		if (i._tag === "Left") return i;
		if (ver._tag === "Left") return ver;
		if (label._tag === "Left") return label;
		return ms._tag === "Left"
			? ms
			: good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: "council",
					id: i.right as CouncilId,
					version: ver.right,
					label: label.right,
					memberRefs: ms.right,
				});
	}
	return bad(`${p}.kind`, "invalidScalar", "known definition kind required");
};
const definitionFor =
	<K extends DefinitionKind>(expected: K) =>
	(
		v: unknown,
		p: string,
	): Either<
		WorkforceDecodeError,
		Extract<WorkforceDefinition, { kind: K }>
	> => {
		const parsed = definition(v, p);
		if (parsed._tag === "Left") return parsed;
		return parsed.right.kind === expected
			? good(parsed.right as Extract<WorkforceDefinition, { kind: K }>)
			: bad(`${p}.kind`, "invalidScalar", `${expected} definition required`);
	};
const event = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, WorkforceEvent> => {
	const probe = object(v, p);
	if (probe._tag === "Left") return probe;
	const k = probe.right.kind;
	const b = (extra: string[]) =>
		fields(v, p, ["schemaVersion", "kind", "eventId", "sequence", ...extra]);
	if (k === "runObserved") {
		const o = b(["run", "occurrence"]);
		if (o._tag === "Left") return o;
		const e = ident<"EventId">(o.right.eventId, `${p}.eventId`),
			s = seq(o.right.sequence, `${p}.sequence`),
			r = run(o.right.run, `${p}.run`),
			q = occurrence(o.right.occurrence, `${p}.occurrence`);
		if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
			return bad(
				`${p}.schemaVersion`,
				"invalidVersion",
				"unsupported workforce schema version",
			);
		if (e._tag === "Left") return e;
		if (s._tag === "Left") return s;
		if (r._tag === "Left") return r;
		return q._tag === "Left"
			? q
			: good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: k,
					eventId: e.right as EventId,
					sequence: s.right,
					run: r.right,
					occurrence: q.right,
				});
	}
	if (k === "resultObserved" || k === "claimObserved") {
		const o = b([
			"run",
			"occurrence",
			k === "resultObserved" ? "result" : "claim",
			"causedByEventId",
		]);
		if (o._tag === "Left") return o;
		const e = ident<"EventId">(o.right.eventId, `${p}.eventId`),
			s = seq(o.right.sequence, `${p}.sequence`),
			r = run(o.right.run, `${p}.run`),
			q = occurrence(o.right.occurrence, `${p}.occurrence`),
			c =
				o.right.causedByEventId === null
					? good(null)
					: ident<"EventId">(o.right.causedByEventId, `${p}.causedByEventId`);
		const payload =
			k === "resultObserved"
				? result(o.right.result, `${p}.result`)
				: claim(o.right.claim, `${p}.claim`);
		if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
			return bad(
				`${p}.schemaVersion`,
				"invalidVersion",
				"unsupported workforce schema version",
			);
		if (e._tag === "Left") return e;
		if (s._tag === "Left") return s;
		if (r._tag === "Left") return r;
		if (q._tag === "Left") return q;
		if (c._tag === "Left") return c;
		if (payload._tag === "Left") return payload;
		return k === "resultObserved"
			? good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: k,
					eventId: e.right as EventId,
					sequence: s.right,
					run: r.right,
					occurrence: q.right,
					result: payload.right as WorkforceResult,
					causedByEventId: c.right as EventId | null,
				})
			: good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: k,
					eventId: e.right as EventId,
					sequence: s.right,
					run: r.right,
					occurrence: q.right,
					claim: payload.right as WorkforceClaim,
					causedByEventId: c.right as EventId | null,
				});
	}
	if (k === "diagnosticObserved") {
		const o = b(["diagnostic", "occurrence"]);
		if (o._tag === "Left") return o;
		const e = ident<"EventId">(o.right.eventId, `${p}.eventId`),
			s = seq(o.right.sequence, `${p}.sequence`),
			d = fields(o.right.diagnostic, `${p}.diagnostic`, ["code", "summary"]),
			q =
				o.right.occurrence === null
					? good(null)
					: occurrence(o.right.occurrence, `${p}.occurrence`);
		if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
			return bad(
				`${p}.schemaVersion`,
				"invalidVersion",
				"unsupported workforce schema version",
			);
		if (e._tag === "Left") return e;
		if (s._tag === "Left") return s;
		if (d._tag === "Left") return d;
		const dc = one(d.right.code, `${p}.diagnostic.code`, [
				"externalObservation",
			] as const),
			ds = ne(d.right.summary, `${p}.diagnostic.summary`);
		if (dc._tag === "Left") return dc;
		if (ds._tag === "Left") return ds;
		return q._tag === "Left"
			? q
			: good({
					schemaVersion: WORKFORCE_SCHEMA_VERSION,
					kind: k,
					eventId: e.right as EventId,
					sequence: s.right,
					diagnostic: { code: dc.right, summary: ds.right },
					occurrence: q.right,
				});
	}
	return bad(`${p}.kind`, "invalidScalar", "known event kind required");
};
const runFact = (
	v: unknown,
	p: string,
): Either<WorkforceDecodeError, WorkforceRunFact> => {
	const o = fields(v, p, [
		"schemaVersion",
		"kind",
		"factId",
		"sequence",
		"run",
		"occurrence",
		"causedByEventId",
		"observation",
	]);
	if (o._tag === "Left") return o;
	if (o.right.schemaVersion !== WORKFORCE_SCHEMA_VERSION)
		return bad(
			`${p}.schemaVersion`,
			"invalidVersion",
			"unsupported workforce schema version",
		);
	const k = one(o.right.kind, `${p}.kind`, ["runFactObserved"] as const),
		i = ident<"FactId">(o.right.factId, `${p}.factId`),
		s = seq(o.right.sequence, `${p}.sequence`),
		r = run(o.right.run, `${p}.run`),
		q = occurrence(o.right.occurrence, `${p}.occurrence`),
		c = ident<"EventId">(o.right.causedByEventId, `${p}.causedByEventId`),
		ob = fields(o.right.observation, `${p}.observation`, ["kind", "result"]);
	if (k._tag === "Left") return k;
	if (i._tag === "Left") return i;
	if (s._tag === "Left") return s;
	if (r._tag === "Left") return r;
	if (q._tag === "Left") return q;
	if (c._tag === "Left") return c;
	if (ob._tag === "Left") return ob;
	const okind = one(ob.right.kind, `${p}.observation.kind`, [
			"result",
		] as const),
		res = result(ob.right.result, `${p}.observation.result`);
	if (okind._tag === "Left") return okind;
	return res._tag === "Left"
		? res
		: good({
				schemaVersion: WORKFORCE_SCHEMA_VERSION,
				kind: k.right,
				factId: i.right as FactId,
				sequence: s.right,
				run: r.right,
				occurrence: q.right,
				causedByEventId: c.right as EventId,
				observation: { kind: okind.right, result: res.right },
			});
};
const availability = <T>(
	v: unknown,
	p: string,
	f: (v: unknown, p: string) => Either<WorkforceDecodeError, T>,
): Either<WorkforceDecodeError, Availability<T>> => {
	const probe = object(v, p);
	if (probe._tag === "Left") return probe;
	if (probe.right.state === "known") {
		const o = fields(v, p, ["state", "values"]);
		if (o._tag === "Left") return o;
		const a = list(o.right.values, `${p}.values`, f);
		return a._tag === "Left" ? a : good({ state: "known", values: a.right });
	}
	if (probe.right.state === "unavailable") {
		const o = fields(v, p, ["state", "reason"]);
		if (o._tag === "Left") return o;
		const r = one(o.right.reason, `${p}.reason`, [
			"notLoaded",
			"sourceUnavailable",
		] as const);
		return r._tag === "Left"
			? r
			: good({ state: "unavailable", reason: r.right });
	}
	return bad(`${p}.state`, "invalidScalar", "availability state required");
};
export const decodeWorkforceStandupInput = (
	input: unknown,
): Either<WorkforceDecodeError, WorkforceStandupInput> => {
	if (hasCycle(input))
		return bad("$", "invalidShape", "cyclic data is not allowed");
	const o = fields(input, "$", [
		"microEmployees",
		"jobs",
		"workflows",
		"schedules",
		"councils",
		"events",
		"runFacts",
		"civilScope",
	]);
	if (o._tag === "Left") return o;
	const ms = availability(
			o.right.microEmployees,
			"$.microEmployees",
			definitionFor("microEmployee"),
		),
		js = availability(o.right.jobs, "$.jobs", definitionFor("job")),
		ws = availability(
			o.right.workflows,
			"$.workflows",
			definitionFor("workflow"),
		),
		ss = availability(
			o.right.schedules,
			"$.schedules",
			definitionFor("schedule"),
		),
		cs = availability(o.right.councils, "$.councils", definitionFor("council")),
		es = availability(o.right.events, "$.events", event),
		fs = availability(o.right.runFacts, "$.runFacts", runFact),
		scope = occurrence(o.right.civilScope, "$.civilScope");
	if (ms._tag === "Left") return ms;
	if (js._tag === "Left") return js;
	if (ws._tag === "Left") return ws;
	if (ss._tag === "Left") return ss;
	if (cs._tag === "Left") return cs;
	if (es._tag === "Left") return es;
	if (fs._tag === "Left") return fs;
	if (scope._tag === "Left") return scope;
	return good({
		microEmployees: ms.right as Availability<MicroEmployeeDefinition>,
		jobs: js.right as Availability<JobDefinition>,
		workflows: ws.right as Availability<WorkflowDefinition>,
		schedules: ss.right as Availability<ScheduleDefinition>,
		councils: cs.right as Availability<CouncilDefinition>,
		events: es.right,
		runFacts: fs.right,
		civilScope: scope.right,
	});
};

const compareUtf16 = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const canonicalValue = (
	v: CanonicalWorkforceValue,
	seen: WeakSet<object>,
): string => {
	if (v === null) return "null";
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v === "boolean") return String(v);
	if (typeof v === "number") {
		if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0))
			throw new TypeError("non-negative safe integer required");
		return JSON.stringify(v);
	}
	if (typeof v !== "object")
		throw new TypeError("canonical domain value required");
	if (seen.has(v)) throw new TypeError("cyclic canonical value");
	seen.add(v);
	try {
		if (Array.isArray(v)) {
			const keys = Object.keys(v);
			const names = Object.getOwnPropertyNames(v);
			if (
				Object.getPrototypeOf(v) !== Array.prototype ||
				keys.length !== v.length ||
				Object.getOwnPropertySymbols(v).length > 0 ||
				names.length !== keys.length + 1 ||
				!names.includes("length")
			)
				throw new TypeError("dense data array required");
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(v, key);
				if (!descriptor || !("value" in descriptor))
					throw new TypeError("data array element required");
			}
			for (let i = 0; i < v.length; i++) {
				if (!Object.prototype.hasOwnProperty.call(v, String(i)))
					throw new TypeError("dense data array required");
			}
			return `[${v.map((item) => canonicalValue(item, seen)).join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(v);
		const keys = Object.keys(v);
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			Object.getOwnPropertySymbols(v).length > 0 ||
			Object.getOwnPropertyNames(v).length !== keys.length
		)
			throw new TypeError("plain enumerable object required");
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(v, key);
			if (!descriptor || !("value" in descriptor))
				throw new TypeError("data property required");
		}
		const record = v as { readonly [key: string]: CanonicalWorkforceValue };
		return `{${keys
			.sort(compareUtf16)
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalValue(record[key]!, seen)}`,
			)
			.join(",")}}`;
	} finally {
		seen.delete(v);
	}
};
export const canonicalWorkforceValueV1 = (v: CanonicalWorkforceValue): string =>
	canonicalValue(v, new WeakSet<object>());
const utf8 = (s: string) => {
	const a: number[] = [];
	for (let i = 0; i < s.length; i++) {
		let c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const l = s.charCodeAt(i + 1);
			if (l >= 0xdc00 && l <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + l - 0xdc00;
				i++;
			}
		}
		if (c < 128) a.push(c);
		else if (c < 2048) a.push(192 | (c >> 6), 128 | (c & 63));
		else if (c < 65536)
			a.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
		else
			a.push(
				240 | (c >> 18),
				128 | ((c >> 12) & 63),
				128 | ((c >> 6) & 63),
				128 | (c & 63),
			);
	}
	return new Uint8Array(a);
};
export const canonicalWorkforcePreimageV1 = (
	v: CanonicalWorkforceValue,
): Uint8Array => utf8(canonicalWorkforceValueV1(v));
export const compareCanonicalWorkforcePreimagesV1 = (
	a: Uint8Array,
	b: Uint8Array,
) => {
	for (let i = 0; i < Math.min(a.length, b.length); i++)
		if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
	return a.length - b.length;
};
const SHA256_CONSTANTS = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
/** Synchronous SHA-256 keeps this inert domain boundary runtime-independent. */
export const digestWorkforcePreimageV1 = (
	input: Uint8Array,
): WorkforceDigest => {
	const w = new Uint32Array(64),
		n = Math.ceil((input.length + 9) / 64) * 64,
		b = new Uint8Array(n),
		k = SHA256_CONSTANTS,
		r = (x: number, s: number) => (x >>> s) | (x << (32 - s));
	b.set(input);
	b[input.length] = 128;
	new DataView(b.buffer).setUint32(n - 4, (input.length * 8) >>> 0);
	new DataView(b.buffer).setUint32(
		n - 8,
		Math.floor((input.length * 8) / 0x100000000),
	);
	let [a, c, d, e, f, g, h, i] = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	];
	for (let o = 0; o < n; o += 64) {
		const v = new DataView(b.buffer, o, 64);
		for (let j = 0; j < 16; j++) w[j] = v.getUint32(j * 4);
		for (let j = 16; j < 64; j++) {
			const x = w[j - 15]!,
				y = w[j - 2]!;
			w[j] =
				((r(x, 7) ^ r(x, 18) ^ (x >>> 3)) +
					w[j - 16]! +
					(r(y, 17) ^ r(y, 19) ^ (y >>> 10)) +
					w[j - 7]!) >>>
				0;
		}
		let [A, B, C, D, E, F, G, H] = [a, c, d, e, f, g, h, i];
		for (let j = 0; j < 64; j++) {
			const t =
					(H +
						(r(E, 6) ^ r(E, 11) ^ r(E, 25)) +
						((E & F) ^ (~E & G)) +
						k[j]! +
						w[j]!) >>>
					0,
				u =
					((r(A, 2) ^ r(A, 13) ^ r(A, 22)) + ((A & B) ^ (A & C) ^ (B & C))) >>>
					0;
			H = G;
			G = F;
			F = E;
			E = (D + t) >>> 0;
			D = C;
			C = B;
			B = A;
			A = (t + u) >>> 0;
		}
		a = (a + A) >>> 0;
		c = (c + B) >>> 0;
		d = (d + C) >>> 0;
		e = (e + D) >>> 0;
		f = (f + E) >>> 0;
		g = (g + F) >>> 0;
		h = (h + G) >>> 0;
		i = (i + H) >>> 0;
	}
	return [a, c, d, e, f, g, h, i]
		.map((x) => x.toString(16).padStart(8, "0"))
		.join("") as WorkforceDigest;
};
