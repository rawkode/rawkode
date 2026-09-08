# Supertag-centering — decisions

Scope: **decisions and concrete interfaces only**, per this task's own framing. Nothing in this
doc has been implemented — no domain schema, no backend RPC, no UI component, no test. Every
schema/interface below is what the next (implementation) stage builds against. `ModelClientScripted`
(the deterministic test double, `packages/backend/src/model-client-scripted.ts`) is what any later
agent-tool verification for this feature must use — this repo has no live LLM key, same as every
prior pass (`index.ts`'s `makeModelClientScripted` wiring, confirmed by reading it this session).

## The framing, verbatim

> "Cloudflare OS is almost perfect, but I need our version to be centered around daily notes and
> Supertags."

Athenaeum keeps Cloudflare OS's shell architecture (persistent sidebar, docked chat, routed main
column — `.impeccable.md`'s "Confident command-center") but recenters the *content* on two things:
the daily note (already the default route) and Supertags — Tana-style typed tags with fields.
Everything else (agent chat, Apps, calendar, other routed views) orbits those two; it does not
disappear, it stops being co-equal.

Enchiridion's own data-model doc is the conceptual anchor (`apps/enchiridion/Documentation/
GraphDataModel.md`, read in full this session): "Supertags provide types and inherited predicates."
The gap this pass closes is exactly that sentence's second half — Athenaeum's `Tag` (multi-parent
DAG, `tagClosure`, real and tested — `packages/domain/src/tag.ts`, `packages/backend/src/
tag-closure.ts`) has the DAG; it has no notion of a field ("predicate slot") a tag declares, and no
way for a user to attach one inline while writing.

---

## 1. Field-definition model

### Schema

New file, `packages/domain/src/tag-field-definition.ts`, same `Schema.Class` convention as every
other entity in this package (`tag.ts`, `fact.ts`, `relation-definition.ts`):

```typescript
import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

export const TagFieldValueKind = Schema.Literal("text", "number", "date", "checkbox", "entity-ref")
export type TagFieldValueKind = typeof TagFieldValueKind.Type

export class TagFieldDefinition extends Schema.Class<TagFieldDefinition>("TagFieldDefinition")({
  id: EntityId,
  tagId: EntityId,               // the tag that DECLARES this field — not every tag that inherits it
  name: Schema.String.pipe(Schema.minLength(1)),
  valueKind: TagFieldValueKind,
  sortOrder: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  builtin: Schema.Boolean         // true only for the seeded Base Tag field defaults below
}) {}
```

`FactsRepository`/`Fact` (fact.ts) already model a value as `(nodeId, predicateId, value)` with
`predicateId: Schema.String` — deliberately not `EntityId`-typed, per that file's own comment
("predicates are a much smaller, more special-purpose vocabulary... read naturally as stable
string keys"). **Decision: a field's values are stored as ordinary `Fact` rows with `predicateId
= TagFieldDefinition.id` (the id's string form).** This is the "recommended" option the task named,
and it is a real zero-cost choice, not just the path of least resistance:

- `Fact.predicateId` is already a bare string — a `TagFieldDefinition.id` (an `EntityId`, itself a
  string at the wire level) satisfies that type with no schema change at all.
- Every read/write path a field value needs already exists and needs no new backend code:
  - **Read** "this node's current field values" = `runView({ viewName: "graph_facts", viewSpec:
    { filter: { op: "eq", field: { kind: "column", column: "nodeId" }, value: nodeId }, ... } })`
    — the exact `RunViewInput`/`ViewSpec` shape `view-spec.ts`'s own doc comment names as the
    intended per-node-facts query ("a per-node lookup... is a ViewSpec filter... not a second
    repository method").
  - **Write/update** a field value = the existing `addFact` RPC (`AddFactInput`: `workspaceId,
    nodeId, predicateId, value, id?`). Setting a field for the first time omits `id` (fresh fact).
    **Editing** an already-set field reuses `AddFactInput.id`, passing the *existing* fact's id —
    `FactsRepository.put`/`GraphService.addFact` is already an upsert-by-id
    (`facts-repository.ts`'s `put` doc comment, `graph-service-live.ts`'s `addFact`), so this is a
    real in-place update through the unmodified RPC, not a new "updateFact" method.
- No parallel value-storage table, no new `ViewPredicate` op, no new sync-feed entity kind. The
  only genuinely new storage is the field *definition* itself (name/kind/owner/order), which has
  no existing analog.

### Inheritance rule

"A node tagged with a child tag carries the child's fields plus all ancestor tags' fields" is
answered entirely by the **existing** `tagClosure` — no new closure computation:

> effective fields for tag `T` = every `TagFieldDefinition` whose `tagId` is in
> `{ ancestorId | (ancestorId, T) ∈ tagClosure }` (which, by `tag-closure.ts`'s own reflexivity
> guarantee, already includes `T` itself).

For a **node** (which may carry several tags directly), effective fields = the union of the above
over every tag the node has (`graph_node_tags`), de-duplicated by `TagFieldDefinition.id` (not by
name — see "known simplification" below).

This is computed **client-side**, mirroring the precedent `mention-plugin.ts`/`view-spec.ts`
already establish for "keep the backend dumb": the client already fetches `listTagClosure` and (new
this pass) `listFieldDefinitions`, both flat, small, whole-workspace lists; joining them is a plain
`Map`/`filter` in the UI layer, not a backend concern. A later Views-stage could promote this into
a `graph_tag_field_definitions` read-model view + a `GraphViewName` addition if usage ever needs
server-side filtering/paging — explicitly out of scope this pass (adding a `GraphViewName` literal
touches the SQLite authorizer allowlist, a bigger cross-cutting change than this recentering pass
warrants; flagged as future work, not silently assumed).

Ordering: a node's effective-fields list groups by owning tag, the node's *directly assigned* tag's
own fields first (by `sortOrder`), then each ancestor's fields in a group of their own (also by
`sortOrder`), ancestor groups ordered alphabetically by ancestor tag name for a stable, if
semantically arbitrary, order — multi-parent diamond inheritance has no natural "which ancestor
wins the tiebreak" answer, and `tagClosure` rows carry no depth/distance field to order by. Two
ancestors defining a field with the same *name* are **not** de-duplicated (each keeps its own
`TagFieldDefinition.id`/fact predicate) — a cosmetic edge case worth a future polish pass, not a
correctness issue (Enchiridion's own DAG is permissive about this exact case: closure is a set
union, not a merge-by-name).

### Base Tag defaults — seeded, with justification

**Decision: seed a small, real default field set for the 8 Base Tags**, not left empty.
Justification: this pass's whole point is that Supertags are the organizing primitive a user
reaches for immediately, from day one — an empty `#Person` tag with zero fields does not feel like
"a type," it feels like a label, which is what plain hashtags already were before this pass. A
useful default (matching `fact.ts`'s own worked example — "a nodes row with the Task supertag plus
facts for due-date/status/capacity-day" — and ordinary Tana/PARA-adjacent practice for these exact
8 nouns) costs nothing extra to seed (same idempotent, `blockConcurrencyWhile`-time mechanism
`ensureBaseTagsSeeded` already uses) and can always be edited/extended later since
`TagFieldDefinition.builtin` only marks provenance, it does not prevent a user from adding *more*
fields to a Base Tag (deleting/renaming the seeded ones is a separate, deliberately-not-decided
question — see "future work").

| Tag | Seeded fields (name : valueKind) |
|---|---|
| Person | role : text, email : text, company : entity-ref |
| Organization | website : text |
| Company | website : text, industry : text |
| Event | date : date, location : text |
| Place | address : text |
| Area | description : text |
| Project | status : text, dueDate : date |
| Task | status : text, dueDate : date, priority : text |

Id scheme: same "literal nil-pattern UUID block" discipline `tag.ts`'s `BaseTagIds` (`...0001`-
`...0008`), `workout.ts`'s `WorkoutRelationIds` (`...0101`-`...0113`), and `mention.ts`'s
`MentionRelationId`/`MentionSentinelTagId` (`...0201`-`...0202`) already establish, so every
fixed/builtin id in the codebase stays trivially distinguishable at a glance. Next free block:
`00000000-0000-0000-0000-0000000003XX`, allocated flat and sequential in the table order above:

