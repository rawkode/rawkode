import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"
import {
  WorkoutActivityKind,
  WorkoutDetail,
  WorkoutImportReceipt,
  WorkoutSource,
  WorkoutSummary
} from "./workout.js"

// Wire schemas for `WorkoutsService`'s two RPC methods (`importWorkout`/`listWorkoutImports`,
// `workouts-service-live.ts`), following graph-rpc.ts's/meeting-rpc.ts's established convention:
// one `Schema.Class` input/output pair per method, decoded with `Schema.decodeUnknown` at the DO
// boundary. See docs/workouts-decisions.md for the full "why this shape" writeup.
//
// **Every method below is workspace-scoped**, and — restated from every prior Phase 4/5/6 RPC file's
// identical hard-constraint note (gatekeeper-rpc.ts, meeting-rpc.ts) — **every method in this
// file, once wired onto `WorkspaceDurableObject`, MUST call `requireRoleForGovernedWorkspace` exactly
// like every other governed-workspace RPC method; no exceptions.** Role split follows the established
// mutation→`"build"`/read→`"use"` convention: `importWorkout`/`importWorkouts` → `"build"`;
// `listWorkoutImports`/`listWorkouts`/`getWorkout` → `"use"`.
//
// **Why one atomic `importWorkout` call, not N calls against the existing generic
// `createNode`/`assignTag`/`addFact`/`createEdge` RPCs** (those four already suffice to build any
// node/tag/fact/edge shape, including a workout's — this is deliberately NOT a new storage
// mechanism, per the plan's own Phase 7 framing: "proves graph generality, no new mechanism"):
// a strength session with, say, 5 exercises × 4 sets is ~40 node/tag/fact/edge writes. Driving
// that as 40 separate Cap'n Web round trips from a native client is slow, non-atomic (a dropped
// connection mid-import leaves a half-built subgraph with no way to resume or roll back), and
// gives the backend no single place to compute/verify a content hash for idempotent-retry
// dedupe (see `WorkoutImportReceipt`'s own doc comment). `importWorkout` is a single RPC whose
// *implementation* still only calls the existing `GraphService`/`NodesRepository` primitives
// internally (`workouts-service-live.ts`) — it is a batching/atomicity/idempotency convenience at
// the RPC boundary, not a second way to create graph data.

/** One strength set within one exercise, per `WorkoutDataSource`'s (native) `ImportedStrengthSet`
 *  shape. `ordinal` is 1-based and must be contiguous within its exercise (`workouts-service-live
 *  .ts` validates this, mirroring Enchiridion's own `WorkoutModule#validate`'s `contiguous(_:)`
 *  check) — a gap or duplicate ordinal fails the whole import with `ValidationError` rather than
 *  silently reordering or dropping a set. */
export const StrengthSetImportInput = Schema.Struct({
  ordinal: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  repetitions: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  loadKilograms: Schema.Number.pipe(Schema.nonNegative()),
  rpe: Schema.optional(Schema.Number),
  completedAt: Schema.optional(IsoDateTimeString)
})
export type StrengthSetImportInput = typeof StrengthSetImportInput.Type

/** One exercise within a strength workout — `sets` must be non-empty and contiguously ordinaled,
 *  same discipline as `StrengthSetImportInput.ordinal`. `maxItems(50)` (adversarial-review fix,
 *  mirroring `ImportWorkoutsInput.workouts`'s own `maxItems(200)` bound and its stated reason
 *  below): a demonstrated real exploit showed an unbounded `sets` array (50,000 items accepted by
 *  the schema, a real 12,000-item single-workout import taking 47s against the live backend, and
 *  the workspace's single-threaded DO staying unresponsive to *every other request against the same
 *  workspace* — not just this one — for the whole duration) lets one `importWorkout`/`importWorkouts`
 *  item alone lock a user out of their entire workspace. Even a genuinely high-volume drop-set/AMRAP
 *  protocol realistically tops out around 10-20 sets per exercise; 50 is generous headroom while
 *  still bounding one exercise's write blast radius to a small, predictable number of
 *  node/tag/fact/edge writes. */
export const StrengthExerciseImportInput = Schema.Struct({
  ordinal: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  name: Schema.String.pipe(Schema.minLength(1)),
  sets: Schema.Array(StrengthSetImportInput).pipe(Schema.minItems(1), Schema.maxItems(50))
})
export type StrengthExerciseImportInput = typeof StrengthExerciseImportInput.Type

