import * as Schema from "effect/Schema"

// Phase 0 scope (see plan §"Storage & domain model"): the full entity set (`Workspace`, `Tag`,
// `Fact`, `RelationDefinition`, `Edge`, `Page`, `Task`, `CalendarEvent`, `Bookmark`, `Meeting`,
// `Workout`, `ViewSpec`, …) is deliberately deferred. `Node` here is the minimal graph-vertex
// shape needed to de-risk the Effect+Cap'n Web RPC boundary, not the full `nodes` collection
// row shape from the plan (`{id, workspaceId, primaryTagIds[], title, createdAt}` — tags omitted).

const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** A stable entity identifier: either a ULID (26-char Crockford base32) or a UUID. */
export const EntityId = Schema.String.pipe(
  Schema.filter((value) => ulidPattern.test(value) || uuidPattern.test(value), {
    message: () => "EntityId must be a ULID or a UUID"
  }),
  Schema.brand("EntityId")
)
export type EntityId = typeof EntityId.Type

/** An ISO-8601 timestamp, represented on the wire and in storage as a plain string. */
export const IsoDateTimeString = Schema.String.pipe(
  Schema.filter((value) => !Number.isNaN(Date.parse(value)), {
    message: () => "IsoDateTimeString must be a valid ISO-8601 date-time string"
  }),
  Schema.brand("IsoDateTimeString")
)
export type IsoDateTimeString = typeof IsoDateTimeString.Type

/**
 * The reusable `pending: {chatId, sequence?}` marker (plan §"Agent-native editing & gatekeeper
 * integrations": "Every agent-proposed mutation is a pending record, `pending: {chatId,
 * sequence?}`, mirroring `GadgetRecord.pending` exactly (Q15 in `multi-gadget.md`)... real, so
 * the chat's own preview works, but invisible to mainline reads/search/other chats/sharing until
 * accepted"). `chatId` is `EntityId` (matches `Chat.id` in chat.ts) rather than a bare string.
 *
 * `sequence` absent means "unstamped" — per `multi-gadget.md` §Q15, an agent tool writes the
 * pending record *before* the enclosing `changes` message (see changes-message.ts) is persisted;
 * `sequence` is stamped atomically with that message, in the same synchronous storage step, once
 * it is. Crash recovery distinguishes the two states by this field's presence: an
 * unstamped-but-logged record (its originating tool call sits in the chat's message log, not yet
 * covered by any `changes` message) is re-adopted by the resumed turn's replay and stamped on the
 * next flush; an unstamped record backed by *no* logged tool call is a crash orphan, reaped by a
 * `reconcilePendingChanges()` sweep (backend, not yet built — this schema is what that sweep will
 * operate over).
 *
 * Defined here, rather than in its own file, because `Node.pending`/`Fact.pending`/`Edge.pending`
 * below all need it and it needs only `EntityId`, which already lives in this file — that keeps
 * the dependency direction simple. A standalone `pending.ts` importing `EntityId` from here while
 * `node.ts` imported `PendingMarker` back from it would be a circular module dependency evaluated
 * at class-definition time (`Schema.optional(PendingMarker)` needs the real export, not just a
 * type), which ESM circular imports make fragile to rely on; putting it here avoids the cycle
 * entirely instead of hoping load order works out.
 *
 * Scope note: only `Node`, `Fact`, and `Edge` gain a `pending` field (below and in fact.ts/
 * edge.ts) — `Tag` does not. The Phase 3 agent tool set (agent-tools.ts: readNote/editNote/
 * createNode/addFact/addEdge/linkCalendarEvent) has no tag-creation tool, so there is currently
 * no code path that would ever produce a pending `Tag` row; adding the field there now would be
 * speculative schema growth with no consumer.
 */
export class PendingMarker extends Schema.Class<PendingMarker>("PendingMarker")({
  chatId: EntityId,
  sequence: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative()))
}) {}

/**
 * The minimal graph-vertex entity for the Phase 0 spike, since extended (Phase 3 storage-schema
 * task) with an optional `pending` marker.
 *
 * Mirrors the `id`/`workspaceId`/`title`/`createdAt` fields of the plan's full `nodes` collection
 * row (`{id, workspaceId, primaryTagIds[], title, createdAt}`); `primaryTagIds` and every other
 * field besides `pending` are out of scope until a later phase actually needs tags.
 *
 * `pending` (optional, absent for every ordinary mainline node) marks a node an agent chat
 * proposed via the `createNode` tool but the user hasn't accepted yet — see `PendingMarker`'s
 * doc comment just above for the full mechanism. Adding the field directly to `Node` (rather
 * than a separate wrapper type) was the deliberate choice here: every consumer of `Node` already
 * has to handle the field regardless (a mainline read must filter pending rows out; the
 * originating chat's own preview must filter mainline-visible rows *in* alongside its own
 * pending ones), and a wrapper would just relocate that same branching one level up without
 * removing it — see this task's own instructions ("if adding a field to an existing Schema.Class
 * is cleaner than a wrapper, do that").
 */
export class Node extends Schema.Class<Node>("Node")({
  id: EntityId,
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  createdAt: IsoDateTimeString,
  pending: Schema.optional(PendingMarker)
}) {}
