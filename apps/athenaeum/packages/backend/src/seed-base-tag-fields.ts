// Base Tag field-default seeding (docs/supertag-centering-decisions.md §1: "Base Tags get real
// seeded defaults... seeded via the same idempotent `blockConcurrencyWhile` pattern as
// `ensureBaseTagsSeeded`"). Mirrors `seed-base-tags.ts` exactly: idempotent (checks existing rows
// by id before writing, never duplicates on a repeated call/DO restart), and joins the same
// `blockConcurrencyWhile` block in `workspace-durable-object.ts`'s constructor as
// `ensureBaseTagsSeeded`/`ensureMentionRelationSeeded` — Base Tag fields are core, always-on
// functionality (a fresh `#Person` should already look like a type, not a bare label, per this
// pass's whole framing), not an optional lazily-seeded feature.
//
// Unlike `ensureBaseTagsSeeded`, there is no SQL read-model write here: `TagFieldDefinition` rows
// have no `graph_*` view of their own (see `tag-field-definitions-live.ts`'s own header comment
// for why) — this collection is KV-only.

import * as Effect from "effect/Effect"
import { BASE_TAG_FIELD_DEFINITIONS, UnexpectedError } from "@athenaeum/domain"
import { toUnexpectedError, type TagFieldDefinitionsCollections } from "./tag-field-definitions-live.js"

/**
 * Idempotent: reads the workspace's current field definitions, inserts only whichever of the 15
 * seeded `BASE_TAG_FIELD_DEFINITIONS` (by id) are missing. Safe to call on every DO construction
 * (a warm workspace that already has all 15 does one `list()` read and nothing else).
 */
export const ensureBaseTagFieldsSeeded = (
  collections: TagFieldDefinitionsCollections
): Effect.Effect<void, UnexpectedError> =>
  Effect.gen(function* () {
    const existing = yield* collections.tagFieldDefinitions.list().pipe(Effect.mapError(toUnexpectedError))
    const existingIds = new Set(existing.map((field) => field.id))

    const missing = BASE_TAG_FIELD_DEFINITIONS.filter((field) => !existingIds.has(field.id))
    if (missing.length === 0) return

    yield* Effect.forEach(
      missing,
      (field) => collections.tagFieldDefinitions.put(field).pipe(Effect.mapError(toUnexpectedError)),
      { discard: true }
    )
  })
