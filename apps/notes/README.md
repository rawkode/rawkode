# Notes

Universal local-first notes app for iOS, iPadOS, and macOS.

Daily notes are the primary document type. The app creates today on launch, stores one daily note per local date, and keeps note content as Tiptap JSON in SQLite rather than Markdown files.

## Architecture

- SwiftUI owns the native shell, daily-note navigation, and persistence.
- SQLite stores `documents`, `entities`, `supertags`, and entity-to-supertag links.
- WKWebView hosts the bundled React/Tiptap editor.
- Tiptap persists rich document JSON, SQLite-backed entity references, and inline Excalidraw sketches.
- The generated web editor bundle is ignored by version control. Xcode builds it from `WebEditor/` before copying app resources.

Query-backed dynamic views are a roadmap feature. They are intentionally not exposed until they are wired to local SQLite behavior.

## Project

The Xcode project is generated from `project.yml` with XcodeGen:

```sh
xcodegen generate
```

Install the web editor dependencies once:

```sh
cd WebEditor
~/.bun/bin/bun install
```

## Build

```sh
xcodebuild -project Notes.xcodeproj -scheme "Notes iOS" -destination "generic/platform=iOS Simulator" CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Notes.xcodeproj -scheme "Notes macOS" -destination "platform=macOS" -derivedDataPath DerivedData/Notes-macOS CODE_SIGNING_ALLOWED=NO build
```
