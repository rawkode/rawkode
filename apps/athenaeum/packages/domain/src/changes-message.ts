import * as Schema from "effect/Schema"
import { AppCodeKind } from "./app.js"
import { EntityId } from "./node.js"

// Phase 3 storage-schema task (plan: "Acceptance rides the same changes-message stream, gaining
// createdNodes/addedFacts/addedEdges/noteEdits fields; mergeChanges/revertChanges promote/delete
// pending records exactly as multi-gadget.md §Q15 describes"). `ChangesMessage` is the
// `changes`-collection envelope named in the plan's §"Storage & domain model" collection list
// ("chats, changes — agent-edit provisional-change stream").
//
// Element-shape decision: each of the four batch fields below is a lightweight *summary* record
// (an id plus just enough display context), not the full `Node`/`Fact`/`Edge` entity. This
// mirrors `multi-gadget.md` §Q15's own `createdGadgets: {gadgetId, title}[]` field precisely —
// the `changes` message's job is bookkeeping (which entities did this batch touch, for
// crash-recovery set-difference matching and for the accept/revert UI's summary line), not being
// the source of truth for the entities themselves. The full pending record already lives in its
// own collection (`nodes`/`facts`/`edges`, each carrying `pending: {chatId, sequence?}` — see
// node.ts/fact.ts/edge.ts); duplicating the whole row into the stream as well would just be a
// second, driftable copy of the same data.

/** One node created by this batch — mirrors `multi-gadget.md`'s `createdGadgets` element shape
 *  (`{gadgetId, title}`) field-for-field, substituting `nodeId` for `gadgetId`. */
export class CreatedNodeSummary extends Schema.Class<CreatedNodeSummary>("CreatedNodeSummary")({
  nodeId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1))
}) {}

/** One fact added by this batch — enough context (`nodeId`, `predicateId`) to render "added
 *  `predicateId` on `nodeId`" in an accept/revert summary without a second full `Fact` copy. */
export class AddedFactSummary extends Schema.Class<AddedFactSummary>("AddedFactSummary")({
  factId: EntityId,
  nodeId: EntityId,
  predicateId: Schema.String.pipe(Schema.minLength(1))
}) {}

/** One edge added by this batch — enough context to render "linked `sourceNodeId` →
 *  `targetNodeId`" without a second full `Edge` copy. */
export class AddedEdgeSummary extends Schema.Class<AddedEdgeSummary>("AddedEdgeSummary")({
  edgeId: EntityId,
  relationDefinitionId: EntityId,
  sourceNodeId: EntityId,
  targetNodeId: EntityId
}) {}

/**
 * One note-body edit accepted by this batch. Note-body edits use the Automerge-fork mechanism
 * (see chat-fork-rpc.ts / docs/automerge-fork-spike.md), not the row-level `pending` flag, so
 * there is no pending `Page`/`Node` row for a `noteEdits` entry to summarize the way
 * `CreatedNodeSummary` et al. do — `headsHash` (mirroring `Page.headsHash`, see page.ts) is what
 * a reader needs to know a fork's accept actually landed and which mainline doc state resulted,
 * without re-deriving it from the Automerge document itself.
 */
export class NoteEditSummary extends Schema.Class<NoteEditSummary>("NoteEditSummary")({
  nodeId: EntityId,
  headsHash: Schema.String.pipe(Schema.minLength(1))
}) {}

/**
 * One App created by this batch — App Library domain-extension task addition, mirroring
 * `CreatedNodeSummary`'s own `{nodeId, title}` shape field-for-field, substituting `appId` for
 * `nodeId`. The full pending `App` row (with its own `pending` marker) already lives in the
 * `App` entity itself (app.ts); this is bookkeeping only, same rationale as this file's header
 * comment gives for the other three summary kinds.
 */
export class CreatedAppSummary extends Schema.Class<CreatedAppSummary>("CreatedAppSummary")({
  appId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1))
}) {}

/**
 * One App code update accepted by this batch — App Library domain-extension task addition. Unlike
 * `CreatedAppSummary` (which mirrors the other three "new pending row" summaries), a proposed code
 * update does not create a second pending `App`/`AppCodeVersion` *record type* to summarize the
 * existence of — it creates an ahead-of-pointer `AppCodeVersion` row (see app.ts's
 * `AppCodeVersion` doc comment for the full mechanism). `kind`/`version` here are exactly what a
 * `mergeChanges`/`revertChanges` implementation (agent-edit-rpc.ts) needs to know which pointer
 * (`App.clientCodeVersion` or `App.serverCodeVersion`) to advance, or which ahead-of-pointer row
 * to delete, without re-deriving it from the chat's raw tool-call log.
 */
export class UpdatedAppCodeSummary extends Schema.Class<UpdatedAppCodeSummary>(
  "UpdatedAppCodeSummary"
)({
  appId: EntityId,
  kind: AppCodeKind,
  version: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))
}) {}

/**
 * The `changes` stream envelope. Mirrors the plan's exact field list: `{chatId, sequence,
 * createdNodes?, addedFacts?, addedEdges?, noteEdits?}`, widened by the App Library
 * domain-extension task with two further optional batch fields (`createdApps`, `updatedAppCode`)
 * following the identical extension pattern — see those two summary classes' own doc comments.
 *
 * `sequence` is the batch's own position in the chat's changes stream — the same number
 * `PendingMarker.sequence` (node.ts) is stamped with for every pending record this message
 * covers, and the value `mergeChanges(chatId, mergeThrough)`/`revertChanges(chatId, revertFrom)`
 * compare against (plan §Q15: "mergeChanges... promotes... creations with sequence <=
 * mergeThrough"). All six batch fields are optional and independently omittable — per §Q15's
 * "a creation-only batch has an empty no-op update," a single `changes` message may carry any
 * non-empty subset of them (e.g. a turn that only calls `addFact` produces a message with
 * `addedFacts` set and the rest absent).
 */
export class ChangesMessage extends Schema.Class<ChangesMessage>("ChangesMessage")({
  chatId: EntityId,
  sequence: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  createdNodes: Schema.optional(Schema.Array(CreatedNodeSummary)),
  addedFacts: Schema.optional(Schema.Array(AddedFactSummary)),
  addedEdges: Schema.optional(Schema.Array(AddedEdgeSummary)),
  noteEdits: Schema.optional(Schema.Array(NoteEditSummary)),
  createdApps: Schema.optional(Schema.Array(CreatedAppSummary)),
  updatedAppCode: Schema.optional(Schema.Array(UpdatedAppCodeSummary))
}) {}
