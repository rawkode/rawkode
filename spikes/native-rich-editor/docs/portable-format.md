# Portable notes, version 2

The shared container is `{ "version": 2, "segments": [...] }`. Segments concatenate exactly in order; no implicit newline is inserted before or after code or components. This is an import/export format, not a concurrent editing protocol.

Text segments have `type: "text"`, exact `text`, and optional fields:

- `marks`: boolean `bold`, `italic`, `underline`, `strike`, `inlineCode`, and string `link`.
- `fontSize`: positive points, up to 512; `fontFamily`: a family name or `system-ui`.
- `foreground` and `background`: `#RRGGBB`, `#RRGGBBAA`, or dynamic tokens `text`, `secondary`, `muted`. Web maps dynamic tokens to its theme; native maps them to system colors.
- `paragraph`: `kind` (`paragraph`, `heading1`, `heading2`, `heading3`, `quote`), optional `alignment` (`left`, `center`, `right`, `justified`), and optional `list`.
- `list`: full nesting `path` of `bullet`, `numbered`, or `task` (maximum six levels), optional task `checked`, and optional numbered `start`. `start` is the displayed number for this item; absence means 1, not implicit continuation.

Paragraph semantics apply to every paragraph touched by a run. Native emits text runs split at paragraph boundaries and repeats paragraph metadata for inline style changes. Text owns exact LF, CRLF, CR, U+2029, blank lines, tabs, and trailing separators. A native generated list marker is removed only when supported native list semantics agree; literal marker-looking text is not stripped. Each editor projects its own visible list marker.

Code segments are `{ "type": "code", "language": "swift", "source": "..." }`. Source can be empty and preserves internal CRLF. The native editable projection uses a tracked newline placeholder for empty code; it serializes back to empty source while untouched.

Component segments are `{ "type": "component", "component": ... }`. Component JSON retains the native payload: UUID `id`, `kind` (`diagram`, `mermaid`, `drawing`, `link`), `title`, `source`, optional SVG cache, drawing, and metadata. IDs are preserved by file interchange; copying a component into another place intentionally creates a new ID. Drawing coordinates remain in the native 900×420 world. Link playback retains the existing enum encoding: `{ "directVideo": { "_0": "https://..." } }` or `{ "embedURL": { "_0": "https://..." } }`.

## Scope

Only version 2 is supported. Other versions or unsupported native content are rejected without overwriting the file. Authoring records heading, quote, and inline-code semantics directly; heading typography is separate from explicit inline bold marks.

`Tests/Fixtures/portable-v2.native-note` is the shared fixture covering split bold list runs, nested mixed lists, tasks, headings, quotes, inline marks, Unicode, code, blank lines, adjacent components, drawing elements, and both playback variants. Ordinary tests never rewrite it.
