# Native rich editor spike

A Swift macOS app called **Fieldnotes**: one continuous native rich-text document with inline diagrams, native vector drawings, and metadata-driven link/video embeds.

## Run

```sh
cd spikes/native-rich-editor
./script/build_and_run.sh
```

Requires macOS 14+ and Xcode/Swift 6. First run downloads pinned D2 0.9.0 and Mermaid 11.17.2 from their official releases, checks integrity, and bundles them locally. No Node, browser download, or system-wide install is needed. Subsequent builds work offline. Link metadata and remote video require a network connection.

The script stages `dist/NativeRichEditor.app`, ad-hoc signs it, and launches it. `--build` builds without launching; `--verify` also checks the running process; `--debug`, `--logs`, and `--telemetry` support development. The project has a Codex Run action.

## Authoring

Type `/` at the start of a paragraph for a keyboard-navigable native block menu: text, headings, quote, lists, tasks, code, diagrams, drawing, or a link/video.

- `- ` or `* ` starts a bulleted list; `1. ` starts a numbered list; `[] ` or `[ ] ` starts a task list.
- Return continues a list; Return on an empty item exits it. Tab/Shift-Tab indent/outdent. Click a task box to toggle it.
- `# `, `## `, `### ` create headings; `> ` creates a quote. Return after a heading starts body text.
- `**bold**`, `*italic*`, `~~strikethrough~~`, and single-backtick inline code format as you type. These shortcuts leave fenced code source alone.
- ⌘B / ⌘I / ⌘U toggle bold / italic / underline; ⌘⇧X toggles strikethrough. ⌘⌥1–3 choose headings and ⌘⌥0 chooses body text. ⌘⇧8 / 7 / 9 choose bullets / numbers / tasks.

The paragraph toolbar menu and Format menu expose the same styles. Selection, copy/paste, and undo remain native text operations across the continuous document.

Type or paste a completed fenced block. The closing fence converts D2 and Mermaid into diagram attachments:

````text
```d2
direction: right
Idea -> Note -> Diagram
```

```mermaid
flowchart LR
    Idea --> Note --> Diagram
```

```swift
let answer = 42
print(answer)
```
````

The Swift example becomes editable monospaced text, as do other languages and unlabelled fences. Code language/source survive persistence. This spike does not syntax-highlight code.

Click a diagram or **Edit source**, change the source, choose **Render preview** (⌘Return), then **Save diagram**. Invalid source remains available for correction. Cancel discards the sheet draft. D2 and Mermaid rendering stays local.

**Insert → Drawing** opens the native canvas: pen, rectangle, ellipse, arrow, text, selection/move, colors, undo/redo, and deletion. Save commits the drawing to the note; Cancel leaves it unchanged.

**Insert → Link** (⌘K) accepts any HTTP(S) URL. **Fetch Preview** discovers Open Graph and advertised JSON oEmbed metadata. A discovered iframe player loads in WebKit; a direct video identified by MIME type uses an AppKit `AVPlayerView`. This avoids the SwiftUI `VideoPlayer` construction path implicated in the reported macOS 27 crash. Click **Play video** to load remote player content. Links without supported players remain preview cards, with an open-in-browser button. There are no provider-specific URL parsers or endpoint tables.

## Document boundary

- SwiftUI owns the window, toolbar, and temporary editing sheets.
- One long-lived `NSTextView` using TextKit 2 owns native editing behavior, hosted through `NSViewRepresentable`.
- `EditorSession` accepts completed native changes into the canonical `NoteDocument` value and writes it atomically. It never replaces the whole attributed string on a keystroke.
- `NoteDocument` version 2 contains portable text runs with marks and paragraph/list semantics, language-tagged code, and typed components with stable UUIDs. No view objects or RTFD are written in new notes.
- `NSTextAttachmentViewProvider` hosts SwiftUI component views. View recreation does not own or mutate source data.
- Component edits replace the current attachment found by UUID, through the native `shouldChangeText` / storage mutation / `didChangeText` undo bracket. Pasted components receive new IDs.

This is an adapter seam, not a CRDT integration. There are no collaborative transactions or remote patches. A production canonical block/CRDT engine would replace the snapshot model and receive granular native transactions at this boundary.

## Persistence and scope

The app autosaves to `~/Library/Application Support/Rawkode Native Rich Editor/note.native-note`, independently of Enchiridion. **File → Save As** writes a portable JSON note; **Open** opens one. A failed load leaves the original file intact. Set `NATIVE_EDITOR_DATA_DIR` when launching a test instance to isolate its autosave.

The spike supports only the shared version 2 format. Other versions are rejected without changing the file. Unsupported attachments, tables, and unsupported visual formatting fail explicitly instead of being silently flattened. The shared fixture is in `Tests/Fixtures`; the schema is documented in [portable-format.md](docs/portable-format.md).

Spike limits: one note/window; synchronous full-note serialization suitable for small notes; no CRDT, live native/web synchronization, syntax highlighting, block dragging, fuzzy slash-menu search, or Excalidraw file compatibility. Lists support six nesting levels; Backspace-to-outdent is not implemented. The canvas is a fixed 900×420 vector surface. Direct-video codecs and publisher embedding restrictions can prevent playback; a discovered player is not a playback guarantee. Metadata parsing covers common HTML tags and iframe-based oEmbed, not all HTML or script-based embeds. Video position is transient when TextKit recycles views. D2 runs as a local process, not in an OS security sandbox; use trusted diagram source and notes.

## Verify

```sh
swift test
./script/build_and_run.sh --verify
# Optional network check: decode frames and advance the reported Kueue HLS stream
RUN_MEDIA_SMOKE=1 swift test --filter RemotePlaybackSmokeTests
```

Tests cover list continuation/exit, numbering, nesting, task persistence, native formatting and undo/redo, fence parsing (including Unicode, CRLF, incomplete/longer fences), mixed rich-text/code/component persistence, TextKit 2 preservation, and native player construction/teardown. The network smoke test is opt-in. A compiler/test pass does not establish interactive rendering or arbitrary-provider playback; those require a live app check.

Architecture references: [Apple view-based text attachments](https://developer.apple.com/documentation/appkit/nstextattachmentviewprovider), [TextKit 2](https://developer.apple.com/videos/play/wwdc2022/10090/), [oEmbed discovery](https://oembed.com/#section4), [Open Graph](https://ogp.me/), [embedded player identity in WebKit](https://developers.google.com/youtube/terms/required-minimum-functionality#embedded-player-api-client-identity).
