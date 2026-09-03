import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

// Plan §"Storage & domain model": "pages — 1:0-or-1 with nodes, holds the Automerge doc ref/
// heads for prose body (not every node has one)." `Page` is that companion row: it holds only
// the *reference* to the Automerge document (its opaque doc ID) and the current merge heads
// (a hash the sync/CRDT layer uses to detect divergence), not the document bytes themselves.
// The plan is explicit that document bytes are "opaque binary" (plan §"Sync protocol", the
// Automerge prose-sync frames) handled by the backend/storage layer — R2 snapshots, DO SQLite
// blob columns, in-memory Automerge state — never schema-validated JSON here. Keeping `Page`
// to just these two fields is therefore not a stub; it's the full shape this schema layer is
// meant to own for prose bodies.

/**
 * A 1:0-or-1 companion to `Node` (keyed by `nodeId`, not its own `id`) holding the Automerge
 * document reference for a node's prose body.
 *
 * - `automergeDocId` — an opaque, backend-assigned identifier for the Automerge document (the
 *   key under which its binary state lives in R2/DO storage). Never the document bytes.
 * - `headsHash` — an opaque hash of the document's current Automerge heads, used by the sync
 *   protocol to detect whether a client's cached copy has diverged, without decoding the
 *   document itself.
 */
export class Page extends Schema.Class<Page>("Page")({
  nodeId: EntityId,
  automergeDocId: Schema.String.pipe(Schema.minLength(1)),
  headsHash: Schema.String.pipe(Schema.minLength(1))
}) {}