/** One distance/time split within a cardio workout — present only when the data source can
 *  derive lap/segment boundaries (native's `HealthKitWorkoutDataSource` does this best-effort from
 *  `HKWorkoutEvent` segment/lap markers when the recording app supplied them; see that file's own
 *  header comment — many real `HKWorkout` samples have none, in which case `payload.splits` is
 *  simply empty and only the root-level `payload.distanceMeters`/etc. roll-ups are set).
 *  `maxItems(500)` (adversarial-review fix, same "bound one call's write blast radius against the
 *  single-threaded per-workspace DO" reason as `StrengthExerciseImportInput.sets`/this file's
 *  `WorkoutImportPayload.exercises` bound below): 500 comfortably covers even auto-lap GPS data
 *  every ~100m across a 50km ultra-distance event, or per-length splits in a long pool swim, while
 *  still keeping one workout's split-subgraph write volume small and predictable. */
export const CardioSplitImportInput = Schema.Struct({
  ordinal: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  distanceMeters: Schema.Number.pipe(Schema.greaterThan(0)),
  durationSeconds: Schema.Number.pipe(Schema.greaterThan(0)),
  averageHeartRate: Schema.optional(Schema.Number),
  energyKilocalories: Schema.optional(Schema.Number)
})
export type CardioSplitImportInput = typeof CardioSplitImportInput.Type

/**
 * The discriminated payload shape — which one of `Strength Workout`/`Cardio Workout` the root
 * node gets tagged, and which child-node subgraph (`exercises`/`sets` vs. `splits`) is built.
 * Discriminated on `kind`, mirroring Enchiridion's own `WorkoutCapturePayload` enum
 * (`.strength([exercises])` / `.cardio(splits, distance, elevation, speed, pace)`,
 * `EnchiridionWorkoutTransport/WorkoutTransport.swift`) rather than derived from `activity` —
 * deliberately: `activity` is an open, wide vocabulary (`WorkoutActivityKind`, workout.ts) a
 * future data source could extend, while "does this workout have exercise/set structure or
 * distance/split structure" is the one bit that actually decides which node subgraph gets built,
 * and letting the payload state that directly (rather than inferring it from an activity-type
 * lookup table this file would then have to keep exhaustive) is simpler and cannot drift out of
 * sync with `WorkoutActivityKind`'s own literal set.
 */
// `maxItems(50)`/`maxItems(500)` below (adversarial-review fix): the identical defensive bound
// applied for the identical stated reason to `StrengthExerciseImportInput.sets`/
// `CardioSplitImportInput` above and `ImportWorkoutsInput.workouts` below — a demonstrated real
// exploit showed these arrays were otherwise unbounded (a schema-accepted 50,000-item `exercises`
// array; a real 12,000-item single-workout `importWorkout` call taking 47s against the live local
// backend; an unrelated fresh connection to the SAME workspace waiting 15-29+ seconds for a response
// during that time, because the workspace's DO — which holds every collection, not just workouts — is
// single-threaded). `WorkoutImportPayload` is shared, unchanged, by both `ImportWorkoutInput`
// (single) and `WorkoutImportItem` (each item of a batch `importWorkouts` call) below, so this one
// bound covers both call paths without needing a second, duplicated bound.
export const WorkoutImportPayload = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("strength"),
    exercises: Schema.Array(StrengthExerciseImportInput).pipe(Schema.minItems(1), Schema.maxItems(50))
  }),
  Schema.Struct({
    kind: Schema.Literal("cardio"),
    splits: Schema.Array(CardioSplitImportInput).pipe(Schema.maxItems(500)),
    distanceMeters: Schema.optional(Schema.Number),
    elevationMeters: Schema.optional(Schema.Number),
    averageSpeedMetersPerSecond: Schema.optional(Schema.Number),
    averagePaceSecondsPerKilometre: Schema.optional(Schema.Number)
  })
)
export type WorkoutImportPayload = typeof WorkoutImportPayload.Type

/**
 * `importWorkout`'s input — the wire shape a native `WorkoutDataSource` implementation (real
 * `HealthKitWorkoutDataSource` or `SyntheticWorkoutDataSource`) is transformed into before being
 * sent over `AthenaeumRPC` (`WorkspaceRPCClient+Workouts.swift`, native). `sourceWorkoutId` is the
 * idempotency key (`WorkoutImportReceipt.sourceWorkoutId`, workout.ts) — the real
 * `HKWorkout.uuid.uuidString` for a HealthKit-sourced import, or a synthetic source's own stable
 * id. **No `payloadHash` field here** — deliberately computed server-side
 * (`workouts-service-live.ts`, `crypto.subtle.digest("SHA-256", ...)` over this decoded input's
 * own content) rather than trusted from the client, the same "server computes what it needs to
 * verify, never trusts a client-supplied hash of client-supplied content" discipline this
 * codebase already uses for HMAC'd share keys/OAuth state (`sharing-service-live.ts`,
 * `calendar-oauth-state.ts`) — a client-supplied hash would let a buggy or malicious client claim
 * "this is a duplicate" (or "this is NOT a duplicate") independent of the content it actually
 * sent, defeating the dedupe guarantee entirely.
 */
