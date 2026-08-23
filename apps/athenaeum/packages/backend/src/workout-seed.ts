// Workout tag/relation-definition seeding — `ensureWorkoutTagsSeeded` is the workout-scoped
// counterpart to `seed-base-tags.ts#ensureBaseTagsSeeded`, extended to also seed
// `WORKOUT_RELATION_DEFINITIONS` (Base Tags have no analogous fixed relations to seed). See
// `workout.ts`'s header comment for why this is a *separate* seeding path, called **lazily** from
// `workouts-service-live.ts#importWorkout` on first use, rather than unconditionally from
// `WorkspaceDurableObject`'s constructor the way `ensureBaseTagsSeeded` is.
//
// Same "raw collections + sql, no Effect service dependency" shape `ensureBaseTagsSeeded` uses —
// deliberately, so this function has no `Layer`/`Context.Tag` prerequisites and can be called
// from anywhere a `WorkoutsService` Effect program already has these values in scope (constructor-
// style closed-over params, exactly like `GraphService`'s own `tagsCollections`/
// `tagClosureCollections`/`sql` handling — see `graph-service-live.ts`'s `makeGraphServiceLive`
// signature).
//
// Idempotent on every axis: re-checks existing tag/relation-definition ids before writing
// (missing-only insert, matching `ensureBaseTagsSeeded`'s own discipline), and only recomputes the
// tag closure when at least one new tag was actually inserted.

import * as Effect from "effect/Effect"
import { Tag, UnexpectedError, WORKOUT_RELATION_DEFINITIONS, WORKOUT_TAGS } from "@athenaeum/domain"
import type { TypedStorageError } from "@athenaeum/typed-storage-effect"
import type { TagsCollections } from "./tags-repository-live.js"
import { reviveTag, toUnexpectedError as tagsToUnexpectedError } from "./tags-repository-live.js"
import { reviveRelationDefinition, type RelationDefinitionsCollections } from "./relation-definitions-repository-live.js"
import { recomputeAndPersistTagClosure, type TagClosureCollections } from "./tag-closure.js"
import { replaceAllTagClosure, replaceTagParents, upsertRelationDefinition, upsertTag } from "./read-model.js"

const relationDefinitionsToUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

export const ensureWorkoutTagsSeeded = (
  tagsCollections: TagsCollections,
  tagClosureCollections: TagClosureCollections,
  relationDefinitionsCollections: RelationDefinitionsCollections,
  sql: SqlStorage
): Effect.Effect<void, UnexpectedError> =>
  Effect.gen(function* () {
    const existingTagsRaw = yield* tagsCollections.tags.list().pipe(Effect.mapError(tagsToUnexpectedError))
    const existingTags = yield* Effect.forEach(existingTagsRaw, reviveTag)
    const existingTagIds = new Set(existingTags.map((tag) => tag.id))
    const missingTags = WORKOUT_TAGS.filter((tag) => !existingTagIds.has(tag.id))

    if (missingTags.length > 0) {
      yield* Effect.forEach(
        missingTags,
        (tag: Tag) =>
          tagsCollections.tags.put(tag).pipe(
            Effect.mapError(tagsToUnexpectedError),
            Effect.zipRight(upsertTag(sql, tag)),
            Effect.zipRight(replaceTagParents(sql, tag.id, tag.parentIds))
          ),
        { discard: true }
      )

      const allTags: ReadonlyArray<Tag> = [...existingTags, ...missingTags]
      yield* recomputeAndPersistTagClosure(tagClosureCollections, allTags)
      const closureRows = yield* tagClosureCollections.tagClosure.list().pipe(Effect.mapError(tagsToUnexpectedError))
      yield* replaceAllTagClosure(sql, closureRows)
    }

    const existingRelationDefinitionsRaw = yield* relationDefinitionsCollections.relationDefinitions
      .list()
      .pipe(Effect.mapError(relationDefinitionsToUnexpectedError))
    const existingRelationDefinitions = yield* Effect.forEach(existingRelationDefinitionsRaw, reviveRelationDefinition)
    const existingRelationDefinitionIds = new Set(existingRelationDefinitions.map((r) => r.id))
    const missingRelationDefinitions = WORKOUT_RELATION_DEFINITIONS.filter(
      (relationDefinition) => !existingRelationDefinitionIds.has(relationDefinition.id)
    )
    yield* Effect.forEach(
      missingRelationDefinitions,
      (relationDefinition) =>
        relationDefinitionsCollections.relationDefinitions
          .put(relationDefinition)
          .pipe(
            Effect.mapError(relationDefinitionsToUnexpectedError),
            Effect.zipRight(upsertRelationDefinition(sql, relationDefinition))
          ),
      { discard: true }
    )
  })
