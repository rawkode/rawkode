// `ChatForkService` — the Phase 3 "Automerge-fork-as-chat-branch" mini-spike (plan §"Agent-native
// editing & gatekeeper integrations", risk #4: "a chat's pending note edits are a per-chat
// Automerge fork (Automerge.clone); accept = merge fork into mainline heads, revert = discard
// fork... This specific combination has no precedent in either source codebase — needs its own
// design spike in Phase 3"). Full writeup of the two hard questions this spike resolves —
// cross-device fork visibility, and interaction with the real Automerge sync-session protocol —
// lives in docs/automerge-fork-spike.md; this module is the real, working mechanism the doc
// describes, proven by test/chat-fork.test.ts against the real production RPC path.
//
// Design summary (see the doc for the full reasoning):
// - A fork is `Automerge.clone()`d from `NotesService.loadDocForMerge(nodeId)` — the SAME
//   authoritative doc `NotesService` itself reads/writes for every other page operation, not a
//   second, independent read of storage. Below, it's kept ONLY in this DO instance's in-memory
//   `forks` Map — never persisted, never `syncFeed.append()`-ed. That single fact is what
//   answers both hard questions at once: forks are purely server-side/in-DO-memory (never touch
//   the Automerge sync-session protocol, which only ever reads/writes through `NotesService`'s
//   own doc cache — see `NotesService.loadDoc`/`startSync`), and every watcher of a chat's live
//   preview is reading the SAME DO instance's SAME in-memory fork (proven by
//   test/chat-fork.test.ts opening two independent RPC connections to one workspace and observing
//   identical `previewFork` output from both) — so cross-device/cross-tab preview is "free" via
//   ordinary DO-instance-scoped state, with no separate sync mechanism to build.
// - `accept()` re-loads mainline fresh via `NotesService.loadDocForMerge` (not the doc the fork
//   was cloned from — the two may have diverged if mainline was edited directly while the fork
//   was open) and runs a real `Automerge.merge(mainline, fork)`, so accept correctly incorporates
//   concurrent direct edits to the page AND the agent's fork edits, not just an overwrite. The
//   merged doc is then persisted via `NotesService.applyMergedDoc` — the exact same
//   `pageDocs`/`pages`/reindex/`syncFeed.append` write path `NotesService.applyLocalEdit` uses,
//   critically INCLUDING NotesService's own in-memory doc cache. This module originally wrote
//   `pageDocs`/`pages` directly (bypassing NotesService); this spike's own test suite caught the
//   resulting bug — `getPageText` kept serving NotesService's now-stale cached doc after an
//   accept — which is why every mainline read/write here goes through `NotesService`, never
//   around it. Accept is a real mainline mutation, fully visible to search, the sync feed, and
//   the Automerge sync protocol, indistinguishable from a normal edit.
// - `revert()` simply discards the in-memory fork entry — nothing was ever written anywhere, so
//   there is nothing to undo; mainline was never touched.
//
// Instance-scoped state via closure, not a module-level Map — identical rationale to
// `NotesService`'s own `docCache`/`sessions` (see notes-service-live.ts's header comment): this
// DO class can be colocated with other unrelated DO instances in the same isolate, so any
// module-level mutable Map would risk leaking chat-fork state across workspaces.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Automerge from "@automerge/automerge"
import { Page, PageNotFound, UnexpectedError, ValidationError, type EntityId } from "@athenaeum/domain"
import type { PageDoc } from "./notes-service-live.js"
import { NotesService } from "./notes-service-live.js"

const forkKey = (chatId: string, nodeId: EntityId): string => `${chatId}:${nodeId}`

export interface ChatForkPreview {
  readonly forked: boolean
  readonly text: string
}

