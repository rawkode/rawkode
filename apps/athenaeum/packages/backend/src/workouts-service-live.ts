// `WorkoutsService` — the plan's diagrammed Effect Service ("Workout/Strength/Cardio/...
// nodes+facts", C4 Level 3 component diagram) and Phase 7's real implementation (plan §"Phased
// delivery": "HealthKit import as typed graph pages, proves graph generality, no new mechanism").
// Same "own small collections module, own focused Effect Service, composed at the thin RPC-
// dispatch layer" convention as `MeetingsService`/`CalendarService` (plan §"Storage & domain
// model", God-object mitigation) — real orchestration logic lives here, not piled into
// `workspace-durable-object.ts`.
//
// **"No new mechanism," concretely**: this service creates graph data using exactly the same
// primitives every other write path in this codebase uses — `NodesRepository.put` (mirroring
// `workspace-durable-object.ts#createNode`'s own inline node-creation dance: repository write +
// `upsertNode`/`indexNodeText` read-model sync + `syncFeed.append`) for nodes, and `GraphService`'s
// already-shipped `assignTag`/`addFact`/`createEdge` for everything else. There is no
// workout-specific storage table, no workout-specific query language, no workout-specific sync
// path — only a workout-specific *composition* of the Phase 1 graph primitives, exactly the
// "proves graph generality" framing the plan states for this phase.
//
// See `docs/workouts-decisions.md` for the full design writeup (HealthKit→graph mapping, tag
// seeding decision, idempotency design) and `workout.ts`/`workout-rpc.ts` for the schemas this
// service implements.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { TreeFormatter } from "effect/ParseResult"
import {
  Edge,
  Fact,
  ImportWorkoutInput,
  IsoDateTimeString,
  Node as NodeEntity,
  NodesRepository,
  UnexpectedError,
  ValidationError,
  WorkoutActivityKind,
  WorkoutCardioSplit,
  WorkoutDetail,
  WorkoutFactPredicate,
  WorkoutImportConflict,
  WorkoutImportFailed,
  WorkoutImportItem,
  WorkoutImportReceipt,
  WorkoutImportSucceeded,
  WorkoutNotFound,
  WorkoutRelationIds,
  WorkoutSource,
  WorkoutStrengthExercise,
  WorkoutStrengthSet,
  WorkoutSummary,
  WorkoutTagIds,
  type CardioSplitImportInput,
  type DomainError,
  type EntityId,
  type StrengthExerciseImportInput,
  type WorkoutDetailPayload,
  type WorkoutImportBatchItemResult,
  type WorkoutImportPayload
} from "@athenaeum/domain"
import * as Schema from "effect/Schema"
import { GraphService } from "./graph-service-live.js"
import { indexNodeText, upsertNode } from "./read-model.js"
import { SyncFeedService } from "./sync-feed-service-live.js"
import { ensureWorkoutTagsSeeded } from "./workout-seed.js"
import {
  reviveWorkoutImportReceipt,
  toUnexpectedError,
  type WorkoutCollections
} from "./workout-collections.js"
import type { TagsCollections } from "./tags-repository-live.js"
import type { TagClosureCollections } from "./tag-closure.js"
import type { RelationDefinitionsCollections } from "./relation-definitions-repository-live.js"
import { reviveFact, type FactsCollections } from "./facts-repository-live.js"
import { reviveEdge, type EdgesCollections } from "./edges-repository-live.js"
import type { NodeTagsCollections } from "./node-tags-live.js"

const nowIso = (): IsoDateTimeString => IsoDateTimeString.make(new Date().toISOString())

/** `ordinal` fields must be 1-based and contiguous within their parent collection — mirrors
 *  Enchiridion's own `WorkoutModule#validate`'s `contiguous(_:)` check
 *  (`apps/enchiridion/Sources/EnchiridionCore/WorkoutModule.swift`): a gap or duplicate ordinal
 *  almost always means the client mis-assembled the payload (e.g. dropped a set while paginating
 *  a long `HKWorkoutEvent` sequence), and silently accepting it would produce a set/exercise/split
 *  ordering downstream code can't rely on — failing closed here, before any node is written, is
 *  strictly better than discovering it later against a half-imported subgraph. */
const requireContiguousOrdinals = (
  label: string,
  ordinals: ReadonlyArray<number>
): Effect.Effect<void, ValidationError> => {
  const sorted = [...ordinals].sort((a, b) => a - b)
  const isContiguous = sorted.every((ordinal, index) => ordinal === index + 1)
  return isContiguous
    ? Effect.void
    : Effect.fail(
        new ValidationError({
          message: `${label} ordinals must be 1-based and contiguous with no gaps/duplicates, got [${sorted.join(", ")}]`
        })
      )
}

/** SHA-256 hex digest of a `WorkoutImportItem`'s own content — `workspaceId` is not part of this
 *  shape at all (it's `importWorkouts`' own routing field, carried once per batch, not per item;
 *  `importWorkout`'s single-item wrapper below strips `ImportWorkoutInput.workspaceId` before building
 *  the `WorkoutImportItem` this function hashes, so both call paths hash the identical content
 *  shape and therefore recognize the identical duplicate/conflict outcome for identical content
 *  regardless of which RPC method it arrived through). See `workout-rpc.ts`'s `ImportWorkoutInput`
 *  doc comment for why this is computed server-side rather than trusted from the client.
 *  `JSON.stringify` over the decoded, already-schema-validated item is stable enough for this
 *  purpose: the item's own key order is fixed by `WorkoutImportItem`'s `Schema.Class` field
 *  declaration order (`effect/Schema` encodes a `Schema.Class` to a plain object with keys in
 *  declared order), so two calls with identical content always hash identically — this is a
 *  dedupe fingerprint, not a canonical wire format, so it doesn't need
 *  JSON-Canonicalization-Scheme-grade rigor. */
