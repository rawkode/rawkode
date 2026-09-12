# Astro + Vue companion

Status: implemented in `spikes/web-rich-editor`. Both apps save Tiptap/ProseMirror JSON, with Zod defining the contract. No legacy migration.

## Outcome

Open, edit, and save the same notes from the native macOS editor and a browser. Astro owns the web application; Vue owns one continuous rich-text editor. Match the existing formatting, list/task, slash-menu, code, diagram, drawing, and metadata-driven embed workflows. Do not imply identical platform key handling or live synchronization.

Use Vue 3 with one continuous Tiptap/ProseMirror editor. Its JSON document is the saved representation. The native client maps the same node tree to one long-lived TextKit 2 `NSTextView`; it does not embed the web editor.

## Format decision

Use standard paragraph, heading, quote, list/item, task, code, text and hard-break nodes, plus a small custom inline component node for diagrams, drawings and links. Zod schemas in `web-rich-editor/src/lib/note.ts` validate reads and writes and infer TypeScript types. Swift's native codec is checked against the same shared fixture.

The flat `segments` model and web conversion adapter have been removed. There is no reader for previous formats. Paragraph boundaries now belong to the tree; preserve code source exactly, but do not retain separate LF/CRLF metadata for prose.

Lists contain item nodes, which can contain multiple paragraphs and nested lists. Each editor owns its visible markers. Headings and inline formatting use node types and marks; optional visual typography uses the standard Tiptap textStyle mark.

Keep drawing coordinates in the current 900 by 420 world. Preserve all drawing elements, colors, source, diagram caches, link metadata, and component IDs. Treat stored SVG and URLs as untrusted in the browser. Never execute arbitrary saved embed HTML.

## Storage boundaries

- No migration, old-format backups or compatibility bridge. Both editors use the same current format.
- Unsupported document shapes or native content must fail safely. Do not silently discard unsupported attachments or formatting.
- Import/export is the initial shared-note workflow. Live sync and simultaneous native/web edits require a separately designed conflict protocol; neither is implied by this spike.
- Browser draft persistence, import, export, and load errors must be visible. A failed import must not replace the current draft.
- Link metadata discovery must remain provider-independent. Any server-side URL fetch needs bounded responses and SSRF protection; direct browser requests are subject to CORS.

## Logical delivery commits

1. Tested native baseline, already published.
2. Architecture and interoperability acceptance gates, this document.
3. Initial portable schema and native adapter.
4. Astro/Vue shell and continuous rich-text editing with file import/export.
5. Vue component editing/rendering for diagrams, drawings, and generic embeds.
6. Replace the custom format with Zod-validated Tiptap JSON; verify cross-runtime behavior and record remaining limits in the PR.

Keep additions scoped to the spike. Do not move or include the unrelated Enchiridion working-copy changes. Each published checkpoint must be compared against main and the complete remote PR file list, not just a path-limited local diff.

## Acceptance gates

- Native note to browser edit to native reopen retains text, marks, list structure/check states, code source/language, component IDs, and payloads.
- An untouched fixture round-tripped twice stabilizes without added blank lines or regenerated IDs.
- Cover mixed nested lists, multi-paragraph list items, bold text within list items, emoji, empty paragraphs/code, CRLF code, adjacent components, malformed schema, unsupported native content, and failed writes.
- Verify actual browser typing, list continuation/exit, nesting, undo, slash commands, component editing, persistence/reopening, and native interchange. Build and unit tests alone do not establish this.
- Do not claim arbitrary video playback from metadata discovery alone. Test direct media separately from publisher iframe embeds and report restrictions.

Implementation references: [Astro Vue integration](https://docs.astro.build/en/guides/integrations-guide/vue/), [Tiptap Vue 3](https://tiptap.dev/docs/editor/getting-started/install/vue3), [Vue node views](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/vue).
