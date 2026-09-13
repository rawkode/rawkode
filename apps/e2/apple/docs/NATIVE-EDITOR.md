# Native SwiftUI note editor

Status, 14 September 2026: preview only under **Settings → Editor → Native
editor (preview)**. Review fixes add durable native drafts, serialized saves,
owner/day fencing, safe list operations, and main-actor WebKit rendering. The
web editor remains the default; native parity is incomplete.

## What it is

A SwiftUI editor for the canonical Tiptap document that the web editor,
`core/documents` and `packages/documents/src/note.ts` share. There is no
WKWebView and no second document model: the note is decoded into
`NoteDocument`, edited in place, and written back through the existing
`POST /api/documents/:id` compare-and-set endpoint.

The portable model represents the web schema. Editing parity has the explicit
gaps below; covered model round trips are tested:

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
caret placement move across blocks through the model. The AppKit spike in `spikes/native-rich-editor` shows the
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

**Drafts are durable before network access.** `NotePersistence` stores the
acknowledged base, current document and uncertain write atomically per origin,
account and document. Saves serialize; editing never cancels transport. Lost
acknowledgements are reconciled against the server before another write. A
shared controller and writer preserve edits through close/reopen and multiple
Mac windows. Failed disk writes block Done and day rollover and retain the
in-memory draft for retry.

**Conflicts are never silently merged.** Check latest reconciles remote state
without replacing a dirty local draft. A differing remote edit remains a conflict;
manual merge/reapplication is not implemented. This native cache does not make
the default web editor offline-capable.

**Markdown block prefixes convert on Return.** Typing a heading or list prefix
keeps the native keyboard buffer stable until Return strips the marker and
creates the next block. Slash commands and toolbar formatting apply immediately.

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
- Done requires a successful local draft write, then sync continues in the
  background. Server acknowledgement is shown separately from local durability.
  Device termination cannot recover data when disk writes themselves fail.

## Verification

The review-fix suite passes 86 core tests, including list-schema regressions and
nine persistence tests for late replies, queued refreshes, offline reopen,
uncertain acknowledgement, disk failure/recovery, and corrupt-cache rejection.
iOS Simulator and Mac builds pass. Five native UI journeys exercise the actual
local website fixture: immediate close/relaunch, heading/paragraph save/relaunch,
slash Checklist insertion with exact text, canonical mention selection, and
Drawing insertion with Dawn/Dark rendering. Screenshots are exported from XCTest,
not generated mockups. Physical-device, VoiceOver and long-document qualification
remain open.

```sh
swift test --package-path apple
```

## Screenshots

Runtime screenshots are in `docs/screenshots/native-editor/` after final review.
UI tests require `APSIDES_EDITOR_TEST_ORIGIN` pointing to the local website fixture.
Each native UI journey uses an isolated `native-test:` document ID; the override
is enabled only in Debug UI-testing builds against HTTP loopback. Relaunch keeps
that ID to verify persistence without contaminating another journey's note.

The fixture proxy asserts the owner identity server-side and sets no
`CF_Authorization` cookie, which the native session otherwise requires. Debug
builds launched with `--ui-testing` against an `http://` loopback origin set
`NativeSession.trustsLoopbackFixture`, which lets requests proceed without the
cookie for that origin only. Release builds and HTTPS origins are unaffected.

The core tests round-trip `Tests/Core/Fixtures/tiptap.native-note` (the same
fixture the web interop check uses), a canonical-entity document, rejection
cases, and each editing operation. Xcode and Simulator evidence does not establish physical-device or VoiceOver
qualification. The toggle remains off by default.
