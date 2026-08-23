// `NotesService` — the plan's diagrammed Effect Service ("Daily notes, page bodies, Automerge doc
// lifecycle"). Backend-internal `Context.Tag` (same rationale as `GraphService` — orchestration,
// not a storage-agnostic repository interface). Owns:
//
// 1. Page lifecycle (task item 4): `createPage`/`getPageText`/`applyLocalEdit`, backed by
//    `PagesRepository` (the `Page` reference row) plus the raw `pageDocs` binary blob collection
//    (`pages-repository-live.ts`) for the actual `Automerge.save()` bytes. Content model is a
//    single top-level `text: string` field per page's Automerge doc, mutated via
//    `Automerge.splice` inside `Automerge.change` (plan: "a single Automerge Text object is
//    sufficient" — in `@automerge/automerge@3.x`'s API, that's a plain string field spliced via
//    `Automerge.splice`, not the removed `Automerge.Text` class; confirmed empirically against
//    real `workerd`, see `automerge-probe-durable-object.ts`).
// 2. The Automerge sync-session protocol (task item 5): real `generateSyncMessage`/
//    `receiveSyncMessage` exchange over an opaque per-node session id with per-session ordinals
//    and a `reset: true` reclaim path, per the plan's "Sync protocol" section.
//
// In-memory doc cache and sync-session state are deliberately **closures captured inside
// `makeNotesServiceLive`**, not module-level `Map`s — see `sync-feed-service-live.ts`'s
// `currentEpochAndGeneration` doc comment for why module-level mutable state risks leaking across
// DO instances colocated in the same isolate. `makeNotesServiceLive` runs once per DO
// construction (from `WorkspaceDurableObject`'s constructor), so a closure here is exactly as
// instance-scoped as the collections/repositories it's built from.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Automerge from "@automerge/automerge"
import { canonicalAutomergeHeadsHash, NodeNotFound, NodesRepository, Page, PageNotFound, PagesRepository, UnexpectedError, type EntityId } from "@athenaeum/domain"
import type { PagesCollections, PageDocRow } from "./pages-repository-live.js"
import { revivePage, toUnexpectedError } from "./pages-repository-live.js"
import { SyncFeedService } from "./sync-feed-service-live.js"
import { indexNodeText } from "./read-model.js"

/** The Phase 1 page-body content model (plan: "a single Automerge Text object is sufficient" —
 *  realized in `@automerge/automerge@3.x` as a plain string field). Extra index signature is
 *  required by `Automerge.from`'s own `T extends Record<string, unknown>` constraint, not part of
 *  this schema's real shape — every value this app ever writes still only ever touches `text`. */
export interface PageDoc {
  text: string
  readonly [key: string]: unknown
}

const headsHashOf = (doc: Automerge.Doc<PageDoc>): string => canonicalAutomergeHeadsHash(Automerge.getHeads(doc))

/**
 * Test-only injection point, same pattern as `graph-service-live.ts`'s `createEdgeTestHook`: the
 * real production value (`2048` — generous on purpose, see the `sessions`/`touchSession` doc
 * comment in `makeNotesServiceLive` below) is what every real caller sees; a test can lower it
 * temporarily to make the LRU-eviction cap actually exercisable without needing thousands of real
 * round trips. Read live (not captured once) by `touchSession`, so mutating it affects sessions
 * already under construction, exactly like `createEdgeTestHook.beforeWrite`.
 */
export const notesServiceSessionCapTestHook: { maxSessions: number } = { maxSessions: 2048 }

export interface PageSyncResult {
  readonly message: Uint8Array | null
  readonly converged: boolean
  readonly reset: boolean
}

/** A durable page write that is deliberately not visible through the in-memory document cache
 * until its caller's enclosing SQLite transaction has committed. */
export interface PreparedMergedDoc {
  readonly page: Page
  readonly text: string
  readonly publish: () => void
}

