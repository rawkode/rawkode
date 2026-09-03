import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId, IsoDateTimeString } from "./node.js"
import { WorkoutImportReceipt, WorkoutSummary, WorkoutDetail } from "./workout.js"
import {
  CardioSplitImportInput,
  GetWorkoutInput,
  GetWorkoutOutput,
  ImportWorkoutInput,
  ImportWorkoutOutput,
  ImportWorkoutsInput,
  ImportWorkoutsOutput,
  ListWorkoutImportsInput,
  ListWorkoutImportsOutput,
  ListWorkoutsInput,
  ListWorkoutsOutput,
  StrengthExerciseImportInput,
  StrengthSetImportInput,
  WorkoutImportFailed,
  WorkoutImportItem,
  WorkoutImportSucceeded
} from "./workout-rpc.js"

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const nodeId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const startedAt = Schema.decodeUnknownSync(IsoDateTimeString)("2026-08-20T06:00:00.000Z")
const completedAt = Schema.decodeUnknownSync(IsoDateTimeString)("2026-08-20T06:45:00.000Z")
const importedAt = Schema.decodeUnknownSync(IsoDateTimeString)("2026-08-20T06:46:00.000Z")

const strengthSet: StrengthSetImportInput = { ordinal: 1, repetitions: 8, loadKilograms: 60 }
const strengthExercise: StrengthExerciseImportInput = { ordinal: 1, name: "Back Squat", sets: [strengthSet] }

const receipt = new WorkoutImportReceipt({
  id: nodeId,
  workspaceId,
  sourceWorkoutId: "healthkit-uuid-1",
  source: "healthkit",
  payloadHash: "deadbeef",
  rootNodeId: nodeId,
  importedAt
})

describe("importWorkout (single) RPC schemas — pre-existing, still round-trip after this stage's additions", () => {
  it("round-trips a strength ImportWorkoutInput/Output", () => {
    roundTrip(
      ImportWorkoutInput,
      new ImportWorkoutInput({
        workspaceId,
        sourceWorkoutId: "healthkit-uuid-1",
        source: "healthkit",
        activity: "strength-training",
        startedAt,
        completedAt,
        durationSeconds: 2700,
        payload: { kind: "strength", exercises: [strengthExercise] }
      })
    )
    roundTrip(ImportWorkoutOutput, new ImportWorkoutOutput({ receipt, duplicate: false }))
  })

  it("round-trips a cardio ImportWorkoutInput with an empty splits array", () => {
    const cardioSplit: CardioSplitImportInput = { ordinal: 1, distanceMeters: 1000, durationSeconds: 300 }
    roundTrip(
      ImportWorkoutInput,
      new ImportWorkoutInput({
        workspaceId,
        sourceWorkoutId: "healthkit-uuid-2",
        source: "synthetic",
        activity: "running",
        startedAt,
        completedAt,
        durationSeconds: 1800,
        payload: { kind: "cardio", splits: [cardioSplit] }
      })
    )
  })

  it("round-trips ListWorkoutImportsInput/Output", () => {
    roundTrip(ListWorkoutImportsInput, new ListWorkoutImportsInput({ workspaceId }))
    roundTrip(ListWorkoutImportsOutput, new ListWorkoutImportsOutput({ receipts: [receipt] }))
  })
})

describe("importWorkouts (batch) RPC schemas", () => {
  const item = new WorkoutImportItem({
    sourceWorkoutId: "healthkit-uuid-1",
    source: "healthkit",
    activity: "strength-training",
    startedAt,
    completedAt,
    durationSeconds: 2700,
    payload: { kind: "strength", exercises: [strengthExercise] }
  })

  it("round-trips ImportWorkoutsInput with one item", () => {
    roundTrip(ImportWorkoutsInput, new ImportWorkoutsInput({ workspaceId, workouts: [item] }))
  })

  it("round-trips ImportWorkoutsInput with multiple items", () => {
    const secondItem = new WorkoutImportItem({
      sourceWorkoutId: "healthkit-uuid-2",
      source: "healthkit",
      activity: "running",
      rawActivity: undefined,
      startedAt,
      completedAt,
      durationSeconds: 1800,
      payload: { kind: "cardio", splits: [] }
    })
    roundTrip(ImportWorkoutsInput, new ImportWorkoutsInput({ workspaceId, workouts: [item, secondItem] }))
  })

  it("rejects an empty workouts array", () => {
    const result = Schema.decodeUnknownEither(ImportWorkoutsInput)({ workspaceId, workouts: [] })
    expect(result._tag).toBe("Left")
  })

  it("rejects a workouts array over the 200-item bound", () => {
    const encodedItem = Schema.encodeSync(WorkoutImportItem)(item)
    const workouts = Array.from({ length: 201 }, () => encodedItem)
    const result = Schema.decodeUnknownEither(ImportWorkoutsInput)({ workspaceId, workouts })
    expect(result._tag).toBe("Left")
  })

  it("round-trips a mixed-outcome ImportWorkoutsOutput", () => {
    const succeeded = new WorkoutImportSucceeded({
      outcome: "imported",
      sourceWorkoutId: "healthkit-uuid-1",
      receipt,
      duplicate: false
    })
    const failed = new WorkoutImportFailed({
      outcome: "failed",
      sourceWorkoutId: "healthkit-uuid-2",
      message: "exercise 1 set ordinals are not contiguous starting at 1"
    })
    roundTrip(ImportWorkoutsOutput, new ImportWorkoutsOutput({ results: [succeeded, failed] }))
  })

  it("round-trips an all-duplicate ImportWorkoutsOutput", () => {
    const duplicate = new WorkoutImportSucceeded({
      outcome: "imported",
      sourceWorkoutId: "healthkit-uuid-1",
      receipt,
      duplicate: true
    })
    roundTrip(ImportWorkoutsOutput, new ImportWorkoutsOutput({ results: [duplicate] }))
  })
})

describe("listWorkouts / getWorkout RPC schemas", () => {
  const summary = new WorkoutSummary({
    nodeId,
    workspaceId,
    sourceWorkoutId: "healthkit-uuid-1",
    source: "healthkit",
    kind: "strength",
    activity: "strength-training",
    startedAt,
    completedAt,
    durationSeconds: 2700
  })

  const detail = new WorkoutDetail({
    nodeId,
    workspaceId,
    sourceWorkoutId: "healthkit-uuid-1",
    source: "healthkit",
    activity: "strength-training",
    startedAt,
    completedAt,
    durationSeconds: 2700,
    payload: { kind: "strength", exercises: [] }
  })

  it("round-trips ListWorkoutsInput/Output, including an empty list", () => {
    roundTrip(ListWorkoutsInput, new ListWorkoutsInput({ workspaceId }))
    roundTrip(ListWorkoutsOutput, new ListWorkoutsOutput({ workouts: [summary] }))
    roundTrip(ListWorkoutsOutput, new ListWorkoutsOutput({ workouts: [] }))
  })

  it("round-trips GetWorkoutInput/Output", () => {
    roundTrip(GetWorkoutInput, new GetWorkoutInput({ workspaceId, nodeId }))
    roundTrip(GetWorkoutOutput, new GetWorkoutOutput({ workout: detail }))
  })
})
