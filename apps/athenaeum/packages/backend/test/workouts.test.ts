// `WorkoutsService`/`importWorkout`/`listWorkoutImports` end-to-end tests — Phase 7 (plan
// §"Phased delivery": "HealthKit import as typed graph pages, proves graph generality, no new
// mechanism"). Runs over REAL Cap'n Web RPC against a REAL `WorkspaceDurableObject`
// (`connectToWorkspace`/`connectToWorkspaceWithSocketAs`, same harness every other backend test in this
// suite uses) — every RPC decode/encode, `requireRoleForGovernedWorkspace` gating, tag/relation
// seeding, and `typed-storage-effect`/read-model write runs for real. Graph shape (which nodes got
// which tags, which edges connect them, which facts landed on them) is verified through the same
// `runView` surface a real client would use (`graph_node_tags`/`graph_edges`/`graph_facts`), not
// by reaching into DO internals.

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  CreateNodeInput,
  CreateNodeOutput,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
  GetWorkoutInput,
  GetWorkoutOutput,
  ImportWorkoutInput,
  ImportWorkoutOutput,
  ImportWorkoutsInput,
  ImportWorkoutsOutput,
  IsoDateTimeString,
  ListWorkoutImportsInput,
  ListWorkoutImportsOutput,
  ListWorkoutsInput,
  ListWorkoutsOutput,
  RunViewInput,
  RunViewOutput,
  ViewSpec,
  WorkoutImportItem,
  WorkoutRelationIds,
  WorkoutTagIds,
  type EntityId,
  type GraphViewName,
  type ViewPredicate
} from "@athenaeum/domain"
import {
  connectToUserAs,
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  rejectionToDomainError
} from "./support.js"

/** A strength session: 2 exercises, the first with 3 sets, the second with 2 — the same
 *  "multiple exercises/sets" fixture shape the task's own hard constraint asks
 *  `SyntheticWorkoutDataSource` (native) to produce, mirrored here in wire-payload form so the
 *  backend's transformation/import logic is proven independent of the native pipeline too. */
const strengthPayload = (workspaceId: EntityId, sourceWorkoutId: string): ImportWorkoutInput =>
  new ImportWorkoutInput({
    workspaceId,
    sourceWorkoutId,
    source: "synthetic",
    activity: "strength-training",
    startedAt: IsoDateTimeString.make("2026-08-15T09:00:00.000Z"),
    completedAt: IsoDateTimeString.make("2026-08-15T09:45:00.000Z"),
    durationSeconds: 2700,
    energyKilocalories: 320,
    averageHeartRate: 118,
    maximumHeartRate: 152,
    payload: {
      kind: "strength",
      exercises: [
        {
          ordinal: 1,
          name: "Back Squat",
          sets: [
            { ordinal: 1, repetitions: 8, loadKilograms: 60 },
            { ordinal: 2, repetitions: 8, loadKilograms: 65 },
            { ordinal: 3, repetitions: 6, loadKilograms: 70, rpe: 8 }
          ]
        },
        {
          ordinal: 2,
          name: "Bench Press",
          sets: [
            { ordinal: 1, repetitions: 10, loadKilograms: 40 },
            { ordinal: 2, repetitions: 8, loadKilograms: 45 }
          ]
        }
      ]
    }
  })

/** A cardio session with 3 distance splits — the task's own "cardio session with distance/pace"
 *  fixture shape. */
const cardioPayload = (workspaceId: EntityId, sourceWorkoutId: string): ImportWorkoutInput =>
  new ImportWorkoutInput({
    workspaceId,
    sourceWorkoutId,
    source: "synthetic",
    activity: "running",
    startedAt: IsoDateTimeString.make("2026-08-16T07:00:00.000Z"),
    completedAt: IsoDateTimeString.make("2026-08-16T07:32:00.000Z"),
    durationSeconds: 1920,
    energyKilocalories: 410,
    averageHeartRate: 152,
    maximumHeartRate: 171,
    payload: {
      kind: "cardio",
      splits: [
        { ordinal: 1, distanceMeters: 1000, durationSeconds: 300, averageHeartRate: 148 },
        { ordinal: 2, distanceMeters: 1000, durationSeconds: 295, averageHeartRate: 153 },
        { ordinal: 3, distanceMeters: 1000, durationSeconds: 310, averageHeartRate: 156 }
      ],
      distanceMeters: 3000,
      elevationMeters: 12,
      averageSpeedMetersPerSecond: 3.1,
      averagePaceSecondsPerKilometre: 322
    }
  })