export class ImportWorkoutInput extends Schema.Class<ImportWorkoutInput>("ImportWorkoutInput")({
  workspaceId: EntityId,
  sourceWorkoutId: Schema.String.pipe(Schema.minLength(1)),
  source: WorkoutSource,
  activity: WorkoutActivityKind,
  /** The data source's own raw activity-type name, preserved losslessly whenever `activity`
   *  couldn't be mapped to anything more specific than `"other"` (see `WorkoutActivityKind`'s own
   *  doc comment) — e.g. `HKWorkoutActivityType.wrestling`'s raw case name. Absent when `activity`
   *  is not `"other"` (no information lost by mapping cleanly). */
  rawActivity: Schema.optional(Schema.String),
  startedAt: IsoDateTimeString,
  completedAt: IsoDateTimeString,
  durationSeconds: Schema.Number.pipe(Schema.nonNegative()),
  energyKilocalories: Schema.optional(Schema.Number),
  averageHeartRate: Schema.optional(Schema.Number),
  maximumHeartRate: Schema.optional(Schema.Number),
  payload: WorkoutImportPayload
}) {}

export class ImportWorkoutOutput extends Schema.Class<ImportWorkoutOutput>("ImportWorkoutOutput")({
  receipt: WorkoutImportReceipt,
  /** `true` when this call found an existing receipt for `sourceWorkoutId` with an identical
   *  payload hash and returned it unchanged (no new nodes/tags/facts/edges were written) —
   *  distinguishes a genuine idempotent no-op from a fresh import for a caller that cares (e.g. a
   *  native sync loop deciding whether to log "imported N new workouts"). */
  duplicate: Schema.Boolean
}) {}

export class ListWorkoutImportsInput extends Schema.Class<ListWorkoutImportsInput>("ListWorkoutImportsInput")({
  workspaceId: EntityId
}) {}

export class ListWorkoutImportsOutput extends Schema.Class<ListWorkoutImportsOutput>("ListWorkoutImportsOutput")({
  receipts: Schema.Array(WorkoutImportReceipt)
}) {}

// --- importWorkouts (batch) ------------------------------------------------------------------
//
// Domain-extension task item 3's batch import. A native sync loop importing a HealthKit history
// backfill (or catching up after being offline) has N workouts to send, not one — driving that as
// N separate `importWorkout` round trips has the same "slow, and no batching win" problem
// `importWorkout`'s own doc comment already argues against for the 40-write single-workout case,
// compounded by N. `importWorkouts` is the batched sibling: one RPC call, one `workspaceId` (every
// workout in one call imports into the same workspace — a native sync loop always has exactly one
// target workspace per call), N `WorkoutImportItem` payloads.
//
// **Per-item, not all-or-nothing.** A `WorkoutsService#importWorkouts` implementation (a later
// stage) is expected to import each item independently — mirroring `importWorkout`'s own
// per-`sourceWorkoutId` idempotency unit — and report a per-item `WorkoutImportBatchItemResult`
// rather than failing the whole call if one item is malformed (bad ordinals) or conflicts
// (`WorkoutImportConflict`, errors.ts). Deliberately NOT wrapped in one all-or-nothing DO
// transaction: the plan's own DO-limits callout (§"Storage & domain model": "30s default
// CPU/request") means a large batch already risks the request's CPU budget before an atomicity
// guarantee on top of that would help, and a partial-success report lets a retrying client resend
// only the failed items' `sourceWorkoutId`s rather than the whole batch.
//
// `maxItems(200)` is a defensive upper bound on one call's blast radius (a strength workout alone
// is ~40 writes; 200 workouts is already thousands of underlying `NodesRepository`/`GraphService`
// writes in one request) — a native client backfilling more history than that is expected to
// paginate across multiple `importWorkouts` calls, not one call an order of magnitude larger.

/** One workout within a batch `importWorkouts` call — identical fields to `ImportWorkoutInput`
 *  above minus `workspaceId`, which `ImportWorkoutsInput` carries once for the whole batch (see this
 *  section's header comment). */
export class WorkoutImportItem extends Schema.Class<WorkoutImportItem>("WorkoutImportItem")({
  sourceWorkoutId: Schema.String.pipe(Schema.minLength(1)),
  source: WorkoutSource,
  activity: WorkoutActivityKind,
  rawActivity: Schema.optional(Schema.String),
  startedAt: IsoDateTimeString,
  completedAt: IsoDateTimeString,
  durationSeconds: Schema.Number.pipe(Schema.nonNegative()),
  energyKilocalories: Schema.optional(Schema.Number),
  averageHeartRate: Schema.optional(Schema.Number),
  maximumHeartRate: Schema.optional(Schema.Number),
  payload: WorkoutImportPayload
}) {}

