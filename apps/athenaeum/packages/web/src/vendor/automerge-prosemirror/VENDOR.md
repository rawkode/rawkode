# Vendored: `@automerge/prosemirror`

Per `docs/rich-text-editor-decisions.md` §1 ("Decision: vendor it, matching new-notes'
precedent") and `apps/new-notes/docs/architecture.md`'s "Editor durability boundary" section
(the original reasoning this pass re-verified rather than skipped): the beta `@automerge/prosemirror`
adapter is not taken as an unconstrained npm dependency. This directory is a narrow, pinned slice of
its source, owned and upgraded deliberately.

## Provenance

- Upstream: `automerge/automerge-prosemirror`, `main` branch (confirmed to match published npm
  `0.2.0` exactly — `main`'s `package.json` reads `"version": "0.2.0"`, and `0.2.0` is npm's
  `latest` dist-tag as of this vendoring).
- npm package shasum (from `npm view @automerge/prosemirror`): `61fb6d5115873e4553674422ae734caa5c211584`.
- Fetched verbatim via `raw.githubusercontent.com/automerge/automerge-prosemirror/main/src/<file>`,
  one commit-pinned pull, no edits except the import-path change documented below.

## Files (11 of 13 `src/` files — narrow slice per the decision)

| File | SHA-256 |
|---|---|
| `DocHandle.ts` | `cd04cba9b0a276577411dee8fe435b43155050b854503cd6ffdae99b402e2138` |
| `amToPm.ts` | `fab2abf4b7bad8c9bd7893dfd885b7bce0a6e3d43b1ad9ac4c3010b45082b958` |
| `basicSchema.ts` | `8c695f9b3957f8bfd0623dc52496c593daae47fd9984ba9c13453335f3667745` |
| `constants.ts` | `3fc5f293b07d63dadfe7245e88fc8a1064fc0062edc28222484a70bfe0d213d1` |
| `maintainSpans.ts` | `d7c3928d18774d73c7bfdf8c8d7817cdd1108a31be4600c72bb9ee712afd6ad1` |
| `patchesToTr.ts` | `1c70969d73e04d3a1b0bb70dd79236c55c77248d1d6b17db6b23d46b58f11bd4` |
| `pmToAm.ts` | `59c3ee13cca77cbb4b130dc65d5ab1c4bee8e393cd6274c1a181ad5a25ce5d4a` (post edit #4, see below) |
| `schema.ts` | `1aa3e2565f27dca24445694fa8c1bc460895dbe27277063f82d634cf60bef0f1` (post edit #2, see below) |
| `syncPlugin.ts` | `cbf7d173071bda59d18ae9fce303853a94b036c4e2022ef0627970a1e18edf38` |
| `traversal.ts` | `76500c48ddf2538a64cd6bfc7431b048414f1c0f94d9d6c16b9dbe6b7a52fbe2` (post edit #3, see below) |
| `types.ts` | `b2a9e5f86244117e44226208da0dbc85774ca6b2f4e65f220c7da08896a6fffc` |
| `utils.ts` | `6a7f859907f49c1b9267e6c332e1b95db34840177fd67d9586a3ca4a2d18da60` |

**Deliberately excluded:** `index.ts` — its only automerge-repo-shaped surface (the `init()`
convenience wrapper) is not called anywhere in this codebase; `LocalDocHandle` (`../rich-text/local-doc-handle.ts`)
implements the `DocHandle<T>` contract directly against the existing `automerge-page.ts` sync
session, so `index.ts` buys nothing and is one less file to keep in sync on upgrade.

Recompute with `shasum -a 256 <file>` before ever re-pulling from upstream — an upgrade means
re-running the fetch, re-diffing every file, and re-running this package's editor contract tests
(`../../rich-text/*.test.ts`) before updating this table, not a silent `git pull`.

## Edit #1 (every file): `slim` → fullfat import

Every file's `@automerge/automerge/slim` import was rewritten to `@automerge/automerge` (the
"fullfat" entry point, matching the exact same package + import already used throughout this
codebase, e.g. `notes-service-live.ts`/`automerge-page.ts`). `slim` requires the caller to
separately `initializeWasm()`/`initializeBase64Wasm()` before use; `fullfat` embeds and
auto-initializes the wasm module, which is what every other Automerge call site here already
relies on implicitly. Both entry points re-export the identical `implementation.js` API surface
(confirmed: `@automerge/automerge/dist/index.d.ts` — `export * as next from "./implementation.js"`
is the same module both `slim.js` and `fullfat_*.js` re-export), so this is a build/init-strategy
change only, not an API change.

## Edit #2 (`schema.ts`): `unknownLeaf.toDOM` return type

Upstream's `unknownLeaf.toDOM` returns a raw `document.createTextNode(...)` — a DOM `Text` node,
not assignable to the stricter `DOMOutputSpec = Element | {dom,contentDOM} | readonly
[string, ...any[]]` this repo's installed `prosemirror-model` (1.25.11) declares. Changed to an
array output spec (`["span", {}, "￼"]`) that renders identically (a `<span>` containing the same
placeholder glyph) — a type-checking fix only, no behavior change. See the inline comment at
`schema.ts`'s `unknownLeaf.toDOM`.

## Edit #3 (`traversal.ts`): close open frames before a block-level `isEmbed` leaf

Upstream's `TraverseState.newBlock` handles `isEmbed` blocks (line ~641) by matching the embed's
node type directly against `this.currentMatch` — correct for upstream's only `isEmbed` user
(`basicSchema.ts`'s `image`, an INLINE leaf meant to sit inside whatever textblock is already open
on the traversal stack) but wrong for a BLOCK-level `isEmbed` leaf: this schema's `horizontal_rule`
(`../../rich-text/schema.ts` — upstream's own `basicSchema.ts` never maps `divider`/`hr` at all, so
this is genuinely new-to-this-codebase surface, not something upstream's own test suite would have
exercised). If a textblock is left open on the stack when a block-level embed's span arrives (e.g.
an empty paragraph immediately before a divider — the ordinary case right after pressing Enter),
`this.currentMatch` resolves to that paragraph's own `"inline*"` content model, and matching a
block-group node against it returns `null`, which the `currentMatch` setter turns into a thrown
`"Match cannot be null"`.

This is 100% reproducible on every reload of a note containing a divider — confirmed by hand in a
real browser session against the real backend: `traverseSpans` (which `newBlock` drives) only runs
when rebuilding a ProseMirror doc FROM STORED SPANS on mount/reload, so a live local
`replaceRangeWith` (what actually runs while typing the `---` markdown shortcut) never touches this
code path, and the bug stayed invisible until a real reload-and-resync was exercised. Uncaught, it
took down the whole `<RichNoteEditor>` tree (no error boundary), not just that one note's view.

Fix: before matching a NON-inline embed's type, run the same close-mismatched-frames-then-reopen
dance the adjacent non-embed branch already performs (via `outerNodeTypes`/stack-diff/
`finishStackFrame`), so the embed is matched against the correct block-level content model instead
of whichever textblock happened to be left open. Inline embeds (upstream's `image`) are unaffected
— the added branch is gated on `!content.isInline`. See the inline comment at `traversal.ts`'s
`newBlock`.

## Edit #4 (`pmToAm.ts`): use `markMappings` for `AddMarkStep`/`RemoveMarkStep`, not raw PM names

Upstream's `applyAddMarkSteps`/`removeMarkStep` — the code path that runs for every mark applied
via a plain `tr.addMark`/`tr.removeMark` (as opposed to the text-splice-plus-mark-reconciliation
path `reconcileMarks` already handles correctly, a few lines below in the same file) — read
`step.mark.type.name` (the ProseMirror schema's own key for the mark) directly as the *Automerge*
mark name, and derived the stored value from a hardcoded `markAttrsToMarkValue` switch that only
recognized upstream's own four marks (`link` → `JSON.stringify(attrs)`; `strong`/`em`/`code` →
`true`; everything else → `true`, with its own "Maybe we should just throw here?" comment). Both
bypass the `adapter.markMappings` indirection that `amMarksFromPmMarks`/`pmMarksFromAmMarks`
(`schema.ts`) — and `reconcileMarks` itself — already use correctly to translate between a
ProseMirror mark type and its real Automerge name/value via each mark's own `automerge.markName`/
`automerge.parsers`.

This is silently harmless for every mark in `../../rich-text/schema.ts` whose ProseMirror schema
key happens to equal its `automerge.markName` (`em`, `strong`, `code`, `strike`, `link` all do,
and `link`'s attrs shape happens to match what the hardcoded `JSON.stringify(attrs)` branch would
produce anyway) — but a real, silent **data-loss** bug for `entityRef`, the one mark this pass
added whose Automerge name (`"entity-ref"`) deliberately differs from its ProseMirror key
(`entityRef`), and whose real payload (`{nodeId, label}`, via its own `automerge.parsers.
fromProsemirror`) was being discarded in favor of a bare boolean `true` from the hardcoded
fallback.

Confirmed for real, in a browser session against the real backend: an `@`-mention inserted via
`tr.addMark` (this schema's `../../rich-text/mention-plugin.ts` — the *only* way an `entityRef`
mark is ever created) round-tripped through a page reload as an unrecognized `data-unknown-mark`
span — `pmMarksFromAmMarks` found no mapping for the stored key `"entityRef"` (the mapping is keyed
`"entity-ref"`) and folded it into `unknownMark`, and even if the name had matched, the stored
value was `true`, not the real `nodeId`. Beyond the visible styling loss, this was a real
backlink-integrity hazard: `RichNoteEditor.tsx`'s `collectEntityRefIds` (used to drive
`syncNoteReferences`) only recognizes genuine `entityRef` marks, so any edit *after* a reload would
have resynced an empty reference list and silently deleted the real backlink edge the mention had
created.

Fix: both functions now look up `adapter.markMappings.find(m => m.prosemirrorMark === step.mark.
type)` — the exact same table `amMarksFromPmMarks` already trusts — and use its
`automergeMarkName`/`parsers.fromProsemirror(step.mark)` instead of the raw PM name / hardcoded
switch. A step whose mark has no mapping is now skipped (mirroring `amMarksFromPmMarks`'s own
"unmapped mark import mapping is null" handling) rather than silently mis-tagged.
`markAttrsToMarkValue` is now dead and removed; the now-unused `MarkType` import was removed with
it. Re-verified in-browser: a fresh `@`-mention now round-trips through a reload as a real,
correctly-styled `entity-ref` span with its `nodeId` intact, and the Backlinks panel correctly
keeps showing the mention-derived backlink after the reload.

## Why vendor instead of depend

1. `0.2.0` carries no semver stability guarantee, and its own `DocHandle.ts` doc comment states the
   package expects consumers to copy/adapt this exact interface rather than depend on
   `automerge-repo` — i.e. vendoring this boundary is the upstream-intended integration shape, not
   a workaround.
2. We use a narrow slice (`schema.ts`'s adapter machinery, `basicSchema.ts`'s default block/mark
   mapping extended with our own custom adapter, `traversal.ts`'s pure span↔ProseMirror-doc
   functions, `syncPlugin.ts`'s `appendTransaction`/remote-patch plugin, `patchesToTr`/`amToPm`/
   `pmToAm`/`maintainSpans` as their shared internals) — pinning exactly that slice, with nothing
   upgrading out from under us on a routine `pnpm update`.
3. Our own bridge (`LocalDocHandle`) has no upstream precedent to validate against if a point
   release changes `syncPlugin`'s internal patch-application assumptions; a pinned copy plus this
   package's own contract tests is the upgrade boundary, mirroring new-notes' stated design
   ("The compatibility fork and editor contract tests are the upgrade boundary").