export class NotesService extends Context.Tag("@athenaeum/backend/NotesService")<
  NotesService,
  {
    readonly createPage: (
      nodeId: EntityId
    ) => Effect.Effect<{ page: Page; text: string }, NodeNotFound | PageNotFound | UnexpectedError>
    readonly getPageText: (nodeId: EntityId) => Effect.Effect<{ page: Page; text: string }, PageNotFound | UnexpectedError>
    readonly applyLocalEdit: (
      nodeId: EntityId,
      index: number,
      deleteCount: number,
      insertText: string
    ) => Effect.Effect<{ page: Page; text: string }, PageNotFound | UnexpectedError>
    readonly startSync: (
      nodeId: EntityId,
      sessionId: string
    ) => Effect.Effect<Uint8Array | null, PageNotFound | UnexpectedError>
    readonly receiveSyncMessage: (
      nodeId: EntityId,
      sessionId: string,
      ordinal: number,
      message: Uint8Array
    ) => Effect.Effect<PageSyncResult, PageNotFound | UnexpectedError>
    /**
     * `ChatForkService`'s hook into NotesService's single authoritative doc cache + storage pair
     * (Phase 3 spike, plan risk #4 — see chat-fork-service-live.ts's header comment for the full
     * design). Returns the current mainline doc — cache-or-storage, exactly like every other
     * method here — so a fork always clones (and, at accept time, merges against) truly current
     * state, never a copy that's gone stale relative to NotesService's own cache.
     */
    readonly loadDocForMerge: (nodeId: EntityId) => Effect.Effect<Automerge.Doc<PageDoc>, PageNotFound | UnexpectedError>
    /**
     * Persists an externally-produced doc (a `ChatForkService.accept()` merge result) through the
     * exact same `saveDoc`/reindex/`syncFeed.append` path `applyLocalEdit` uses — the load-bearing
     * reason this exists rather than `ChatForkService` writing `pageDocs`/`pages` directly: a
     * direct write would leave this service's in-memory `docCache` stale (a real bug this spike's
     * own test suite caught — a subsequent `getPageText` kept returning the pre-merge text,
     * served from the stale cache, until this method was introduced). Routing every mainline
     * write through this one path is what keeps NotesService's cache and DO storage from ever
     * being able to disagree, no matter which service produced the new doc.
     */
    readonly applyMergedDoc: (
      nodeId: EntityId,
      mergedDoc: Automerge.Doc<PageDoc>
    ) => Effect.Effect<{ page: Page; text: string }, UnexpectedError>
    /** Transaction fanout seam for ledgered mutations. Persists page bytes, page metadata,
     * search projection, and sync-feed record, but leaves cache publication to `publish()` after
     * the outer Durable Object transaction succeeds. */
    readonly prepareMergedDoc: (
      nodeId: EntityId,
      mergedDoc: Automerge.Doc<PageDoc>
    ) => Effect.Effect<PreparedMergedDoc, UnexpectedError>
    /** Restores a committed doc to the instance-local cache during an accepted-proposal replay. */
    readonly restoreCommittedDoc: (
      nodeId: EntityId,
      committedBytes: Uint8Array,
      committedHeadsHash: string
    ) => Effect.Effect<{ page: Page; text: string }, PageNotFound | UnexpectedError>
  }
>() {}

