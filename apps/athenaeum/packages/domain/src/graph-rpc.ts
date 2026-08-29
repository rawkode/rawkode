import * as Schema from "effect/Schema"
import { Edge } from "./edge.js"
import { Fact } from "./fact.js"
import { GraphIssue } from "./graph-issue.js"
import { JsonValue } from "./json-value.js"
import { MutationAttribution, MutationCommitMessage, MutationRequestId } from "./ledger.js"
import { EntityId } from "./node.js"
import { RelationCardinality, RelationDefinition } from "./relation-definition.js"
import { Tag } from "./tag.js"
import { TagFieldDefinition, TagFieldValueKind } from "./tag-field-definition.js"
import { GraphViewName, ViewSpec } from "./view-spec.js"

// Wire schemas for the RPC methods the Storage/Views stages will need (plan task item 8),
// following rpc.ts's convention: one `Schema.Class` input/output pair per RPC method, decoded
// with `Schema.decodeUnknown` at the DO boundary. Kept in a separate file from rpc.ts rather
// than appended to it — rpc.ts's own header comment scopes it explicitly to "the Phase 0 exit
// criterion's createNode/listNodes round trip"; these are a distinct, later-phase surface
// (tags/facts/relationDefinitions/edges/views), so a new file keeps that scoping honest instead
// of quietly widening rpc.ts's stated purpose.

export class CreateTagInput extends Schema.Class<CreateTagInput>("CreateTagInput")({
  workspaceId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1)),
  // Parent order is retained in the stored Tag and is part of ledger request identity; a retry
  // with the same parent set in a different order is a different semantic command.
  parentIds: Schema.Array(EntityId),
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class CreateTagOutput extends Schema.Class<CreateTagOutput>("CreateTagOutput")({
  tag: Tag
}) {}

export class AddFactInput extends Schema.Class<AddFactInput>("AddFactInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  predicateId: Schema.String.pipe(Schema.minLength(1)),
  value: JsonValue,
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution,
  // Same convention as `rpc.ts`'s `CreateNodeInput.id` (adversarial-review fix, see this file's
  // and `sync-feed-service-live.ts`'s doc comments): optional caller-supplied id, defaulted
  // server-side (crypto.randomUUID()) when absent, preserving every existing caller's behavior.
  // A caller that retries a failed/uncertain `addFact` call resends the same requestId and command
  // context; the WorkspaceDO ledger replays the exact receipt before invoking GraphService again.
  // `id` remains optional because it controls the Fact identity/upsert independently: distinct
  // requestIds without an id are distinct operations and receive fresh server-minted Fact ids.
  id: Schema.optional(EntityId)
}) {}

export class AddFactOutput extends Schema.Class<AddFactOutput>("AddFactOutput")({
  fact: Fact
}) {}

