import * as Automerge from "@automerge/automerge"
import * as Effect from "effect/Effect"
import { StartPageSyncInput, PageSyncMessageInput, type DomainError, type EntityId } from "@athenaeum/domain"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

// Client-side half of the plan's Automerge prose sync protocol (plan §"Sync protocol": "Prose
// (Automerge note bodies): real CRDT sync — opaque session ID stable across restarts, per-session
// ordinals, reset:true reclaim on ambiguous timeout"). Deliberately does NOT call `applyPageEdit`
// (the direct server-side-mutation RPC `notes-service-live.ts` also exposes) — per this stage's
// task ("edits apply as real local Automerge changes and sync to the backend via the real
// Automerge sync-session protocol"), every edit here is applied to a genuine local
// `Automerge.Doc` first and only reaches the server as real `generateSyncMessage`/
// `receiveSyncMessage` frames over `startPageSync`/`pageSyncMessage`, exactly the exchange two
// Automerge peers would have — not a shortcut RPC.
//
// Content model mirrors `notes-service-live.ts`'s `PageDoc` exactly (same doc shape both sides of
// the sync protocol must agree on): a single top-level `text: string` field. `@automerge/
// automerge@3.x` has no `Automerge.Text` class (confirmed server-side by
// `automerge-probe-durable-object.ts`) — a plain string field is the real, current API, not a
// simplification. This module only owns transport (session handling + the sync round trip below);
// this pass's rich-text schema replaced the earlier plain-textarea editor's direct
// `Automerge.splice`/full-string-diff mutation path (`applyLocalSplice`/`diffText`, both removed —
// dead once `RichNoteEditor` started mutating the doc via the vendored `@automerge/prosemirror`
// `syncPlugin`/`LocalDocHandle` instead) with block-marker-aware mutation
// (`rich-text/migration.ts`'s `Automerge.splitBlock`, and ProseMirror transactions applied via
// `LocalDocHandle`) — the `text` field itself, and this module's transport, are unchanged by that.

export interface PageDoc {
  text: string
  /** Root-level rich-text schema marker (adversarial-review fix, `rich-text/schema.ts`'s
   *  `RICH_TEXT_SCHEMA_VERSION` doc comment has the full story) — absent or `< 2` on a legacy
   *  flat-text note; `>= 2` once any content has passed through the rich editor's
   *  `LocalDocHandle.change`/`ensureRichTextSchema` migration. Declared as an explicit (mutable)
   *  property, not left to the index signature below, specifically so those call sites can assign
   *  `draft.schemaVersion = ...` — the index signature stays `readonly` for every other ad hoc key
   *  this opaque-to-the-backend doc shape may carry. This is `packages/web`'s own mirror of the
   *  root key `native/AthenaeumCore/Sources/AthenaeumCore/PageDocumentStore.swift`'s
   *  `isRichTextNote` reads as its primary signal — the field name and the "`>= 2`" threshold must
   *  stay in sync with that file if either ever changes. */
  schemaVersion?: number
  readonly [key: string]: unknown
}

/**
 * A caller-owned, mutable handle to one Automerge sync session's id (adversarial-review fix: the
 * plan's "opaque session ID stable across restarts" was previously undermined by
 * `syncPageWithServer` minting a brand-new `crypto.randomUUID()` on every call, including every
 * debounced-edit resync — see this module's and `notes-service-live.ts`'s doc comments for the
 * full before/after). The caller (`DailyNote.tsx`) creates exactly one of these per resolved note
 * per component lifetime and passes it into every `syncPageWithServer` call for that note, so the
 * *same* session id is reused across the initial resolve and every subsequent debounced sync —
 * `syncPageWithServer` only ever replaces `.id` itself, on a real `reset:true` from the server.
 * A plain mutable object (not a `useRef` type) so this module stays React-agnostic — `DailyNote`
 * wraps it in a `useRef` on its side.
 */
export interface SyncSessionHandle {
  id: string
}

export const newSyncSessionHandle = (): SyncSessionHandle => ({ id: crypto.randomUUID() })