export class ImportWorkoutsInput extends Schema.Class<ImportWorkoutsInput>("ImportWorkoutsInput")({
  workspaceId: EntityId,
  workouts: Schema.Array(WorkoutImportItem).pipe(Schema.minItems(1), Schema.maxItems(200))
}) {}

/** One batch item succeeded — same `receipt`/`duplicate` shape as `ImportWorkoutOutput`, plus the
 *  `sourceWorkoutId` this result corresponds to (needed here, unlike the single-item RPC, because
 *  a batch response's items must each self-identify which input they answer — `receipt
 *  .sourceWorkoutId` is equivalent, but a caller matching results back to inputs by index alone
 *  is fragile against a future implementation that reorders results, e.g. to finish fast items
 *  first; matching by `sourceWorkoutId` directly is not). */
export class WorkoutImportSucceeded extends Schema.Class<WorkoutImportSucceeded>("WorkoutImportSucceeded")({
  outcome: Schema.Literal("imported"),
  sourceWorkoutId: Schema.String,
  receipt: WorkoutImportReceipt,
  duplicate: Schema.Boolean
}) {}

/** One batch item failed — `message` is human-readable (mirrors every other in-package
 *  conflict/failure result's own `message` field, e.g. `ObserverVerificationDenied`, gatekeeper.ts)
 *  rather than a typed `DomainError`/`RpcErrorEnvelope`: this is a WIRE RESULT living inside a
 *  successful `ImportWorkoutsOutput`, not a thrown error crossing the Cap'n Web throw boundary
 *  (`rpc-error.ts`'s envelope), so it does not need — and deliberately does not reuse —
 *  `RpcErrorEnvelope`'s closed `knownTags` shape; a batch item's own service-level implementation
 *  (a later stage) decides how much of a `ValidationError`/`WorkoutImportConflict`'s message to
 *  surface here. */
export class WorkoutImportFailed extends Schema.Class<WorkoutImportFailed>("WorkoutImportFailed")({
  outcome: Schema.Literal("failed"),
  sourceWorkoutId: Schema.String,
  message: Schema.String
}) {}

export const WorkoutImportBatchItemResult = Schema.Union(WorkoutImportSucceeded, WorkoutImportFailed)
export type WorkoutImportBatchItemResult = typeof WorkoutImportBatchItemResult.Type

/** Results are returned in the same order as `ImportWorkoutsInput.workouts` (this schema's own
 *  fixed contract — a `WorkoutsService` implementation must preserve input order even if it
 *  processes items concurrently internally), one `WorkoutImportBatchItemResult` per input item. */
export class ImportWorkoutsOutput extends Schema.Class<ImportWorkoutsOutput>("ImportWorkoutsOutput")({
  results: Schema.Array(WorkoutImportBatchItemResult)
}) {}

// --- listWorkouts / getWorkout ----------------------------------------------------------------
//
// Domain-extension task item 3's read side. See workout.ts's own "Read models" section header
// comment for why `WorkoutSummary`/`WorkoutDetail` are assembled read shapes, not collection
// rows, and for the observer-exclusion note on their `nodeId` field.

export class ListWorkoutsInput extends Schema.Class<ListWorkoutsInput>("ListWorkoutsInput")({
  workspaceId: EntityId
}) {}

/** Most-recently-started first, in a real implementation — this schema does not itself fix
 *  ordering, matching `ListMeetingsOutput`'s/`ListChatsOutput`'s identical scope note. */
export class ListWorkoutsOutput extends Schema.Class<ListWorkoutsOutput>("ListWorkoutsOutput")({
  workouts: Schema.Array(WorkoutSummary)
}) {}

/** `nodeId` is the workout ROOT node's id (`WorkoutSummary.nodeId`/`WorkoutImportReceipt
 *  .rootNodeId`) — not a `sourceWorkoutId`, which is a provider-scoped import-identity key, not a
 *  graph identity; a caller with only a `sourceWorkoutId` (e.g. a native sync loop that just
 *  called `importWorkout`) resolves it to a `nodeId` via that call's own `ImportWorkoutOutput
 *  .receipt.rootNodeId` first. Fails with `WorkoutNotFound` (errors.ts) if `nodeId` does not
 *  reference a `Workout`-tagged node in this workspace. */
export class GetWorkoutInput extends Schema.Class<GetWorkoutInput>("GetWorkoutInput")({
  workspaceId: EntityId,
  nodeId: EntityId
}) {}

export class GetWorkoutOutput extends Schema.Class<GetWorkoutOutput>("GetWorkoutOutput")({
  workout: WorkoutDetail
}) {}
