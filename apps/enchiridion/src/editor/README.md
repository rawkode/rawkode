# Daily editor

`createDailyEditor` mounts one Tiptap/ProseMirror document and binds it directly to
Loro through `loro-prosemirror` 0.4.4. Await `handle.ready` before commands. Native
storage owns the day lease and serializes saves; this module never opens files.

Snapshots contain exactly two root maps:

- `metadata`: `schemaVersion: 3`, `day`, `binding: "loro-prosemirror"`,
  `bindingVersion: "0.4.4"`, `editorSchema: 1`.
- `doc`: the official binding's `nodeName`, `attributes: LoroMap`, and
  `children: LoroList`, recursively containing node maps and marked LoroText.

Preflight validates every node, mark, attribute, container, and content expression
before attaching the binding. This is necessary because the binding's permissive
reader otherwise filters unsupported nodes. Unknown schema versions fail without
emitting saves. The host keeps the original snapshot available.

Bootstrap, migration projection, selection, and focus do not call `onChange`.
Real local changes and Loro undo/redo coalesce into one snapshot callback per
microtask. Call `prepareForTransition()` before navigation or quit: it rejects an active IME
composition, synchronously flushes buffered native DOM input, and freezes editing.
Then drain microtasks before flushing the native save queue. A narrowly typed
ProseMirror observer seam is necessary because changing editability otherwise
redraws the old state before its delayed MutationObserver flush.
`exportSnapshot` returns the current bytes without saving them.

Diagrams are atomic block nodes in the same selection and undo model as prose,
lists, tasks, and tables. Only editable `id`, `kind`, and `source` live in Loro;
`loadPreview` supplies an optional derived PNG. `updateDiagram` checks both node
identity and the source captured when the modal opened. Clipboard copies get new
identities. Destroying the handle removes both bindings and frees Loro state.

Legacy v1/v2 notes project into a new v3 snapshot, saved only on an actual edit.
Native storage must retain the original backup. Supported body attributes are the
verified SwiftUI body/default system-17 fonts, recursive bold/italic modifiers,
single underline/strikethrough, and absolute HTTP/HTTPS/mailto links. Plain legacy
paragraphs, coherent nested lists/checklists, and diagram sources migrate into
one document. Unknown font settings, invalid indentation, marks, or structures
fail explicitly instead of being flattened.

Run `npx vitest run tests/editor` for model and keyboard integration checks.
The optional `EDITOR_FIXTURE_PATH=/tmp/example.loro` environment variable exports
the rich-document test snapshot for native Rust interoperability tests.
