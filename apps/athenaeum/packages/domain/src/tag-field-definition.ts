import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"
import { BaseTagIds } from "./tag.js"

// Supertag-centering pass (docs/supertag-centering-decisions.md §1 — "Field-definition model").
// The framing, verbatim: "Cloudflare OS is almost perfect, but I need our version to be centered
// around daily notes and Supertags." Enchiridion's GraphDataModel.md: "Supertags provide types
// and inherited predicates." `Tag` (tag.ts) already has the DAG (multi-parent `parentIds`,
// materialized `tagClosure`); it had no notion of a *field* ("predicate slot") a tag declares —
// this file is exactly that gap.
//
// `TagFieldDefinition` is a **definition** only — the field's name/kind/owner/order. A field's
// *values* are deliberately **not** modeled here: they are ordinary `Fact` rows (fact.ts) with
// `predicateId = TagFieldDefinition.id` (an `EntityId`, which is already a bare string at the
// wire level and therefore satisfies `Fact.predicateId: Schema.String` with zero schema change).
// See graph-rpc.ts's `DefineTagFieldInput`/`ApplySupertagInput` doc comments for the read/write
// paths this buys for free (`runView` on `graph_facts`, the existing `addFact` RPC) and for why
// no parallel "field value" storage type exists anywhere in this package.

export const TagFieldValueKind = Schema.Literal("text", "number", "date", "checkbox", "entity-ref")
export type TagFieldValueKind = typeof TagFieldValueKind.Type

/**
 * A single field ("predicate slot") a Supertag declares — e.g. `#Person` declaring a `role: text`
 * field. `tagId` is the tag that **declares** this field, not every tag that inherits it; a node
 * tagged with a *descendant* of `tagId` (per `tagClosure`, tag-closure.ts) also gets this field,
 * computed by unioning `TagFieldDefinition`s across the ancestor chain — no new closure logic,
 * the existing one already answers "is A an ancestor of B" (see graph-rpc.ts's `ListTagFieldsInput`
 * doc comment for exactly how a resolved/effective field list is derived from this plus
 * `tagClosure`).
 *
 * `sortOrder` is scoped to `tagId` (the field's own declaring tag), not global — it orders a
 * single tag's own fields relative to each other; ordering *between* a node's several
 * directly-and-transitively-assigned tags' field groups is a presentation-layer concern (own tag's
 * fields first, then each ancestor's own group, per the decisions doc), not encoded here.
 *
 * `builtin` mirrors `Tag.builtin`/`RelationDefinition`'s absence-of-such-a-field precedent set by
 * `BaseTagIds`/`BASE_TAGS` (tag.ts): `true` only for the seeded Base Tag field defaults below,
 * `false` for anything a user (or an agent, via the `defineSupertag` tool — see agent-tools.ts)
 * adds afterward. It marks *provenance* only — it does not prevent adding more fields to a Base
 * Tag, and does not (this pass) gate editing/deleting an existing definition, since neither
 * mutation exists yet (see this file's own "deliberately deferred" note below).
 */
export class TagFieldDefinition extends Schema.Class<TagFieldDefinition>("TagFieldDefinition")({
  id: EntityId,
  tagId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1)),
  valueKind: TagFieldValueKind,
  sortOrder: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  builtin: Schema.Boolean
}) {}

// Deliberately deferred, not silently assumed solved (decisions doc §1): editing, reordering, or
// deleting an existing `TagFieldDefinition`, and what happens to already-written `Fact` rows if
// one is deleted or its `valueKind` changes. This pass ships the definition schema plus
// create+list (via graph-rpc.ts's `DefineTagFieldInput`/`ListTagFieldsInput`) only.

