// Phase 1 exit-criterion verification, quoted exactly from the plan's Verification section:
// "daily notes + backlinks + at least one read-only graph view work fully offline-first in the
// web client against a real deployed (or workerd-local) Worker, with the full sync/epoch
// protocol exercised (not stubbed) even though there's only one client."
//
// Backlinks (item 2) and read-only graph views incl. disallowed-ViewSpec rejection (item 3) are
// already covered end-to-end by `graph-service.test.ts`'s "listBacklinks: via the edges-by-target
// index" describe block and `views-search.test.ts`'s "runView: ..." describe blocks respectively
// — both against a real `WorkspaceDurableObject` over a real Cap'n Web WebSocket session in real
// `workerd`. This file adds the two things those existing suites (and `sync-feed.test.ts`) don't
// yet cover:
//
// 1. The Automerge sync SESSION protocol exercised for a *daily note specifically* (deterministic
//    per-date node id, exactly `web/src/daily-note-id.ts`'s scheme), including the reset:true path
//    triggered by an out-of-order ordinal on an already-established session — `notes-service.
//    test.ts`'s existing reset test only covers a session id that was *never started at all*, not
//    a session that WAS started and then desyncs mid-exchange (the more realistic "client and
//    server ordinal counters disagree" case).
// 2. "Idempotent-replay" for the structured-record sync feed: requesting the exact same page
//    (same knownEpoch/afterCounter/limit) twice in a row is a pure, side-effect-free read that
//    returns byte-for-byte the same entries both times — no duplication, no counter advancement,
//    no epoch change. (The feed's `syncFeed` RPC is read-only/server-authoritative — there is no
//    client "submit a feed page" RPC to replay in the literal sense; this is the faithful
//    reading of that requirement against what's actually built. See this file's own header note
//    at the bottom for why.)

