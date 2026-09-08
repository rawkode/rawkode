import * as Schema from "effect/Schema"
import { JsonValue } from "./json-value.js"
import { EntityId, PendingMarker } from "./node.js"

// Plan §"Storage & domain model": "facts — typed (nodeId, predicateId, value) assertions;
// predicateId stable across renames." `predicateId` is a stable identifier for *what* is being
// asserted (e.g. a due-date, a status, an email address) — deliberately a plain `Schema.String`,
// not `EntityId`: predicates are a much smaller, more special-purpose vocabulary than nodes/
// tags/edges (see plan's Tasks example: "a nodes row with the Task supertag plus facts for
// due-date/status/capacity-day" — `"due-date"`/`"status"` read naturally as stable string keys,
// not ULID/UUID-identified entities in their own right).

/**
 * A single typed `(nodeId, predicateId, value)` assertion. `value` uses the shared `JsonValue`
 * recursive union (see json-value.ts) rather than `Schema.Unknown` — see that file for the
 * reasoning, which applies identically here: a fact's value must be JSON-safe to survive DO
 * SQLite storage, the sync feed, and the Cap'n Web wire, and `Schema.Unknown` would defer that
 * validation to a much less legible failure point downstream.
 */
// Phase 3 storage-schema task: optional `pending` marker, mirroring `Node.pending` (see that
// field's doc comment in node.ts, and `PendingMarker`'s own comment, for the full mechanism and
// for why this lives on the entity directly rather than a wrapper type) — a `Fact` an agent chat
// proposed via the `addFact` tool but the user hasn't accepted yet.

export class Fact extends Schema.Class<Fact>("Fact")({
  id: EntityId,
  nodeId: EntityId,
  predicateId: Schema.String.pipe(Schema.minLength(1)),
  value: JsonValue,
  pending: Schema.optional(PendingMarker)
}) {}
