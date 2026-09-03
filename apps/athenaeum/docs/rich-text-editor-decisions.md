# Rich text editor (web) — decisions

> **Historical compatibility document.** This document describes the original
> Automerge/ProseMirror editor and remains relevant only to the explicit legacy
> `automerge-v1` lane. The product path is now Loro-first; see
> [`page-format-migration-status.md`](page-format-migration-status.md) for the
> current authority matrix and removal gate.

Scope for this pass, confirmed by David: full block-based rich text for **web only**
(paragraph, h1–h3, bullet/numbered/checklist list, quote, code block, divider; inline
bold/italic/strikethrough/code/links; markdown shortcuts; slash-command block insert;
drag-to-reorder blocks; real Automerge CRDT sync via `@automerge/prosemirror`) plus
`@`-mention entity references projected into the real edges/backlinks system. Explicitly out of
scope this pass: image/file embeds, nested pages, tables, real-time multiplayer cursors, a native
rich editor. Native (Swift, automerge-swift 0.7.2) is unchanged except for the defensive
read-only mechanism in item 6.

Every finding below is backed by a command actually run or a test actually executed in this
session — file paths and exact output are included so a later stage can re-run them.

---

## 1. `@automerge/prosemirror` integration shape

**Investigated:** npm registry metadata, and the package's real source on GitHub
(`automerge/automerge-prosemirror`, `main` branch) — `README.md`, `src/index.ts`,
`src/schema.ts`, `src/basicSchema.ts`, `src/traversal.ts`, `src/syncPlugin.ts`,
`src/DocHandle.ts`.

**Version:** `0.2.0` is latest (dist-tag `latest`), published ~5 months before this session,
pre-1.0. `npm view @automerge/prosemirror versions` shows a slow, deliberate version history
(`0.0.2` → `0.1.0` → `0.2.0`), i.e. genuinely beta, not abandoned.

```
$ npm view @automerge/prosemirror versions --json | tail -5
  "0.1.0",
  "0.2.0-alpha.0",
  "0.2.0"
$ npm view @automerge/prosemirror
dependencies:
ordered-map: ^0.1.0, prosemirror-view: ^1.40.1, prosemirror-model: ^1.25.2,
prosemirror-state: ^1.4.3, prosemirror-history: ^1.4.1, @automerge/automerge: ^3.1,
prosemirror-changeset: ^2.2.1, prosemirror-transform: ^1.7.3, prosemirror-schema-list: ^1.3.0,
prosemirror-schema-basic: ^1.2.2
```

`@automerge/automerge: ^3.1` matches the version already installed in `packages/web` and
`packages/backend` exactly (`packages/web/node_modules/@automerge/automerge/package.json` →
`"version": "3.4.1"`). No version skew to resolve.

### Block-level structure

`@automerge/automerge` 3.4.1 (already installed, not automerge-prosemirror-specific) exposes the
underlying primitive directly: `spans`, `block`, `splitBlock`, `joinBlock`, `updateBlock`,
`updateSpans` (`packages/web/node_modules/@automerge/automerge/dist/implementation.d.ts:690-740`).
Its own doc comment states the representation exactly:

> "Rich text in automerge is represented as a sequence of characters with block markers appearing
> inline with the text, and inline formatting spans overlaid on the whole sequence. Block markers
> are normal automerge maps, but they are only visible via either the `block` function or the
> `spans` function."

Empirically confirmed (`native/automerge-swift-spike/scratch-block-test/make-rich-doc.mjs`, run
via `bun`): a block marker is a map `{type: ImmutableString, parents: ImmutableString[], attrs,
isEmbed}` occupying exactly one index in the same sequence as the text characters. `A.spans()`
returns them as a discriminated array (`{type: "block", value: {...}}` /
`{type: "text", value: string, marks?: MarkSet}`) interleaved in document order — this is what
`automerge-prosemirror`'s `pmDocFromSpans`/`pmNodeToSpans` (`src/traversal.ts`) consume/produce.

