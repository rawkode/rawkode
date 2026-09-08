import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId, IsoDateTimeString } from "./node.js"
import { BASE_TAGS, BaseTagIds } from "./tag.js"
import {
  WORKOUT_RELATION_DEFINITIONS,
  WORKOUT_TAGS,
  WorkoutCardioSplit,
  WorkoutDetail,
  WorkoutDetailPayload,
  WorkoutFactPredicate,
  WorkoutImportReceipt,
  WorkoutRelationIds,
  WorkoutStrengthExercise,
  WorkoutStrengthSet,
  WorkoutSummary,
  WorkoutTagIds
} from "./workout.js"
import { RelationDefinition } from "./relation-definition.js"
import { Tag } from "./tag.js"

describe("WORKOUT_TAGS", () => {
  it("has exactly the 6 plan/Enchiridion-named tags, all builtin", () => {
    expect(WORKOUT_TAGS).toHaveLength(6)
    expect(WORKOUT_TAGS.map((tag) => tag.name)).toEqual([
      "Workout",
      "Strength Workout",
      "Cardio Workout",
      "Strength Exercise",
      "Strength Set",
      "Cardio Split"
    ])
    for (const tag of WORKOUT_TAGS) {
      expect(tag.builtin).toBe(true)
    }
  })

  it("Strength Workout / Cardio Workout declare Workout as their sole DAG parent", () => {
    const strength = WORKOUT_TAGS.find((tag) => tag.name === "Strength Workout")
    const cardio = WORKOUT_TAGS.find((tag) => tag.name === "Cardio Workout")
    expect(strength?.parentIds).toEqual([WorkoutTagIds.Workout])
    expect(cardio?.parentIds).toEqual([WorkoutTagIds.Workout])
  })

  it("Workout / Strength Exercise / Strength Set / Cardio Split declare no parent", () => {
    for (const name of ["Workout", "Strength Exercise", "Strength Set", "Cardio Split"]) {
      expect(WORKOUT_TAGS.find((tag) => tag.name === name)?.parentIds).toEqual([])
    }
  })

  it("every workout tag id is distinct, schema-valid, and disjoint from BASE_TAGS' ids", () => {
    const ids = WORKOUT_TAGS.map((tag) => tag.id)
    expect(new Set(ids).size).toBe(6)
    for (const id of ids) {
      expect(() => Schema.decodeUnknownSync(EntityId)(id)).not.toThrow()
      expect(BASE_TAGS.map((tag) => tag.id)).not.toContain(id)
    }
  })

  it("WorkoutTagIds and WORKOUT_TAGS agree on id assignment", () => {
    expect(WORKOUT_TAGS.find((tag) => tag.name === "Workout")?.id).toBe(WorkoutTagIds.Workout)
    expect(WORKOUT_TAGS.find((tag) => tag.name === "Cardio Split")?.id).toBe(WorkoutTagIds.CardioSplit)
  })

  it("every WORKOUT_TAGS row round-trips through the Tag schema", () => {
    for (const tag of WORKOUT_TAGS) {
      const encoded = Schema.encodeSync(Tag)(tag)
      expect(Schema.decodeUnknownSync(Tag)(encoded)).toEqual(tag)
    }
  })

  it("is not the same array/constant as BASE_TAGS (deliberately parallel, not merged)", () => {
    expect(WORKOUT_TAGS).not.toBe(BASE_TAGS)
    expect(BaseTagIds.Person).not.toBe(WorkoutTagIds.Workout)
  })
})

