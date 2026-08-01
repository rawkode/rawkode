# Enchiridion

A local-first, native SwiftUI knowledge journal for macOS and iOS.

## Architecture

- `EnchiridionCore`: Automerge page documents, GRDB/SQLite local authority, EventKit and direct Google Calendar adapters, and private CloudKit sync.
- `SharedUI`: native SwiftUI navigation and rich-text editing with `TextEditor`, `AttributedString`, and Automerge inline marks.
- `Sources/macOS` and `Sources/iOS`: platform-native window, sidebar, tab, navigation, settings, and command surfaces.

Native edits are committed atomically to SQLite as Automerge text and inline marks. CloudKit is a transport; the local database remains authoritative offline.

## Knowledge graph

Pages are vault-local graph nodes. Supertags provide multiple-inheritance types and typed facts;
canonical relationships provide one-to-one, one-to-many, many-to-one, and many-to-many edges with
inverse backlinks. The visual query builder compiles to bounded, read-only SQLite over stable
`graph_*` views, and advanced users can run SQL against the same allowlisted surface.

See [Knowledge graph data model](Documentation/GraphDataModel.md) for the semantic contract, vault
and sync boundaries, and the SQL-versus-Cypher decision.

## Supertags

Supertags turn ordinary pages into typed objects while keeping the page editable and linkable:

- Use **Add Supertag** in a page toolbar to tag the current page as a Person, Organization, Project, Task, Place, or custom type.
- Select **Insert Page Reference** in the editor formatting bar to insert a reference at the cursor or replace selected text.
- Use **Properties** to edit typed fields and resolve any concurrent-value conflicts explicitly.
- Use **Library → New Supertag** to define a custom type, fields, select options, and reference constraints.
- Open a Supertag collection for every page of one type, or use the built-in People, Projects, Tasks, and Work Calendar live views.

Calendar attendees are imported as deterministic Person pages. Repeated refreshes reuse the same Person by normalized email and never overwrite an existing title.

## Requirements

- Xcode 27 or newer
- XcodeGen 2.46 or newer

## Build and test

```sh
swift test
xcodegen generate
xcodebuild -project Enchiridion.xcodeproj -scheme "Enchiridion macOS" -destination "platform=macOS" build
xcodebuild -project Enchiridion.xcodeproj -scheme "Enchiridion iOS" -destination "generic/platform=iOS Simulator" build
```

Use the Codex `Run` action or `./script/build_and_run.sh` to build and launch the macOS app.

## iCloud and CloudKit setup

Enchiridion syncs the local SQLite authority through the private CloudKit container `iCloud.dev.rawkode.enchiridion`. Both app targets use the explicit App ID `dev.rawkode.enchiridion` and the P4X-639 Ltd development team (`6KXCJGJ45W`). `CKSyncEngine` requires both CloudKit and Remote Notifications; the iOS target also enables the remote-notification background mode.

One-time Apple Developer setup:

1. Register or open the explicit App ID `dev.rawkode.enchiridion` under team `6KXCJGJ45W`.
2. Enable **iCloud**, choose **Include CloudKit support**, and assign `iCloud.dev.rawkode.enchiridion` to the App ID. An iCloud container cannot be renamed later, so do not substitute the older `iCloud.com.rawkode.enchiridion` identifier.
3. Enable **Push Notifications**. For the iOS target, also keep the approved **Voice-based conversational app** capability enabled.
4. Regenerate the iOS App Development and Mac App Development profiles after changing any capability. Each profile must include the iCloud container, the applicable APNs entitlement, and (for iOS) the approved CarPlay entitlement.
5. In Xcode **Settings → Accounts**, sign in to the P4X-639 Ltd team, create or import an Apple Development certificate whose private key is present in Keychain, and download the refreshed profiles.
6. Sign in to the same iCloud account on the signed test Mac and a physical iPhone, then enable iCloud Drive on both. Simulator remains useful for builds, UI checks, and manually triggered iCloud fetches, but it does not receive the notifications that trigger automatic synchronization and is not a CKSyncEngine push-acceptance device.

The launcher now attempts a signed build by default so the resulting app can sync:

```sh
./script/build_and_run.sh --verify
```

If signing is intentionally unavailable, the explicit local-only escape hatch remains:

```sh
ENCHIRIDION_LOCAL_ONLY=1 ./script/build_and_run.sh --verify
```

That fallback is unsigned and cannot exercise iCloud. It must not be used for sync acceptance.

To refresh automatic signing and build both platform products directly:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project Enchiridion.xcodeproj -scheme "Enchiridion macOS" \
  -destination "platform=macOS" -allowProvisioningUpdates build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project Enchiridion.xcodeproj -scheme "Enchiridion iOS" \
  -destination "generic/platform=iOS" -allowProvisioningUpdates build
```

After a signed build, inspect the app signature rather than trusting only the source entitlements:

```sh
codesign -dvvv --entitlements :- /path/to/Enchiridion.app
security find-identity -p codesigning -v
```

The final signature must contain `iCloud.dev.rawkode.enchiridion`, `CloudKit`, and the platform APNs entitlement (`aps-environment` on iOS or `com.apple.developer.aps-environment` on macOS). Development profiles select the development CloudKit/APNs environments; distribution profiles select production.

Run the signed app once against the development environment, then verify the container, private custom zone, record types, and records in CloudKit Console. Before TestFlight or App Store distribution, deploy the development schema to production in CloudKit Console. Final acceptance requires a signed Mac and a signed physical iPhone logged into the same iCloud account: edit on one device and confirm the change arrives automatically on the other, then repeat in the opposite direction and after an offline edit. An iOS Simulator build does not satisfy this acceptance check.

## Google Calendar configuration

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