export class ChatForkService extends Context.Tag("@athenaeum/backend/ChatForkService")<
  ChatForkService,
  {
    /** Forks the mainline page for `(chatId, nodeId)` if not already forked; idempotent — a
     *  second `fork()` for the same pair returns the current (possibly already-edited) fork's
     *  text rather than discarding it and re-cloning from mainline. */
    readonly fork: (
      chatId: string,
      nodeId: EntityId
    ) => Effect.Effect<{ text: string }, PageNotFound | UnexpectedError>
    /** Applies a text-splice edit to the fork ONLY — never touches mainline storage, the sync
     *  feed, or the Automerge sync-session protocol. Fails with `ValidationError` if no fork is
     *  active (the caller must `fork()` first). */
    readonly applyForkEdit: (
      chatId: string,
      nodeId: EntityId,
      index: number,
      deleteCount: number,
      insertText: string
    ) => Effect.Effect<{ text: string }, ValidationError>
    /** Read-only snapshot of a chat's fork state, safe to call from any number of concurrent
     *  watchers (see this module's header comment) — never falls back to mainline text. */
    readonly previewFork: (chatId: string, nodeId: EntityId) => Effect.Effect<ChatForkPreview, never>
    /** Merges the fork into a freshly-reloaded mainline doc via real `Automerge.merge`, persists
     *  the result via `NotesService.applyMergedDoc` (pageDocs bytes + `Page.headsHash` +
     *  `graph_text_search` reindex + a `syncFeed.append` entry — see this module's header
     *  comment for why this must go through `NotesService`, not direct storage writes), then
     *  discards the fork. Fails with `ValidationError` if no fork is active. */
    readonly accept: (
      chatId: string,
      nodeId: EntityId
    ) => Effect.Effect<{ page: Page; text: string }, ValidationError | PageNotFound | UnexpectedError>
    /** Discards the in-memory fork, if any. Never fails — reverting an already-reverted or
     *  never-forked `(chatId, nodeId)` pair is a no-op, not an error, since "no pending edit
     *  exists" is exactly the state revert is trying to reach. */
    readonly revert: (chatId: string, nodeId: EntityId) => Effect.Effect<void, never>
  }
>() {}

export const makeChatForkServiceLive = (): Layer.Layer<ChatForkService, never, NotesService> =>
  Layer.effect(
    ChatForkService,
    Effect.gen(function* () {
      const notes = yield* NotesService

      // Instance-scoped fork state — see this module's header comment for why a closure, not a
      // module-level Map. Keyed by "chatId:nodeId" so one chat can hold forks on multiple pages
      // and multiple chats can independently fork the same page without colliding.
      const forks = new Map<string, Automerge.Doc<PageDoc>>()

      const notForked = (chatId: string, nodeId: EntityId, action: string): ValidationError =>
        new ValidationError({
          message: `no active fork for chat ${chatId} on node ${nodeId} — ${action}`
        })

      return {
        fork: (chatId, nodeId) =>
          Effect.gen(function* () {
            const key = forkKey(chatId, nodeId)
            const existing = forks.get(key)
            if (existing !== undefined) return { text: existing.text }
            const mainline = yield* notes.loadDocForMerge(nodeId)
            const forked = Automerge.clone<PageDoc>(mainline)
            forks.set(key, forked)
            return { text: forked.text }
          }),

        applyForkEdit: (chatId, nodeId, index, deleteCount, insertText) =>
          Effect.gen(function* () {
            const key = forkKey(chatId, nodeId)
            const doc = forks.get(key)
            if (doc === undefined) {
              return yield* Effect.fail(notForked(chatId, nodeId, "call fork() before applyForkEdit()"))
            }
            const next = Automerge.change(doc, (draft) => {
              Automerge.splice(draft, ["text"], index, deleteCount, insertText)
            })
            forks.set(key, next)
            return { text: next.text }
          }),

        previewFork: (chatId, nodeId) =>
          Effect.sync((): ChatForkPreview => {
            const doc = forks.get(forkKey(chatId, nodeId))
            return doc === undefined ? { forked: false, text: "" } : { forked: true, text: doc.text }
          }),

        accept: (chatId, nodeId) =>
          Effect.gen(function* () {
            const key = forkKey(chatId, nodeId)
            const fork = forks.get(key)
            if (fork === undefined) {
              return yield* Effect.fail(notForked(chatId, nodeId, "nothing to accept"))
            }

            // Reload mainline fresh — it may have been edited directly (applyPageEdit, or a real
            // Automerge sync session) since fork() cloned it. Automerge.merge correctly
            // incorporates both sets of changes via shared causal history; this is not an
            // overwrite.
            const mainline = yield* notes.loadDocForMerge(nodeId)
            const merged = Automerge.merge(mainline, fork)
            const result = yield* notes.applyMergedDoc(nodeId, merged)

            forks.delete(key)
            return result
          }),

        revert: (chatId, nodeId) =>
          Effect.sync(() => {
            forks.delete(forkKey(chatId, nodeId))
          })
      }
    })
  )
