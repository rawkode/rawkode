import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

// Plan §"Sync protocol": two content classes under one epoch/session envelope. This file
// covers the structured-record side's wire shapes plus the epoch value type; the Automerge
// prose-sync side gets a minimal session envelope too (its actual frame/hash-chunking protocol
// is out of scope here — plan task item 9: "keep these minimal but real; the Storage+CRDT+Sync
// stage will implement the actual protocol logic using these types").

/**
 * One entry in a workspace's append-only structured-record sync feed (plan §"Sync protocol":
 * "append-only per-workspace sequenced feed, (replicaEpoch, monotonicCounter)-identified mutations,
 * idempotent by ID+hash, base-revision optimistic concurrency, explicit tombstone/conflict
 * recording").
 *
 * - `replicaEpoch`/`monotonicCounter` together form the feed's total order — `replicaEpoch`
 *   pins an entry to a particular `WorkspaceEpoch` generation (see below), `monotonicCounter`
 *   orders entries within it. Both are non-negative integers, never floats or negative
 *   sequence numbers.
 * - `entityKind` is a plain string, not a closed literal union — deliberately: this feed
 *   already carries every mutable collection the plan names (nodes/tags/facts/edges/tasks/
 *   calendarEvents/bookmarks/meetings/workouts/chats/changes, per §"Storage & domain model"),
 *   and pinning `entityKind` to a union here would force this file to be edited every time a
 *   later phase adds a collection, for a field whose real job (routing a feed entry to the
 *   right collection's apply-logic) lives in the backend, not in wire-schema validation.
 * - `payload` is `Schema.Unknown`, not `JsonValue` (contrast `Fact.value` in fact.ts) —
 *   deliberately, per plan task item 9's own wording ("payload: unknown"): unlike a `Fact`'s
 *   value (a single JSON-safe leaf), a feed entry's payload is a full encoded entity (a `Node`,
 *   `Tag`, `Fact`, `Edge`, ...) or a tombstone/conflict marker whose shape is entity-kind-
 *   dependent and re-validated against that entity's own schema by the apply-logic that reads
 *   `entityKind` first — re-deriving a JsonValue-shaped union of every entity here would just
 *   duplicate that validation one layer too early, at a point that doesn't yet know which
 *   entity's schema to check against.
 * - `hash` backs "idempotent by ID+hash" — a content hash of the payload, letting a replayed or
 *   duplicated feed entry be recognized and skipped without re-decoding/re-applying it.
 *
 * **"Idempotent by ID+hash" scope, narrowed by adversarial review (see
 * `sync-feed-service-live.ts`'s `append` doc comment for the enforcement mechanism):** this is a
 * real write-side guarantee, but only for a mutation whose caller supplies a *stable* `entityId`
 * across retries (the same convention `rpc.ts`'s `CreateNodeInput.id` and `graph-rpc.ts`'s
 * `AddFactInput.id` already use) — two `append()` calls for the same `(entityKind, entityId)`
 * whose payload hashes to the same `hash` are recognized as the same logical write and collapse
 * to one feed entry, not two. It does **not** cover a mutation RPC that mints a fresh id
 * server-side on every call (every RPC that doesn't yet accept a caller-supplied id): two such
 * calls are, by construction, indistinguishable from two genuinely separate mutations, so nothing
 * here (or anywhere in Phase 1) can recognize one as a retry of the other. `entityId`/`hash`
 * dedup is a real mechanism a retry-safe caller can rely on; it is not a blanket guarantee that
 * every mutation RPC is retry-safe by default.
 */
export class SyncFeedEntry extends Schema.Class<SyncFeedEntry>("SyncFeedEntry")({
  replicaEpoch: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  monotonicCounter: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  entityKind: Schema.String.pipe(Schema.minLength(1)),
  entityId: EntityId,
  operation: Schema.Literal("put", "delete"),
  payload: Schema.Unknown,
  hash: Schema.String.pipe(Schema.minLength(1))
}) {}

/**
 * A workspace's epoch value (plan §"Sync protocol": "each WorkspaceDurableObject owns a random
 * workspaceEpoch; PITR restore or explicit rotation changes it; a mismatch invalidates cursors and
 * forces paged recovery-inventory bootstrap"). Branded as an opaque string, not a number:
 * unlike `SyncFeedEntry`'s `monotonicCounter` (a real ordered sequence a client counts through),
 * a workspace epoch is a random token a client only ever compares for *equality* against the value
 * it last saw — modeling it as a number would wrongly suggest it's orderable/incrementable.
 */
export const WorkspaceEpoch = Schema.String.pipe(Schema.minLength(1), Schema.brand("WorkspaceEpoch"))
export type WorkspaceEpoch = typeof WorkspaceEpoch.Type

/**
 * The Automerge prose-sync side's minimal session envelope (plan §"Sync protocol": "opaque
 * session ID stable across restarts, per-session ordinals, reset:true reclaim on ambiguous
 * timeout"). `sessionId` is stable across a client's reconnects (so the DO can resume rather
 * than restart a sync session); `ordinal` orders messages within that session; `reset` signals
 * the "reclaim on ambiguous timeout" path — the receiver must discard any partial session state
 * and restart from a fresh full sync rather than trying to resume. The actual frame-splitting/
 * hash-verification/idempotent-retry mechanics the plan describes (512 KiB/frame, 21 MiB
 * logical message cap) belong to the Storage+CRDT+Sync stage that implements the protocol using
 * this envelope, not to this schema.
 */
export class AutomergeSyncSession extends Schema.Class<AutomergeSyncSession>(
  "AutomergeSyncSession"
)({
  sessionId: Schema.String.pipe(Schema.minLength(1)),
  ordinal: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  reset: Schema.Boolean
}) {}