/**
 * A fresh, empty local replica — used both for a brand-new page and, after a reload, as the
 * starting point that `syncPageWithServer` fills in with whatever the server already has (this
 * app keeps no local persistence of the Automerge doc across reloads — see the daily-note
 * component's doc comment for why that's an accepted Phase 1 scope decision, not an oversight).
 *
 * **Must be `Automerge.init()`, never `Automerge.from({text: ""})`** — this was a real, verified
 * data-loss bug found and fixed during the offline-first exit-criterion pass (see the Phase 1
 * exit-criteria report). `Automerge.from(...)` performs its own genesis commit, creating an
 * *independent* `text` object under a brand-new actor id, with no causal relationship to the
 * server's own genesis `text` object (created once, in `createPage`, when the page first exists).
 * When two independently-`.from()`-created docs are merged, Automerge resolves the map-level
 * conflict on the shared `text` *key* via last-writer-wins (by actor id), not by merging the two
 * text objects character-by-character — so a reload's fresh `emptyPageDoc()` merging against a
 * server doc that already has real content has a real chance of the empty local `text` object
 * winning the tiebreak, silently discarding the server's content the moment this doc syncs back
 * up. Reproduced for real: type into today's note, go offline mid-edit (network emulation, not
 * simulated), let the debounced sync succeed once connectivity resumes (content correct at that
 * point), then reload the page — the previously-synced content came back empty, confirmed
 * independently against the backend's own `getPageText` RPC (not just a client-side rendering
 * glitch). `Automerge.init()` has no such genesis commit — its `text` key only ever comes from
 * whatever `syncPageWithServer` merges in from the server's real lineage, so there is nothing for
 * a LWW race to resolve the wrong way. Confirmed fixed by re-running the identical offline/reload
 * repro after this change (see the exit-criteria report for the full before/after).
 */
export const emptyPageDoc = (): Automerge.Doc<PageDoc> => Automerge.init<PageDoc>()

/**
 * Runs a full Automerge sync-session round trip against the backend's real
 * `startPageSync`/`pageSyncMessage` RPCs, returning the resulting merged local doc. Exchanges
 * genuine `generateSyncMessage`/`receiveSyncMessage` frames until neither side has anything left
 * to send — pulls down whatever the server already had (e.g. after a reload, starting from
 * `emptyPageDoc()`) *and* pushes up any local edits already applied to `localDoc`, in the same
 * pass, exactly like two converging Automerge peers.
 *
 * Bounded at 50 round trips (not `while (true)`): a genuine protocol bug on either side must fail
 * loudly/return, not hang the UI forever. A real Phase 1 single-page edit converges in 2-4 round
 * trips in practice.
 *
 * **`session` is caller-owned and reused across calls (adversarial-review fix)** — see
 * `SyncSessionHandle`'s doc comment. This function only ever *reads* `session.id` to start with,
 * and only ever *writes* it on a genuine `reset: true` from the server (a fresh session id is the
 * correct response to that, not a bug) — never mints a fresh id on a normal, successful call.
 */
export const syncPageWithServer = (
  client: WorkspaceRpcClientService,
  workspaceId: EntityId,
  nodeId: EntityId,
  localDoc: Automerge.Doc<PageDoc>,
  session: SyncSessionHandle
): Effect.Effect<Automerge.Doc<PageDoc>, DomainError> =>
  Effect.gen(function* () {
    let doc = localDoc
    let syncState = Automerge.initSyncState()
    let ordinal = 0

    let serverMessage = (
      yield* client.startPageSync(new StartPageSyncInput({ workspaceId, nodeId, sessionId: session.id }))
    ).message

    for (let round = 0; round < 50; round++) {
      if (serverMessage !== null) {
        const [nextDoc, nextState] = Automerge.receiveSyncMessage(doc, syncState, serverMessage)
        doc = nextDoc
        syncState = nextState
      }

      const [afterGenState, outMessage] = Automerge.generateSyncMessage(doc, syncState)
      syncState = afterGenState

      if (outMessage === null) {
        // Nothing left for us to send. If the server's last message was also `null` (or this is
        // the very first round and it had nothing to offer), both sides are caught up.
        break
      }

      const response = yield* client.pageSyncMessage(
        new PageSyncMessageInput({ workspaceId, nodeId, sessionId: session.id, ordinal, message: outMessage })
      )
      ordinal += 1

      if (response.reset) {
        // The plan's "reset: true reclaim on ambiguous timeout" path: the server has no memory of
        // this session (evicted, or never started) — restart with a fresh session id and fresh
        // sync state rather than assume any further ordinal continuity. This is the one legitimate
        // place `session.id` is ever overwritten (see `SyncSessionHandle`'s doc comment) — the
        // caller's stored handle picks up the new id automatically since it's the same object.
        session.id = crypto.randomUUID()
        syncState = Automerge.initSyncState()
        const restarted = yield* client.startPageSync(
          new StartPageSyncInput({ workspaceId, nodeId, sessionId: session.id })
        )
        serverMessage = restarted.message
        ordinal = 0
        continue
      }

      serverMessage = response.message
      if (response.converged && serverMessage === null) break
    }

    return doc
  })
