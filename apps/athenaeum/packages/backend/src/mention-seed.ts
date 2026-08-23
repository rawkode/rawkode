// Mention relation-definition seeding — rich-text-editor pass, entity-reference-to-edge
// projection design (`docs/rich-text-editor-decisions.md` §5, `mention.ts`'s
// `MENTION_RELATION_DEFINITION`). The `syncNoteReferences` RPC (`graph-service-live.ts`) requires
// this fixed `relationDefinitionId` to already exist before it can write a single "mentions" edge
// — `createEdge`'s own validation discipline (`relationDefinitionsRepository.get`) applies here
// too, so the relation must be seeded before any `@`-mention is ever reconciled.
//
// Seeded **unconditionally at DO construction**, alongside `ensureBaseTagsSeeded`
// (`seed-base-tags.ts`) — not lazily on first use the way `ensureWorkoutTagsSeeded` is (see that
// module's header comment for why workout seeding is lazy: HealthKit import is an optional
// feature most workspaces never touch). `@`-mentions are a core rich-text-editor capability every
// governed and ungoverned workspace gets from this pass onward, exactly like the 8 Base Tags —
// same rationale, same placement.
//
// Deliberately its own small module, not folded into `seed-base-tags.ts`: seeding a single
// `RelationDefinition` needs the `RelationDefinitionsCollections` handle, which
// `ensureBaseTagsSeeded` has no reason to depend on (it only ever touches
// `TagsCollections`/`TagClosureCollections`). Mirrors `workout-seed.ts`'s own "separate module per
// seeded concern" precedent.

import * as Effect from "effect/Effect"
import { MENTION_RELATION_DEFINITION, UnexpectedError } from "@athenaeum/domain"
import type { TypedStorageError } from "@athenaeum/typed-storage-effect"
import type { RelationDefinitionsCollections } from "./relation-definitions-repository-live.js"
import { upsertRelationDefinition } from "./read-model.js"

const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/**
 * Idempotent: inserts `MENTION_RELATION_DEFINITION` only if a relation definition with its fixed
 * id (`MentionRelationId`) isn't already present — same "check existing ids before writing"
 * discipline `ensureBaseTagsSeeded`/`ensureWorkoutTagsSeeded` both follow, safe to call on every
 * DO construction (including a re-instantiation after eviction) without ever duplicating or
 * overwriting the row.
 */
export const ensureMentionRelationSeeded = (
  relationDefinitionsCollections: RelationDefinitionsCollections,
  sql: SqlStorage
): Effect.Effect<void, UnexpectedError> =>
  Effect.gen(function* () {
    const existing = yield* relationDefinitionsCollections.relationDefinitions
      .get(MENTION_RELATION_DEFINITION.id)
      .pipe(Effect.mapError(toUnexpectedError))
    if (existing !== undefined) return // already seeded, nothing to write

    yield* relationDefinitionsCollections.relationDefinitions
      .put(MENTION_RELATION_DEFINITION)
      .pipe(Effect.mapError(toUnexpectedError))
    yield* upsertRelationDefinition(sql, MENTION_RELATION_DEFINITION)
  })