/** Every column each view used by this suite has (`read-model.ts`'s own `VIEW_COLUMNS`
 *  allowlist) — `ViewSpec.visibleColumns` must name at least one real column (empty is rejected
 *  with `ValidationError`), so every call below asks for all of them rather than an arbitrary
 *  subset. */
const VIEW_COLUMNS_FOR_TEST: { readonly [K in GraphViewName]?: ReadonlyArray<string> } = {
  graph_nodes: ["id", "workspaceId", "title", "createdAt"],
  graph_tags: ["id", "name", "builtin"],
  graph_node_tags: ["nodeId", "tagId"],
  graph_facts: ["id", "nodeId", "predicateId", "value"],
  graph_relation_definitions: ["id", "forwardName", "inverseName", "sourceTagId", "targetTagId", "cardinality"],
  graph_edges: ["id", "relationDefinitionId", "sourceNodeId", "targetNodeId"]
}

const runViewRows = async (
  stub: Awaited<ReturnType<typeof connectToWorkspace>>,
  workspaceId: EntityId,
  viewName: GraphViewName,
  filter?: ViewPredicate
) => {
  const spec = new ViewSpec({
    view: "table",
    ...(filter !== undefined ? { filter } : {}),
    visibleColumns: VIEW_COLUMNS_FOR_TEST[viewName] ?? ["id"],
    rowLimit: 200
  })
  const output = Schema.decodeUnknownSync(RunViewOutput)(
    await stub.runView(Schema.encodeSync(RunViewInput)(new RunViewInput({ workspaceId, viewName, viewSpec: spec })))
  )
  return output.rows as ReadonlyArray<Record<string, unknown>>
}