describe("WORKOUT_RELATION_DEFINITIONS", () => {
  it("has exactly the 3 plan/Enchiridion-named relations, all one-to-many", () => {
    expect(WORKOUT_RELATION_DEFINITIONS).toHaveLength(3)
    for (const relationDefinition of WORKOUT_RELATION_DEFINITIONS) {
      expect(relationDefinition.cardinality).toBe("one-to-many")
    }
  })

  it("workoutExercises: Strength Workout -> Strength Exercise, forward 'exercises'", () => {
    const relationDefinition = WORKOUT_RELATION_DEFINITIONS.find(
      (r) => r.id === WorkoutRelationIds.WorkoutExercises
    )
    expect(relationDefinition?.sourceTagId).toBe(WorkoutTagIds.StrengthWorkout)
    expect(relationDefinition?.targetTagId).toBe(WorkoutTagIds.StrengthExercise)
    expect(relationDefinition?.forwardName).toBe("exercises")
    expect(relationDefinition?.inverseName).toBe("workout")
  })

  it("exerciseSets: Strength Exercise -> Strength Set, forward 'sets'", () => {
    const relationDefinition = WORKOUT_RELATION_DEFINITIONS.find((r) => r.id === WorkoutRelationIds.ExerciseSets)
    expect(relationDefinition?.sourceTagId).toBe(WorkoutTagIds.StrengthExercise)
    expect(relationDefinition?.targetTagId).toBe(WorkoutTagIds.StrengthSet)
    expect(relationDefinition?.forwardName).toBe("sets")
  })

  it("workoutSplits: Cardio Workout -> Cardio Split, forward 'splits'", () => {
    const relationDefinition = WORKOUT_RELATION_DEFINITIONS.find((r) => r.id === WorkoutRelationIds.WorkoutSplits)
    expect(relationDefinition?.sourceTagId).toBe(WorkoutTagIds.CardioWorkout)
    expect(relationDefinition?.targetTagId).toBe(WorkoutTagIds.CardioSplit)
    expect(relationDefinition?.forwardName).toBe("splits")
  })

  it("every relation definition's sourceTagId/targetTagId is one of WORKOUT_TAGS' own ids", () => {
    const tagIds = new Set(WORKOUT_TAGS.map((tag) => tag.id))
    for (const relationDefinition of WORKOUT_RELATION_DEFINITIONS) {
      expect(tagIds.has(relationDefinition.sourceTagId)).toBe(true)
      expect(tagIds.has(relationDefinition.targetTagId)).toBe(true)
    }
  })

  it("every relation definition id is distinct and every row round-trips through the schema", () => {
    const ids = WORKOUT_RELATION_DEFINITIONS.map((r) => r.id)
    expect(new Set(ids).size).toBe(3)
    for (const relationDefinition of WORKOUT_RELATION_DEFINITIONS) {
      const encoded = Schema.encodeSync(RelationDefinition)(relationDefinition)
      expect(Schema.decodeUnknownSync(RelationDefinition)(encoded)).toEqual(relationDefinition)
    }
  })
})

describe("WorkoutFactPredicate", () => {
  it("every predicate string is a distinct, non-empty kebab-case-looking key", () => {
    const values = Object.values(WorkoutFactPredicate)
    expect(new Set(values).size).toBe(values.length)
    for (const value of values) {
      expect(value).toMatch(/^[a-z]+(-[a-z]+)*$/)
    }
  })
})

describe("WorkoutImportReceipt schema", () => {
  const validId = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

  it("round-trips encode/decode", () => {
    const receipt = new WorkoutImportReceipt({
      id: EntityId.make(validId),
      workspaceId: EntityId.make(validId),
      sourceWorkoutId: "healthkit-uuid-1234",
      source: "healthkit",
      payloadHash: "deadbeef",
      rootNodeId: EntityId.make(validId),
      importedAt: Schema.decodeUnknownSync(IsoDateTimeString)("2026-08-20T00:00:00.000Z")
    })
    const encoded = Schema.encodeSync(WorkoutImportReceipt)(receipt)
    expect(Schema.decodeUnknownSync(WorkoutImportReceipt)(encoded)).toEqual(receipt)
  })

  it("rejects an empty sourceWorkoutId", () => {
    const result = Schema.decodeUnknownEither(WorkoutImportReceipt)({
      id: validId,
      workspaceId: validId,
      sourceWorkoutId: "",
      source: "healthkit",
      payloadHash: "deadbeef",
      rootNodeId: validId,
      importedAt: "2026-08-20T00:00:00.000Z"
    })
    expect(result._tag).toBe("Left")
  })

  it("rejects an unrecognized source", () => {
    const result = Schema.decodeUnknownEither(WorkoutImportReceipt)({
      id: validId,
      workspaceId: validId,
      sourceWorkoutId: "abc",
      source: "manual-entry",
      payloadHash: "deadbeef",
      rootNodeId: validId,
      importedAt: "2026-08-20T00:00:00.000Z"
    })
    expect(result._tag).toBe("Left")
  })
})