import { afterEach, describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import {
  ApplyPageEditOutput,
  ApplyPageEditInput,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  CreatePageOutput,
  EntityId,
  GetPageTextInput,
  GetPageTextOutput,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  SyncFeedInput,
  SyncFeedOutput
} from "@athenaeum/domain"
import { connectToWorkspace, freshWorkspaceId } from "./support.js"

/** Mirrors `web/src/daily-note-id.ts`'s `todayDailyNoteId` scheme exactly (a fixed all-zero
 *  `EntityId` prefix distinguishing itself from `BaseTagIds`' own all-zero scheme, suffixed with
 *  an 8-digit local calendar-date stamp) — reproduced here rather than imported because `backend`
 *  intentionally has no dependency on `web` (a browser package). This is what makes the test
 *  below a "daily note" test and not just an arbitrary page test: the id is genuinely
 *  content-derived from a date, the same way the real client computes it. */
const dailyNoteIdFor = (date: Date): EntityId => {
  const y = date.getFullYear().toString().padStart(4, "0")
  const m = (date.getMonth() + 1).toString().padStart(2, "0")
  const d = date.getDate().toString().padStart(2, "0")
  const suffix = `${y}${m}${d}`.padStart(12, "0")
  return Schema.decodeUnknownSync(EntityId)(`00000000-0000-4000-8000-${suffix}`)
}

describe("Daily note: real Automerge sync SESSION protocol (session id, ordinals, reset path)", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("resolves/creates today's note at its deterministic id, edits sync via startPageSync/pageSyncMessage frames (never applyPageEdit), and persists", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)
    const nodeId = dailyNoteIdFor(new Date())

    // "Resolve or create" — a fresh workspace has never touched today's note yet, so the deterministic
    // id must be genuinely absent first (proves this is really a fresh id, not a coincidental
    // collision with seeded data).
    const created = Schema.decodeUnknownSync(CreateNodeOutput)(
      await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, id: nodeId, title: "Daily note" })))
    ).node
    expect(created.id).toBe(nodeId)

    Schema.decodeUnknownSync(CreatePageOutput)(
      await workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(new CreatePageInput({ workspaceId, nodeId })))
    )

    // --- Real session protocol, driven by hand (not `applyPageEdit`) -----------------------
    const Automerge = await import("@automerge/automerge")
    const sessionId = crypto.randomUUID()
    let syncState = Automerge.initSyncState()
    let ordinal = 0

    /** Runs one Automerge sync round trip to convergence over the real `startPageSync`/
     *  `pageSyncMessage` RPCs, continuing `sessionId`'s ordinal sequence (not restarting it) —
     *  mirrors `web/src/automerge-page.ts`'s `syncPageWithServer` loop shape, generalized to be
     *  callable more than once against the same live session (the real client does this too: one
     *  session per node, re-driven on every debounced edit). */
    const syncOnce = async (
      localDoc: import("@automerge/automerge").Doc<{ text: string }>,
      firstServerMessage: Uint8Array | null
    ): Promise<import("@automerge/automerge").Doc<{ text: string }>> => {
      let doc = localDoc
      let serverMessage = firstServerMessage
      for (let round = 0; round < 20; round++) {
        if (serverMessage !== null) {
          const [nextDoc, nextState] = Automerge.receiveSyncMessage(doc, syncState, serverMessage)
          doc = nextDoc
          syncState = nextState
        }
        const [afterGen, outMessage] = Automerge.generateSyncMessage(doc, syncState)
        syncState = afterGen
        if (outMessage === null) break

        const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
          await workspaceStub!.pageSyncMessage(
            Schema.encodeSync(PageSyncMessageInput)(
              new PageSyncMessageInput({ workspaceId, nodeId, sessionId, ordinal, message: outMessage })
            )
          )
        )
        expect(response.sessionId).toBe(sessionId)
        expect(response.ordinal).toBe(ordinal)
        expect(response.reset).toBe(false)
        ordinal += 1
        serverMessage = response.message
        if (response.converged && serverMessage === null) break
      }
      return doc
    }

    const started = Schema.decodeUnknownSync(StartPageSyncOutput)(
      await workspaceStub.startPageSync(Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId, sessionId })))
    )
    expect(started.sessionId).toBe(sessionId)

    // Phase 1: converge an empty local replica against the server's (also-empty) page FIRST —
    // exactly what a real client does on load (`DailyNote.tsx`'s `resolveDailyNote` calls
    // `syncPageWithServer` with a fresh `emptyPageDoc()` before the user ever types). This is not
    // optional ceremony: it's what gives the local doc's `text` object the *same* CRDT lineage as
    // the server's, so a subsequent local edit is a genuine concurrent-insert merge into one
    // shared text object rather than two independently-`Automerge.from`-created docs racing at
    // the map level (which Automerge resolves via last-writer-wins on the `text` key itself,
    // nondeterministically discarding one side's content — confirmed by reproducing exactly that
    // flake while developing this test with the initial-sync step skipped).
    let doc = await syncOnce(Automerge.from<{ text: string }>({ text: "" }), started.message)
    expect(doc.text).toBe("")

    doc = Automerge.change(doc, (draft) => {
      Automerge.splice(draft, ["text"], 0, 0, "Today I shipped Phase 1.")
    })
    const ordinalBeforeEdit = ordinal

    // Phase 2: sync the local edit up, continuing the SAME session (not a new one) — proves
    // ordinals keep advancing correctly mid-session, not just across a session's very first
    // exchange.
    doc = await syncOnce(doc, null)
    expect(ordinal).toBeGreaterThan(ordinalBeforeEdit) // at least one more real frame was exchanged
    expect(doc.text).toBe("Today I shipped Phase 1.")

    const persisted = Schema.decodeUnknownSync(GetPageTextOutput)(
      await workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(new GetPageTextInput({ workspaceId, nodeId })))
    )
    expect(persisted.text).toBe("Today I shipped Phase 1.")

    // --- reset:true on an out-of-order ordinal against an ALREADY-STARTED session -----------
    // (distinct from notes-service.test.ts's existing "never-started sessionId" reset case: this
    // session id is real and was just used successfully above; the server's `expectedOrdinal` is
    // now `ordinal`, so replaying an old/wrong ordinal must be rejected with reset:true rather
    // than silently accepted or silently ignored.)
    const staleOrdinal = 0
    const desynced = Schema.decodeUnknownSync(PageSyncMessageOutput)(
      await workspaceStub.pageSyncMessage(
        Schema.encodeSync(PageSyncMessageInput)(
          new PageSyncMessageInput({
            workspaceId,
            nodeId,
            sessionId,
            ordinal: staleOrdinal,
            message: new Uint8Array([9, 9, 9])
          })
        )
      )
    )
    expect(desynced.reset).toBe(true)
    expect(desynced.converged).toBe(false)

    // The reclaim path itself: the client discards state and calls startPageSync again with a
    // *fresh* session id (exactly `web/src/automerge-page.ts`'s `syncPageWithServer` reset
    // handling) — this must work cleanly and see the server's already-persisted content, proving
    // the desynced attempt above didn't corrupt server state.
    const freshSessionId = crypto.randomUUID()
    const restarted = Schema.decodeUnknownSync(StartPageSyncOutput)(
      await workspaceStub.startPageSync(Schema.encodeSync(StartPageSyncInput)(new StartPageSyncInput({ workspaceId, nodeId, sessionId: freshSessionId })))
    )
    // A full reconciliation, not a single exchange: Automerge's protocol typically needs a
    // "haves/needs" negotiation round before the actual content payload arrives, exactly like the
    // main sync loop above — a real client (`web/src/automerge-page.ts`'s `syncPageWithServer`)
    // loops for the same reason.
    let freshDoc = Automerge.init<{ text: string }>()
    let freshSyncState = Automerge.initSyncState()
    let freshServerMessage = restarted.message
    let freshOrdinal = 0
    for (let round = 0; round < 20; round++) {
      if (freshServerMessage !== null) {
        const [nextDoc, nextState] = Automerge.receiveSyncMessage(freshDoc, freshSyncState, freshServerMessage)
        freshDoc = nextDoc
        freshSyncState = nextState
      }
      const [afterGen, outMessage] = Automerge.generateSyncMessage(freshDoc, freshSyncState)
      freshSyncState = afterGen
      if (outMessage === null) break

      const response = Schema.decodeUnknownSync(PageSyncMessageOutput)(
        await workspaceStub.pageSyncMessage(
          Schema.encodeSync(PageSyncMessageInput)(
            new PageSyncMessageInput({ workspaceId, nodeId, sessionId: freshSessionId, ordinal: freshOrdinal, message: outMessage })
          )
        )
      )
      expect(response.reset).toBe(false)
      freshOrdinal += 1
      freshServerMessage = response.message
      if (response.converged && freshServerMessage === null) break
    }
    expect(freshDoc.text).toBe("Today I shipped Phase 1.")
  })
})

