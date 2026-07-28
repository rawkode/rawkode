# Enchiridion

A local-first, native SwiftUI knowledge journal for macOS and iOS.

## Architecture

- `EnchiridionCore`: Automerge page documents, GRDB/SQLite local authority, EventKit and direct Google Calendar adapters, and private CloudKit sync.
- `SharedUI`: native navigation around a narrowly bridged `WKWebView` editor.
- `WebEditor`: ProseMirror bound directly to each Automerge document, with links, page references, bookmark cards, YouTube embeds, slash commands, and an IndexedDB recovery journal.
- `Sources/macOS` and `Sources/iOS`: platform-native window, sidebar, tab, navigation, settings, and command surfaces.

Edits are journaled in the editor before Swift receives them, committed atomically to SQLite, and only then acknowledged. CloudKit is a transport; the local database remains authoritative offline.

## Supertags

Supertags turn ordinary pages into typed objects while keeping the page editable and linkable:

- Use **Add Supertag** in a page toolbar to tag the current page as a Person, Organization, Project, Task, Place, or custom type.
- Select text in the editor and choose **Supertag** to find a page of that type or create one while preserving the selected text as the visible reference.
- Use **Properties** to edit typed fields and resolve any concurrent-value conflicts explicitly.
- Use **Library → New Supertag** to define a custom type, fields, select options, and reference constraints.
- Open a Supertag collection for every page of one type, or use the built-in People, Projects, Tasks, and Work Calendar live views.

Calendar attendees are imported as deterministic Person pages. Repeated refreshes reuse the same Person by normalized email and never overwrite an existing title.

## Requirements

- Xcode 16 or newer
- XcodeGen 2.46 or newer
- Bun 1.2 or newer for rebuilding the bundled editor

## Build and test

```sh
cd WebEditor
bun install
bun run check
bun run build
cd ..

swift test
xcodegen generate
xcodebuild -project Enchiridion.xcodeproj -scheme "Enchiridion macOS" -destination "platform=macOS" build
xcodebuild -project Enchiridion.xcodeproj -scheme "Enchiridion iOS" -destination "generic/platform=iOS Simulator" build
```

Use the Codex `Run` action or `./script/build_and_run.sh` to build and launch the macOS app.

## Service configuration

CloudKit uses the private container `iCloud.dev.rawkode.enchiridion`. Add that container to the Apple Developer team used for signing.

Google Calendar is serverless: the app uses OAuth 2.0 Authorization Code + PKCE, stores the refresh token in Keychain, and calls the read-only Calendar REST API directly. Create an iOS/macOS OAuth client in Google Cloud, then replace these placeholder values in `project.yml` before regenerating the project:

- `GoogleOAuthClientID`
- `GoogleOAuthRedirectScheme`
- the matching `CFBundleURLSchemes` entry

No OAuth client secret belongs in the app.
