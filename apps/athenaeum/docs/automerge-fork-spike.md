# Automerge-fork-as-chat-branch spike

> Compatibility record: this mechanism remains only for legacy `automerge-v1`
> pages. New and migrated pages are Loro-authoritative; their agent `editNote`
> calls commit through the semantic ledger and never create an Automerge fork.

Status: Phase 3 pre-work spike, complete. Resolves risk #4 from the architecture plan's "Top
risks, explicitly flagged" section and the corresponding item in "Agent-native editing &
gatekeeper integrations": *"a chat's pending note edits are a per-chat Automerge fork
(Automerge.clone); accept = merge fork into mainline heads, revert = discard fork... This
specific combination has no precedent in either source codebase — needs its own design spike in
Phase 3."*

Real, working code: `packages/backend/src/chat-fork-service-live.ts` (the mechanism),
`packages/backend/src/notes-service-live.ts` (two small additive methods — see "What changed in
NotesService" below), `packages/backend/src/workspace-durable-object.ts` (real wiring: 5 new RPC
methods on the real `WorkspaceDurableObject`, not a scratch/throwaway DO), and
`packages/domain/src/chat-fork-rpc.ts` (wire schemas). Real, working tests:
`packages/backend/test/chat-fork.test.ts`, 9 tests, all passing, all exercised over the real
Cap'n Web RPC path via `connectToWorkspace` — the same harness every other backend feature test uses,
not a bypass into service internals.

## The mechanism

- `ChatForkService.fork(chatId, nodeId, rationale?)` — `Automerge.clone()`s the current mainline
  doc into an in-memory fork keyed by `"${chatId}:${nodeId}"`. Idempotent: a second `fork()` call
  for an already-forked pair returns the current (possibly agent-edited) fork's text, not a fresh
  clone that would discard prior edits. Legacy agent calls carry their commit message as the
  proposal rationale.
- `ChatForkService.applyForkEdit(chatId, nodeId, index, deleteCount, insertText, rationale?)` —
  applies a text-splice `Automerge.change` to the fork only and refreshes the proposal rationale
  when the caller supplies one.
- `ChatForkService.previewFork(chatId, nodeId)` — read-only `{forked, text}` snapshot.
- `ChatForkService.accept(chatId, nodeId)` — reloads mainline **fresh** (not the doc the fork was
  cloned from), runs `Automerge.merge(mainline, fork)`, persists the merged doc, and discards the
  fork.
- `ChatForkService.revert(chatId, nodeId)` — discards the in-memory fork. Never fails.

Fork state lives in a plain in-memory `Map`, closed over inside `makeChatForkServiceLive`'s
`Layer.effect` body — never a module-level `Map`. This mirrors `NotesService`'s own
`docCache`/`sessions` state and for the identical reason: a DO class can be colocated with other
unrelated DO instances in the same `workerd` isolate, so module-level mutable state risks leaking
across workspaces. A closure is exactly as instance-scoped as the `Layer` it's built from.

## Proof (what `test/chat-fork.test.ts` actually exercises)

All nine tests run against a real deployed-shape Workspace DO (via `@cloudflare/vitest-pool-workers`)
reached over real Cap'n Web WebSocket RPC connections, with real `@automerge/automerge` CRDT
operations and real DO SQLite storage underneath — nothing is mocked or bypassed.

1. **Fork isolation.** Editing a fork never changes what `getPageText` (mainline) returns, for
   as long as the fork is open.
2. **Accept merges correctly, including under real concurrency.** One test forks, then edits
   mainline directly (`applyPageEdit`, simulating the user typing in their own tab) *while the
   fork is still open*, then edits the fork, then accepts — and asserts **both** edits' content
   survived the merge. This is a genuine `Automerge.merge` over diverged causal history, not an
   overwrite; a naive "accept = replace mainline with the fork's text" implementation would have
   silently dropped the concurrent direct edit, and this test would have caught it.
3. **Revert leaves mainline byte-for-byte untouched**, including the `Page.headsHash` — and a
   revert of a chat/node pair that was never forked is a safe no-op (not an error), matching the
   design's stated semantics ("no pending edit exists" is exactly the state revert is trying to
   reach).
