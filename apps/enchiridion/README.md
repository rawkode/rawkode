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

## CarPlay voice assistant signing

The iPhone app keeps its iOS 18 deployment target. Its read-only CarPlay voice assistant is availability-gated to iOS 26.4 or later, and `FoundationModels.framework` is weak-linked so the phone app remains launchable on earlier supported releases.

CarPlay voice-based conversation is a managed capability. Before testing on a device or distributing the app, verify that Apple has enabled **Voice-based conversational app** for the exact explicit App ID `dev.rawkode.enchiridion`:

1. In Certificates, Identifiers & Profiles, open **Identifiers**, select `dev.rawkode.enchiridion`, and confirm the approved CarPlay capability is enabled.
2. Regenerate every profile used by this target after enabling the capability. At minimum, create or refresh an **iOS App Development** profile and the applicable distribution profile (**App Store Connect**, **Ad Hoc**, or both). Select the exact App ID, current certificates, and devices where the profile type requires them, then download and install each profile.
3. In Xcode, open **Settings → Accounts**, select the team, and download profiles. Alternatively, let Xcode refresh automatic profiles with a signed device build using `-allowProvisioningUpdates`.
4. Do not clear `CODE_SIGN_ENTITLEMENTS` for CarPlay testing. A local-only build that omits entitlements can exercise the phone UI, but it cannot appear in CarPlay.

After building or archiving, verify both the embedded profile and the final code signature. Replace the example path with the signed device `.app` (for an archive, use `Enchiridion.xcarchive/Products/Applications/Enchiridion.app`):

```sh
APP_PATH=/path/to/Enchiridion.app

security cms -D -i "$APP_PATH/embedded.mobileprovision" > /tmp/enchiridion-profile.plist
/usr/libexec/PlistBuddy \
  -c 'Print :Entitlements:com.apple.developer.carplay-voice-based-conversation' \
  /tmp/enchiridion-profile.plist

codesign -d --entitlements - --xml "$APP_PATH" \
  > /tmp/enchiridion-signed-entitlements.plist
/usr/libexec/PlistBuddy \
  -c 'Print :com.apple.developer.carplay-voice-based-conversation' \
  /tmp/enchiridion-signed-entitlements.plist

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
```

Both `PlistBuddy` commands must print `true`. If the profile check fails, regenerate the profile after enabling the capability. If only the signed-app check fails, confirm the `EnchiridionMobile` target uses `Configuration/EnchiridionMobile.entitlements`, then rebuild without overriding `CODE_SIGN_ENTITLEMENTS`.
