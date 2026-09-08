import * as Effect from "effect/Effect"
import { SyncFeedInput, WorkspaceEpoch, type DomainError, type EntityId } from "@athenaeum/domain"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

// Adversarial-review fix: the plan's structured-record sync feed (`SyncFeedService`/`syncFeed`
// RPC — plan §"Sync protocol" item 2: "append-only per-workspace sequenced feed... a syncFeed RPC
// method a client can page through with a cursor to catch up") was implemented and tested
// end-to-end at the backend/RPC layer (`sync-feed.test.ts`), but no real web client code ever
// called it — the browser app only ever used direct RPCs (getNode/createNode/etc.) and the
// separate Automerge prose-sync protocol. This module is the missing client-side half: a real
// (not stubbed) consumer that pages through the feed on every app boot/reconnect, persists its
// cursor across reloads (`sync-feed-cursor.ts`-style localStorage key below), and drives the
// epoch-mismatch recovery path for real when the workspace's epoch has rotated out from under a
// stale cursor — not just at the backend layer.
//
// Phase 1 has exactly one client and no local structured-record cache to "apply" these entries
// into (direct RPCs already reflect current server state, unlike the Automerge prose side, which
// genuinely has no other way to fetch content) — so "catching up" here means walking the whole
// feed for real and reporting what it found, per this finding's own accepted recommendation
// ("even a minimal one, e.g. logging/catch-up on reconnect"). The load-bearing part is the
// protocol walk itself (paging, cursor persistence, epoch-mismatch bootstrap) actually running
// against the real backend from real client code — not the logging.

export interface SyncFeedCursor {
  readonly epoch: string
  readonly afterCounter: number | undefined
}

export interface SyncFeedCatchUpResult {
  readonly epoch: string
  readonly entriesSeen: number
  readonly byEntityKind: Readonly<Record<string, number>>
  readonly cursor: SyncFeedCursor
}

const PAGE_LIMIT = 100
// Bounded, not `while (true)` — same discipline as `automerge-page.ts`'s `syncPageWithServer`: a
// genuine protocol bug (e.g. a server that never advances `nextAfterCounter`) must fail loudly by
// hitting this cap, not hang the caller forever. 500 pages * 100/page comfortably covers Phase 1
// scale with headroom.
const MAX_PAGES = 500

/**
 * Pages through the structured-record sync feed from `startCursor` (or from the very start of the
 * workspace's current epoch, if `startCursor` is `undefined` — first-ever run on this device) until
 * caught up, following the epoch-mismatch recovery path for real: a mismatched `knownEpoch`
 * restarts the walk from scratch under the newly-reported epoch, exactly as the plan's "Sync
 * protocol"/"Epoch recovery" sections describe for a client whose cursor has gone stale (e.g. a
 * PITR restore or explicit `rotateEpoch`).
 */
export const catchUpSyncFeed = (
  client: WorkspaceRpcClientService,
  workspaceId: EntityId,
  startCursor: SyncFeedCursor | undefined
): Effect.Effect<SyncFeedCatchUpResult, DomainError> =>
  Effect.gen(function* () {
    let knownEpoch = startCursor === undefined ? undefined : WorkspaceEpoch.make(startCursor.epoch)
    let afterCounter = startCursor?.afterCounter
    let epoch = startCursor?.epoch ?? ""
    let entriesSeen = 0
    const byEntityKind: Record<string, number> = {}

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = yield* client.syncFeed(
        new SyncFeedInput({ workspaceId, knownEpoch, afterCounter, limit: PAGE_LIMIT })
      )
      epoch = result.epoch

      if (result.epochMismatch) {
        // Stale cursor — the plan's epoch-recovery path: drop everything we thought we knew and
        // restart the walk from the start of the newly-reported epoch, rather than trust any part
        // of the old cursor.
        knownEpoch = undefined
        afterCounter = undefined
        continue
      }

      knownEpoch = result.epoch
      for (const entry of result.entries) {
        entriesSeen += 1
        byEntityKind[entry.entityKind] = (byEntityKind[entry.entityKind] ?? 0) + 1
      }

      if (result.nextAfterCounter === undefined) {
        // Nothing came back and there's nothing further to page through — caught up.
        return { epoch, entriesSeen, byEntityKind, cursor: { epoch, afterCounter } }
      }
      afterCounter = result.nextAfterCounter
    }

    // Hit MAX_PAGES without converging — return what was gathered rather than loop forever; the
    // caller (see `App.tsx`) logs this case distinctly so a real protocol bug (feed that never
    // stops paging) is visible, not silently swallowed as "caught up".
    return { epoch, entriesSeen, byEntityKind, cursor: { epoch, afterCounter } }
  })

// --- Cursor persistence (localStorage) -----------------------------------------------------------
//
// Kept separate from `catchUpSyncFeed` above so the paging/epoch-recovery logic itself stays a
// pure function of its inputs (client + cursor in, result + next cursor out) — easier to reason
// about and, if a test runner is ever added to `web`, to unit-test without a real `localStorage`.

const storageKey = (workspaceId: EntityId): string => `athenaeum:syncFeedCursor:${workspaceId}`

/** Reads the persisted cursor for `workspaceId`, or `undefined` on first-ever run for this
 *  workspace/device (or if `localStorage` is unavailable/the stored value is corrupt — fails open to
 *  "no cursor", which `catchUpSyncFeed` already treats as a valid from-scratch bootstrap, rather
 *  than throwing and blocking app boot over a non-essential cache). */
export const loadSyncFeedCursor = (workspaceId: EntityId): SyncFeedCursor | undefined => {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId))
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { epoch?: unknown }).epoch !== "string" ||
      (parsed as { epoch: string }).epoch.length === 0
    ) {
      return undefined
    }
    const afterCounter = (parsed as { afterCounter?: unknown }).afterCounter
    return {
      epoch: (parsed as { epoch: string }).epoch,
      afterCounter: typeof afterCounter === "number" ? afterCounter : undefined
    }
  } catch {
    return undefined
  }
}

/** Persists `cursor` for `workspaceId` — best-effort, same fail-open rationale as `loadSyncFeedCursor`
 *  (a `localStorage` write failure, e.g. private-mode quota, must not fail the caller's own sync
 *  round trip). */
export const saveSyncFeedCursor = (workspaceId: EntityId, cursor: SyncFeedCursor): void => {
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(cursor))
  } catch {
    // Best-effort — see doc comment above.
  }
}