```typescript
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

export const BASE_TAG_FIELD_DEFINITIONS: ReadonlyArray<TagFieldDefinition> = [/* one entry per row above,
  tagId = the matching BaseTagIds member, builtin: true, sortOrder 0-based within its own tag */]
```

Seeded the same way (`seed-base-tag-fields.ts`, mirroring `seed-base-tags.ts` verbatim: idempotent
missing-id diff, called from the same DO-constructor `blockConcurrencyWhile`, after
`ensureBaseTagsSeeded` since it references those tags' ids — no existence check needed against
live storage since the ids are fixed constants, but the ordering keeps the dependency honest for a
reader).

### Repository + RPC surface (new)

Mirrors `TagsRepository`/`graph-rpc.ts`'s `CreateTagInput`/`ListTagsInput` pattern exactly:

```typescript
// packages/domain/src/tag-field-definitions-repository.ts
export class TagFieldDefinitionsRepository extends Context.Tag(
  "@athenaeum/domain/TagFieldDefinitionsRepository"
)<TagFieldDefinitionsRepository, {
  readonly get: (id: EntityId) => Effect.Effect<TagFieldDefinition, TagFieldDefinitionNotFound | UnexpectedError>
  readonly put: (def: TagFieldDefinition) => Effect.Effect<TagFieldDefinition, UnexpectedError>
  readonly list: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<TagFieldDefinition>, UnexpectedError>
}>() {}

// packages/domain/src/errors.ts (new tagged error, same shape as TagNotFound)
export class TagFieldDefinitionNotFound extends Data.TaggedError("TagFieldDefinitionNotFound")<{ id: EntityId }> {}

// packages/domain/src/graph-rpc.ts (new pairs, appended to the existing file)
export class CreateTagFieldDefinitionInput extends Schema.Class<CreateTagFieldDefinitionInput>(
  "CreateTagFieldDefinitionInput"
)({
  workspaceId: EntityId,
  tagId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1)),
  valueKind: TagFieldValueKind,
  sortOrder: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}
export class CreateTagFieldDefinitionOutput extends Schema.Class<CreateTagFieldDefinitionOutput>(
  "CreateTagFieldDefinitionOutput"
)({ fieldDefinition: TagFieldDefinition }) {}

export class ListTagFieldDefinitionsInput extends Schema.Class<ListTagFieldDefinitionsInput>(
  "ListTagFieldDefinitionsInput"
)({ workspaceId: EntityId }) {}
export class ListTagFieldDefinitionsOutput extends Schema.Class<ListTagFieldDefinitionsOutput>(
  "ListTagFieldDefinitionsOutput"
)({ fieldDefinitions: Schema.Array(TagFieldDefinition) }) {}
```

