// Base Tag seeding (task item 2): "on first construction of a workspace's DO..., seed the 8 fixed
// Base Tags as immutable builtin: true rows if not already present. Idempotent — must not
// duplicate on repeated calls/restarts."
//
// Design decision: seeded once, in `WorkspaceDurableObject`'s constructor via
// `ctx.blockConcurrencyWhile` (not "an idempotent ensureSeeded Effect run at the top of every RPC
// entrypoint" — the task's other offered option). `blockConcurrencyWhile` is the correct
// Cloudflare DO primitive for "run this exactly once, before any request is handled, and make
// every other request wait for it" — it defers delivery of incoming requests until the callback
// resolves, so there is no window where a request could observe a partially-seeded workspace, and
// (unlike a per-call check) there's no redundant "are the base tags there yet?" storage read on
// every single RPC call once the workspace is warm. Still fully idempotent on its own terms (checked
// below, not just "only run once per constructor") because a DO can be constructed more than once
// over its lifetime (eviction + a later request re-instantiates the same durable storage).

import * as Effect from "effect/Effect"
import { BASE_TAGS, Tag, UnexpectedError } from "@athenaeum/domain"
import type { TagsCollections } from "./tags-repository-live.js"
import { toUnexpectedError, reviveTag } from "./tags-repository-live.js"
import { recomputeAndPersistTagClosure, type TagClosureCollections } from "./tag-closure.js"
import { replaceAllTagClosure, replaceTagParents, upsertTag } from "./read-model.js"

/**
 * Idempotent: reads the workspace's current tags, inserts only whichever Base Tags (by id) are
 * missing, and recomputes the closure if anything was actually inserted (a no-op workspace that
 * already has all 8 skips the closure recompute entirely — correct either way since recompute is
 * a full rebuild, but skipping avoids pointless work on every warm-DO restart).
 *
 * Views/Search stage addition: also keeps `read-model.ts`'s `rm_tags`/`rm_tag_parents`/
 * `rm_tag_closure` (and therefore `graph_tags`/`graph_tag_parents`/`graph_tag_closure`) in sync
 * for the Base Tags — this seeding path writes tags directly into `tagsCollections`/
 * `tagClosureCollections`, bypassing `GraphService.createTag` (which is where every *other*
 * tag's read-model write happens), so without this the read-model would never learn about the 8
 * Base Tags at all: `hasTag` filters and `graph_tags`/`graph_tag_closure` view queries against
 * them would silently return nothing, while the KV-backed `listTagClosure` RPC kept working —
 * exactly the kind of two-tier-storage drift this stage's read-model design has to guard against
 * at every write site, not just the ones that happen to go through `GraphService`.
 */
export const ensureBaseTagsSeeded = (
  tagsCollections: TagsCollections,
  tagClosureCollections: TagClosureCollections,
  sql: SqlStorage
): Effect.Effect<void, UnexpectedError> =>
  Effect.gen(function* () {
    const existingRaw = yield* tagsCollections.tags.list().pipe(Effect.mapError(toUnexpectedError))
    const existing = yield* Effect.forEach(existingRaw, reviveTag)
    const existingIds = new Set(existing.map((tag) => tag.id))

    const missing = BASE_TAGS.filter((tag) => !existingIds.has(tag.id))
    if (missing.length === 0) return

    yield* Effect.forEach(
      missing,
      (tag) =>
        tagsCollections.tags.put(tag).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.zipRight(upsertTag(sql, tag)),
          // Base Tags are always roots (`parentIds: []`, tag.ts's own doc comment), but this
          // still calls through the real `replaceTagParents` rather than assuming "empty" needs
          // no write — correct either way, and consistent with every other tag-parent write path.
          Effect.zipRight(replaceTagParents(sql, tag.id, tag.parentIds))
        ),
      { discard: true }
    )

    const allTags: ReadonlyArray<Tag> = [...existing, ...missing]
    yield* recomputeAndPersistTagClosure(tagClosureCollections, allTags)
    const closureRows = yield* tagClosureCollections.tagClosure.list().pipe(Effect.mapError(toUnexpectedError))
    yield* replaceAllTagClosure(sql, closureRows)
  })