// --- Base Tag field defaults --------------------------------------------------------------------
//
// Decision (decisions doc §1, "Base Tag defaults — seeded, with justification"): seed a small,
// real default field set for the 8 Base Tags, not left empty — an empty `#Person` with zero
// fields reads as a label, not a type, which defeats this pass's whole point (Supertags as the
// organizing primitive from day one). `builtin: true` marks provenance only; a user may always add
// more fields to a Base Tag afterward.
//
// Id scheme: same "literal nil-pattern UUID block" discipline `BaseTagIds` (`...0001`-`...0008`),
// `workout.ts`'s `WorkoutRelationIds` (`...0101`-`...0113`), and `mention.ts`'s
// `MentionRelationId`/`MentionSentinelTagId` (`...0201`-`...0202`) already establish — every
// fixed/builtin id in this codebase stays trivially distinguishable at a glance. Next free block:
// `00000000-0000-0000-0000-0000000003XX`, allocated flat and sequential in the table below's order.
export const BaseTagFieldIds = {
  PersonRole: EntityId.make("00000000-0000-0000-0000-000000000301"),
  PersonEmail: EntityId.make("00000000-0000-0000-0000-000000000302"),
  PersonCompany: EntityId.make("00000000-0000-0000-0000-000000000303"),
  OrganizationWebsite: EntityId.make("00000000-0000-0000-0000-000000000304"),
  CompanyWebsite: EntityId.make("00000000-0000-0000-0000-000000000305"),
  CompanyIndustry: EntityId.make("00000000-0000-0000-0000-000000000306"),
  EventDate: EntityId.make("00000000-0000-0000-0000-000000000307"),
  EventLocation: EntityId.make("00000000-0000-0000-0000-000000000308"),
  PlaceAddress: EntityId.make("00000000-0000-0000-0000-000000000309"),
  AreaDescription: EntityId.make("00000000-0000-0000-0000-000000000310"),
  ProjectStatus: EntityId.make("00000000-0000-0000-0000-000000000311"),
  ProjectDueDate: EntityId.make("00000000-0000-0000-0000-000000000312"),
  TaskStatus: EntityId.make("00000000-0000-0000-0000-000000000313"),
  TaskDueDate: EntityId.make("00000000-0000-0000-0000-000000000314"),
  TaskPriority: EntityId.make("00000000-0000-0000-0000-000000000315")
} as const

// `tag.ts` never imports this file, so importing `BaseTagIds` here (definitions -> tag ids) is
// one-directional and safe, same shape as `mention.ts` importing `EntityId` from `node.ts`.

/**
 * The 15 Base Tag field defaults, seeded once at workspace creation alongside `BASE_TAGS`
 * (decisions doc §1's table, reproduced here as the literal seed data):
 *
 * | Tag | Seeded fields (name : valueKind) |
 * |---|---|
 * | Person | role : text, email : text, company : entity-ref |
 * | Organization | website : text |
 * | Company | website : text, industry : text |
 * | Event | date : date, location : text |
 * | Place | address : text |
 * | Area | description : text |
 * | Project | status : text, dueDate : date |
 * | Task | status : text, dueDate : date, priority : text |
 */
export const BASE_TAG_FIELD_DEFINITIONS: ReadonlyArray<TagFieldDefinition> = [
  new TagFieldDefinition({
    id: BaseTagFieldIds.PersonRole,
    tagId: BaseTagIds.Person,
    name: "role",
    valueKind: "text",
    sortOrder: 0,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.PersonEmail,
    tagId: BaseTagIds.Person,
    name: "email",
    valueKind: "text",
    sortOrder: 1,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.PersonCompany,
    tagId: BaseTagIds.Person,
    name: "company",
    valueKind: "entity-ref",
    sortOrder: 2,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.OrganizationWebsite,
    tagId: BaseTagIds.Organization,
    name: "website",
    valueKind: "text",
    sortOrder: 0,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.CompanyWebsite,
    tagId: BaseTagIds.Company,
    name: "website",
    valueKind: "text",
    sortOrder: 0,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.CompanyIndustry,
    tagId: BaseTagIds.Company,
    name: "industry",
    valueKind: "text",
    sortOrder: 1,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.EventDate,
    tagId: BaseTagIds.Event,
    name: "date",
    valueKind: "date",
    sortOrder: 0,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.EventLocation,
    tagId: BaseTagIds.Event,
    name: "location",
    valueKind: "text",
    sortOrder: 1,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.PlaceAddress,
    tagId: BaseTagIds.Place,
    name: "address",
    valueKind: "text",
    sortOrder: 0,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.AreaDescription,
    tagId: BaseTagIds.Area,
    name: "description",
    valueKind: "text",
    sortOrder: 0,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.ProjectStatus,
    tagId: BaseTagIds.Project,
    name: "status",
    valueKind: "text",
    sortOrder: 0,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.ProjectDueDate,
    tagId: BaseTagIds.Project,
    name: "dueDate",
    valueKind: "date",
    sortOrder: 1,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.TaskStatus,
    tagId: BaseTagIds.Task,
    name: "status",
    valueKind: "text",
    sortOrder: 0,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.TaskDueDate,
    tagId: BaseTagIds.Task,
    name: "dueDate",
    valueKind: "date",
    sortOrder: 1,
    builtin: true
  }),
  new TagFieldDefinition({
    id: BaseTagFieldIds.TaskPriority,
    tagId: BaseTagIds.Task,
    name: "priority",
    valueKind: "text",
    sortOrder: 2,
    builtin: true
  })
]