`GraphService` (backend) gains `createFieldDefinition(workspaceId, tagId, name, valueKind,
sortOrder)` (validates `tagsRepository.get(tagId)` first, exactly like `createTag`'s parent-existence
check) and `listFieldDefinitions(workspaceId)`. `workspace-durable-object.ts` wires both as thin
shims, **gated `requireRoleForGovernedWorkspace(currentUser, "build")`** for the create (a
structural schema mutation, same tier as `createTag`/`createRelationDefinition`) — reusing the
established discipline, not inventing a new authorization tier.

**Deliberately deferred, not silently assumed solved:** editing/reordering/deleting an existing
`TagFieldDefinition`, and what happens to already-written `Fact` rows if one is deleted or its
`valueKind` changes. `FactsRepository.delete` exists (Phase 3's pending/revert mechanism) so the
storage primitive for a future `deleteFieldDefinition` is not missing, but the "orphan facts left
behind" question needs its own decision, not a rushed one here — this pass ships create + list only,
matching "keep this pass shippable."

---

## 2. Inline `#` UX

### Direct template

`packages/web/src/rich-text/mention-plugin.ts` (read in full) is the literal template, confirmed
line-for-line reusable for `#`: trigger-char detection (`computeState`'s regex against
`textBefore`), plugin state (`active/from/to/query`), a hand-managed floating DOM menu
(`view(editorView)`'s `menu`/`render`/`position`), keyboard nav wired through `handleKeyDown` (must
register **before** the keymap plugins in `RichNoteEditor.tsx`'s plugin list — same documented
ordering bug class already found and fixed for the mention/slash menus), and a debounced
doc-derived reconciliation call fired from `dispatchTransaction` alongside prose sync
(`RichNoteEditor.tsx`'s `scheduleReferenceSync`).

### New mark: `supertagRef`

New `MappedMarkSpec` entry in `packages/web/src/rich-text/schema.ts`, sibling to `entityRef`,
same "immutable id + point-in-time label, JSON-serialized into the Automerge mark value" shape:

```typescript
supertagRef: {
  attrs: { tagId: {}, label: { default: "" } },
  inclusive: false,
  parseDOM: [{ tag: "span[data-supertag-ref]", getAttrs: (dom) => ({
    tagId: dom.getAttribute("data-supertag-ref"), label: dom.textContent ?? ""
  }) }],
  toDOM: (node) => ["span", { "data-supertag-ref": node.attrs.tagId, class: "supertag-chip" }, 0],
  automerge: { markName: "supertag-ref", parsers: { /* identical JSON-string shape to entityRef */ } }
}
```

Rendered as a distinct visual chip class (`supertag-chip`, not `entity-ref`) so a `#Person` mention
reads as a typed tag, not an entity link, even though both are "immutable id in a non-expanding
mark" mechanically.

### Trigger, picker, and target — decided explicitly

- Typing `#` opens a picker exactly like `@`'s (same `computeState`-shaped regex, `/(?:^|\s)#
  ([^\s#]{0,40})$/`), listing existing tags (`listTags` RPC, already real) filtered client-side by
  the query, plus a "Create new '<query>'" row that calls the existing `createTag` RPC (parentless
  — a fast top-level tag; setting parents is a Supertags-admin-page action, not an inline one, to
  keep the inline picker as fast as `@`'s).
- **Target, decided per this task's own framing: tagging applies to the note's own node** — i.e.
  selecting a tag calls `assignTag(workspaceId, nodeId=<this note>, tagId)`. It does **not** create
  a separate entity node for the current block. Per-block entity extraction (a Tana "supertag turns
  this line into its own node" concept) is explicitly **future work** — noted, not built — because
  it is a materially bigger feature (new node identity per block, a block↔node addressing scheme,
  interaction with the existing whole-page `entity-ref` mention model) than this recentering pass's
  "keep it concrete and minimal" mandate allows.
- On selection, the mark is inserted (chip rendered) **and** the picker's `insertMention`-equivalent
  immediately opens the field-editing popover (below) for that tag, so applying `#Person` flows
  straight into "role / email / company" without a second click — the whole point of centering on
  Supertags is that typing the tag and filling its fields is one motion, not two separate screens.

### Reconciliation — tag membership from chip marks

Mirrors `collectEntityRefIds`/`syncNoteReferences` (§5 of `rich-text-editor-decisions.md`)
conceptually, but **decided to use client-side diffing against the existing `assignTag` primitive
plus one new symmetric `unassignTag`, not a new batch-reconcile RPC**:

- `assignTag` already exists and is already idempotent (`graph-service-live.ts`'s `assignTag`:
  "re-assigning the same `(nodeId, tagId)` pair overwrites the same composite-keyed row").
- `unassignTag` is the one genuinely missing piece — removing a `#tag` chip from the note's text
  must actually untag the note, and no removal path exists today (`node-tags-live.ts`'s
  `NodeTagRow`/`nodeTagRowId` collection has no delete call site anywhere in `graph-service-live.ts`).
  New, small, symmetric addition:

  ```typescript
  // graph-rpc.ts
  export class UnassignTagInput extends Schema.Class<UnassignTagInput>("UnassignTagInput")({
    workspaceId: EntityId, nodeId: EntityId, tagId: EntityId
  }) {}
  export class UnassignTagOutput extends Schema.Class<UnassignTagOutput>("UnassignTagOutput")({
    nodeId: EntityId, tagId: EntityId
  }) {}
  ```

  `GraphService.unassignTag(workspaceId, nodeId, tagId)`: deletes the `nodeTagRowId(nodeId, tagId)`
  row from `nodeTagsCollections`, mirrors it into the read model (new `deleteNodeTag(sql, nodeId,
  tagId)` in `read-model.ts`, same shape as the existing `deleteEdge`), and appends a `"delete"`
  sync-feed entry — the exact three-step shape `assignTag`/`syncNoteReferences`'s edge-delete branch
  already establish. Gated `requireRoleForGovernedWorkspace(currentUser, "build")`, same tier as
  `assignTag`.

- Client side (new `collectSupertagRefIds(doc, schema)`, sibling to `collectEntityRefIds`, in a new
  `packages/web/src/rich-text/supertag-plugin.ts`): on the same debounce timer
  `scheduleReferenceSync` already uses, compute the current set of `tagId`s from `supertagRef`
  marks, diff against a `lastSyncedTagIds` ref (identical pattern to
  `lastSyncedReferenceIds`), and call `assignTag` for newly-added ids / `unassignTag` for
  newly-removed ids (`Promise.all`, not a single batch call).

  **Why diffing + two idempotent per-pair primitives instead of a `syncNoteReferences`-shaped batch
  RPC**, decided explicitly rather than copied by default: `syncNoteReferences` earned a dedicated
  batch RPC because `Edge` had *no* per-pair delete method at the RPC layer at all before that
  stage. Tag assignment already had `assignTag`; only the symmetric delete was missing, and adding
  *that* (not a second reconciliation endpoint) is the minimal real gap. A personal note's inline
  `#tag` count is small (a handful, not the potentially-larger `@`-mention set a long note might
  accumulate), so N small idempotent calls per debounce tick is not a meaningful cost — flagged as
  a future optimization (fold into one `syncNoteTags`-shaped RPC) if usage ever proves otherwise,
  not assumed necessary now.

### Field-editing popover

A small, quiet panel (`.impeccable.md`'s "sidebar-adjacent chrome, not a competing visual system" —
same brief the mention picker's own styling followed) shown after inserting a `#tag` chip, or on
clicking an existing one:

- **Data it needs, entirely from existing RPCs, zero new reads:**
  - `listTagClosure(workspaceId)` + `listFieldDefinitions(workspaceId)` (new, §1) →
    client-computed "effective fields for this tag," grouped own-then-inherited as decided above.
  - `runView({ viewName: "graph_facts", viewSpec: { filter: { op: "eq", field: { kind: "column",
    column: "nodeId" }, value: noteNodeId }, ... } })` → current values, matched to a field by
    `predicateId === fieldDefinition.id`.
- **Per-field control by `valueKind`:** text → text input, number → number input (`type="number"`),
  date → `type="date"`, checkbox → checkbox, entity-ref → a plain text input with a `<datalist>`
  of candidate titles sourced from the same `listNodes` RPC the mention picker's `listCandidates`
  already calls (storing the chosen candidate's raw `nodeId` string as the fact value) —
  **deliberately not** the full mention-picker interaction inside a popover; that is a real UX
  upgrade worth its own pass, not required to ship field editing for entity-ref fields at all.
- **Save**: `addFact({ workspaceId, nodeId: noteNodeId, predicateId: fieldDefinition.id, value,
  id: existingFactId })` — `id` present (in-place update) if a fact for this `(nodeId,
  predicateId)` was found in the `graph_facts` read above, omitted (fresh) otherwise. Zero new
  backend surface for this step, per §1's storage-reuse decision.
- **"+ Add field"** row at the bottom of the popover calls `createTagFieldDefinition` directly on
  the tag being edited — the fastest, most Tana-like path to extending a type ("while filling in
  this Person's fields, realize you also want a 'birthday' field, add it right there") — in
  addition to, not instead of, the dedicated Supertags admin route (§3) being the durable place to
  manage a tag's full field set.

### Known interaction to verify (flagged, not resolved here)

`buildInputRules`'s markdown-shortcut heading rule (`# ` at block start → heading) and this
plugin's `#`-trigger state computation both react to typing `#`. The mention plugin's own
precedent note (`RichNoteEditor.tsx`'s ordering comment: "ProseMirror tries every plugin's
`handleKeyDown` in registration order") covers *keyboard* conflicts between plugins, but the
heading shortcut is a `prosemirror-inputrules` textblock-type rule triggered by the following
space keystroke, not a `handleKeyDown` — a genuinely different mechanism this doc has not tested
against the new plugin. **The next implementation stage must verify empirically** (mirroring
`rich-text-editor-decisions.md`'s own evidence discipline) whether typing `"# "` at the start of an
empty block converts to a heading, opens the (empty-query) supertag picker, or both, and adjust the
`#`-trigger regex (e.g. requiring the block to already have non-whitespace content, or requiring a
non-space character to follow `#` immediately) if the two collide in practice.

---

## 3. IA recentering

### Sidebar order — decided

`AppShell.tsx`'s `NAV_ITEMS` reorders to:

```typescript
const NAV_ITEMS = [
  { to: "/notes", label: "Today" },       // unchanged route path, relabeled — the daily note IS home
  { to: "/supertags", label: "Supertags" }, // new
  { to: "/graph", label: "Graph" },
  { to: "/calendar", label: "Calendar" },
  { to: "/bookmarks", label: "Bookmarks" },
  { to: "/meetings", label: "Meetings" },
  { to: "/workouts", label: "Workouts" },
  { to: "/sharing", label: "Sharing" },
  { to: "/apps", label: "Apps" }
]
```

`/notes` keeps its URL (no churn to the already-shipped default-route redirect in `App.tsx`:
`<Route index element={<Navigate to="/notes" replace />} />`) but the nav **label** changes from
"Notes" to "Today" — a one-word signal that this is the home surface, not one section among equals.
`NotesRoute.tsx`'s own heading copy ("Daily note" kicker, "Notes" `<h1>`) should be revisited in the
implementation stage to match (`<h1>Today</h1>` reads better against the new nav label), but that is
a copy tweak, not a decision this doc needs to belabor further.

### `/graph` vs `/supertags` — decided: both stay, distinct concerns

`/graph` (`GraphRoute.tsx` → `GraphView.tsx`) is a **read-only ViewSpec browse** ("all nodes",
optionally filtered by tag) — a query/browse tool. The new `/supertags` route is **tag schema
administration** — create a tag, set its parents, define/list its fields. These are different
mental modes (browsing data vs. editing a type system) and conflating them would recreate the
"graph route's admin feel" the task explicitly asks to move away from, just under a busier single
page. Decision: **`/graph` stays exactly as-is** (unchanged code, unchanged position — moved one
slot later in the nav to make room for `/supertags`); **`/supertags` is new**, and takes over the
"define types" job `/graph`'s `+ Person` button today does only informally (`GraphView.tsx`'s
`handleAssignPerson` — a hardcoded single-tag assign button, not a real admin surface).

### New `/supertags` route — minimal, concrete shape

`packages/web/src/routes/SupertagsRoute.tsx` (new) → a new `SupertagsManager.tsx` component:

- **Tag list** (left column or top list, data-dense per `.impeccable.md`'s "tight spacing in
  data-dense views"): every tag (`listTags`), each row showing name, builtin badge if applicable,
  and parent tag names (resolved from `parentIds` against the same list — no new RPC).
- **Create tag** form: name + a multi-select of existing tags as parents → `createTag`.
- **Selected tag detail panel**: its own `TagFieldDefinition`s (own, not inherited — inherited ones
  are shown read-only/greyed with "inherited from X" per §1's ordering) via `listFieldDefinitions`
  filtered client-side to `tagId === selected`, plus the same "+ Add field" affordance the inline
  popover uses (`createTagFieldDefinition`) — **the same component/form**, not a duplicate one, so
  "add a field" behaves identically whether reached from a `#chip` popover mid-note or from this
  admin page.
- Setting/editing a tag's `parentIds` **after** creation (the admin page's most "admin" job) is
  **not** decided here as a concrete RPC — `createTag` takes `parentIds` at creation time only;
  there is no `updateTagParents` RPC today. Flagged explicitly as the one real gap this doc leaves
  open for the implementation stage to size (likely a small, symmetric addition —
  `GraphService.updateTagParents(workspaceId, tagId, parentIds)` re-running
  `recomputeAndPersistTagClosure`, mirroring `createTag`'s own closure-recompute tail exactly) —
  not built here because the task's "keep it concrete and minimal" instruction and this being a
  *decisions* stage argue for naming the gap precisely rather than half-speccing a mutation this
  doc hasn't fully justified the validation rules for (e.g. must reject a parent change that would
  introduce a cycle — `computeTagClosure`'s cycle-safety is defensive today, per its own comment,
  "not expected... in practice"; allowing user-edited parents after creation makes that a real,
  reachable path that needs a real pre-check, which is implementation-stage work).

### Daily note gets its tags surfaced prominently — decided

`DailyNote.tsx` gains one new section, a `NoteTags.tsx` component rendered between the editor and
the existing `<Backlinks>` panel (same "generous spacing around prose" zone `.impeccable.md`
already carves out for this view): the note's own tag chips (`graph_node_tags` filtered by
`nodeId`, via `runView` — same read the field popover uses) each opening the identical field-editing
popover described in §2. This is the same underlying data the inline `#` chips read/write — a tag
applied via typing `#Person` in the prose shows up here automatically (both paths go through
`assignTag`/`addFact`), and a field edited here is reflected if the note is re-opened with that
chip still in its text. One data model, two entry points, per the task's "everything else orbits"
framing — the daily note's own tag/field summary is not a separate feature, it is the same
Supertag state rendered a second, more scannable way.

---

## Summary: concrete interfaces the next stage builds against

| Layer | New | Reused unchanged |
|---|---|---|
| `packages/domain` | `tag-field-definition.ts` (`TagFieldDefinition`, `TagFieldValueKind`, `BaseTagIds`-style `BaseTagFieldIds`/`BASE_TAG_FIELD_DEFINITIONS`); `tag-field-definitions-repository.ts`; `errors.ts`: `TagFieldDefinitionNotFound`; `graph-rpc.ts` additions: `CreateTagFieldDefinitionInput/Output`, `ListTagFieldDefinitionsInput/Output`, `UnassignTagInput/Output` | `Fact`, `AddFactInput/Output`, `AssignTagInput/Output`, `RunViewInput/Output`, `ViewSpec`, `listTagClosure`/`TagClosureEntry`, `CreateTagInput/Output`, `ListTagsInput/Output` |
| `packages/backend` | `tag-field-definitions-repository-live.ts`; `seed-base-tag-fields.ts`; `GraphService.createFieldDefinition`/`listFieldDefinitions`/`unassignTag`; `read-model.ts`: `deleteNodeTag` helper; `workspace-durable-object.ts`: 3 new thin RPC shims, each `requireRoleForGovernedWorkspace(..., "build")` | `GraphService.assignTag`/`addFact`/`createTag`/`listTags`/`listTagClosure`/`runView`; `tag-closure.ts` (closure computation reused as-is, no new inheritance logic in the backend at all — computed client-side, §1) |
| `packages/web` | `rich-text/schema.ts`: `supertagRef` mark; `rich-text/supertag-plugin.ts` (`#`-trigger picker + `collectSupertagRefIds`, direct copy-and-adapt of `mention-plugin.ts`); `SupertagFieldPopover.tsx`; `routes/SupertagsRoute.tsx` + `SupertagsManager.tsx`; `NoteTags.tsx`; `AppShell.tsx` nav reorder/relabel | `RichNoteEditor.tsx`'s plugin-list wiring pattern and debounce timer shape (`SYNC_DEBOUNCE_MS`); `mention-plugin.ts`'s `listCandidates`/`createNode` closures, reused verbatim for the entity-ref field control |

Every new RPC method follows the same shim shape already established (`decodeRpcInput` →
`requireOwnWorkspace` → `requireRoleForGovernedWorkspace` → `Effect.gen` calling one `GraphService`
method → `runRpcProgram`) — no new authorization tier, no new RPC-dispatch mechanism.

**Post-decisions-stage addendum:** the implementation stage *did* add two dedicated agent tools,
`defineSupertagTool`/`applySupertagTool` (`agent-edit-service-live.ts`), superseding this section's
original "no new agent tool is added this pass" call — worth recording here rather than leaving the
doc silently wrong. The original reasoning (field values ride the existing `addFact` tool since
`predicateId` is already a free-form string) still holds and is exactly what `applySupertagTool`'s
optional `fieldValues` does internally; the new tools additionally let an agent *tag* a node and
*declare a field* in one call each, rather than requiring the agent to already know a
`TagFieldDefinition.id` to call `addFact` with. See "Known risks / trade-offs" immediately below for
the one real gap this addition introduced.

## Known risks / trade-offs (adversarial-review addendum)

Recorded prominently here, not just as a code comment, per explicit review feedback that a two-line
comment buried in `agent-edit-service-live.ts` under-communicated a finding that directly
contradicts this project's own "every agent tool rides the existing pending/accept-revert
mechanism" discipline.

- **`applySupertagTool`'s tag assignment has no pending/accept-revert story, unlike every other
  agent mutation.** `addFactTool`/`addEdgeTool`/`createNodeTool`/`createAppTool` all write a
  `PendingMarker`-stamped row that `mergeChanges`/`revertChanges`/`reconcilePendingChanges` can
  promote, delete, or crash-recover. `applySupertagTool` composes `GraphService.assignTag` (see its
  own doc comment: "writes immediately, same as the mainline `applySupertag` RPC") — the tag
  membership row is real and mainline the instant the tool call runs, before the user has reviewed
  anything. Only the tool's optional `fieldValues` facts are pending; the tag itself is not.
  **Consequence:** rejecting the chat turn, or calling `revertChanges`, does not remove a tag an
  agent applied — there is no code path that would.
- **The gap compounds with the inline-`#`-chip mechanism's own reconciliation model.** A
  human-applied tag (typing `#Person`) is represented by a `supertagRef` mark in the note's prose;
  removing that mark is what drives `unassignTag` via `scheduleSupertagSync`'s chip-diffing. An
  agent-applied tag has no such mark — `applySupertagTool` never touches the Automerge doc — so the
  one mechanism that *does* exist for "un-tagging by editing" cannot see or reach it either. Before
  this fix, an agent-applied tag was consequently **permanent and unreachable from the UI**: no
  chip to delete, no pending row to reject.
- **Mitigation shipped (this fix pass): a manual "Remove tag" button, not automatic revert.**
  `SupertagFieldPopover.tsx` — the same popover both the inline chip and `NoteTags.tsx`'s chip list
  already open — now has a "Remove tag" button that calls the existing, already-idempotent
  `unassignTag` RPC unconditionally for whichever tag the popover is currently open on. This closes
  the "permanent and unreachable" half of the gap (every tag, however it was applied, now has *some*
  one-click undo in the UI) but is explicitly **not** the same guarantee the rest of the pending
  mechanism gives: it is a manual action the user must take, not something that happens
  automatically when a chat turn is rejected, and it has no crash-safety story (unlike
  `reconcilePendingChanges`) because there is nothing pending to reconcile.
- **Why the deeper fix (a real `PendingMarker` on `graph_node_tags` rows) was not attempted in this
  pass:** it would require (a) widening `NodeTagRow` (`node-tags-live.ts`) with an optional
  `pending` field and a `byPendingChatId` index, mirroring `Node`/`Fact`/`Edge`; (b) gating
  `upsertNodeTag`'s read-model write and the `hasTag` `ViewPredicate` the same "never touch the
  read-model until promoted" way those three entities already are; and (c) extending
  `mergeChanges`/`revertChanges`/`reconcilePendingChanges` (`agent-edit-service-live.ts`) to handle
  a fourth pending-entity kind end-to-end, including its own crash-recovery re-adopt/reap logic.
  That is a real, mechanical extension of an already-proven pattern, not a research problem, but it
  touches the crash-safety-critical pending pipeline for three files at once — a change worth its
  own dedicated, carefully-tested pass rather than a fold-in in a fix pass that also touched IA/nav
  hierarchy. Flagged here as the correct next step, not silently deferred.

## Explicitly out of scope / future work

- Per-block entity extraction (`#tag` on a line turning that line into its own node) — noted in §2
  as a materially bigger feature.
- Editing, reordering, or deleting an existing `TagFieldDefinition`, and the resulting orphan-fact
  question — §1.
- Editing a tag's `parentIds` after creation (`updateTagParents`) — §3.
- Promoting field-definition listing into a real `ViewSpec`/`GraphViewName`-compiled view — §1.
- A richer entity-ref field control reusing the full mention-picker UX inside the field popover — §2.
- De-duplicating same-named inherited fields from different ancestors — §1.
- The `#` vs. markdown heading-shortcut interaction — flagged for empirical verification in §2.
- A real `PendingMarker`/accept-revert story for `graph_node_tags` rows (today: `assignTag` always
  writes immediately, agent-tool-triggered or not) — see "Known risks / trade-offs" above for the
  full scope this would touch and why it was not folded into the fix pass that added the manual
  "Remove tag" mitigation.