describe("read models: WorkoutSummary / WorkoutDetail (listWorkouts/getWorkout)", () => {
  const nodeId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
  const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
  const startedAt = Schema.decodeUnknownSync(IsoDateTimeString)("2026-08-20T06:00:00.000Z")
  const completedAt = Schema.decodeUnknownSync(IsoDateTimeString)("2026-08-20T06:45:00.000Z")

  const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
    const encoded = Schema.encodeSync(schema)(value)
    expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
  }

  it("round-trips a strength WorkoutSummary", () => {
    roundTrip(
      WorkoutSummary,
      new WorkoutSummary({
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
    )
  })

  it("round-trips a cardio WorkoutSummary with every optional field present", () => {
    roundTrip(
      WorkoutSummary,
      new WorkoutSummary({
        nodeId,
        workspaceId,
        sourceWorkoutId: "healthkit-uuid-2",
        source: "synthetic",
        kind: "cardio",
        activity: "running",
        rawActivity: "HKWorkoutActivityTypeRunning",
        startedAt,
        completedAt,
        durationSeconds: 1800,
        energyKilocalories: 420,
        averageHeartRate: 152,
        maximumHeartRate: 178
      })
    )
  })

  it("round-trips a WorkoutStrengthSet, with and without optional fields", () => {
    roundTrip(
      WorkoutStrengthSet,
      new WorkoutStrengthSet({
        nodeId,
        ordinal: 1,
        repetitions: 8,
        loadKilograms: 60,
        volumeKilograms: 480,
        rpe: 8.5,
        completedAt
      })
    )
    roundTrip(
      WorkoutStrengthSet,
      new WorkoutStrengthSet({
        nodeId,
        ordinal: 2,
        repetitions: 6,
        loadKilograms: 65,
        volumeKilograms: 390
      })
    )
  })

  it("round-trips a WorkoutDetail with a strength payload", () => {
    const detailPayload: WorkoutDetailPayload = {
      kind: "strength",
      exercises: [
        new WorkoutStrengthExercise({
          nodeId,
          ordinal: 1,
          name: "Back Squat",
          volumeKilograms: 870,
          sets: [
            new WorkoutStrengthSet({ nodeId, ordinal: 1, repetitions: 8, loadKilograms: 60, volumeKilograms: 480 }),
            new WorkoutStrengthSet({ nodeId, ordinal: 2, repetitions: 6, loadKilograms: 65, volumeKilograms: 390 })
          ]
        })
      ]
    }
    roundTrip(
      WorkoutDetail,
      new WorkoutDetail({
        nodeId,
        workspaceId,
        sourceWorkoutId: "healthkit-uuid-1",
        source: "healthkit",
        activity: "strength-training",
        startedAt,
        completedAt,
        durationSeconds: 2700,
        payload: detailPayload
      })
    )
  })

  it("round-trips a WorkoutDetail with a cardio payload, including an empty splits array", () => {
    roundTrip(
      WorkoutDetail,
      new WorkoutDetail({
        nodeId,
        workspaceId,
        sourceWorkoutId: "healthkit-uuid-2",
        source: "healthkit",
        activity: "running",
        startedAt,
        completedAt,
        durationSeconds: 1800,
        payload: {
          kind: "cardio",
          splits: [],
          distanceMeters: 5000,
          averagePaceSecondsPerKilometre: 330
        }
      })
    )
  })

  it("round-trips a WorkoutCardioSplit", () => {
    roundTrip(
      WorkoutCardioSplit,
      new WorkoutCardioSplit({
        nodeId,
        ordinal: 1,
        distanceMeters: 1000,
        durationSeconds: 300,
        paceSecondsPerKilometre: 300,
        averageHeartRate: 160,
        energyKilocalories: 65
      })
    )
  })

  it("rejects a WorkoutDetail payload with neither 'strength' nor 'cardio' kind", () => {
    const result = Schema.decodeUnknownEither(WorkoutDetail)({
      nodeId,
      workspaceId,
      sourceWorkoutId: "x",
      source: "healthkit",
      activity: "running",
      startedAt,
      completedAt,
      durationSeconds: 100,
      payload: { kind: "yoga", exercises: [] }
    })
    expect(result._tag).toBe("Left")
  })
})