describe("WorkoutsService: importWorkout/listWorkoutImports", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("imports a strength workout as a Workout/Strength Workout/Strength Exercise/Strength Set node subgraph", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const input = strengthPayload(workspaceId, `synthetic-strength-${crypto.randomUUID()}`)
    const encoded = Schema.encodeSync(ImportWorkoutInput)(input)
    const output = Schema.decodeUnknownSync(ImportWorkoutOutput)(await workspaceStub.importWorkout(encoded))

    expect(output.duplicate).toBe(false)
    const rootNodeId = output.receipt.rootNodeId

    // `ViewSpec`'s `eq`/`in` ops JSON-encode their bound parameter (`read-model.ts`'s `jsonParam`,
    // shared with `graph_facts.value` comparisons), which only round-trips against columns that
    // are THEMSELVES stored JSON-encoded — true for `graph_facts.value`, not for a plain string
    // column like `nodeId`/`sourceNodeId` (stored as plain unquoted TEXT). So every assertion
    // below fetches the full (small, per-test-workspace) view unfiltered and filters/joins in JS,
    // rather than pushing an `eq` predicate onto a plain-string column the compiler can't actually
    // match — a real, load-bearing finding about `runView`'s current filter semantics, not a
    // workaround for a bug this task's scope covers fixing.
    const nodeTags = await runViewRows(workspaceStub, workspaceId, "graph_node_tags")
    const edges = await runViewRows(workspaceStub, workspaceId, "graph_edges")
    const facts = await runViewRows(workspaceStub, workspaceId, "graph_facts")

    // Root node carries the Strength Workout tag (and transitively Workout, via tagClosure).
    const rootTagRows = nodeTags.filter((r) => r.nodeId === rootNodeId)
    expect(rootTagRows.map((r) => r.tagId)).toEqual([WorkoutTagIds.StrengthWorkout])

    // Two exercise edges out of the root, under the workoutExercises relation.
    const exerciseEdges = edges.filter(
      (e) => e.sourceNodeId === rootNodeId && e.relationDefinitionId === WorkoutRelationIds.WorkoutExercises
    )
    expect(exerciseEdges).toHaveLength(2)

    // Each exercise has its own sets, reachable via exerciseSets edges.
    let totalSets = 0
    for (const edge of exerciseEdges) {
      const exerciseNodeId = edge.targetNodeId as EntityId
      const setEdges = edges.filter(
        (e) => e.sourceNodeId === exerciseNodeId && e.relationDefinitionId === WorkoutRelationIds.ExerciseSets
      )
      totalSets += setEdges.length
    }
    expect(totalSets).toBe(5) // 3 + 2 sets across the two exercises

    // Root-level roll-up facts match the payload. `graph_facts.value` is stored JSON-encoded
    // (`read-model.ts#upsertFact`: `JSON.stringify(fact.value)`) and `runView` returns it as the
    // raw stored TEXT, not re-decoded — a real, previously-unexercised finding (no prior test in
    // this suite reads `graph_facts.value` back through `runView`): a caller must `JSON.parse`
    // each value itself to recover its original type (number/string/boolean), same as reading any
    // other JSON-in-a-TEXT-column value straight out of SQLite.
    const rootFacts = facts.filter((f) => f.nodeId === rootNodeId)
    const factsByPredicate = Object.fromEntries(
      rootFacts.map((f) => [f.predicateId, JSON.parse(f.value as string) as unknown])
    )
    expect(factsByPredicate["exercise-count"]).toBe(2)
    expect(factsByPredicate["set-count"]).toBe(5)
    expect(factsByPredicate["total-volume-kilograms"]).toBe(8 * 60 + 8 * 65 + 6 * 70 + 10 * 40 + 8 * 45)
    expect(factsByPredicate["activity"]).toBe("strength-training")
    expect(factsByPredicate["source-workout-id"]).toBe(input.sourceWorkoutId)
  })

  it("imports a cardio workout as a Workout/Cardio Workout/Cardio Split node subgraph", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const input = cardioPayload(workspaceId, `synthetic-cardio-${crypto.randomUUID()}`)
    const encoded = Schema.encodeSync(ImportWorkoutInput)(input)
    const output = Schema.decodeUnknownSync(ImportWorkoutOutput)(await workspaceStub.importWorkout(encoded))
    expect(output.duplicate).toBe(false)
    const rootNodeId = output.receipt.rootNodeId

    // See the strength test above for why this fetches unfiltered + filters in JS.
    const nodeTags = await runViewRows(workspaceStub, workspaceId, "graph_node_tags")
    const edges = await runViewRows(workspaceStub, workspaceId, "graph_edges")
    const facts = await runViewRows(workspaceStub, workspaceId, "graph_facts")

    const rootTagRows = nodeTags.filter((r) => r.nodeId === rootNodeId)
    expect(rootTagRows.map((r) => r.tagId)).toEqual([WorkoutTagIds.CardioWorkout])

    const splitEdges = edges.filter(
      (e) => e.sourceNodeId === rootNodeId && e.relationDefinitionId === WorkoutRelationIds.WorkoutSplits
    )
    expect(splitEdges).toHaveLength(3)

    const rootFacts = facts.filter((f) => f.nodeId === rootNodeId)
    const factsByPredicate = Object.fromEntries(
      rootFacts.map((f) => [f.predicateId, JSON.parse(f.value as string) as unknown])
    )
    expect(factsByPredicate["split-count"]).toBe(3)
    expect(factsByPredicate["distance-meters"]).toBe(3000)
    expect(factsByPredicate["average-pace-seconds-per-kilometre"]).toBe(322)
  })

  it("re-importing the same sourceWorkoutId with identical content is an idempotent no-op", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const input = strengthPayload(workspaceId, `synthetic-idempotent-${crypto.randomUUID()}`)
    const encoded = Schema.encodeSync(ImportWorkoutInput)(input)

    const first = Schema.decodeUnknownSync(ImportWorkoutOutput)(await workspaceStub.importWorkout(encoded))
    expect(first.duplicate).toBe(false)

    const second = Schema.decodeUnknownSync(ImportWorkoutOutput)(await workspaceStub.importWorkout(encoded))
    expect(second.duplicate).toBe(true)
    expect(second.receipt.id).toBe(first.receipt.id)
    expect(second.receipt.rootNodeId).toBe(first.receipt.rootNodeId)

    // No second subgraph was created: only one receipt exists for this workspace.
    const receipts = Schema.decodeUnknownSync(ListWorkoutImportsOutput)(
      await workspaceStub.listWorkoutImports(Schema.encodeSync(ListWorkoutImportsInput)(new ListWorkoutImportsInput({ workspaceId })))
    ).receipts
    expect(receipts).toHaveLength(1)
  })

  it("re-importing the same sourceWorkoutId with DIFFERENT content fails closed (WorkoutImportConflict)", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const sourceWorkoutId = `synthetic-conflict-${crypto.randomUUID()}`
    const first = strengthPayload(workspaceId, sourceWorkoutId)
    await workspaceStub.importWorkout(Schema.encodeSync(ImportWorkoutInput)(first))

    const second = cardioPayload(workspaceId, sourceWorkoutId) // same id, genuinely different content/shape
    const error = await rejectionToDomainError(workspaceStub.importWorkout(Schema.encodeSync(ImportWorkoutInput)(second)))
    // Dedicated tag (not the generic ValidationError), so a caller can type-safely distinguish a
    // genuine content-collision conflict from any unrelated validation failure — see
    // `workouts-service-live.ts#importOneWorkout`'s doc comment on this branch.
    expect(error._tag).toBe("WorkoutImportConflict")
    if (error._tag === "WorkoutImportConflict") {
      expect(error.sourceWorkoutId).toBe(sourceWorkoutId)
    }
  })

  it("rejects non-contiguous set ordinals before writing any node (ValidationError)", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const input = strengthPayload(workspaceId, `synthetic-bad-ordinals-${crypto.randomUUID()}`)
    const broken = new ImportWorkoutInput({
      ...input,
      payload: {
        kind: "strength",
        exercises: [
          {
            ordinal: 1,
            name: "Deadlift",
            sets: [
              { ordinal: 1, repetitions: 5, loadKilograms: 100 },
              { ordinal: 3, repetitions: 5, loadKilograms: 100 } // gap: 2 is missing
            ]
          }
        ]
      }
    })
    const error = await rejectionToDomainError(workspaceStub.importWorkout(Schema.encodeSync(ImportWorkoutInput)(broken)))
    expect(error._tag).toBe("ValidationError")

    const nodes = await runViewRows(workspaceStub, workspaceId, "graph_nodes")
    expect(nodes).toHaveLength(0) // nothing was written — the ordinal check runs before any node creation
  })

  it("seeds the 6 workout tags + 3 relation definitions exactly once per workspace, idempotently", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const tagsBefore = await runViewRows(workspaceStub, workspaceId, "graph_tags")
    expect(tagsBefore).toHaveLength(8) // just the Base Tags, workout tags not seeded yet

    await workspaceStub.importWorkout(
      Schema.encodeSync(ImportWorkoutInput)(strengthPayload(workspaceId, `synthetic-seed-1-${crypto.randomUUID()}`))
    )
    const tagsAfterFirst = await runViewRows(workspaceStub, workspaceId, "graph_tags")
    expect(tagsAfterFirst).toHaveLength(14) // 8 Base Tags + 6 Workout tags

    await workspaceStub.importWorkout(
      Schema.encodeSync(ImportWorkoutInput)(cardioPayload(workspaceId, `synthetic-seed-2-${crypto.randomUUID()}`))
    )
    const tagsAfterSecond = await runViewRows(workspaceStub, workspaceId, "graph_tags")
    expect(tagsAfterSecond).toHaveLength(14) // unchanged — no duplicate seeding

    const relationDefinitions = await runViewRows(workspaceStub, workspaceId, "graph_relation_definitions")
    // 3 workout relation definitions + the fixed "mentions" relation, unconditionally seeded on
    // every workspace at DO construction alongside the 8 Base Tags (rich-text-editor pass,
    // `mention-seed.ts#ensureMentionRelationSeeded`) — present here even though this test never
    // touches the rich-text editor at all.
    expect(relationDefinitions).toHaveLength(4)
  })

  it("listWorkoutImports lists receipts most-recently-imported first", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const firstOut = Schema.decodeUnknownSync(ImportWorkoutOutput)(
      await workspaceStub.importWorkout(
        Schema.encodeSync(ImportWorkoutInput)(strengthPayload(workspaceId, `synthetic-order-1-${crypto.randomUUID()}`))
      )
    )
    const secondOut = Schema.decodeUnknownSync(ImportWorkoutOutput)(
      await workspaceStub.importWorkout(
        Schema.encodeSync(ImportWorkoutInput)(cardioPayload(workspaceId, `synthetic-order-2-${crypto.randomUUID()}`))
      )
    )

    const receipts = Schema.decodeUnknownSync(ListWorkoutImportsOutput)(
      await workspaceStub.listWorkoutImports(Schema.encodeSync(ListWorkoutImportsInput)(new ListWorkoutImportsInput({ workspaceId })))
    ).receipts
    expect(receipts.map((r) => r.id)).toEqual([secondOut.receipt.id, firstOut.receipt.id])
  })

  it("rejects an anonymous caller on a GOVERNED workspace (requireRoleForGovernedWorkspace, no exceptions)", async () => {
    const ownerEmail = `workouts-owner-${crypto.randomUUID()}@rawkode.academy`
    const { credential } = await devSignIn(ownerEmail)
    const { stub: userStub, socket: userSocket } = await connectToUserAs(credential)
    let workspaceId: EntityId
    try {
      const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
        await userStub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Governed workouts workspace" })))
      )
      workspaceId = created.workspace.workspaceId
    } finally {
      userStub[Symbol.dispose]()
      userSocket.close()
    }

    const anonymousStub = await connectToWorkspace(workspaceId)
    try {
      const importError = await rejectionToDomainError(
        anonymousStub.importWorkout(
          Schema.encodeSync(ImportWorkoutInput)(strengthPayload(workspaceId, `synthetic-gov-${crypto.randomUUID()}`))
        )
      )
      expect(importError._tag).toBe("Unauthorized")

      const listError = await rejectionToDomainError(
        anonymousStub.listWorkoutImports(Schema.encodeSync(ListWorkoutImportsInput)(new ListWorkoutImportsInput({ workspaceId })))
      )
      expect(listError._tag).toBe("Unauthorized")
    } finally {
      anonymousStub[Symbol.dispose]()
    }

    const { stub: ownerWorkspaceStub, socket: ownerSocket } = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    try {
      const output = Schema.decodeUnknownSync(ImportWorkoutOutput)(
        await ownerWorkspaceStub.importWorkout(
          Schema.encodeSync(ImportWorkoutInput)(strengthPayload(workspaceId, `synthetic-gov-owner-${crypto.randomUUID()}`))
        )
      )
      expect(output.duplicate).toBe(false)
    } finally {
      ownerWorkspaceStub[Symbol.dispose]()
      ownerSocket.close()
    }
  })
})

