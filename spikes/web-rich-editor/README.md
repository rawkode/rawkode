# Fieldnotes — Astro + Vue spike

A continuous rich-text editor for the same `.native-note` files as the [native companion](../native-rich-editor). Saved content is Tiptap/ProseMirror JSON, validated by Zod. No second document model or legacy migration.

## Run

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4327. For the production server:

```sh
npm run build
HOST=127.0.0.1 PORT=4327 node dist/server/entry.mjs
```

## Editing

- Headings, bold/italic/underline/strike, inline code, quotes, bullets, numbered lists and checked tasks.
- Markdown shortcuts, Tab/Shift-Tab list nesting, undo/redo and `/` block insertion.
- Type or paste fenced `d2` and `mermaid` blocks to create diagrams. Click a diagram to edit source. Other languages remain editable code.
- Draw with pen, shapes, arrows and text in the native companion's 900 × 420 coordinate space.
- Insert any HTTP(S) link. Open Graph and advertised oEmbed metadata discover previews and players without provider-specific branches. Remote previews/playback load on request.
- Open a portable note, edit it, then Export note to open it natively. The current draft is saved in this browser.

## Check

```sh
npm test
npm run check
npm run build
# On macOS with Swift installed:
npm run test:interop
```

Tests use the running editor's extensions and a shared native fixture: nested/multi-paragraph lists, code source, stable component IDs, fences, undo, safe block conversion, malformed-document rejection, and metadata URL guards.

The interop check runs a real web → Swift → Zod → Tiptap round trip and compares the whole document, allowing only standard editor defaults, mark ordering and UUID case normalization. It leaves both generated notes in a temporary directory for inspection.

## Document format

`src/lib/note.ts` defines the Zod contract and inferred TypeScript types. The saved file is the result of validating `editor.getJSON()`:

```json
{
  "type": "doc",
  "content": [
    { "type": "heading", "attrs": { "level": 1 }, "content": [{ "type": "text", "text": "A note" }] },
    { "type": "paragraph", "content": [{ "type": "text", "text": "Hello", "marks": [{ "type": "bold" }] }] }
  ]
}
```

Paragraphs, lists, list items and code blocks are real nodes. Built-in marks carry formatting; optional `textStyle` and `textAlign` use Tiptap's standard extensions. The custom inline `component` node holds diagram, drawing or link attributes, including a stable UUID. Playback metadata is `{ "type": "directVideo", "url": "https://…" }` or `embedURL`.

Both import and save validate before replacing data. Local browser drafts add a Zod-validated `{ filename, note }` wrapper; exported files contain only the document. Swift uses a native codec for the same node tree, verified with shared fixtures. Zod runs in the TypeScript application and tests, not inside AppKit.

## Spike boundaries

No cloud sync, accounts, concurrent-writer conflict handling or legacy migration. Export/import is the sharing workflow. Keep the server bound to loopback; it is not a production multi-user service.

Publishers may disallow embedding or require login; a discovered player URL is not a guarantee of playback. MP4 uses the browser player, HLS uses native support or hls.js. D2/Mermaid render locally using lazily loaded engines; their bundles are large.

This is the application's selected Tiptap schema, not support for every third-party Tiptap extension. Unknown nodes/marks/attributes and old segment files are rejected. Paragraph boundaries are structural; prose line-ending byte fidelity is not a goal. Code source retains its exact text.