export const makeNotesServiceLive = (
  collections: PagesCollections,
  sql: SqlStorage
): Layer.Layer<NotesService, never, NodesRepository | PagesRepository | SyncFeedService> =>
  Layer.effect(
    NotesService,
    Effect.gen(function* () {
      const nodesRepository = yield* NodesRepository
      const pagesRepository = yield* PagesRepository
      const syncFeed = yield* SyncFeedService

      // Instance-scoped (see module doc comment above), lazily populated from `pageDocs` storage
      // on first touch per node, kept in sync with storage on every mutation.
      const docCache = new Map<EntityId, Automerge.Doc<PageDoc>>()

      // Instance-scoped sync-session state: per `(nodeId, sessionId)` compound key, the server's
      // own `Automerge.SyncState` plus the ordinal it expects the client's *next* message to carry
      // (the mechanism backing "per-session ordinals" — task item 5).
      interface SessionState {
        syncState: Automerge.SyncState
        expectedOrdinal: number
      }
      const sessions = new Map<string, SessionState>()
      const sessionKey = (nodeId: EntityId, sessionId: string): string => `${nodeId}:${sessionId}`

      // Adversarial-review fix: with the client now reusing one stable session id per note per
      // tab-lifetime (see `automerge-page.ts`'s `SyncSessionHandle` doc comment), normal typing
      // activity no longer accumulates a fresh entry here on every debounced sync. This cap is the
      // second, independent half of that fix — a server-side backstop bounding `sessions`
      // regardless of *how* many distinct ids arrive (a buggy/malicious client, many notes, many
      // tabs, a future multi-device client): an LRU eviction, not just a size check, since the
      // sessions actually worth keeping are the recently-touched ones a client is mid-exchange
      // with. Generous on purpose (a personal single-workspace app's realistic concurrent-session count
      // is tiny) — this exists to bound memory, not to constrain legitimate use.
      const touchSession = (key: string, state: SessionState): void => {
        // `Map` preserves insertion order; deleting then re-setting moves `key` to the
        // most-recently-used end, so the oldest (least-recently-touched) entry is always the one
        // `.keys().next()` yields once the cap is exceeded.
        sessions.delete(key)
        sessions.set(key, state)
        while (sessions.size > notesServiceSessionCapTestHook.maxSessions) {
          const oldestKey = sessions.keys().next().value
          if (oldestKey === undefined) break
          sessions.delete(oldestKey)
        }
      }

      const loadDoc = (nodeId: EntityId): Effect.Effect<Automerge.Doc<PageDoc>, PageNotFound | UnexpectedError> =>
        Effect.gen(function* () {
          const cached = docCache.get(nodeId)
          if (cached) return cached

          const pageRow = yield* collections.pages.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
          if (pageRow === undefined) return yield* Effect.fail(new PageNotFound({ nodeId }))

          const docRow = yield* collections.pageDocs.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
          if (docRow === undefined) {
            return yield* Effect.fail(
              new UnexpectedError({ message: `page ${nodeId} exists but its Automerge doc blob is missing` })
            )
          }
          const doc = Automerge.load<PageDoc>((docRow as PageDocRow).bytes)
          docCache.set(nodeId, doc)
          return doc
        })

      /** Persists `doc` as this node's new authoritative state: updates the in-memory cache, the
       *  raw binary blob, and the `Page` reference row's `headsHash` together, so they never drift
       *  out of sync with each other. */
      const saveDoc = (
        nodeId: EntityId,
        doc: Automerge.Doc<PageDoc>
      ): Effect.Effect<Page, UnexpectedError> =>
        Effect.gen(function* () {
          docCache.set(nodeId, doc)
          const bytes = Automerge.save(doc)
          yield* collections.pageDocs.put({ nodeId, bytes }).pipe(Effect.mapError(toUnexpectedError))

          const existingPage = yield* collections.pages.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
          const automergeDocId = existingPage?.automergeDocId ?? nodeId
          const page = new Page({ nodeId, automergeDocId, headsHash: headsHashOf(doc) })
          yield* collections.pages.put(page).pipe(Effect.mapError(toUnexpectedError))
          return page
        })

      const prepareMergedDoc = (
        nodeId: EntityId,
        mergedDoc: Automerge.Doc<PageDoc>
      ): Effect.Effect<PreparedMergedDoc, UnexpectedError> =>
        Effect.gen(function* () {
          // Do not publish `mergedDoc` to docCache yet. A ledger caller may still roll back its
          // enclosing `transactionSync`; cache publication happens only through the returned
          // closure after that transaction has committed.
          const bytes = Automerge.save(mergedDoc)
          yield* collections.pageDocs.put({ nodeId, bytes }).pipe(Effect.mapError(toUnexpectedError))
          const existingPage = yield* collections.pages.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
          const page = new Page({ nodeId, automergeDocId: existingPage?.automergeDocId ?? nodeId, headsHash: headsHashOf(mergedDoc) })
          yield* collections.pages.put(page).pipe(Effect.mapError(toUnexpectedError))
          yield* reindex(nodeId, mergedDoc.text)
          yield* syncFeed.append("page", nodeId, "put", { nodeId, headsHash: page.headsHash })
          return { page, text: mergedDoc.text, publish: () => docCache.set(nodeId, mergedDoc) }
        })

      /** Re-indexes `graph_text_search` (Views/Search stage, plan §"Full-text search") for one
       *  node's current title + page body, immediately after every successful page write.
       *  Fetches the node's title fresh each time rather than caching it — an extra
       *  `nodesRepository.get` per edit, acceptable at Phase 1's scale, and avoids the read-model
       *  index silently going stale if a future stage adds node-title editing.
       *
       *  A page can only exist for a node that passed `nodesRepository.get` in `createPage`
       *  (this phase's domain model has no node-delete RPC — `Node` rows are never removed), so
       *  a `NodeNotFound` here should be unreachable; it is still folded into `UnexpectedError`
       *  rather than propagated, both to keep `applyLocalEdit`/`receiveSyncMessage`'s already-
       *  published error channel (`PageNotFound | UnexpectedError`, no `NodeNotFound`) accurate,
       *  and because a `NodeNotFound` that *did* somehow happen here would be exactly that: an
       *  internal inconsistency, not an expected caller-facing failure mode. */
      const reindex = (nodeId: EntityId, body: string): Effect.Effect<void, UnexpectedError> =>
        Effect.gen(function* () {
          const node = yield* nodesRepository.get(nodeId)
          yield* indexNodeText(sql, nodeId, node.title, body)
        }).pipe(
          Effect.catchTag("NodeNotFound", (error) =>
            Effect.fail(
              new UnexpectedError({
                message: `graph_text_search reindex: page exists for missing node ${error.nodeId}`
              })
            )
          )
        )

      return {
        createPage: (nodeId) =>
          Effect.gen(function* () {
            yield* nodesRepository.get(nodeId)

            const existingRaw = yield* collections.pages.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
            if (existingRaw !== undefined) {
              const existing = yield* revivePage(existingRaw)
              const doc = yield* loadDoc(nodeId)
              return { page: existing, text: doc.text }
            }

            const doc = Automerge.from<PageDoc>({ text: "" })
            const page = yield* saveDoc(nodeId, doc)
            yield* reindex(nodeId, doc.text)
            yield* syncFeed.append("page", nodeId, "put", { nodeId, headsHash: page.headsHash })
            return { page, text: doc.text }
          }),

        getPageText: (nodeId) =>
          Effect.gen(function* () {
            const page = yield* pagesRepository.get(nodeId)
            const doc = yield* loadDoc(nodeId)
            return { page, text: doc.text }
          }),

        applyLocalEdit: (nodeId, index, deleteCount, insertText) =>
          Effect.gen(function* () {
            const doc = yield* loadDoc(nodeId)
            const nextDoc = Automerge.change(doc, (draft) => {
              Automerge.splice(draft, ["text"], index, deleteCount, insertText)
            })
            const page = yield* saveDoc(nodeId, nextDoc)
            yield* reindex(nodeId, nextDoc.text)
            yield* syncFeed.append("page", nodeId, "put", { nodeId, headsHash: page.headsHash })
            return { page, text: nextDoc.text }
          }),

        startSync: (nodeId, sessionId) =>
          Effect.gen(function* () {
            const doc = yield* loadDoc(nodeId)
            const [syncState, message] = Automerge.generateSyncMessage(doc, Automerge.initSyncState())
            touchSession(sessionKey(nodeId, sessionId), { syncState, expectedOrdinal: 0 })
            return message
          }),

        receiveSyncMessage: (nodeId, sessionId, ordinal, message) =>
          Effect.gen(function* () {
            // Confirms the page (and thus the doc) exists before touching session state — a
            // `pageSyncMessage` call against a node with no page fails the same way `startSync`
            // would have.
            const doc = yield* loadDoc(nodeId)

            const key = sessionKey(nodeId, sessionId)
            const session = sessions.get(key)
            if (session === undefined || ordinal !== session.expectedOrdinal) {
              // The plan's "reset: true reclaim on ambiguous timeout" path: no session memory (it
              // was never started, or was reaped) or an out-of-order ordinal — either way this
              // server has no safe way to continue the exchange, so it discards any partial state
              // for this id and tells the caller to restart via `startSync`.
              sessions.delete(key)
              return { message: null, converged: false, reset: true }
            }

            const [nextDoc, receivedState] = Automerge.receiveSyncMessage(doc, session.syncState, message)
            const [outState, outMessage] = Automerge.generateSyncMessage(nextDoc, receivedState)

            touchSession(key, { syncState: outState, expectedOrdinal: ordinal + 1 })
            yield* saveDoc(nodeId, nextDoc)
            yield* reindex(nodeId, nextDoc.text)
            yield* syncFeed.append("page", nodeId, "put", {
              nodeId,
              headsHash: headsHashOf(nextDoc)
            })

            return { message: outMessage, converged: outMessage === null, reset: false }
          }),

        loadDocForMerge: (nodeId) => loadDoc(nodeId),

        applyMergedDoc: (nodeId, mergedDoc) =>
          Effect.gen(function* () {
            const prepared = yield* prepareMergedDoc(nodeId, mergedDoc)
            prepared.publish()
            return { page: prepared.page, text: prepared.text }
          }),

        prepareMergedDoc,
        restoreCommittedDoc: (nodeId, committedBytes, committedHeadsHash) =>
          Effect.gen(function* () {
            const page = yield* pagesRepository.get(nodeId)
            if (page.headsHash === committedHeadsHash) {
              const committedDoc = Automerge.load<PageDoc>(committedBytes)
              docCache.set(nodeId, committedDoc)
              return { page, text: committedDoc.text }
            }

            // A later direct/sync write has already superseded this accepted proposal. A retry
            // is idempotent for its ledger receipt, not authorization to overwrite that newer
            // durable page state; bypass the cache because it may be the stale pre-commit doc.
            const currentRow = yield* collections.pageDocs.get(nodeId).pipe(Effect.mapError(toUnexpectedError))
            if (currentRow === undefined) {
              return yield* Effect.fail(new UnexpectedError({ message: `page ${nodeId} exists but its Automerge doc blob is missing` }))
            }
            const currentDoc = Automerge.load<PageDoc>((currentRow as PageDocRow).bytes)
            docCache.set(nodeId, currentDoc)
            return { page, text: currentDoc.text }
          })
      }
    })
  )
