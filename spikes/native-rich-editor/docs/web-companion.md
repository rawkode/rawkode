# Astro + Vue companion

Status: implemented in `spikes/web-rich-editor`. One shared portable format; no legacy migration.

## Outcome

Open, edit, and save the same notes from the native macOS editor and a browser. Astro owns the web application; Vue owns one continuous rich-text editor. Match the existing formatting, list/task, slash-menu, code, diagram, drawing, and metadata-driven embed workflows. Do not imply identical platform key handling or live synchronization.

Use Vue 3 with Tiptap/ProseMirror as the editable projection. Keep the portable note model independent of Tiptap and NSTextView. A note must not become disconnected text fields or a dashboard of components.

## Compatibility decision

The shared version 2 format uses portable attributed runs and explicit paragraph/list metadata. Typed code and component payloads retain stable IDs. Old Apple RTFD notes are deliberately unsupported in this spike.

Define the contract and fixtures before changing persistence. Preserve exact separators, blank lines, tabs, trailing newlines, adjacent components, and mixed inline formatting. A block adapter must not add a newline around every component.

Native list state combines NSTextList nesting with explicit visible marker characters. The portable representation retains the full list-kind path and task check state, while each editor owns rendering its markers. Headings, quotes, and inline code use semantic attributes.

Keep drawing coordinates in the current 900 by 420 world. Preserve all drawing elements, colors, source, diagram caches, link metadata, and component IDs. Treat stored SVG and URLs as untrusted in the browser. Never execute arbitrary saved embed HTML.

## Storage boundaries

- No migration, old-format backups or compatibility bridge. Both editors use the same current format.
- Unsupported versions or native rich content must fail safely or remain opaque. Do not silently discard unsupported attachments or formatting.
- Import/export is the initial shared-note workflow. Live sync and simultaneous native/web edits require a separately designed conflict protocol; neither is implied by this spike.
- Browser draft persistence, import, export, and load errors must be visible. A failed import must not replace the current draft.
- Link metadata discovery must remain provider-independent. Any server-side URL fetch needs bounded responses and SSRF protection; direct browser requests are subject to CORS.

## Logical delivery commits

1. Tested native baseline, already published.
2. Architecture and interoperability acceptance gates, this document.
3. Portable schema, native adapter, and cross-runtime fixture.
4. Astro/Vue shell and continuous rich-text editing with file import/export.
5. Vue component editing/rendering for diagrams, drawings, and generic embeds.
6. Browser/native round-trip verification and remaining fixes, with evidence recorded in the PR.

Keep additions scoped to the spike. Do not move or include the unrelated Enchiridion working-copy changes. Each published checkpoint must be compared against main and the complete remote PR file list, not just a path-limited local diff.

## Acceptance gates

- Native portable note to browser edit to native reopen retains text, marks, list paths/check states, code source/language, component IDs, and payloads.
- An untouched fixture round-tripped twice stabilizes without added blank lines or regenerated IDs.
- Cover mixed nested lists, bold text within list items, emoji, empty paragraphs/code, CRLF code, adjacent components, unknown versions, unsupported native content, and failed writes.
- Verify actual browser typing, list continuation/exit, nesting, undo, slash commands, component editing, persistence/reopening, and native interchange. Build and unit tests alone do not establish this.
- Do not claim arbitrary video playback from metadata discovery alone. Test direct media separately from publisher iframe embeds and report restrictions.

Implementation references: [Astro Vue integration](https://docs.astro.build/en/guides/integrations-guide/vue/), [Tiptap Vue 3](https://tiptap.dev/docs/editor/getting-started/install/vue3), [Vue node views](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/vue).
