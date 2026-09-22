# Shared Tiptap document

Both editors persist the same Tiptap/ProseMirror JSON root:

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A note"}]}]}
```

There is no versioned segment wrapper, compatibility reader, or migration path. The web application validates this tree with Zod and edits it directly with Tiptap. Native Swift Codable types read and write that same tree; `NativeDocumentBridge` projects it into the continuous AppKit text view.

Supported blocks are paragraphs, headings (`attrs.level` 1–3), blockquotes, bullet/ordered/task lists and their items, and code blocks (`attrs.language`). Lists contain items, each beginning with a paragraph; nested lists and multiple paragraphs in an item retain their hierarchy. Ordered lists support decimal numbering with `attrs.start`. Paragraphs/headings can have `attrs.textAlign`.

Inline content is text, hard breaks, and the custom component node. Standard marks are `bold`, `italic`, `underline`, `strike`, `code`, `link`, and `textStyle`. Text-style attributes are CSS `fontFamily`, `fontSize` (for example `"17px"`), `color`, and `backgroundColor`. Native system defaults are omitted; semantic heading typography is not an inline bold mark.

Components are inline nodes: `{ "type": "component", "attrs": { "component": { ... } } }`. The payload retains its stable UUID, kind, title, source, diagram cache, drawing, and metadata. Drawing coordinates use the existing 900×420 world. Playback is `{ "type": "directVideo", "url": "https://..." }` or `{ "type": "embedURL", "url": "https://..." }`. Component and hard-break nodes may carry marks.

The paragraph tree owns structure. Native renders a newline between blocks and a line separator for `hardBreak`; original flat-file line-ending spellings are not part of the model. Code text remains exact, including internal CRLF. Code blocks contain text only; a native code-styled attachment is projected into a neighboring component paragraph rather than placed inside a code block.

Native paragraph attributes carry transient ancestor identities to retain imported quote/list structure during text edits. They are not serialized. A projection-only invisible placeholder retains the style of a sole empty block; literal text separators remain distinct from hard-break nodes. Explicit native block/list operations update or discard the affected projection context; the canonical document remains the Tiptap tree.

Native validates the decoder before Swift Codable can discard fields: unknown nodes, marks, attributes, invalid hierarchy, unsafe URLs, and duplicate component/drawing IDs are rejected. Both runtimes enforce a 16 MiB file limit, 20,000 nodes, depth 32, 4 Mi UTF-16 text units, and 1,000 components, plus bounded component and drawing payloads. Explicit null attributes remain null, including link targets and relationships that would otherwise acquire different Tiptap defaults.

The shared fixture is `Tests/Fixtures/tiptap.native-note`. Tests cover native editing, hierarchical round trips, exact code, inline marks, and component IDs. For cross-runtime verification only, `FIELDNOTES_ROUNDTRIP_OUTPUT=/private/tmp/new-note.json swift test --filter TiptapDocumentTests.testSharedFixtureRoundTripsAndCanExportForZodVerification` exports a native round trip to a new temporary file. There is no production conversion CLI.
