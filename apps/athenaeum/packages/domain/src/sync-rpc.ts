import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"
import { SyncFeedEntry, WorkspaceEpoch } from "./sync.js"

// Wire schemas for the two RPC surfaces the plan's "Sync protocol" section describes (see that
// section's numbered list): (1) the Automerge prose-sync session envelope
// (`StartPageSync`/`PageSyncMessage`), and (2) the structured-record append-only feed
// (`SyncFeed`/`RotateEpoch`). Kept in their own file rather than folded into `sync.ts` — that
// file scopes itself explicitly to "wire schemas... the actual protocol logic using these types"
// belongs to a later stage (this one), so its own header comment would go stale if extended here.

// --- Automerge prose sync (per-page session) -------------------------------------------------
//
// `sessionId` is client-chosen (a fresh session per `startPageSync` call — plan: "opaque session
// ID stable across restarts" refers to a *client* reusing the same id across its own reconnects,
// not the server minting one) and must round-trip on every subsequent `pageSyncMessage` call for
// that session; `ordinal` is caller-supplied and must be strictly increasing per session (the
// mechanism backing "per-session ordinals" — see `automerge-sync-service.ts` for the actual
// out-of-order/replay rejection logic, not modeled here at the schema level).

export class StartPageSyncInput extends Schema.Class<StartPageSyncInput>("StartPageSyncInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  sessionId: Schema.String.pipe(Schema.minLength(1))
}) {}

export class StartPageSyncOutput extends Schema.Class<StartPageSyncOutput>("StartPageSyncOutput")({
  sessionId: Schema.String,
  // The server's first sync message for this fresh session (Automerge's own
  // `generateSyncMessage` against an empty `SyncState` on the server side) — `null` only when the
  // server document is already empty/has nothing to offer, matching `generateSyncMessage`'s own
  // `SyncMessage | null` return shape.
  message: Schema.NullOr(Schema.Uint8ArrayFromSelf)
}) {}

/**
 * One leg of the sync exchange: the client sends its own `generateSyncMessage` output (or,
 * exceptionally, an empty message purely to solicit the server's next message) tagged with this
 * session's next `ordinal`; the server applies it (`receiveSyncMessage`), advances its own sync
 * state, and returns its own next outbound message (or `null` once both sides have converged —
 * see `automerge-sync-service.ts`'s doc comment for the exact convergence check).
 */
export class PageSyncMessageInput extends Schema.Class<PageSyncMessageInput>("PageSyncMessageInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  ordinal: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  message: Schema.Uint8ArrayFromSelf
}) {}

export class PageSyncMessageOutput extends Schema.Class<PageSyncMessageOutput>("PageSyncMessageOutput")({
  sessionId: Schema.String,
  ordinal: Schema.Number,
  message: Schema.NullOr(Schema.Uint8ArrayFromSelf),
  // True once the server believes this session has nothing further to exchange in either
  // direction (`generateSyncMessage` returned `null` *and* the client's own message indicated no
  // further need — see the service for the precise check). A client can stop polling once this is
  // true rather than needing to infer convergence from `message` being `null` alone (a `null`
  // response can also just mean "nothing new since your last message", not "fully converged").
  converged: Schema.Boolean,
  // The plan's "reset: true reclaim on ambiguous timeout" path — set when the server has no
  // sync-state memory of `sessionId` (e.g. it was evicted, or the id was never started), meaning
  // the caller must restart via `startPageSync` rather than continue assuming per-session ordinal
  // continuity.
  reset: Schema.Boolean
}) {}

// --- Structured-record sync feed + epoch -------------------------------------------------------

export class SyncFeedInput extends Schema.Class<SyncFeedInput>("SyncFeedInput")({
  workspaceId: EntityId,
  // The epoch the client last saw. Absent (first-ever sync / a client with no prior state)
  // always yields a fresh, non-mismatched page starting from the current epoch. Present and
  // differing from the workspace's current epoch is exactly the "stale cursor" case the plan's
  // epoch-recovery design exists for.
  knownEpoch: Schema.optional(WorkspaceEpoch),
  // Resume after this `monotonicCounter` (within `knownEpoch`); absent means "from the start of
  // the current epoch's feed".
  afterCounter: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  limit: Schema.Number.pipe(Schema.int(), Schema.positive())
}) {}

export class SyncFeedOutput extends Schema.Class<SyncFeedOutput>("SyncFeedOutput")({
  epoch: WorkspaceEpoch,
  // True when `knownEpoch` was present and didn't match the workspace's current epoch — per the
  // plan, this means "invalidates cursors and forces paged recovery-inventory bootstrap": `
  // entries` is always `[]` and `nextAfterCounter` always absent in this case, since the client's
  // cursor is meaningless against a different epoch and it must restart its catch-up from
  // scratch (fetch this same RPC again with `knownEpoch` unset/set to the returned `epoch`).
  epochMismatch: Schema.Boolean,
  entries: Schema.Array(SyncFeedEntry),
  // Present iff `entries` is non-empty; the `monotonicCounter` to pass as the next call's
  // `afterCounter` to continue paging.
  nextAfterCounter: Schema.optional(Schema.Number)
}) {}

/** Admin/test-only (plan: "expose an admin/test-only rotateEpoch RPC for Phase 1 testing
 *  purposes"). Rotates the workspace's epoch to a fresh random value, immediately invalidating every
 *  outstanding client cursor on their next `syncFeed` call. */
export class RotateEpochInput extends Schema.Class<RotateEpochInput>("RotateEpochInput")({
  workspaceId: EntityId
}) {}

export class RotateEpochOutput extends Schema.Class<RotateEpochOutput>("RotateEpochOutput")({
  epoch: WorkspaceEpoch
}) {}