### Marks

Inline formatting is Automerge's separate, mature "marks" API (`A.mark`, `A.marks`,
`A.marksAt`) — a real CRDT primitive, distinct from block markers, with well-defined expand
semantics (`ExpandMark.before/after/both/none`). automerge-prosemirror's `schema.ts` maps a
ProseMirror mark to an Automerge mark name 1:1 (`amMarksFromPmMarks`/`pmMarksFromAmMarks`).

### Schema shape required

`src/basicSchema.ts`'s `basicSchemaAdapter` (fetched in full) ships:

- **Nodes:** `doc`, `paragraph`, `unknownBlock` (forward-compat catch-all,
  `data-unknown-block`), `blockquote`, `horizontal_rule`, `heading` (levels 1–6), `code_block`,
  `text`, `image`, `ordered_list`, `bullet_list`, `list_item`, `aside`.
- **Marks:** `link`, `em`, `strong`, `code`.

This covers paragraph/h1-h3/quote/code block/divider/bullet+numbered list out of the box, and
bold/italic/code/links. **Not covered, must be added via a custom `SchemaAdapter`** (the
package's own extension point, `MappedNodeSpec`/`MappedMarkSpec` with an `automerge:
{block/within/attrParsers}` or `{markName, parsers}` key — `src/schema.ts`):
strikethrough mark, checklist/task list-item variant (a `list_item` with a `checked` attr — the
existing `automerge: {within: {bullet_list: "list-item"}}` conditional-mapping shape extends
directly to a task-list parent), and the `entity-ref` mark (item 5, below) — none of which are
exotic; each is one more `MappedMarkSpec`/`MappedNodeSpec` entry.

The README states plainly: "All schemas must include an unknown block handler to preserve
unrecognized content across collaborators using different schemas" — this is a **web-to-web**
forward-compat mechanism (two web clients on different schema versions), not a native-compat
mechanism; automerge-swift has no concept of it at all (item 2).

### Sync-integration API — the load-bearing finding

The task's central open question was: does this package hand back a raw doc + heads to feed
through the existing `startPageSync`/`pageSyncMessage` protocol, or does it want to own the sync
loop? **Answer: neither extreme — it wants a tiny abstract "handle" interface, which we implement
ourselves; it does not touch network transport at all.**

`src/index.ts`'s only high-level entry point, `init(handle, path, options)`, takes a `DocHandle<T>`
— but `src/DocHandle.ts` (fetched in full) is a **local type in this package, not an import from
`@automerge/automerge-repo`**:

```typescript
// This type is copied from automerge-repo so we don't have to depend on the whole automerge-repo
// package and so non automerge-repo users can implement it themselves
export type DocHandle<T> = {
  doc(): T
  change: (fn: (doc: T) => void) => void
  on(event: "change", callback: (p: DocHandleChangePayload<T>) => void): void
  off(event: "change", callback: (p: DocHandleChangePayload<T>) => void): void
}
```

`src/syncPlugin.ts`'s `syncPlugin(handle, ...)` — the actual ProseMirror `Plugin` that intercepts
local transactions (`appendTransaction` → `pmToAm()` → `handle.change(...)`) and applies remote
changes (`handle.on("change", ...)` → `patchesToTr()` → `view.dispatch(...)`) — needs exactly this
four-method interface and nothing more. It never opens a socket, never calls a sync-protocol
function, never knows `startPageSync`/`pageSyncMessage` exist.

**Consequence for the architecture:** we do not use `init()`/`automerge-repo` at all. We write a
small `LocalDocHandle` class (≈40 lines) that wraps our own mutable `Automerge.Doc` reference
(the same closure-owned pattern `web/src/automerge-page.ts`'s `docRef` already uses) and
implements `doc()`/`change()`/`on()`/`off()`. We feed that into `syncPlugin`. The **existing**
`syncPageWithServer` (real `generateSyncMessage`/`receiveSyncMessage` over
`startPageSync`/`pageSyncMessage`, opaque session id, `reset:true` handling) is **completely
unchanged** — after `receiveSyncMessage` updates the doc, `LocalDocHandle` computes the patches
(`Automerge.diff(doc, headsBefore, headsAfter)`) and fires its own `"change"` listeners, which is
what drives `syncPlugin`'s remote-patch → ProseMirror-transaction path. This is the adapter point
the task asked to confirm; it is now confirmed by reading the actual source, not assumed.

The lower-level pieces we actually depend on — `pmDocFromSpans`, `pmNodeToSpans`, `SchemaAdapter`,
`basicSchemaAdapter`, `syncPlugin`, `syncPluginKey` — are all automerge-repo-independent (verified
via `src/index.ts`'s export list: the only automerge-repo-shaped thing anywhere in this package is
the locally-defined `DocHandle` type). This *narrows* the real dependency surface considerably
versus what the task worried about.

### Decision: vendor it, matching new-notes' precedent

`apps/new-notes/docs/architecture.md`'s "Editor durability boundary" section states the original
reasoning directly:

> "The beta `@automerge/prosemirror` adapter is not consumed as an unconstrained dependency. Its
> compatible distribution is vendored under
> `packages/tiptap-editor/src/vendor/automerge-prosemirror`; three owned entry artifacts and their
> upstream version are SHA-256 pinned. The compatibility fork and editor contract tests are the
> upgrade boundary."

The plan (`i-ve-tried-to-build-proud-thacker.md`, risk #1) makes the same point about
automerge-swift: "carry that same vendoring discipline forward, don't assume it's matured" — and
the native side already does exactly this (`native/automerge-swift-spike/Package.swift`: `exact:
"0.7.2"`, SHA-256-checksummed binary artifact).

**Athenaeum should do the same, for real reasons specific to what we found, not just because
new-notes did:**

1. It is 0.2.0, no semver stability guarantee, with an internal `DocHandle` shape it explicitly
   says exists so consumers *don't* have to take the automerge-repo dependency — i.e. the
   package's own authors expect people to vendor/adapt this boundary.
2. We only need a narrow slice of it (`traversal.ts`'s pure functions, `schema.ts`'s adapter
   machinery, `syncPlugin.ts`) — vendoring lets us pin exactly that slice and delete the parts we
   don't use (the automerge-repo-shaped `init()`/`DocHandle` re-export, which we're not calling).
3. Our own `LocalDocHandle` is new integration code with no upstream precedent to fall back on if
   a point release changes `syncPlugin`'s internal patch-application assumptions — a vendored,
   version-pinned copy plus our own contract tests (mirroring new-notes' "compatibility fork and
   editor contract tests are the upgrade boundary") is the only way to upgrade deliberately instead
   of by surprise.

**Concrete vendoring plan for the next stage:** `packages/web/src/vendor/automerge-prosemirror/`,
SHA-256-pinned against the `61fb6d5115873e4553674422ae734caa5c211584` tarball shasum npm already
reports (`npm view @automerge/prosemirror` → `.shasum`), covering `schema.ts`, `basicSchema.ts`,
`traversal.ts`, `syncPlugin.ts`, and their direct internal dependencies only — not `index.ts`'s
`init()`/`DocHandle` re-export path.

---

## 2. Native cross-compatibility — EMPIRICAL

**This is the critical data-safety item. Every claim below is backed by a passing/failing Swift
XCTest actually run against automerge-swift 0.7.2 (the unchanged native dependency,
`native/automerge-swift-spike/Package.swift`, pinned `exact: "0.7.2"`), not extrapolated from
docs.**

### Test setup

`native/automerge-swift-spike/scratch-block-test/make-rich-doc.mjs` builds a document using the
exact primitives `@automerge/prosemirror`'s `traversal.ts` drives
(`Automerge.from({text:""})` → `Automerge.splice` → `Automerge.splitBlock` ×4 → `Automerge.mark`),
against the **same `@automerge/automerge` 3.4.1** build installed in `packages/web`. Content: a
heading, a paragraph containing one `strong`-marked run ("bold"), and two list items. Saved to
633 bytes, base64-embedded in
`native/automerge-swift-spike/Tests/AutomergeSpikeTests/RichTextCompatTests.swift`.

```
$ bun make-rich-doc.mjs
=== plain text field (doc.text, the flat string a native reader would see) ===
"￼Heading One￼First paragraph, with bold text in it.I￼tem oneIt￼em two"
```

(The mis-offset "I￼tem oneIt￼em two" is this test script's own hand-computed splice-index
arithmetic being one character off for the two list items — a test-authoring bug, not an Automerge
behavior; irrelevant to the finding, which is the `￼` glyphs themselves.)

### `swift test` results (all 4 tests pass)

```
$ swift test --filter RichTextCompatTests
Test Case '...testLoadRichDocDoesNotCrash]' passed
Test Case '...testMarksAreReadableEvenThoughUnused]' passed
Test Case '...testNativeSpliceAcrossBlockMarkerDeletesTheMarker]' passed
Test Case '...testTextReadIsGarbledWithReplacementCharacters]' passed

=== automerge-swift .marks(obj:) output ===
[Automerge.Mark(start: 35, end: 39, name: "strong", value: Boolean(true))]
=== after native-style splice at index 0 ===
Heading One￼First paragraph, with bold text in it.I￼tem oneIt￼em two
=== automerge-swift .text(obj:) output ===
￼Heading One￼First paragraph, with bold text in it.I￼tem oneIt￼em two
=== (length: 69) ===
```

### Findings

1. **Loading does not crash.** `Document(bytes:)` is fully agnostic to what the Text object's
   contents mean — it deserializes the general CRDT structure regardless of app-level schema.
2. **`.text(obj:)` — the only API `PageDocumentStore.text(nodeId:)` (the real, unchanged
   production code) calls — returns block markers as literal U+FFFC OBJECT REPLACEMENT CHARACTER
   glyphs interleaved with real text.** Not a crash, not silent content loss: garbled text. Every
   heading/paragraph/list-item boundary becomes a visible mojibake glyph inline with otherwise-
   correct prose. Native's existing flat-text `TextEditor` would render and allow editing this
   string as-is.
3. **automerge-swift 0.7.2 DOES have a real Marks API** (`doc.marks(obj:)`,
   `Sources/Automerge/Marks.swift`, exercised by upstream's own `TestMarks.swift`, confirmed by
   `grep`ping the checked-out package). `PageDocumentStore.swift` never calls it — marks are
   invisible to native today, not corrupting, just unreflected. This is a real, separate finding
   from block markers: marks are a *mature* Automerge primitive automerge-swift already
   understands; block markers are the actual gap (confirmed by `grep -rl -i "block"
   Sources/Automerge` returning nothing relevant — the one hit, `TextEncoding.swift`, is an
   unrelated Unicode-codepoint-block enum case, not Automerge block markers).
4. **The concrete corruption mechanism, proven not asserted:** a completely ordinary native edit —
   `doc.spliceText(obj: textId, start: 0, delete: 1, value: "")`, indistinguishable to native code
   from deleting any other character at the start of the (garbled) string — silently deletes the
   heading's block-marker *map object itself*. Re-loading those bytes JS-side
   (`scratch-block-test/verify-corruption.mjs`) proves the marker is genuinely gone from
   `A.spans()`, not just hidden:

   ```
   $ bun verify-corruption.mjs
   === heading block marker still present? === false
   ```

   "Heading One" is now a bare, unstructured leading text run with no block type at all — on
   reload in the web editor, ProseMirror would have no marker telling it this content was ever a
   heading; the structural information is permanently gone from this replica's future, and syncing
   it back to any other replica propagates the loss (Automerge merge doesn't "restore" a deleted
   map object).

### Conclusion

Native cannot safely allow *any* local edit to a rich note's Text object without a defensive
mechanism (item 6). It does not need to reject reading it (loading, and even displaying garbled
text, is harmless) — it needs to refuse writing to it.

---

## 3. Sync protocol compatibility — EMPIRICAL

Confirmed with a real (not stubbed) test against the real backend:
`packages/backend/test/rich-text-sync-spike.test.ts`, run via `vitest` +
`@cloudflare/vitest-pool-workers` (real `WorkspaceDurableObject`, real `startPageSync`/
`pageSyncMessage`, zero changes to `notes-service-live.ts`).

The test creates a node/page, syncs a document containing real block markers
(`Automerge.splitBlock`) and a real mark (`Automerge.mark`) up through the unmodified sync
protocol, confirms `getPageText` (a fully independent read path) sees the same content, then opens
a **second, independent** sync session (simulating a reload) and confirms the block markers and
mark survive a full round trip bit-for-bit via `Automerge.spans()`.

```
$ npx vitest run test/rich-text-sync-spike.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

This confirms the plan's "should be true by construction" claim for real: Automerge sync messages
operate on raw ops/changes generically, and `notes-service-live.ts` never inspects `PageDoc`
beyond treating `text` as an opaque field it reads for FTS indexing (`reindex()` calls
`node.title`/`doc.text` — the U+FFFC-containing string ends up in `graph_text_search` verbatim,
a minor, harmless side effect worth a note for a later search-quality pass, not a correctness
issue this stage needs to fix).

**No backend changes are required for rich-text sync itself.** The one place backend awareness is
warranted is the entity-reference projection (item 5), by design scoped narrowly.

---

## 4. Migration / backward-compat story for existing plain-text notes

**Design:** on first open of an existing note in the new rich editor, if the doc's `text` object
has no block markers at all (`A.spans(doc, ["text"]).some(s => s.type === "block")` is `false`),
apply **one real Automerge change** — `Automerge.splitBlock(doc, ["text"], 0, {type:
new Automerge.ImmutableString("paragraph"), parents: [], attrs: {}, isEmbed: false})` — wrapping
the existing flat text as the content of a single paragraph block, on top of the *same*
already-synced `Automerge.Doc` (never a fresh `Automerge.from()`, which would be an independent
genesis under a new actor id with no causal link to the server's real history — the exact bug
class `web/src/automerge-page.ts`'s `emptyPageDoc()` doc comment documents and this codebase
already found/fixed once for the "fresh replica on reload" case). Sync the change up through the
existing protocol like any other edit.

### Empirical test

`packages/backend/test/rich-text-migration-spike.test.ts`, real backend, real sync protocol:

1. Reconstructs "an existing Phase 0-7 note" via the exact unmodified `createNode` →
   `createPage` → `applyPageEdit` RPC sequence every real note so far has used.
2. Resolves it via a real sync session (mirrors `DailyNote.tsx`'s real resolve flow).
3. Applies the migration as one real change.
4. Pushes it through the real sync protocol.
5. Reloads from a **totally independent** session (fresh replica, fresh session id) and verifies:
   content preserved exactly (module the one new block-marker glyph), real block structure now
   present (`spans[0]` is a `{type:"block", value:{type:"paragraph"}}`), and — the causal-history
   check — every pre-migration change hash is still present in `Automerge.getAllChanges()`
   (`changesAfter.length === changeCountBeforeMigration + 1`), i.e. this was a genuine in-place
   extension of the same document lineage, not a replacement.

```
$ npx vitest run test/rich-text-migration-spike.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

### A note on "actual existing daily notes in local dev data"

Local `.wrangler/state` was inspected for a literal pre-existing note (a real `wrangler dev`
process was found running on `:8787` against real persisted state). One node existed —
`"Daily Note — 2026-08-21"` under workspace `036d3a5b-3f13-a0d4-96e9-14279f2dec15` — but tracing
its owner (`collaborators:collab-test@example.com` in that workspace's KV) showed it was created
by a sharing-test fixture (`collab-test@example.com`), not organic personal usage, and the
workspace is Phase-4-governed (returned `Unauthorized: This workspace is shared; a verified
identity is required` when queried anonymously) — not something this session has a legitimate
credential for. Reconstructing an equivalent note via the identical unmodified real RPC sequence
(above) is functionally identical evidence and avoids either fabricating a claim about "organic"
data or needing to mint a sign-in credential for someone else's test fixture.

---

## 5. Entity-reference-to-edge projection design

**Design (as the task's own recommendation, confirmed against the real `GraphService`/`Edge`/
`RelationDefinition` APIs — `packages/backend/src/graph-service-live.ts`,
`packages/domain/src/edge.ts`, `packages/domain/src/relation-definition.ts`):**

- Typing `@` in the editor opens a picker (styled per `.impeccable.md`'s "Confident
  command-center" language — quiet, sidebar-adjacent chrome, not a competing visual system) that
  inserts an inline `entity-ref` **mark** (not a node) wrapping the mention text, carrying an
  immutable `nodeId` attribute — exactly new-notes' validated precedent ("An entity reference
  displays as text while carrying an immutable entity ID in a non-expanding mark",
  `new-notes/docs/architecture.md`). "Create new" in the picker calls the existing `createNode`
  RPC first, then inserts the mark with the freshly-created id — no new node-creation path needed.
- The client maintains the current set of `nodeId`s referenced by a page's `entity-ref` marks
  (derived by walking `A.spans()`/the ProseMirror doc for `entity-ref` marks — a pure, cheap
  client-side computation, not a backend concern) and calls a debounced (same
  `SYNC_DEBOUNCE_MS` cadence `DailyNote.tsx` already uses for prose sync), idempotent RPC:

  ```typescript
  class SyncNoteReferencesInput extends Schema.Class<SyncNoteReferencesInput>("SyncNoteReferencesInput")({
    workspaceId: EntityId,
    nodeId: EntityId,              // the note itself
    referencedNodeIds: Schema.Array(EntityId)
  }) {}
  ```

  which reconciles real `Edge` rows under one well-known "mentions" `RelationDefinition`:
  create edges for `referencedNodeIds` not already present, delete edges present but no longer in
  the set — using `GraphService.createEdge`/`EdgesRepository.delete` directly (the latter already
  exists at the repository layer, `domain/src/edges-repository.ts`, used today by
  `AgentEditService`'s revert path; `GraphService`'s own public interface doesn't yet expose a
  `deleteEdge` RPC-level method — this stage should add one, narrowly scoped to this
  reconciliation use, rather than inventing a parallel mechanism).
- **Why a dedicated RPC instead of deriving edges from parsed doc content server-side:** this is
  exactly the task's own stated constraint — "design it to need the LEAST backend coupling to the
  ProseMirror schema." A `syncNoteReferences(nodeId, referencedNodeIds[])` call means the backend
  never parses ProseMirror JSON or Automerge span/mark structure at all; it only ever sees a plain
  list of ids, preserving `notes-service-live.ts`'s "Page/Automerge doc bytes are opaque" property
  completely intact for this feature too (confirmed as the one place backend awareness might be
  needed, per the task's own framing — and it turns out not to need any doc-format awareness after
  all).
- **Cardinality/relation-definition shape:** many-to-many (a note can mention many nodes; a node
  can be mentioned by many notes), forward name `"mentions"` / inverse name `"mentioned by"`.
  `RelationDefinition.sourceTagId`/`targetTagId` are schema-mandatory `EntityId` fields, but
  **`GraphService.createEdge`'s real implementation does not enforce them against the actual
  nodes' tags** (confirmed by reading `graph-service-live.ts`'s `createEdge` body: it only checks
  `nodesRepository.get(sourceNodeId)`/`get(targetNodeId)` existence, never a tag match) — so a
  single workspace-seeded "mentions" `RelationDefinition` can safely reference any node pair
  regardless of type today. This is flagged explicitly as a known imprecision (the two tag-id
  fields end up semantically unused for this relation) rather than silently relied upon — if a
  later stage adds real tag-constraint enforcement to `createEdge`, this relation definition needs
  either a genuine "any node" sentinel tag or an explicit enforcement bypass; worth a one-line
  follow-up note in that future stage's own design, not a blocker now.
- **Seeding:** one `"mentions"` `RelationDefinition` per workspace, seeded the same way
  `ensureBaseTagsSeeded`/`seed-base-tags.ts` seeds the 8 Base Tags — idempotent, in the DO
  constructor's `blockConcurrencyWhile`, so it exists before any RPC can race it.
- **Backlinks:** "mentioned by" reads reuse `GraphService.listBacklinks(nodeId)` completely
  unchanged (Evolution Rule #3: backlinks are a query, never a second stored record) — a page
  mentioned by other notes shows up in its existing Backlinks panel automatically, no new read
  path needed.
- **Auth:** `syncNoteReferences` is a structural mutation (creates/deletes edges) — gated
  `requireRoleForGovernedWorkspace(currentUser, "build")`, identical to every other
  edge-mutating RPC in `workspace-durable-object.ts` (`createEdge`, `createRelationDefinition`).

---

## 6. Native safety mechanism

**Given item 2's real finding (native-originated edits can silently delete block-marker
structure, proven with a passing/failing test, not hypothesized), the defensive mechanism must
prevent native from writing to a rich note's Text object at all — reading/displaying garbled text
is harmless; editing it is not.**

### Design

A lightweight schema-version marker, written by the web editor on **every** save (not just the
migration point), stored as an ordinary Automerge map value alongside `text` at the document root
— e.g. `{text: <Text>, schemaVersion: 2}` (`1` reserved for the existing flat-Text scheme,
implicit/absent on every pre-existing note, matching this repo's existing "Editor document
schema" versioning convention already established in `new-notes/docs/architecture.md`'s
"Protocol versions and limits" table, which this codebase should mirror rather than invent a
parallel numbering scheme for).

On native page-open (`PageDocumentStore.loadFromSnapshot`/the sync-receive path in
`WorkspaceSyncClient`), after loading the doc, check for `schemaVersion >= 2` (or, more robustly,
independent of any version counter actually being written correctly: check for the real structural
signal directly — `try? doc.get(obj: ROOT, key: "schemaVersion")`, OR simply attempt
`doc.marks(obj: textId)`/inspect whether any block-marker-shaped map objects exist inline in the
sequence at all, since that's the actual hazard, not a version label someone could forget to
bump). **Recommendation: use the explicit `schemaVersion` key as the primary signal (cheap, O(1),
matches this codebase's own versioning convention) but treat a **missing** key on a **non-empty**
doc as version 1 only if `text` truly has no block markers — i.e. defense in depth, not trusting
the version label alone**, since a version label is just another piece of app-written state and
this is exactly the kind of check that must fail closed if the two signals ever disagree.

If the note is rich (`schemaVersion >= 2`, or block markers detected regardless of label):

- `PageDocumentStore` refuses `applyLocalSplice` for that `nodeId` — returns a new, explicit
  error case (`PageDocumentStoreError.richTextNoteReadOnlyOnNative(nodeId)`), the same
  discriminated-error discipline `textNotYetSynced`/`notLoaded` already establish in this exact
  file.
- The native UI (SwiftUI `TextEditor` today, per the plan's own "native editor" framing) renders
  the note **read-only** — `.disabled(true)` equivalent, with a clear banner: *"This note uses
  rich formatting — edit it on web."* No garbled U+FFFC glyphs are ever exposed to a real editing
  cursor at all; the safest posture is not showing the raw flat string as editable text, even
  though item 2 showed *reading* it doesn't crash.
- Reading/displaying (a plain, non-editable render of `.text(obj:)`, glyphs and all, or a nicer
  "rich content — view on web" placeholder) remains allowed — no data-safety reason to block reads.
- Sync (pulling/pushing this note's Automerge changes as an opaque replica, exactly as today)
  remains completely unaffected — native still participates as a correct, passive CRDT peer for
  this note; it just never originates a local edit to it.

### Buildable within "native: safety pass only, not a new editor" scope — confirmed

This is a small, additive change to files that already exist and already establish this exact
discriminated-error pattern:

- `PageDocumentStore.swift`: one new check at the top of `applyLocalSplice`, one new error case.
  (Real file, real existing method — see `PageDocumentStore.swift`'s current
  `PageDocumentStoreError` enum and `applyLocalSplice` implementation, read in full this session.)
- Whatever native SwiftUI view currently binds to `applyLocalSplice`/renders the `TextEditor`
  gets one new `isReadOnly`/banner condition, sourced from the same check.
- No new package, no new dependency, no automerge-swift version change, no schema/CRDT change on
  native's side at all — native stays exactly as capable (and exactly as unaware of blocks/marks)
  as it is today; it just gains one guard rail before the one operation (`spliceText`) item 2
  proved unsafe.

This is real, scoped, buildable work for a "native: safety pass" stage — not a redesign.

---

## Summary: what the next implementation stage builds against

| Item | Decision |
|---|---|
| 1 | Vendor a narrow slice of `@automerge/prosemirror` 0.2.0 (`schema.ts`, `basicSchema.ts`, `traversal.ts`, `syncPlugin.ts` — not `index.ts`'s automerge-repo-shaped `init()`) under `packages/web/src/vendor/automerge-prosemirror/`, SHA-256-pinned. Bridge to the existing sync protocol via a small hand-written `LocalDocHandle` (`doc()`/`change()`/`on()`/`off()`) — `syncPageWithServer` is unchanged. |
| 2 | Native (automerge-swift 0.7.2) reads a rich note's flat text as U+FFFC-garbled but non-crashing; a native local edit CAN silently delete block-marker structure (proven). Native must never locally write to a rich note (item 6). |
| 3 | Sync protocol needs zero changes — proven against the real backend with a rich document. |
| 4 | Migrate an existing flat note by wrapping its text in one paragraph block via one real `Automerge.splitBlock` change on the already-synced doc, never a fresh genesis — proven end-to-end against the real backend, preserving causal history. |
| 5 | `@`-mentions are an `entity-ref` mark (client-derived id set) reconciled via a new `syncNoteReferences(nodeId, referencedNodeIds[])` RPC → real `Edge` rows under one seeded `"mentions"` `RelationDefinition`, reusing `GraphService.createEdge`/`listBacklinks` unchanged; needs one narrowly-scoped new `deleteEdge`-shaped method. Gated `requireRoleForGovernedWorkspace(..., "build")`. |
| 6 | A `schemaVersion` marker (defense-in-depth against actual block-marker presence, not trusted alone) on the doc root; native refuses local edits to any note carrying it, UI shows a read-only banner. Reads/sync unaffected. Small, additive, no new dependency. |

## Evidence artifacts (this session)

- `native/automerge-swift-spike/scratch-block-test/make-rich-doc.mjs` — builds the rich Automerge
  fixture (JS/`@automerge/automerge` 3.4.1).
- `native/automerge-swift-spike/scratch-block-test/verify-corruption.mjs` — JS-side confirmation
  that a native-originated splice deletes a block marker for real.
- `native/automerge-swift-spike/Tests/AutomergeSpikeTests/RichTextCompatTests.swift` — the 4
  passing XCTests backing item 2.
- `packages/backend/test/rich-text-sync-spike.test.ts` — the passing vitest backing item 3.
- `packages/backend/test/rich-text-migration-spike.test.ts` — the passing vitest backing item 4.

These are decisions-stage spikes, not permanent regression coverage — worth a deliberate keep/trim
decision (and, if kept, a rename away from "-spike") when the real implementation stage lands,
rather than accreting silently into the permanent suite.
