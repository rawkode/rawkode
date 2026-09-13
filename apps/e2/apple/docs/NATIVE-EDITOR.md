# Native SwiftUI note editor

Status, 13 September 2026: implemented behind **Settings → Editor → Native
editor (preview)**. The portable core is compiled and tested. The SwiftUI layer
has not been compiled with Xcode 26 or run on a device in this change; the
web editor remains the default and the qualified path.

## What it is

A SwiftUI editor for the canonical Tiptap document that the web editor,
`core/documents` and `packages/documents/src/note.ts` share. There is no
WKWebView and no second document model: the note is decoded into
`NoteDocument`, edited in place, and written back through the existing
`POST /api/documents/:id` compare-and-set endpoint.

Everything the web schema allows is supported, so a note edited natively
survives a web round trip and vice versa:

| Content                                          | Native behaviour                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Paragraphs, headings 1–3, quotes, code blocks    | One block view each; `/` menu, `#`, `##`, `>`, ```` ``` ```` and toolbar switch between them             |
| Bullet, numbered and task lists, nested          | Markers and indentation from the tree; Return/Backspace/Tab/Shift-Tab follow the ProseMirror commands |
| Bold, italic, underline, strike, inline code     | Semantic attributes on `AttributedString`; `**x**`, `*x*`, `~~x~~`, `` `x` `` and ⌘B/⌘I/⌘U/⌘E            |
| Links, font family/size, colours (`textStyle`)   | Preserved and rendered; the toolbar edits links, colours are read-only in this slice                  |
| `hardBreak`, `textAlign`, explicit `null` attrs  | Preserved byte-for-byte on untouched nodes                                                            |
| Components: D2, Mermaid, drawing, link/video     | Inline cards between text; each has a native editor sheet                                             |
| Entities: canonical (`@`/`#`) and provider       | Atomic inline runs; `@` and `#` search the workspace and insert canonical references                  |

## Where the code lives

- `Sources/Core/Note/NoteDocument.swift` — Codable tree, components, drawings,
  link metadata, entity references. IDs and URLs stay strings so nothing is
  re-cased or re-encoded.
- `Sources/Core/Note/NoteValidation.swift` — decoder walk with the Zod limits;
  unknown nodes, marks and attributes are rejected before Codable can drop them.
- `Sources/Core/Note/NoteInlineText.swift` — inline nodes ⇄ `AttributedString`
  with semantic keys (`noteBold`, `noteEntity`, `noteComponent`, …), atom
  reconciliation, and the segment split used by the views.
- `Sources/Core/Note/NoteEditing.swift` — path-addressed block operations:
  split, join, lift, list toggling and nesting, block styles with the web's
  `clearNodes` semantics, component and entity insertion.
- `Sources/Core/Note/NoteShortcuts.swift` — markdown, slash and mention rules.
- `Sources/SharedUI/Editor/` — `NoteEditorModel` (focus, menus, undo, every
  edit path), block views on `TextEditor(text:selection:)`, the formatting
  definition, component cards and editors, and `NativeNoteScreen`, which loads,
  autosaves and reports conflicts.
- `Sources/Platform/NativeSession.swift` — `saveDocument(id:note:expectedRevision:)`.

## Design decisions

**Block-based, not one continuous text view.** Pure SwiftUI cannot place custom
views inside a `TextEditor`, style paragraphs differently inside one editor, or
draw checkboxes and quote bars. Each paragraph, heading and code block is its
own `TextEditor`; components render as cards between text segments; focus and
caret placement move across blocks through the model. This is how Notion and
Craft behave on iOS. The AppKit spike in `spikes/native-rich-editor` shows the
alternative (a single `NSTextView` with attachment views); it is macOS-only.

**The document is the only state.** Views hold no copy of the note. A keystroke
becomes `NoteEditorModel.commitText`, which replaces that segment's inline
nodes and re-projects. Untouched blocks are never re-serialised, so loading a
note and saving it without edits sends identical JSON.

**Atoms are indivisible.** Entities are attributed runs whose text must equal
the reference's display text; components are U+FFFC placeholders. Any edit that
alters such a run removes the whole node, matching ProseMirror atoms.

**Presentation is derived.** Fonts, colours and underlines are computed from
the semantic keys by `NoteTextPresentation` and enforced by
`NoteFormattingDefinition`. Nothing presentational is read back into the note.

**Conflicts are never merged.** A 409 stops autosave, keeps the local edits on
screen, and offers *Reload latest*. There is no offline outbox in this slice;
see `OFFLINE-EDITOR.md` for the contract that would add one.

## Known gaps

- Diagram rendering (D2/Mermaid → SVG) and link metadata discovery are not
  performed natively. Cached SVG and metadata are shown; changing a source
  clears the cache so the web re-renders it. The spike's local renderers need
  bundled binaries and are macOS-only.
- Task creation from the slash menu (`New task`) and Supertag-driven entity
  creation need mutations the native session does not expose.
- Backspace at the start of a block and arrow-key block navigation rely on key
  events, which the iPhone software keyboard does not send; on iPhone the
  toolbar's block menu offers *Merge with previous block*, *Delete block* and
  *Line break*, or use a hardware keyboard. Cross-block selection and
  drag-to-reorder are not supported.
- Undo covers structural edits and formatting through the toolbar; typing
  inside a block uses the text view's own undo.
- Block identity is the tree path, so inserting a block above another recreates
  the views below it. Focus is restored by the model, but the text view's
  scroll position within a long block is not.
- Leaving the screen triggers a best-effort save; the iPhone sheet's Done
  button does not wait for it. Watch the status line before closing.

## Verification

```sh
swift test --package-path apple   # 75 tests incl. 23 for the note model
```

The core tests round-trip `Tests/Core/Fixtures/tiptap.native-note` (the same
fixture the web interop check uses), a canonical-entity document, rejection
cases, and each editing operation. No Xcode build, simulator run, VoiceOver or
device qualification is claimed for the SwiftUI layer; those are the next step
before the toggle can default on.
