# Fieldnotes — Astro + Vue spike

A continuous rich-text editor for the same `.native-note` files as the [native companion](../native-rich-editor). One shared format, no legacy migration.

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
```

Tests use the actual editor schema and shared native fixture, including joins/splits, nesting, exact source/separators, stable component IDs, code fences, undo, safe block conversion, and metadata URL guards.

## Spike boundaries

No cloud sync, accounts, concurrent-writer conflict handling or legacy migration. Export/import is the sharing workflow. Keep the server bound to loopback; it is not a production multi-user service.

Publishers may disallow embedding or require login; a discovered player URL is not a guarantee of playback. MP4 uses the browser player, HLS uses native support or hls.js. D2/Mermaid render locally using lazily loaded engines; their bundles are large.

The portable format supports one paragraph per list item plus nested items. Use Shift-Enter for a line break inside an item; unsupported imported structures fail visibly instead of being silently discarded. Unsupported old note files are rejected.
