// `typed-storage-effect` collection backing `WorkoutsService` (`workouts-service-live.ts`) — same
// "one small collections module per repository/service" convention as `meeting-collections.ts`/
// `calendar-collections.ts` (plan §"Storage & domain model", God-object mitigation).
//
// One collection: `workoutImportReceipts` — see `workout.ts`'s `WorkoutImportReceipt` doc comment
// for the full "why a receipt collection, not just the node graph itself" rationale (idempotent
// re-import dedupe, mirroring Enchiridion's own `workout_import_receipts` table). Indexed
// `uniqueIndexes.bySourceWorkoutId` — a **unique** index (not `nonUniqueIndexes`, unlike
// `calendar-collections.ts`'s `byProviderEventId`) because within one workspace a given
// `sourceWorkoutId` (a real `HKWorkout.uuid`, or a synthetic source's own stable id) genuinely
// identifies at most one receipt — `workouts-service-live.ts#importWorkout` relies on this being a
// true `UniqueIndex.get` (one-or-none), not a list, to decide duplicate-vs-conflict-vs-fresh in a
// single lookup.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { UnexpectedError, WorkoutImportReceipt, type EntityId } from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError,
  type UniqueIndex
} from "@athenaeum/typed-storage-effect"

const workoutImportReceiptsCollectionSchema = collection<WorkoutImportReceipt>()({
  primaryKey: "id",
  uniqueIndexes: {
    bySourceWorkoutId: (receipt: WorkoutImportReceipt) => receipt.sourceWorkoutId
  },
  nonUniqueIndexes: {
    byWorkspaceId: (receipt: WorkoutImportReceipt) => receipt.workspaceId
  }
})

export interface WorkoutCollections {
  readonly workoutImportReceipts: Collection<WorkoutImportReceipt, EntityId> & {
    readonly bySourceWorkoutId: UniqueIndex<WorkoutImportReceipt, string>
    readonly byWorkspaceId: NonUniqueIndex<WorkoutImportReceipt, EntityId>
  }
}

export const makeWorkoutCollections = (storage: DurableObjectStorage): WorkoutCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: { workoutImportReceipts: workoutImportReceiptsCollectionSchema }
  })
  return { workoutImportReceipts: typedStorage.workoutImportReceipts }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** `DurableObjectStorage` round-trips values through structured clone — a record read back is a
 *  plain object, not the `Schema.Class` instance callers need (same concern as every other
 *  `revive*` helper in this codebase — `meeting-collections.ts#reviveMeeting` is this file's own
 *  template). */
export const reviveWorkoutImportReceipt = (raw: unknown): Effect.Effect<WorkoutImportReceipt, UnexpectedError> =>
  Schema.decodeUnknown(WorkoutImportReceipt)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({
          message: `corrupt stored workout import receipt: ${TreeFormatter.formatErrorSync(parseError)}`
        })
    )
  )