4. **Cross-connection ("cross-device") visibility.** A second, fully independent live RPC
   connection to the same workspace (`connectToWorkspace` called twice, standing in for a second browser
   tab or a native client) sees the **identical** `chatForkPreview` output a first connection
   does, while a `getPageText` call from that second connection sees only mainline. This is the
   concrete proof for the cross-device decision below.
5. **No interaction with the Automerge sync-session protocol.** With a fork open and edited, a
   full real `startPageSync`/`pageSyncMessage` exchange is driven from a from-scratch client-side
   Automerge doc — the reconstructed client doc after the exchange converges to mainline exactly,
   never containing the fork's edit.
6. **Sync-feed interaction is exactly as designed.** Forking and editing a fork appends zero
   entries to the structured-record sync feed; accepting appends exactly one (indistinguishable
   from any other page edit); reverting appends zero.

## The two hard questions this spike had to resolve

### 1. Does a second device watching the same chat see the fork, or only mainline?

**Decision: server-side, DO-instance-scoped, visible to any number of live watchers — not
single-device/web-only, and not requiring a separate cross-device sync mechanism.**

The plan explicitly asked for this to be decided "explicitly... rather than by default," framing
the choice as single-device/web-only (simpler) vs. genuinely cross-device (harder). The resolved
design lands on a third option that is simultaneously the simplest to build *and* genuinely
cross-device, because of one specific choice: **only the agent (mediated by the DO) ever writes
to a fork; nothing writes to it from more than one place.** A fork is a server-side value with
exactly one writer (`ChatForkService.applyForkEdit`, called by the future `AgentEditService`'s
tool-execution loop) and any number of readers (`previewFork`, callable from any live RPC
connection to the workspace). Because the DO is a single process holding one canonical in-memory
`forks` Map, every connected client — web tab, native app, a second browser window — that calls
`chatForkPreview` for the same `(chatId, nodeId)` sees exactly the same bytes, "for free," with
zero additional sync protocol. Test #4 above proves this directly: two independent WebSocket
sessions to the same workspace see byte-identical fork state.