const computePayloadHash = (item: WorkoutImportItem): Effect.Effect<string, UnexpectedError> =>
  Effect.tryPromise({
    try: async () => {
      const content = Schema.encodeSync(WorkoutImportItem)(item)
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)))
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    },
    catch: (cause) =>
      new UnexpectedError({
        message: `failed to hash workout import payload: ${cause instanceof Error ? cause.message : String(cause)}`
      })
  })

/** Strips `workspaceId` off an `ImportWorkoutInput` to build the `WorkoutImportItem` shape
 *  `importOneWorkout` (this file) and `computePayloadHash` (above) both operate on — the two
 *  classes share every other field by construction (`workout-rpc.ts`'s `WorkoutImportItem` doc
 *  comment: "identical fields to `ImportWorkoutInput` above minus `workspaceId`"). */
const toWorkoutImportItem = (input: ImportWorkoutInput): WorkoutImportItem =>
  new WorkoutImportItem({
    sourceWorkoutId: input.sourceWorkoutId,
    source: input.source,
    activity: input.activity,
    ...(input.rawActivity !== undefined ? { rawActivity: input.rawActivity } : {}),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationSeconds: input.durationSeconds,
    ...(input.energyKilocalories !== undefined ? { energyKilocalories: input.energyKilocalories } : {}),
    ...(input.averageHeartRate !== undefined ? { averageHeartRate: input.averageHeartRate } : {}),
    ...(input.maximumHeartRate !== undefined ? { maximumHeartRate: input.maximumHeartRate } : {}),
    payload: input.payload
  })

/** A domain error crossing the Cap'n Web throw boundary is always typed (`DomainError`'s closed
 *  union, `errors.ts`), but `WorkoutImportFailed.message` (workout-rpc.ts) is a plain human-
 *  readable string living INSIDE a successful `ImportWorkoutsOutput`, not a thrown error — see
 *  that class's own doc comment for why it deliberately doesn't reuse `RpcErrorEnvelope`. Most
 *  `DomainError` members carry a `message` field (`ValidationError`/`UnexpectedError`/
 *  `WorkoutImportConflict`/…); the few that don't (e.g. `NodeNotFound`'s `{nodeId}`) fall back to
 *  their `_tag` alone, which is still informative enough for a batch-import failure reason. */
const domainErrorMessage = (error: DomainError): string => {
  const message = (error as { readonly message?: unknown }).message
  return typeof message === "string" ? `${error._tag}: ${message}` : error._tag
}

/** Validates every ordinal sequence in `payload` UP FRONT, before `importWorkout` writes a single
 *  node — see `workout-rpc.ts`'s `ImportWorkoutInput` doc comment for why this is one atomic RPC
 *  in the first place ("a dropped connection mid-import leaves a half-built subgraph with no way
 *  to resume or roll back"): that atomicity claim would be hollow if a content error (a gap in a
 *  set's ordinals, discovered three exercises deep) could still leave the root node and the first
 *  two exercises' worth of nodes/edges/facts written before the failure. `importStrengthExercises`/
 *  `importCardioSplits` below re-check the same invariant per exercise/split as cheap defense in
 *  depth (in case a future caller reaches them some other way), but THIS is the check that
 *  actually makes `importWorkout` fail closed before any write. */
const validatePayloadOrdinals = (payload: WorkoutImportPayload): Effect.Effect<void, ValidationError> =>
  payload.kind === "strength"
    ? Effect.gen(function* () {
        yield* requireContiguousOrdinals("exercise", payload.exercises.map((e) => e.ordinal))
        for (const exercise of payload.exercises) {
          yield* requireContiguousOrdinals(
            `exercise #${exercise.ordinal} ("${exercise.name}") set`,
            exercise.sets.map((s) => s.ordinal)
          )
        }
      })
    : payload.splits.length === 0
      ? Effect.void
      : requireContiguousOrdinals("split", payload.splits.map((s) => s.ordinal))

const activityLabel = (activity: string): string =>
  activity
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")

export interface WorkoutsServiceApi {
  readonly importWorkout: (
    input: ImportWorkoutInput
  ) => Effect.Effect<{ receipt: WorkoutImportReceipt; duplicate: boolean }, DomainError>
  readonly listWorkoutImports: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<WorkoutImportReceipt>, DomainError>
  /** Batched sibling of `importWorkout` — see `workout-rpc.ts`'s `ImportWorkoutsInput`/
   *  `ImportWorkoutsOutput` doc comments for the full "one RPC, N independent per-item outcomes"
   *  rationale. Never fails the whole `Effect` for a single bad item: every item's outcome
   *  (imported/duplicate vs. failed) is reported in the returned array, in the same order as
   *  `items`. Only fails for something that isn't item-specific at all (there is currently
   *  nothing that would — tag/relation seeding is itself per-item-independent and idempotent). */
  readonly importWorkouts: (
    workspaceId: EntityId,
    items: ReadonlyArray<WorkoutImportItem>
  ) => Effect.Effect<ReadonlyArray<WorkoutImportBatchItemResult>, DomainError>
  /** Lightweight per-workout read model, one row per successful import in this workspace — see
   *  `workout.ts`'s `WorkoutSummary` doc comment for why this is assembled from the `nodes`/
   *  `facts`/`edges` subgraph rather than read from a dedicated collection. Most-recently-started
   *  first. */
  readonly listWorkouts: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<WorkoutSummary>, DomainError>
  /** Full aggregate read for one workout root node — see `workout.ts`'s `WorkoutDetail` doc
   *  comment. Fails with `WorkoutNotFound` (not `NodeNotFound`) when `nodeId` doesn't reference an
   *  existing `Workout`-tagged node in this workspace, per `workout-rpc.ts`'s `GetWorkoutInput` doc
   *  comment. */
  readonly getWorkout: (workspaceId: EntityId, nodeId: EntityId) => Effect.Effect<WorkoutDetail, DomainError>
}

export class WorkoutsService extends Context.Tag("@athenaeum/backend/WorkoutsService")<
  WorkoutsService,
  WorkoutsServiceApi