/** `strengthPayload`/`cardioPayload` above are `ImportWorkoutInput`-shaped (they carry `workspaceId`,
 *  needed by the single-item `importWorkout` RPC); `importWorkouts` (batch) items are
 *  `WorkoutImportItem`-shaped (no `workspaceId` — the batch carries it once, `ImportWorkoutsInput
 *  .workspaceId`). Both share every other field by construction (`workout-rpc.ts`'s `WorkoutImportItem`
 *  doc comment), so this just drops `workspaceId` off the same fixtures rather than duplicating them. */
const toImportItem = (input: ImportWorkoutInput): WorkoutImportItem => {
  const { workspaceId: _workspaceId, ...rest } = input
  return new WorkoutImportItem(rest)
}

describe("WorkoutsService: importWorkouts/listWorkouts/getWorkout", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("imports a batch of workouts in one call, one succeeded result per item, in input order", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const items = [
      toImportItem(strengthPayload(workspaceId, `batch-strength-${crypto.randomUUID()}`)),
      toImportItem(cardioPayload(workspaceId, `batch-cardio-${crypto.randomUUID()}`))
    ]
    const output = Schema.decodeUnknownSync(ImportWorkoutsOutput)(
      await workspaceStub.importWorkouts(Schema.encodeSync(ImportWorkoutsInput)(new ImportWorkoutsInput({ workspaceId, workouts: items })))
    )

    expect(output.results).toHaveLength(2)
    expect(output.results.map((r) => r.sourceWorkoutId)).toEqual(items.map((i) => i.sourceWorkoutId))
    for (const result of output.results) {
      expect(result.outcome).toBe("imported")
      if (result.outcome === "imported") expect(result.duplicate).toBe(false)
    }

    const receipts = Schema.decodeUnknownSync(ListWorkoutImportsOutput)(
      await workspaceStub.listWorkoutImports(Schema.encodeSync(ListWorkoutImportsInput)(new ListWorkoutImportsInput({ workspaceId })))
    ).receipts
    expect(receipts).toHaveLength(2)
  })

  it("re-importing the same batch is a per-item idempotent no-op — no duplicate subgraphs", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const items = [
      toImportItem(strengthPayload(workspaceId, `batch-dup-strength-${crypto.randomUUID()}`)),
      toImportItem(cardioPayload(workspaceId, `batch-dup-cardio-${crypto.randomUUID()}`))
    ]
    const encodedInput = Schema.encodeSync(ImportWorkoutsInput)(new ImportWorkoutsInput({ workspaceId, workouts: items }))

    const first = Schema.decodeUnknownSync(ImportWorkoutsOutput)(await workspaceStub.importWorkouts(encodedInput))
    expect(first.results.every((r) => r.outcome === "imported" && r.duplicate === false)).toBe(true)

    // Re-import the identical batch, plus one genuinely new item, in the same call.
    const newItem = toImportItem(strengthPayload(workspaceId, `batch-dup-new-${crypto.randomUUID()}`))
    const second = Schema.decodeUnknownSync(ImportWorkoutsOutput)(
      await workspaceStub.importWorkouts(
        Schema.encodeSync(ImportWorkoutsInput)(new ImportWorkoutsInput({ workspaceId, workouts: [...items, newItem] }))
      )
    )
    expect(second.results).toHaveLength(3)
    expect(second.results[0].outcome).toBe("imported")
    expect(second.results[1].outcome).toBe("imported")
    expect(second.results[2].outcome).toBe("imported")
    if (second.results[0].outcome === "imported") expect(second.results[0].duplicate).toBe(true)
    if (second.results[1].outcome === "imported") expect(second.results[1].duplicate).toBe(true)
    if (second.results[2].outcome === "imported") expect(second.results[2].duplicate).toBe(false)

    // Still only 3 receipts total (2 original + 1 new) — the re-imported pair created no second
    // subgraph.
    const receipts = Schema.decodeUnknownSync(ListWorkoutImportsOutput)(
      await workspaceStub.listWorkoutImports(Schema.encodeSync(ListWorkoutImportsInput)(new ListWorkoutImportsInput({ workspaceId })))
    ).receipts
    expect(receipts).toHaveLength(3)
  })

  it("reports a per-item failure without aborting the rest of the batch", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const good = toImportItem(strengthPayload(workspaceId, `batch-mixed-good-${crypto.randomUUID()}`))
    const badInput = strengthPayload(workspaceId, `batch-mixed-bad-${crypto.randomUUID()}`)
    const bad = new WorkoutImportItem({
      ...toImportItem(badInput),
      payload: {
        kind: "strength",
        exercises: [
          {
            ordinal: 1,
            name: "Deadlift",
            sets: [
              { ordinal: 1, repetitions: 5, loadKilograms: 100 },
              { ordinal: 3, repetitions: 5, loadKilograms: 100 } // gap: 2 is missing
            ]
          }
        ]
      }
    })

    const output = Schema.decodeUnknownSync(ImportWorkoutsOutput)(
      await workspaceStub.importWorkouts(
        Schema.encodeSync(ImportWorkoutsInput)(new ImportWorkoutsInput({ workspaceId, workouts: [good, bad] }))
      )
    )

    expect(output.results).toHaveLength(2)
    expect(output.results[0].outcome).toBe("imported")
    expect(output.results[1].outcome).toBe("failed")
    if (output.results[1].outcome === "failed") {
      expect(output.results[1].sourceWorkoutId).toBe(bad.sourceWorkoutId)
      expect(output.results[1].message.length).toBeGreaterThan(0)
    }

    // The good item's subgraph still landed despite the bad item failing.
    const receipts = Schema.decodeUnknownSync(ListWorkoutImportsOutput)(
      await workspaceStub.listWorkoutImports(Schema.encodeSync(ListWorkoutImportsInput)(new ListWorkoutImportsInput({ workspaceId })))
    ).receipts
    expect(receipts).toHaveLength(1)
    expect(receipts[0].sourceWorkoutId).toBe(good.sourceWorkoutId)
  })

  it("listWorkouts returns a summary per workout, most-recently-started first", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const strengthOut = Schema.decodeUnknownSync(ImportWorkoutOutput)(
      await workspaceStub.importWorkout(
        Schema.encodeSync(ImportWorkoutInput)(strengthPayload(workspaceId, `list-strength-${crypto.randomUUID()}`))
      )
    )
    const cardioOut = Schema.decodeUnknownSync(ImportWorkoutOutput)(
      await workspaceStub.importWorkout(
        Schema.encodeSync(ImportWorkoutInput)(cardioPayload(workspaceId, `list-cardio-${crypto.randomUUID()}`))
      )
    )

    const output = Schema.decodeUnknownSync(ListWorkoutsOutput)(
      await workspaceStub.listWorkouts(Schema.encodeSync(ListWorkoutsInput)(new ListWorkoutsInput({ workspaceId })))
    )

    // cardioPayload's startedAt (2026-08-16) is later than strengthPayload's (2026-08-15), so
    // cardio sorts first — most-recently-started first.
    expect(output.workouts.map((w) => w.nodeId)).toEqual([cardioOut.receipt.rootNodeId, strengthOut.receipt.rootNodeId])

    const strengthSummary = output.workouts.find((w) => w.nodeId === strengthOut.receipt.rootNodeId)!
    expect(strengthSummary.kind).toBe("strength")
    expect(strengthSummary.activity).toBe("strength-training")
    expect(strengthSummary.durationSeconds).toBe(2700)
    expect(strengthSummary.energyKilocalories).toBe(320)

    const cardioSummary = output.workouts.find((w) => w.nodeId === cardioOut.receipt.rootNodeId)!
    expect(cardioSummary.kind).toBe("cardio")
    expect(cardioSummary.activity).toBe("running")
  })

  it("getWorkout returns the full strength aggregate (exercises + sets, correctly ordered)", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const input = strengthPayload(workspaceId, `get-strength-${crypto.randomUUID()}`)
    const importOut = Schema.decodeUnknownSync(ImportWorkoutOutput)(
      await workspaceStub.importWorkout(Schema.encodeSync(ImportWorkoutInput)(input))
    )

    const output = Schema.decodeUnknownSync(GetWorkoutOutput)(
      await workspaceStub.getWorkout(
        Schema.encodeSync(GetWorkoutInput)(new GetWorkoutInput({ workspaceId, nodeId: importOut.receipt.rootNodeId }))
      )
    )

    const workout = output.workout
    expect(workout.nodeId).toBe(importOut.receipt.rootNodeId)
    expect(workout.sourceWorkoutId).toBe(input.sourceWorkoutId)
    expect(workout.activity).toBe("strength-training")
    expect(workout.payload.kind).toBe("strength")
    if (workout.payload.kind !== "strength") throw new Error("expected strength payload")

    expect(workout.payload.exercises.map((e) => e.name)).toEqual(["Back Squat", "Bench Press"])
    expect(workout.payload.exercises.map((e) => e.ordinal)).toEqual([1, 2])
    expect(workout.payload.exercises[0].sets).toHaveLength(3)
    expect(workout.payload.exercises[1].sets).toHaveLength(2)
    expect(workout.payload.exercises[0].sets.map((s) => s.ordinal)).toEqual([1, 2, 3])
    expect(workout.payload.exercises[0].sets[2].rpe).toBe(8)
    expect(workout.payload.exercises[0].volumeKilograms).toBe(8 * 60 + 8 * 65 + 6 * 70)
  })

  it("getWorkout returns the full cardio aggregate (splits, correctly ordered)", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const input = cardioPayload(workspaceId, `get-cardio-${crypto.randomUUID()}`)
    const importOut = Schema.decodeUnknownSync(ImportWorkoutOutput)(
      await workspaceStub.importWorkout(Schema.encodeSync(ImportWorkoutInput)(input))
    )

    const output = Schema.decodeUnknownSync(GetWorkoutOutput)(
      await workspaceStub.getWorkout(
        Schema.encodeSync(GetWorkoutInput)(new GetWorkoutInput({ workspaceId, nodeId: importOut.receipt.rootNodeId }))
      )
    )

    const workout = output.workout
    expect(workout.payload.kind).toBe("cardio")
    if (workout.payload.kind !== "cardio") throw new Error("expected cardio payload")
    expect(workout.payload.splits.map((s) => s.ordinal)).toEqual([1, 2, 3])
    expect(workout.payload.splits[0].distanceMeters).toBe(1000)
    expect(workout.payload.distanceMeters).toBe(3000)
    expect(workout.payload.averagePaceSecondsPerKilometre).toBe(322)
  })

  it("getWorkout fails with WorkoutNotFound for a node that exists but isn't a workout root", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const plainNode = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title: "Not a workout" })))
    ).node

    const error = await rejectionToDomainError(
      workspaceStub.getWorkout(Schema.encodeSync(GetWorkoutInput)(new GetWorkoutInput({ workspaceId, nodeId: plainNode.id })))
    )
    expect(error._tag).toBe("WorkoutNotFound")
  })

  it("getWorkout fails with WorkoutNotFound for a nodeId that doesn't exist at all", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    const error = await rejectionToDomainError(
      workspaceStub.getWorkout(
        Schema.encodeSync(GetWorkoutInput)(new GetWorkoutInput({ workspaceId, nodeId: freshWorkspaceId() }))
      )
    )
    expect(error._tag).toBe("WorkoutNotFound")
  })

  it("rejects an anonymous caller on a GOVERNED workspace for importWorkouts/listWorkouts/getWorkout", async () => {
    const ownerEmail = `workouts-batch-owner-${crypto.randomUUID()}@rawkode.academy`
    const { credential } = await devSignIn(ownerEmail)
    const { stub: userStub, socket: userSocket } = await connectToUserAs(credential)
    let workspaceId: EntityId
    try {
      const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
        await userStub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Governed workouts batch workspace" })))
      )
      workspaceId = created.workspace.workspaceId
    } finally {
      userStub[Symbol.dispose]()
      userSocket.close()
    }

    const anonymousStub = await connectToWorkspace(workspaceId)
    try {
      const importError = await rejectionToDomainError(
        anonymousStub.importWorkouts(
          Schema.encodeSync(ImportWorkoutsInput)(
            new ImportWorkoutsInput({
              workspaceId,
              workouts: [toImportItem(strengthPayload(workspaceId, `batch-gov-${crypto.randomUUID()}`))]
            })
          )
        )
      )
      expect(importError._tag).toBe("Unauthorized")

      const listError = await rejectionToDomainError(
        anonymousStub.listWorkouts(Schema.encodeSync(ListWorkoutsInput)(new ListWorkoutsInput({ workspaceId })))
      )
      expect(listError._tag).toBe("Unauthorized")

      const getError = await rejectionToDomainError(
        anonymousStub.getWorkout(Schema.encodeSync(GetWorkoutInput)(new GetWorkoutInput({ workspaceId, nodeId: freshWorkspaceId() })))
      )
      expect(getError._tag).toBe("Unauthorized")
    } finally {
      anonymousStub[Symbol.dispose]()
    }
  })
})