describe("syncFeed idempotent replay: requesting the same page twice never duplicates or advances anything", () => {
  let workspaceStub: Awaited<ReturnType<typeof connectToWorkspace>> | undefined
  afterEach(() => {
    workspaceStub?.[Symbol.dispose]()
    workspaceStub = undefined
  })

  it("two identical syncFeed calls (same knownEpoch/afterCounter/limit) return byte-identical pages", async () => {
    const workspaceId = freshWorkspaceId()
    workspaceStub = await connectToWorkspace(workspaceId)

    for (const title of ["Alpha", "Beta", "Gamma"]) {
      Schema.decodeUnknownSync(CreateNodeOutput)(
        await workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(new CreateNodeInput({ workspaceId, title })))
      )
    }

    const query = () =>
      workspaceStub!.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 2 })))

    const firstCall = Schema.decodeUnknownSync(SyncFeedOutput)(await query())
    const secondCall = Schema.decodeUnknownSync(SyncFeedOutput)(await query())

    expect(secondCall.epoch).toBe(firstCall.epoch)
    expect(secondCall.epochMismatch).toBe(firstCall.epochMismatch)
    expect(secondCall.nextAfterCounter).toBe(firstCall.nextAfterCounter)
    expect(secondCall.entries).toHaveLength(firstCall.entries.length)
    for (let i = 0; i < firstCall.entries.length; i++) {
      expect(secondCall.entries[i]!.monotonicCounter).toBe(firstCall.entries[i]!.monotonicCounter)
      expect(secondCall.entries[i]!.hash).toBe(firstCall.entries[i]!.hash)
      expect(secondCall.entries[i]!.entityId).toBe(firstCall.entries[i]!.entityId)
    }

    // Confirm replaying the first page didn't silently push the feed forward or fabricate new
    // entries: paging the *whole* feed from scratch still yields exactly 3 entries (one per
    // createNode), not 4+ from some phantom write triggered by the repeated read.
    const wholeFeed = Schema.decodeUnknownSync(SyncFeedOutput)(
      await workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(new SyncFeedInput({ workspaceId, limit: 100 })))
    )
    expect(wholeFeed.entries).toHaveLength(3)
  })
})

// Note on this file's interpretation of "idempotent-replay... submitting the same feed page
// twice doesn't duplicate": the structured-record sync feed as actually built
// (`sync-feed-service-live.ts`) is a server-authoritative, append-only, *read-only* paged feed —
// clients page through it with `syncFeed`, they never "submit" a page of mutations back to the
// server (mutations happen through the normal domain RPCs — createNode/createTag/addFact/etc —
// each of which appends its own feed entry as a side effect). There is no `submitFeedPage`-shaped
// RPC in this codebase to literally replay. The above is the faithful test of what "idempotent
// replay" means for the feed as designed: reading is a pure function of (epoch, cursor), so
// reading the same page twice can never duplicate feed state — which the test above confirms
// directly rather than assuming.