export class CreateRelationDefinitionInput extends Schema.Class<CreateRelationDefinitionInput>(
  "CreateRelationDefinitionInput"
)({
  workspaceId: EntityId,
  forwardName: Schema.String.pipe(Schema.minLength(1)),
  inverseName: Schema.String.pipe(Schema.minLength(1)),
  sourceTagId: EntityId,
  targetTagId: EntityId,
  cardinality: RelationCardinality,
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class CreateRelationDefinitionOutput extends Schema.Class<CreateRelationDefinitionOutput>(
  "CreateRelationDefinitionOutput"
)({
  relationDefinition: RelationDefinition
}) {}

export class CreateEdgeInput extends Schema.Class<CreateEdgeInput>("CreateEdgeInput")({
  workspaceId: EntityId,
  relationDefinitionId: EntityId,
  sourceNodeId: EntityId,
  targetNodeId: EntityId,
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class CreateEdgeOutput extends Schema.Class<CreateEdgeOutput>("CreateEdgeOutput")({
  edge: Edge
}) {}

// `RunViewInput` design decision (plan task item 8 — "{workspaceId, viewSpec: ViewSpec} or
// {workspaceId, viewName: string} — your call... document the decision"): **both**, not either/or.
// `viewName` selects which of the plan's fixed, authorizer-restricted read-only views
// (`graph_nodes`, `graph_tags`, ... `graph_text_search` — see view-spec.ts's `GraphViewName`)
// is queried; `ViewSpec` supplies the filter/sort/groupBy/columns/limit/rendering-mode applied
// *against* that view. The plan's own wording makes this a package-deal, not a choice between
// them: "carry forward Enchiridion's exact read-only view set... compiled from a ViewSpec
// schema" — the fixed view set is what makes the authorizer able to deny physical tables
// (plan: "Physical tables denied via a SQLite authorizer restricting to the fixed view set"),
// which only works if the RPC boundary itself never accepts an arbitrary/ad-hoc table name, only
// one of the ten known `GraphViewName` literals. An ad-hoc-SQL-string `RunViewInput` was
// therefore not a real option to weigh against this — it would defeat the authorizer design in
// the same paragraph.
export class RunViewInput extends Schema.Class<RunViewInput>("RunViewInput")({
  workspaceId: EntityId,
  viewName: GraphViewName,
  viewSpec: ViewSpec
}) {}

export class RunViewOutput extends Schema.Class<RunViewOutput>("RunViewOutput")({
  rows: Schema.Array(Schema.Unknown)
}) {}

// --- Backend/Views-stage additions -----------------------------------------------------------
//
// `RunViewInput`/`RunViewOutput` above are the plan's general ViewSpec→SQL-compiled surface
// (deliberately not implemented by the Storage/Views backend stage — see that stage's own report
// for why a full authorizer-backed SQL compiler is scoped out of Phase 1's storage/sync work).
// These four pairs are narrower, real (not stubbed) read RPCs the same stage *does* implement,
// needed for: (a) `listBacklinks` specifically, which the plan names as its own RPC method
// ("listBacklinks(nodeId)... via the edges-by-target index" — not merely a `graph_edges` view
// filter, an actual dedicated method), and (b) end-to-end verification of tag-closure and
// graph-issue correctness via a real RPC round trip rather than only a backend-internal unit
// test.

export class ListBacklinksInput extends Schema.Class<ListBacklinksInput>("ListBacklinksInput")({
  workspaceId: EntityId,
  nodeId: EntityId
}) {}

export class ListBacklinksOutput extends Schema.Class<ListBacklinksOutput>("ListBacklinksOutput")({
  edges: Schema.Array(Edge)
}) {}

export class ListGraphIssuesInput extends Schema.Class<ListGraphIssuesInput>("ListGraphIssuesInput")({
  workspaceId: EntityId
}) {}

export class ListGraphIssuesOutput extends Schema.Class<ListGraphIssuesOutput>("ListGraphIssuesOutput")({
  graphIssues: Schema.Array(GraphIssue)
}) {}

/** One row of the materialized `tagClosure` collection (plan §"Storage & domain model":
 *  "tagClosure — materialized transitive closure"). `ancestorId === descendantId` rows are the
 *  reflexive self-membership entries every tag gets (see `tag-closure.ts`'s doc comment for why
 *  reflexivity is part of the closure, not a special case layered on top of it). */
export class TagClosureEntry extends Schema.Class<TagClosureEntry>("TagClosureEntry")({
  ancestorId: EntityId,
  descendantId: EntityId
}) {}

export class ListTagClosureInput extends Schema.Class<ListTagClosureInput>("ListTagClosureInput")({
  workspaceId: EntityId
}) {}

export class ListTagClosureOutput extends Schema.Class<ListTagClosureOutput>("ListTagClosureOutput")({
  entries: Schema.Array(TagClosureEntry)
}) {}

export class ListTagsInput extends Schema.Class<ListTagsInput>("ListTagsInput")({
  workspaceId: EntityId
}) {}

export class ListTagsOutput extends Schema.Class<ListTagsOutput>("ListTagsOutput")({
  tags: Schema.Array(Tag)
}) {}

// --- Views/Search-stage addition: node-tag membership -----------------------------------------
//
// `graph_node_tags` (view-spec.ts's `GraphViewName`) needs a real underlying node-to-tag
// membership relation to query against. None existed before this stage: `Node` (node.ts)
// deliberately deferred `primaryTagIds` ("out of scope until a later phase actually needs
// tags" — that file's own doc comment), and no prior stage built a node-tags junction. Rather
// than widen `Node`'s already-shipped, tested Phase 0 schema, this adds the minimal real
// mutation this view (and the `hasTag` ViewPredicate op, which is otherwise untestable without
// any way to tag a node) needs: assigning an existing tag to an existing node. See
// `graph-service-live.ts`'s `assignTag` for the orchestration and the backend Views-stage
// report for why this was judged in-scope rather than deferred.
export class AssignTagInput extends Schema.Class<AssignTagInput>("AssignTagInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  tagId: EntityId,
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class AssignTagOutput extends Schema.Class<AssignTagOutput>("AssignTagOutput")({
  nodeId: EntityId,
  tagId: EntityId,
  changed: Schema.Boolean
}) {}

/**
 * `assignTag`'s missing symmetric counterpart (docs/supertag-centering-decisions.md §2,
 * "Reconciliation — tag membership from chip marks": "`unassignTag` is the one genuinely missing
 * piece — removing a `#tag` chip from the note's text must actually untag the note, and no
 * removal path exists today"). Deletes the `(nodeId, tagId)` `graph_node_tags` row exactly the
 * way `syncNoteReferences`' own edge-delete branch removes a stale `Edge` — see
 * `graph-service-live.ts`'s `unassignTag` for the read-model/sync-feed mirroring. Idempotent:
 * unassigning a tag the node doesn't currently carry is a no-op, not an error (matches
 * `assignTag`'s own "re-assigning is a no-op overwrite" idempotency in the opposite direction).
 */
export class UnassignTagInput extends Schema.Class<UnassignTagInput>("UnassignTagInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  tagId: EntityId,
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class UnassignTagOutput extends Schema.Class<UnassignTagOutput>("UnassignTagOutput")({
  nodeId: EntityId,
  tagId: EntityId,
  changed: Schema.Boolean
}) {}

// --- Rich-text-editor-stage addition: entity-reference-to-edge projection ---------------------
//
// Rich-text-editor-decisions.md §5: typing `@` in the web editor inserts an inline `entity-ref`
// mark carrying an immutable `nodeId`; the client walks the page's ProseMirror doc / Automerge
// spans to derive the current set of referenced node ids and calls this RPC (debounced, same
// cadence as prose sync) to reconcile that set into real `Edge` rows under the one fixed
// `MENTION_RELATION_DEFINITION` (see `mention.ts`). Idempotent by design — resending the same
// `referencedNodeIds` for a `nodeId` is a no-op diff (create-missing/delete-stale against the
// existing edges under that relation for that source node), matching every other reconciliation
// path in this codebase rather than append-only writes.
//
// Deliberately narrow: the backend never parses ProseMirror JSON or Automerge block/mark structure
// to derive this set itself — it only ever sees a plain list of ids — preserving
// `notes-service-live.ts`'s "Page/Automerge doc bytes are opaque" property for this feature too
// (the decisions doc's own stated reason for choosing a dedicated RPC over backend-side doc
// parsing).
export class SyncNoteReferencesInput extends Schema.Class<SyncNoteReferencesInput>(
  "SyncNoteReferencesInput"
)({
  workspaceId: EntityId,
  // The note (page-bearing node) whose current set of `@`-mentions is being reconciled — becomes
  // every resulting edge's `sourceNodeId`.
  nodeId: EntityId,
  // The complete current set of node ids the note's `entity-ref` marks reference, as of this call —
  // not a delta. The server diffs this against the existing "mentions" edges from `nodeId` and
  // creates/deletes to match exactly.
  referencedNodeIds: Schema.Array(EntityId),
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class SyncNoteReferencesOutput extends Schema.Class<SyncNoteReferencesOutput>(
  "SyncNoteReferencesOutput"
)({
  // The resulting "mentions" edges from `nodeId`, post-reconciliation — i.e. one per
  // `referencedNodeIds` entry, in the same relation-definition/backlink shape every other edge in
  // this codebase uses, so a caller can render/confirm the reconciled state without a second
  // `listBacklinks`-style round trip.
  edges: Schema.Array(Edge)
}) {}

// --- Supertag-centering pass: field definitions + one-call tag application --------------------
//
// docs/supertag-centering-decisions.md §1/§2. Enchiridion's GraphDataModel.md: "Supertags provide
// types and inherited predicates" — `Tag`'s DAG (tag.ts) plus its materialized `tagClosure`
// (`ListTagClosureOutput` above) already exist; these three pairs are the missing "types declare
// fields" half.

/**
 * Declares a new `TagFieldDefinition` (tag-field-definition.ts) on an existing tag — e.g. adding
 * a `role: text` field to `#Person`. Named `defineTagField`, not `createTagFieldDefinition`, to
 * read naturally alongside `defineSupertag`-shaped agent tooling (agent-tools.ts) and the inline
 * `#`-picker's "+ Add field" affordance (decisions doc §2), both of which frame this as "defining
 * a field on a Supertag," not raw CRUD.
 *
 * Deliberately narrow, matching `createTag`'s own validation story: the backend implementation of
 * this RPC validates `tagId` exists (`TagFieldDefinitionNotFound` is not raised here —
 * `TagNotFound`, already in `DomainError`, covers "the tag itself doesn't exist") before writing.
 * No edit/delete/reorder pair exists yet — see tag-field-definition.ts's own "deliberately
 * deferred" note.
 */
export class DefineTagFieldInput extends Schema.Class<DefineTagFieldInput>("DefineTagFieldInput")({
  workspaceId: EntityId,
  tagId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1)),
  valueKind: TagFieldValueKind,
  sortOrder: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  requestId: MutationRequestId,
  commitMessage: MutationCommitMessage,
  attribution: MutationAttribution
}) {}

export class DefineTagFieldOutput extends Schema.Class<DefineTagFieldOutput>("DefineTagFieldOutput")({
  fieldDefinition: TagFieldDefinition
}) {}

/**
 * One resolved field in a `ListTagFieldsOutput` — a `TagFieldDefinition` plus whether it was
 * declared by the queried tag itself or inherited from an ancestor via `tagClosure`.
 * `inherited === false` iff `field.tagId === ` the `tagId` the caller queried with; `true` means
 * `field.tagId` is a strict ancestor of it in the closure. Carrying `inherited` on the wire (rather
 * than making the caller re-derive it by comparing `field.tagId` to the query `tagId` itself) is a
 * small convenience, not new information — a client rendering "role (own)" vs. "website (inherited
 * from Organization)" (decisions doc §1's own-then-inherited-by-ancestor-group ordering) needs
 * exactly this boolean and would otherwise recompute it identically at every call site.
 */
export class ResolvedTagField extends Schema.Class<ResolvedTagField>("ResolvedTagField")({
  field: TagFieldDefinition,
  inherited: Schema.Boolean
}) {}

/**
 * Lists the **effective** field set for one tag — its own `TagFieldDefinition`s plus every
 * ancestor's, resolved via the existing `tagClosure` (no new closure computation; see
 * tag-field-definition.ts's own doc comment on `TagFieldDefinition.tagId` for the exact rule:
 * "effective fields for tag T = every field whose `tagId` is in `{ancestorId | (ancestorId, T) ∈
 * tagClosure}`", which by `tagClosure`'s own reflexivity guarantee already includes `T` itself).
 *
 * Scoped to a single `tagId`, not "list every field definition in the workspace" — this is the
 * shape the field-editing popover and Supertags admin panel actually need ("what fields apply to
 * *this* tag/node's tags"), and pushing the closure join into the RPC (rather than shipping a flat
 * list and joining client-side against a separately-fetched `listTagClosure`) means a caller needs
 * exactly one round trip per tag to render a complete, correctly-ordered field list. A node
 * carrying several tags calls this once per tag and merges the results client-side (de-duplicated
 * by `field.id`, per decisions doc §1's "not de-duplicated by name" rule) — still zero new
 * closure logic, just one join instead of one-per-caller.
 */
export class ListTagFieldsInput extends Schema.Class<ListTagFieldsInput>("ListTagFieldsInput")({
  workspaceId: EntityId,
  tagId: EntityId
}) {}

export class ListTagFieldsOutput extends Schema.Class<ListTagFieldsOutput>("ListTagFieldsOutput")({
  fields: Schema.Array(ResolvedTagField)
}) {}

// No `SetFieldValueInput`/`Output` pair: decisions doc §1 explicitly decided **against** a new
// convenience RPC for writing a single field value, since one already exists and needs no
// change — "Write/update a field value = the existing `addFact` RPC (`AddFactInput`: workspaceId,
// nodeId, predicateId, value, requestId, commitMessage, attribution, id?)... Setting a field for the
// first time omits `id`... Editing an already-set field reuses `AddFactInput.id` for the Fact
// upsert while each semantic operation receives a new requestId... a real in-place update through
// the unmodified RPC, not a new 'updateFact' method." `predicateId` is simply `TagFieldDefinition.id`'s string form.
// `ApplySupertagInput.fieldValues` below is the one genuinely new writing surface this pass adds,
// and it exists to combine tagging + seeding fields in one round trip, not to replace `addFact`.

/** One field value supplied inline when applying a Supertag to a node — becomes a `Fact` with
 *  `predicateId = fieldId` (see the "No `SetFieldValueInput`/`Output` pair" note above for why no
 *  separate value-write schema exists). */
export class ApplySupertagFieldValue extends Schema.Class<ApplySupertagFieldValue>(
  "ApplySupertagFieldValue"
)({
  fieldId: EntityId,
  value: JsonValue
}) {}

/**
 * Tags a node with a Supertag and optionally seeds initial field values, in one call — decisions
 * doc §2's "typing the tag and filling its fields is one motion, not two separate screens."
 * Composes two already-real primitives rather than inventing new storage: `assignTag`
 * (`AssignTagInput`/`Output` above, unchanged) for the tag membership, then one `addFact`-shaped
 * write per `fieldValues` entry (fresh `Fact`s — this is the "setting a field for the first time"
 * path, so no existing fact id to reuse; editing an already-applied Supertag's fields afterward
 * goes through `addFact` directly with the existing fact's id, not through this RPC again).
 * `fieldValues` is optional and may be empty: applying a Supertag with no fields filled in yet
 * (then filling them in later via the field-editing popover) is exactly as valid as applying one
 * with values already known.
 */
export class ApplySupertagInput extends Schema.Class<ApplySupertagInput>("ApplySupertagInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  tagId: EntityId,
  /** One logical operation id, generated once and retained across transport retries. */
  requestId: MutationRequestId,
  /** Caller rationale is private ledger payload data; the server derives the public activity label. */
  commitMessage: MutationCommitMessage,
  /** Asserted provenance only; authorization still comes from the authenticated connection. */
  attribution: MutationAttribution,
  fieldValues: Schema.optional(Schema.Array(ApplySupertagFieldValue))
}) {}

export class ApplySupertagOutput extends Schema.Class<ApplySupertagOutput>("ApplySupertagOutput")({
  nodeId: EntityId,
  tagId: EntityId,
  // The `Fact` rows created for each `ApplySupertagInput.fieldValues` entry, in the same order —
  // empty when `fieldValues` was omitted or empty. Returned (rather than just ids) so a caller
  // can render "Person tagged, role set to Engineer" without a second `runView` round trip,
  // mirroring `CreateTagOutput`/`AddFactOutput`'s own "return the real row" convention.
  facts: Schema.Array(Fact)
}) {}