>() {}

export const makeWorkoutsServiceLive = (
  collections: WorkoutCollections,
  tagsCollections: TagsCollections,
  tagClosureCollections: TagClosureCollections,
  relationDefinitionsCollections: RelationDefinitionsCollections,
  factsCollections: FactsCollections,
  edgesCollections: EdgesCollections,
  nodeTagsCollections: NodeTagsCollections,
  sql: SqlStorage,
  /** Raw DO storage handle, used ONLY for its `transactionSync` escape hatch (adversarial-review
   *  fix — see `importOneWorkout`'s inner `writeSubgraphAndReceipt` for the full rationale). Every
   *  ordinary read/write in this file still goes through `collections`/`nodesRepository`/`graph`/
   *  `syncFeed` as before — this is not a second storage-access path, just the one existing
   *  `DurableObjectStorage` handle those were already built over (`workspace-durable-object.ts` passes
   *  `ctx.storage` here, the same instance `makeWorkoutCollections(ctx.storage)` already uses). */
  storage: DurableObjectStorage
): Layer.Layer<WorkoutsService, never, NodesRepository | SyncFeedService | GraphService> =>
  Layer.effect(
    WorkoutsService,
    Effect.gen(function* () {
      const nodesRepository = yield* NodesRepository
      const syncFeed = yield* SyncFeedService
      const graph = yield* GraphService

      // --- Read-side helpers (listWorkouts/getWorkout) — reconstruct read models from the
      // nodes/facts/edges subgraph `importWorkout`/`importWorkouts` above wrote, the mirror image
      // of `buildRootFacts`/`importWorkoutSubgraph`. Reuses `factsCollections`/`edgesCollections`/
      // `nodeTagsCollections` directly (raw `typed-storage-effect` collections, not the domain
      // `FactsRepository`/`EdgesRepository` `Context.Tag`s, which only expose a full-workspace
      // `list()` — no per-node index) — the same "reach past the domain repository interface for
      // an indexed query it doesn't expose" convention `GraphServiceLive` itself already uses for
      // `edgesCollections`'s `bySourceNodeId`/`byTargetNodeId` (see that file's own imports).

      const factsForNode = (nodeId: EntityId): Effect.Effect<ReadonlyArray<Fact>, DomainError> =>
        factsCollections.facts.byNodeId.get(nodeId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((rows) => Effect.forEach(rows, reviveFact)),
          Effect.map((facts) => facts.filter((fact) => fact.pending === undefined))
        )

      const edgesFromSource = (sourceNodeId: EntityId): Effect.Effect<ReadonlyArray<Edge>, DomainError> =>
        edgesCollections.edges.bySourceNodeId.get(sourceNodeId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((rows) => Effect.forEach(rows, reviveEdge)),
          Effect.map((edges) => edges.filter((edge) => edge.pending === undefined))
        )

      const tagIdsForNode = (nodeId: EntityId): Effect.Effect<ReadonlySet<EntityId>, DomainError> =>
        nodeTagsCollections.nodeTags.byNodeId.get(nodeId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.map((rows) => new Set(rows.map((row) => row.tagId)))
        )

      /** A required fact missing, or shaped unexpectedly, is a corrupt/incomplete workout
       *  subgraph — `UnexpectedError`, not `ValidationError`: the caller supplied nothing wrong
       *  here, `importWorkout`'s own write path (above) is what guarantees every one of these
       *  facts exists with this shape, so a failure here means that guarantee was violated. */
      const requiredFactValue = <A, I>(
        facts: ReadonlyArray<Fact>,
        predicateId: string,
        schema: Schema.Schema<A, I>
      ): Effect.Effect<A, UnexpectedError> => {
        const raw = facts.find((fact) => fact.predicateId === predicateId)?.value
        if (raw === undefined) {
          return Effect.fail(
            new UnexpectedError({ message: `workout node is missing required fact "${predicateId}"` })
          )
        }
        return Schema.decodeUnknown(schema)(raw).pipe(
          Effect.mapError(
            (parseError) =>
              new UnexpectedError({
                message: `workout fact "${predicateId}" has an unexpected shape: ${TreeFormatter.formatErrorSync(parseError)}`
              })
          )
        )
      }

      const optionalFactValue = <A, I>(
        facts: ReadonlyArray<Fact>,
        predicateId: string,
        schema: Schema.Schema<A, I>
      ): Effect.Effect<A | undefined, UnexpectedError> => {
        const raw = facts.find((fact) => fact.predicateId === predicateId)?.value
        return raw === undefined
          ? Effect.succeed(undefined)
          : Schema.decodeUnknown(schema)(raw).pipe(
              Effect.mapError(
                (parseError) =>
                  new UnexpectedError({
                    message: `workout fact "${predicateId}" has an unexpected shape: ${TreeFormatter.formatErrorSync(parseError)}`
                  })
              )
            )
      }

      /** Builds `{key: value}` only when `value` is defined, `{}` otherwise — the established
       *  "conditional spread, never construct with an explicit `undefined`" convention every other
       *  optional-field `Schema.Class` construction in this codebase uses (e.g.
       *  `calendar-service-live.ts`'s `...(seriesId !== undefined ? { seriesId } : {})`). */
      const optionalField = <K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } =>
        value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: V })

      const workoutKindForTags = (tagIds: ReadonlySet<EntityId>): Effect.Effect<"strength" | "cardio", UnexpectedError> =>
        tagIds.has(WorkoutTagIds.StrengthWorkout)
          ? Effect.succeed("strength" as const)
          : tagIds.has(WorkoutTagIds.CardioWorkout)
            ? Effect.succeed("cardio" as const)
            : Effect.fail(
                new UnexpectedError({
                  message: "workout root node is tagged neither Strength Workout nor Cardio Workout"
                })
              )

      /** Every root-node fact BOTH `WorkoutSummary` and `WorkoutDetail` need — read from facts
       *  directly (not from a `WorkoutImportReceipt`) so `getWorkout` (which has only a `nodeId`,
       *  no receipt) and `listWorkouts` (which starts from receipts) go through one shared,
       *  single-source-of-truth reconstruction path rather than two that could drift. */
      const readWorkoutRootFacts = (facts: ReadonlyArray<Fact>) =>
        Effect.gen(function* () {
          const sourceWorkoutId = yield* requiredFactValue(facts, WorkoutFactPredicate.SourceWorkoutId, Schema.String)
          const source = yield* requiredFactValue(facts, WorkoutFactPredicate.Source, WorkoutSource)
          const activity = yield* requiredFactValue(facts, WorkoutFactPredicate.Activity, WorkoutActivityKind)
          const rawActivity = yield* optionalFactValue(facts, WorkoutFactPredicate.RawActivity, Schema.String)
          const startedAt = yield* requiredFactValue(facts, WorkoutFactPredicate.StartedAt, IsoDateTimeString)
          const completedAt = yield* requiredFactValue(facts, WorkoutFactPredicate.CompletedAt, IsoDateTimeString)
          const durationSeconds = yield* requiredFactValue(facts, WorkoutFactPredicate.DurationSeconds, Schema.Number)
          const energyKilocalories = yield* optionalFactValue(facts, WorkoutFactPredicate.EnergyKilocalories, Schema.Number)
          const averageHeartRate = yield* optionalFactValue(facts, WorkoutFactPredicate.AverageHeartRate, Schema.Number)
          const maximumHeartRate = yield* optionalFactValue(facts, WorkoutFactPredicate.MaximumHeartRate, Schema.Number)
          return {
            sourceWorkoutId,
            source,
            activity,
            rawActivity,
            startedAt,
            completedAt,
            durationSeconds,
            energyKilocalories,
            averageHeartRate,
            maximumHeartRate
          }
        })

      const readStrengthSet = (setNodeId: EntityId): Effect.Effect<WorkoutStrengthSet, DomainError> =>
        Effect.gen(function* () {
          const facts = yield* factsForNode(setNodeId)
          const ordinal = yield* requiredFactValue(facts, WorkoutFactPredicate.Ordinal, Schema.Number)
          const repetitions = yield* requiredFactValue(facts, WorkoutFactPredicate.Repetitions, Schema.Number)
          const loadKilograms = yield* requiredFactValue(facts, WorkoutFactPredicate.LoadKilograms, Schema.Number)
          const volumeKilograms = yield* requiredFactValue(facts, WorkoutFactPredicate.VolumeKilograms, Schema.Number)
          const rpe = yield* optionalFactValue(facts, WorkoutFactPredicate.Rpe, Schema.Number)
          const completedAt = yield* optionalFactValue(facts, WorkoutFactPredicate.SetCompletedAt, IsoDateTimeString)
          return new WorkoutStrengthSet({
            nodeId: setNodeId,
            ordinal,
            repetitions,
            loadKilograms,
            volumeKilograms,
            ...optionalField("rpe", rpe),
            ...optionalField("completedAt", completedAt)
          })
        })

      const readStrengthExercise = (exerciseNodeId: EntityId): Effect.Effect<WorkoutStrengthExercise, DomainError> =>
        Effect.gen(function* () {
          const node = yield* nodesRepository.get(exerciseNodeId)
          const facts = yield* factsForNode(exerciseNodeId)
          const ordinal = yield* requiredFactValue(facts, WorkoutFactPredicate.Ordinal, Schema.Number)
          const volumeKilograms = yield* requiredFactValue(facts, WorkoutFactPredicate.ExerciseVolumeKilograms, Schema.Number)
          const setEdges = yield* edgesFromSource(exerciseNodeId).pipe(
            Effect.map((edges) => edges.filter((edge) => edge.relationDefinitionId === WorkoutRelationIds.ExerciseSets))
          )
          const sets = yield* Effect.forEach(setEdges, (edge) => readStrengthSet(edge.targetNodeId))
          return new WorkoutStrengthExercise({
            nodeId: exerciseNodeId,
            ordinal,
            name: node.title,
            volumeKilograms,
            sets: [...sets].sort((a, b) => a.ordinal - b.ordinal)
          })
        })

      const readCardioSplit = (splitNodeId: EntityId): Effect.Effect<WorkoutCardioSplit, DomainError> =>
        Effect.gen(function* () {
          const facts = yield* factsForNode(splitNodeId)
          const ordinal = yield* requiredFactValue(facts, WorkoutFactPredicate.Ordinal, Schema.Number)
          const distanceMeters = yield* requiredFactValue(facts, WorkoutFactPredicate.SplitDistanceMeters, Schema.Number)
          const durationSeconds = yield* requiredFactValue(facts, WorkoutFactPredicate.SplitDurationSeconds, Schema.Number)
          const paceSecondsPerKilometre = yield* optionalFactValue(facts, WorkoutFactPredicate.PaceSecondsPerKilometre, Schema.Number)
          const averageHeartRate = yield* optionalFactValue(facts, WorkoutFactPredicate.AverageHeartRate, Schema.Number)
          const energyKilocalories = yield* optionalFactValue(facts, WorkoutFactPredicate.EnergyKilocalories, Schema.Number)
          return new WorkoutCardioSplit({
            nodeId: splitNodeId,
            ordinal,
            distanceMeters,
            durationSeconds,
            ...optionalField("paceSecondsPerKilometre", paceSecondsPerKilometre),
            ...optionalField("averageHeartRate", averageHeartRate),
            ...optionalField("energyKilocalories", energyKilocalories)
          })
        })

      const readWorkoutDetailPayload = (
        rootNodeId: EntityId,
        kind: "strength" | "cardio",
        rootFacts: ReadonlyArray<Fact>
      ): Effect.Effect<WorkoutDetailPayload, DomainError> =>
        kind === "strength"
          ? Effect.gen(function* () {
              const exerciseEdges = yield* edgesFromSource(rootNodeId).pipe(
                Effect.map((edges) => edges.filter((edge) => edge.relationDefinitionId === WorkoutRelationIds.WorkoutExercises))
              )
              const exercises = yield* Effect.forEach(exerciseEdges, (edge) => readStrengthExercise(edge.targetNodeId))
              return {
                kind: "strength" as const,
                exercises: [...exercises].sort((a, b) => a.ordinal - b.ordinal)
              }
            })
          : Effect.gen(function* () {
              const splitEdges = yield* edgesFromSource(rootNodeId).pipe(
                Effect.map((edges) => edges.filter((edge) => edge.relationDefinitionId === WorkoutRelationIds.WorkoutSplits))
              )
              const splits = yield* Effect.forEach(splitEdges, (edge) => readCardioSplit(edge.targetNodeId))
              const distanceMeters = yield* optionalFactValue(rootFacts, WorkoutFactPredicate.DistanceMeters, Schema.Number)
              const elevationMeters = yield* optionalFactValue(rootFacts, WorkoutFactPredicate.ElevationMeters, Schema.Number)
              const averageSpeedMetersPerSecond = yield* optionalFactValue(
                rootFacts,
                WorkoutFactPredicate.AverageSpeedMetersPerSecond,
                Schema.Number
              )
              const averagePaceSecondsPerKilometre = yield* optionalFactValue(
                rootFacts,
                WorkoutFactPredicate.AveragePaceSecondsPerKilometre,
                Schema.Number
              )
              return {
                kind: "cardio" as const,
                splits: [...splits].sort((a, b) => a.ordinal - b.ordinal),
                ...optionalField("distanceMeters", distanceMeters),
                ...optionalField("elevationMeters", elevationMeters),
                ...optionalField("averageSpeedMetersPerSecond", averageSpeedMetersPerSecond),
                ...optionalField("averagePaceSecondsPerKilometre", averagePaceSecondsPerKilometre)
              }
            })

      const buildWorkoutSummary = (receipt: WorkoutImportReceipt): Effect.Effect<WorkoutSummary, DomainError> =>
        Effect.gen(function* () {
          const facts = yield* factsForNode(receipt.rootNodeId)
          const tagIds = yield* tagIdsForNode(receipt.rootNodeId)
          const kind = yield* workoutKindForTags(tagIds)
          const root = yield* readWorkoutRootFacts(facts)
          return new WorkoutSummary({
            nodeId: receipt.rootNodeId,
            workspaceId: receipt.workspaceId,
            sourceWorkoutId: root.sourceWorkoutId,
            source: root.source,
            kind,
            activity: root.activity,
            startedAt: root.startedAt,
            completedAt: root.completedAt,
            durationSeconds: root.durationSeconds,
            ...optionalField("rawActivity", root.rawActivity),
            ...optionalField("energyKilocalories", root.energyKilocalories),
            ...optionalField("averageHeartRate", root.averageHeartRate),
            ...optionalField("maximumHeartRate", root.maximumHeartRate)
          })
        })

      /** Mirrors `workspace-durable-object.ts#createNode`'s own inline node-creation dance exactly
       *  (repository write, read-model `upsertNode`/`indexNodeText` sync, sync-feed append) — see
       *  this file's header comment for why this is the "no new mechanism" primitive rather than
       *  a workout-specific write path. `title`-only text indexing (empty body), same as every
       *  node created without a `Page` (`createNode`'s own established behavior). */
      const createGraphNode = (workspaceId: EntityId, title: string): Effect.Effect<NodeEntity, DomainError> =>
        Effect.gen(function* () {
          const node = new NodeEntity({
            id: crypto.randomUUID() as EntityId,
            workspaceId,
            title,
            createdAt: nowIso()
          })
          const created = yield* nodesRepository.put(node)
          yield* upsertNode(sql, created)
          yield* indexNodeText(sql, created.id, created.title, "")
          yield* syncFeed.append("node", created.id, "put", created)
          return created
        })

      const importStrengthExercises = (
        workspaceId: EntityId,
        rootNodeId: EntityId,
        exercises: ReadonlyArray<StrengthExerciseImportInput>
      ): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          yield* requireContiguousOrdinals("exercise", exercises.map((e) => e.ordinal))
          const sortedExercises = [...exercises].sort((a, b) => a.ordinal - b.ordinal)
          for (const exercise of sortedExercises) {
            yield* requireContiguousOrdinals(
              `exercise #${exercise.ordinal} ("${exercise.name}") set`,
              exercise.sets.map((s) => s.ordinal)
            )
            const exerciseNode = yield* createGraphNode(workspaceId, exercise.name)
            yield* graph.assignTag(workspaceId, exerciseNode.id, WorkoutTagIds.StrengthExercise)
            const volumeKilograms = exercise.sets.reduce((sum, set) => sum + set.repetitions * set.loadKilograms, 0)
            yield* graph.addFact(workspaceId, exerciseNode.id, WorkoutFactPredicate.Ordinal, exercise.ordinal)
            yield* graph.addFact(workspaceId, exerciseNode.id, WorkoutFactPredicate.ExerciseSetCount, exercise.sets.length)
            yield* graph.addFact(workspaceId, exerciseNode.id, WorkoutFactPredicate.ExerciseVolumeKilograms, volumeKilograms)
            yield* graph.createEdge(workspaceId, WorkoutRelationIds.WorkoutExercises, rootNodeId, exerciseNode.id)

            const sortedSets = [...exercise.sets].sort((a, b) => a.ordinal - b.ordinal)
            for (const set of sortedSets) {
              const setNode = yield* createGraphNode(workspaceId, `Set ${set.ordinal}`)
              yield* graph.assignTag(workspaceId, setNode.id, WorkoutTagIds.StrengthSet)
              yield* graph.addFact(workspaceId, setNode.id, WorkoutFactPredicate.Ordinal, set.ordinal)
              yield* graph.addFact(workspaceId, setNode.id, WorkoutFactPredicate.Repetitions, set.repetitions)
              yield* graph.addFact(workspaceId, setNode.id, WorkoutFactPredicate.LoadKilograms, set.loadKilograms)
              yield* graph.addFact(
                workspaceId,
                setNode.id,
                WorkoutFactPredicate.VolumeKilograms,
                set.repetitions * set.loadKilograms
              )
              if (set.rpe !== undefined) yield* graph.addFact(workspaceId, setNode.id, WorkoutFactPredicate.Rpe, set.rpe)
              if (set.completedAt !== undefined) {
                yield* graph.addFact(workspaceId, setNode.id, WorkoutFactPredicate.SetCompletedAt, set.completedAt)
              }
              yield* graph.createEdge(workspaceId, WorkoutRelationIds.ExerciseSets, exerciseNode.id, setNode.id)
            }
          }
        })

      const importCardioSplits = (
        workspaceId: EntityId,
        rootNodeId: EntityId,
        splits: ReadonlyArray<CardioSplitImportInput>
      ): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          if (splits.length === 0) return
          yield* requireContiguousOrdinals("split", splits.map((s) => s.ordinal))
          const sortedSplits = [...splits].sort((a, b) => a.ordinal - b.ordinal)
          for (const split of sortedSplits) {
            const splitNode = yield* createGraphNode(workspaceId, `Split ${split.ordinal}`)
            yield* graph.assignTag(workspaceId, splitNode.id, WorkoutTagIds.CardioSplit)
            yield* graph.addFact(workspaceId, splitNode.id, WorkoutFactPredicate.Ordinal, split.ordinal)
            yield* graph.addFact(workspaceId, splitNode.id, WorkoutFactPredicate.SplitDistanceMeters, split.distanceMeters)
            yield* graph.addFact(workspaceId, splitNode.id, WorkoutFactPredicate.SplitDurationSeconds, split.durationSeconds)
            if (split.distanceMeters > 0) {
              yield* graph.addFact(
                workspaceId,
                splitNode.id,
                WorkoutFactPredicate.PaceSecondsPerKilometre,
                (split.durationSeconds / split.distanceMeters) * 1000
              )
            }
            if (split.averageHeartRate !== undefined) {
              yield* graph.addFact(workspaceId, splitNode.id, WorkoutFactPredicate.AverageHeartRate, split.averageHeartRate)
            }
            if (split.energyKilocalories !== undefined) {
              yield* graph.addFact(
                workspaceId,
                splitNode.id,
                WorkoutFactPredicate.EnergyKilocalories,
                split.energyKilocalories
              )
            }
            yield* graph.createEdge(workspaceId, WorkoutRelationIds.WorkoutSplits, rootNodeId, splitNode.id)
          }
        })

      const importWorkoutSubgraph = (
        workspaceId: EntityId,
        rootNodeId: EntityId,
        payload: WorkoutImportPayload
      ): Effect.Effect<void, DomainError> =>
        payload.kind === "strength"
          ? importStrengthExercises(workspaceId, rootNodeId, payload.exercises)
          : importCardioSplits(workspaceId, rootNodeId, payload.splits)

      const buildRootFacts = (
        workspaceId: EntityId,
        item: WorkoutImportItem,
        rootNodeId: EntityId
      ): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.StartedAt, item.startedAt)
          yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.CompletedAt, item.completedAt)
          yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.DurationSeconds, item.durationSeconds)
          yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.Activity, item.activity)
          yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.Source, item.source)
          yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.SourceWorkoutId, item.sourceWorkoutId)
          if (item.rawActivity !== undefined) {
            yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.RawActivity, item.rawActivity)
          }
          if (item.energyKilocalories !== undefined) {
            yield* graph.addFact(
              workspaceId,
              rootNodeId,
              WorkoutFactPredicate.EnergyKilocalories,
              item.energyKilocalories
            )
          }
          if (item.averageHeartRate !== undefined) {
            yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.AverageHeartRate, item.averageHeartRate)
          }
          if (item.maximumHeartRate !== undefined) {
            yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.MaximumHeartRate, item.maximumHeartRate)
          }

          if (item.payload.kind === "strength") {
            const exerciseCount = item.payload.exercises.length
            const setCount = item.payload.exercises.reduce((sum, e) => sum + e.sets.length, 0)
            const totalVolumeKilograms = item.payload.exercises.reduce(
              (sum, e) => sum + e.sets.reduce((setSum, s) => setSum + s.repetitions * s.loadKilograms, 0),
              0
            )
            yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.ExerciseCount, exerciseCount)
            yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.SetCount, setCount)
            yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.TotalVolumeKilograms, totalVolumeKilograms)
          } else {
            const { splits, distanceMeters, elevationMeters, averageSpeedMetersPerSecond, averagePaceSecondsPerKilometre } =
              item.payload
            yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.SplitCount, splits.length)
            if (distanceMeters !== undefined) {
              yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.DistanceMeters, distanceMeters)
            }
            if (elevationMeters !== undefined) {
              yield* graph.addFact(workspaceId, rootNodeId, WorkoutFactPredicate.ElevationMeters, elevationMeters)
            }
            if (averageSpeedMetersPerSecond !== undefined) {
              yield* graph.addFact(
                workspaceId,
                rootNodeId,
                WorkoutFactPredicate.AverageSpeedMetersPerSecond,
                averageSpeedMetersPerSecond
              )
            }
            if (averagePaceSecondsPerKilometre !== undefined) {
              yield* graph.addFact(
                workspaceId,
                rootNodeId,
                WorkoutFactPredicate.AveragePaceSecondsPerKilometre,
                averagePaceSecondsPerKilometre
              )
            }
          }
        })

      /** The subgraph-plus-receipt write for one NEW (non-duplicate, non-conflicting) workout —
       *  everything `importOneWorkout` below still has to do once it knows this is a fresh import.
       *  Every step here is itself already synchronous under the hood (`typed-storage-effect`'s
       *  `Collection.put`/`NodesRepository.put`/`GraphService.addFact`/`assignTag`/`createEdge`
       *  are all `Effect.try`-wrapped synchronous DO-SQLite operations, never real async I/O — see
       *  `sync-feed-service-live.ts`'s `fnv1aHash` doc comment for the same constraint stated
       *  elsewhere in this codebase), which is exactly what makes running this program via
       *  `Effect.runSyncExit` from inside a plain synchronous `storage.transactionSync()` callback
       *  safe: nothing here can suspend on genuine I/O, so `runSyncExit` always resolves to a real
       *  `Exit` in the same tick, never a defect from an incomplete synchronous run.
       *
       *  **Why this needs its own transaction at all (adversarial-review fix):** confirmed for
       *  real that `typed-storage-effect` commits each collection `.put()` in its own independent
       *  `storage.transactionSync()` (`collection.ts`), not one enclosing transaction across a
       *  whole multi-write import — a strength session with 5 exercises × 4 sets is ~40 separate
       *  node/tag/fact/edge writes, each independently durable. A request killed mid-write
       *  (production CPU limit, DO eviction, or hibernation) between any two of those forty writes
       *  would previously leave an orphaned partial exercise/set subgraph with no
       *  `WorkoutImportReceipt` referencing it — invisible to `listWorkouts`/`listWorkoutImports`,
       *  un-deduped on retry (no receipt means the next `importWorkout` call for the same
       *  `sourceWorkoutId` sees no existing receipt and imports the whole thing again), and never
       *  cleaned up. Wrapping the whole thing in one outer `storage.transactionSync()` makes it
       *  atomic: either every node/tag/fact/edge write AND the receipt commit together, or (DO
       *  storage's own transaction semantics) none of them do — confirmed empirically against real
       *  `workerd` that this DO's SQLite-backed storage permits nesting (an outer
       *  `transactionSync()` wrapping typed-storage-effect's own per-`.put()` inner
       *  `transactionSync()` calls commits both layers together), so this doesn't fight the
       *  existing per-collection transaction usage, it subsumes it. */
      const writeSubgraphAndReceipt = (
        workspaceId: EntityId,
        item: WorkoutImportItem,
        payloadHash: string
      ): Effect.Effect<{ receipt: WorkoutImportReceipt; duplicate: boolean }, DomainError> =>
        Effect.gen(function* () {
          const rootTagId = item.payload.kind === "strength" ? WorkoutTagIds.StrengthWorkout : WorkoutTagIds.CardioWorkout
          const rootNode = yield* createGraphNode(workspaceId, `${activityLabel(item.activity)} workout`)
          yield* graph.assignTag(workspaceId, rootNode.id, rootTagId)
          yield* buildRootFacts(workspaceId, item, rootNode.id)
          yield* importWorkoutSubgraph(workspaceId, rootNode.id, item.payload)

          const receipt = new WorkoutImportReceipt({
            id: crypto.randomUUID() as EntityId,
            workspaceId,
            sourceWorkoutId: item.sourceWorkoutId,
            source: item.source,
            payloadHash,
            rootNodeId: rootNode.id,
            importedAt: nowIso()
          })
          yield* collections.workoutImportReceipts.put(receipt).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("workoutImportReceipt", receipt.id, "put", receipt)

          return { receipt, duplicate: false }
        })

      /** Runs `writeSubgraphAndReceipt` synchronously inside one `storage.transactionSync()` —
       *  see that function's own doc comment for why this is safe and why it's needed. Lifted back
       *  into Effect via `Effect.suspend` + `Exit.match` so a failure inside the transaction
       *  (`ValidationError` from a defense-in-depth ordinal re-check, `UnexpectedError` from a
       *  storage error) still propagates as a normal typed `DomainError` failure to
       *  `importOneWorkout`'s caller, exactly as it would have without the transaction wrapper —
       *  this changes atomicity, not error semantics. */
      const writeSubgraphAndReceiptTransactionally = (
        workspaceId: EntityId,
        item: WorkoutImportItem,
        payloadHash: string
      ): Effect.Effect<{ receipt: WorkoutImportReceipt; duplicate: boolean }, DomainError> =>
        Effect.suspend(() =>
          Exit.match(storage.transactionSync(() => Effect.runSyncExit(writeSubgraphAndReceipt(workspaceId, item, payloadHash))), {
            onFailure: Effect.failCause,
            onSuccess: Effect.succeed
          })
        )

      /** The shared core both `importWorkout` (single) and `importWorkouts` (batch) call — one
       *  workout, one workspace, the identical idempotent-upsert-by-`sourceWorkoutId` dance
       *  `WorkoutImportReceipt`'s own doc comment describes ("mirrors Enchiridion's own
       *  `workout_import_receipts` table"), same as Phase 5's calendar sync deduping on
       *  `providerEventId`. */
      const importOneWorkout = (
        workspaceId: EntityId,
        item: WorkoutImportItem
      ): Effect.Effect<{ receipt: WorkoutImportReceipt; duplicate: boolean }, DomainError> =>
        Effect.gen(function* () {
          yield* validatePayloadOrdinals(item.payload)
          yield* ensureWorkoutTagsSeeded(tagsCollections, tagClosureCollections, relationDefinitionsCollections, sql)

          const payloadHash = yield* computePayloadHash(item)

          const existingRaw = yield* collections.workoutImportReceipts.bySourceWorkoutId
            .get(item.sourceWorkoutId)
            .pipe(Effect.mapError(toUnexpectedError))
          if (existingRaw !== undefined) {
            const existing = yield* reviveWorkoutImportReceipt(existingRaw)
            if (existing.workspaceId === workspaceId && existing.payloadHash === payloadHash) {
              return { receipt: existing, duplicate: true }
            }
            // Cross-workspace collision is a genuine caller-bug-shaped validation failure (this
            // workspace's `sourceWorkoutId` namespace was never claimed by the other workspace's import at
            // all — nothing here is "the same identity, different content", so `ValidationError`
            // stays correct for this branch). Same-workspace-different-content is the one case
            // `WorkoutImportConflict` (errors.ts) exists for — a purpose-built tag so a caller
            // (native `WorkoutImportBridge`, web) can type-safely distinguish a genuine
            // content-collision conflict from any unrelated validation failure, rather than having
            // to string-match a generic `ValidationError.message` (adversarial-review fix: this
            // branch previously raised the generic `ValidationError` for the exact scenario
            // `WorkoutImportConflict` was designed for, defeating the reason the tag was added).
            if (existing.workspaceId !== workspaceId) {
              return yield* Effect.fail(
                new ValidationError({
                  message: `workout ${item.sourceWorkoutId} was already imported into a different workspace`
                })
              )
            }
            return yield* Effect.fail(
              new WorkoutImportConflict({
                sourceWorkoutId: item.sourceWorkoutId,
                message:
                  `workout ${item.sourceWorkoutId} was already imported with different content ` +
                  `(payload hash ${existing.payloadHash} !== ${payloadHash}) — re-import under a new sourceWorkoutId if this is intentional`
              })
            )
          }

          return yield* writeSubgraphAndReceiptTransactionally(workspaceId, item, payloadHash)
        })

      const importWorkout: WorkoutsServiceApi["importWorkout"] = (input) =>
        importOneWorkout(input.workspaceId, toWorkoutImportItem(input))

      const listWorkoutImports: WorkoutsServiceApi["listWorkoutImports"] = (workspaceId) =>
        collections.workoutImportReceipts.byWorkspaceId.get(workspaceId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((rows) => Effect.forEach(rows, reviveWorkoutImportReceipt)),
          Effect.map((receipts) => [...receipts].sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1)))
        )

      /** Per-item independent outcomes, sequential (not `{ concurrency: "unbounded" }`): each
       *  item's `importOneWorkout` call already does a read-then-write dedupe check against
       *  `bySourceWorkoutId` and a lazy tag-seeding read-then-maybe-write — running items
       *  concurrently would reopen exactly the kind of interleaved-read-before-either-write race
       *  `createEdgeTestHook` (`graph-service-live.ts`) exists to let a test deliberately provoke
       *  elsewhere in this codebase; sequential avoids it here without needing that machinery.
       *  Preserves `items`' input order in the result array, per `ImportWorkoutsOutput`'s own
       *  doc comment. */
      const importWorkouts: WorkoutsServiceApi["importWorkouts"] = (workspaceId, items) =>
        Effect.forEach(items, (item) =>
          importOneWorkout(workspaceId, item).pipe(
            Effect.map(
              ({ receipt, duplicate }): WorkoutImportBatchItemResult =>
                new WorkoutImportSucceeded({
                  outcome: "imported",
                  sourceWorkoutId: item.sourceWorkoutId,
                  receipt,
                  duplicate
                })
            ),
            Effect.catchAll((error) =>
              Effect.succeed(
                new WorkoutImportFailed({
                  outcome: "failed",
                  sourceWorkoutId: item.sourceWorkoutId,
                  message: domainErrorMessage(error)
                }) satisfies WorkoutImportBatchItemResult
              )
            )
          )
        )

      const listWorkouts: WorkoutsServiceApi["listWorkouts"] = (workspaceId) =>
        collections.workoutImportReceipts.byWorkspaceId.get(workspaceId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((rows) => Effect.forEach(rows, reviveWorkoutImportReceipt)),
          Effect.flatMap((receipts) => Effect.forEach(receipts, buildWorkoutSummary)),
          Effect.map((summaries) => [...summaries].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)))
        )

      const getWorkout: WorkoutsServiceApi["getWorkout"] = (workspaceId, nodeId) =>
        Effect.gen(function* () {
          // `NodesRepository.get`'s storage is already scoped to this one `WorkspaceDurableObject`
          // instance (one DO per workspace, per the plan's own sharding decision) — same reasoning
          // `getNode` (`workspace-durable-object.ts`) relies on for not separately checking
          // `node.workspaceId === workspaceId` beyond the `requireOwnWorkspace(this.#workspaceId, decoded.workspaceId)`
          // gate already run at the RPC boundary before this service method is ever called.
          yield* nodesRepository
            .get(nodeId)
            .pipe(Effect.catchTag("NodeNotFound", () => Effect.fail(new WorkoutNotFound({ nodeId }))))

          const tagIds = yield* tagIdsForNode(nodeId)
          const kind = yield* workoutKindForTags(tagIds).pipe(
            // Not tagged Workout at all (or tagged something else entirely) — `WorkoutNotFound`,
            // not the underlying `UnexpectedError`, per `GetWorkoutInput`'s own doc comment: "not
            // a workout root" is this method's own well-known failure, not a corrupt-data defect.
            Effect.catchTag("UnexpectedError", () => Effect.fail(new WorkoutNotFound({ nodeId })))
          )

          const facts = yield* factsForNode(nodeId)
          const root = yield* readWorkoutRootFacts(facts)
          const payload = yield* readWorkoutDetailPayload(nodeId, kind, facts)

          return new WorkoutDetail({
            nodeId,
            workspaceId,
            sourceWorkoutId: root.sourceWorkoutId,
            source: root.source,
            activity: root.activity,
            startedAt: root.startedAt,
            completedAt: root.completedAt,
            durationSeconds: root.durationSeconds,
            ...optionalField("rawActivity", root.rawActivity),
            ...optionalField("energyKilocalories", root.energyKilocalories),
            ...optionalField("averageHeartRate", root.averageHeartRate),
            ...optionalField("maximumHeartRate", root.maximumHeartRate),
            payload
          })
        })

      return {
        importWorkout,
        listWorkoutImports,
        importWorkouts,
        listWorkouts,
        getWorkout
      } satisfies WorkoutsServiceApi
    })
  )