What this design **does not** provide, deliberately: a second device does not get its own
writable, offline-editable local replica of the fork's Automerge doc — there is no fork-specific
sync-session protocol (no fork equivalent of `startPageSync`/`pageSyncMessage`), and a network
partition between a watching client and the DO means that client simply can't see fork updates
until reconnected (the same as any other live RPC subscription in this codebase, e.g.
`NodesSubscription` — no different reliability story than what already exists). This is
acceptable, and arguably correct, precisely because a chat's fork is never something a human
edits directly with their own local CRDT replica — the whole point of the fork is that the
*agent* proposes edits and a human reviews/accepts/reverts them via a thin, always-online RPC
call, not a peer that needs offline editing capability of its own. If a future phase wants a
human to co-edit a fork alongside the agent (not in Phase 3's scope), *that* would need real
peer-to-peer sync machinery and should be designed then, not spoken for now.

**Why not build the harder (genuinely offline-multi-writer) option now, given Phase 1/2 already
built a real Automerge sync protocol?** Reusing that protocol for forks would mean giving every
fork its own `AutomergeSyncSession`, its own epoch-recovery story, and its own persisted storage
row — real, non-trivial work, and work that solves a problem this design doesn't have: nothing
in Phase 3's scope needs a human to make concurrent, causally-independent edits to a fork the
agent is also editing. Building that machinery now would be scope creep against an unvalidated
need, exactly the kind of speculative complexity the plan's own "God-object mitigation" and
"deliberately conservative" framing (see the plan's note that scoping forking to prose only,
not structured graph mutations, was "more conservative than it first appears") argues against.

### 2. How does a fork interact with the real Automerge sync-session protocol?

**Decision: not at all, until accept — forks are purely server-side/in-DO-memory, and a chat's
live edit preview does NOT need its own separate sync mechanism.**

`NotesService.startSync`/`receiveSyncMessage` (the real `Automerge.generateSyncMessage`/
`receiveSyncMessage` exchange built in the Storage/Views stage) only ever reads and writes through
`NotesService`'s own doc cache and `pageDocs`/`pages` storage. A fork lives in a completely
separate `Map` inside `ChatForkService` and is never written to that storage until `accept()`
calls `NotesService.applyMergedDoc` — at which point it stops being "a fork" and simply becomes
the next ordinary mainline write, going through the identical path a real
`pageSyncMessage`-driven merge would. Test #5 proves this empirically: a from-scratch client
Automerge doc, synced against the server via the real protocol while a fork is open and edited,
converges to mainline text only — the fork's content is structurally unreachable from that
protocol.

This means a chat's live edit preview is served by an entirely different, much simpler mechanism
than page sync: a plain request/response (or, in the next stage, a push subscription following
`NodesSubscription`'s existing `RpcTarget` pattern) reading `ChatForkService.previewFork`, not a
CRDT sync exchange. **No new sync mechanism is needed for the fork's own content** — the only
thing that ever needs syncing is mainline, and mainline's sync story is completely unchanged by
forks existing.

## A design bug this spike's own tests caught (and the fix that resulted)

The first implementation of `ChatForkService.accept()` wrote merged doc bytes directly to
`collections.pageDocs`/`collections.pages` (the raw typed-storage collections `NotesService`
also uses), reasoning that DO storage is the single source of truth. That reasoning was
incomplete: `NotesService` keeps its own in-memory `docCache` as a read optimization, and nothing
told that cache a write had happened underneath it. `test/chat-fork.test.ts`'s "accept merges the
fork into mainline" test caught this immediately — `getPageText` kept returning the pre-merge
text after a successful `accept()`, served straight from `NotesService`'s stale cache, even
though the correct merged bytes were genuinely sitting in storage.

The fix, and the resolved design going forward: **`ChatForkService` never touches
`pageDocs`/`pages` directly.** `NotesService` grew two small, additive methods —
`loadDocForMerge(nodeId)` (returns the current authoritative doc, cache-or-storage, exactly like
every other `NotesService` read) and `applyMergedDoc(nodeId, mergedDoc)` (persists via the exact
same `saveDoc`/reindex/`syncFeed.append` path `applyLocalEdit` already uses) — and
`ChatForkService` depends on `NotesService`, not on raw collections, for every mainline
interaction. This is a real instance of a general rule worth stating for later stages: **once two
services can both write the same underlying storage, only one of them may actually hold the
cache for it** — everyone else must route through that one service's public interface, never
around it. `AgentEditService`, when it's built, inherits this for free: any of its mainline
writes (accepted graph mutations, accepted note edits) should go through the same established
per-domain service interfaces (`NotesService`, `GraphService`, ...), never around them.

## Concrete design for the next stage (`AgentEditService`)

- The RPC surface built here (`forkChatEdit` / `applyChatForkEdit` / `chatForkPreview` /
  `acceptChatFork` / `revertChatFork`, plus their wire schemas in
  `packages/domain/src/chat-fork-rpc.ts`) is real production surface on the real
  `WorkspaceDurableObject`, not throwaway — `AgentEditService`'s tool-execution loop can call
  `ChatForkService` directly (same DO, same Layer graph) rather than going back over RPC to
  itself; the RPC methods exist for the eventual chat-UI client (web/native) to drive fork/accept/
  revert directly.
- `chatId` is currently a plain caller-chosen string (no `chats` collection exists yet). When the
  real `chats`/`changes` collections land (per the plan's "Storage & domain model" section), swap
  the string for a real `EntityId`-keyed chat and thread `AgentEditService`'s pending-record/
  `changes`-stream machinery (plan §Q15) through the same `ChatForkService.accept`/`revert` calls
  this spike already proves work correctly — no redesign of the fork mechanism itself should be
  needed, only wiring it into the pending-record bookkeeping.
- The live-preview push mechanism (mentioned above, not built here) should follow
  `nodes-subscription.ts`'s existing `RpcTarget`/`Collection.subscribe`-backed pattern, feeding a
  subscriber from `ChatForkService.previewFork` on every `applyForkEdit`/`accept`/`revert` call —
  a small, additive extension once a real chat UI needs push instead of poll.
