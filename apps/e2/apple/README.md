# Apsides for Apple

A native SwiftUI notebook and capture app for Mac, iPhone, iPad, and Apple
Watch, with a next-event WidgetKit extension and a capture App Intent. This is a
working local-development build, not a released or fully qualified universal
product.

Start with [the product contract](docs/PRODUCT.md),
[architecture](docs/ARCHITECTURE.md), and [QA gates](docs/QA.md).
[Verification](docs/VERIFICATION.md) records what actually ran.

## Run

Minimum platforms: iOS/iPadOS 26, macOS 26, and watchOS 26. Requires Xcode 26 or
newer, its Apple platform SDKs, and XcodeGen. The portable core also builds with
Swift Package Manager. No third-party Swift dependencies are used.

```sh
# From apps/e2
apple/script/build_and_run.sh --verify

# Generate/open native targets
xcodegen generate --spec apple/project.yml
open apple/Apsides.xcodeproj

# Core persistence and transport contracts
swift test --package-path apple
```

Select ApsidesIOS for iPhone/iPad (embeds Watch and widget), ApsidesWatch for
Watch, or ApsidesMac. Simulator builds use CODE_SIGNING_ALLOWED=NO. Physical
devices need your development team, provisioning, and the
group.dev.rawkode.apsides app group on the iOS app and widget. XcodeGen's
project.yml is the project source of truth.

The Mac Run script supports --logs, --debug, and --telemetry. Use
APSIDES_BUILD_DIR to put build output elsewhere. No telemetry collection is
implemented.

## What works locally

- A continuous, plain-text daily notebook with atomic local persistence.
- Quick captures retained across close/relaunch, then deliberately added to
  Today.
- Mac sidebar and keyboard commands; iPhone tabs; adaptive iPad split
  navigation.
- Native Liquid Glass navigation, toolbars, tabs, capture transitions and
  primary actions; Rosé Pine Dawn and Dark content.
- Watch capture saved locally before queuing transfer to iPhone; durable receipt
  protocol distinguishes saved on Watch from received on iPhone.
- An App Intent writes immutable captures to a process-safe incoming spool.
- Native context views: overlap-aware day calendar and agenda list, searchable
  people with contact details, repositories and filtered activity timelines.
  Connected data requires a verified account; --demo is an explicitly labelled
  sample preview and disables integrations.
- Unique native captures can be sent through the existing authenticated API and
  fetched by the same account. Existing rich web documents are never flattened.

Local notebook storage is Application Support/Apsides/notebook.json. Unreadable
or future-version files are preserved and opened read-only, with a recovery
message. Sign-out removes downloaded account context and captures;
device-created notes remain local. The App Intent uses Application
Support/Apsides/Incoming.

## Boundaries still to ship

Daily notes do not yet sync with the web editor. Native Supertags, mentions, and
rich content are planned work. The current sign-in sheet depends on an identity
provider that permits embedded sign-in; Google requires the planned
external-browser authorization flow. No live sign-in or cloud round trip was
qualified in this build.

The CarPlay candidate is the small next-event widget, not a custom template app.
CarPlay eligibility/runtime, voice interaction, paired Watch background
delivery, real-device signing, accessibility sweeps, and distribution remain
release gates. The PR must stay draft until those gates and document continuity
are satisfied.

## iPhone editor update (12 September)

Today now hosts the deployed Apsides web editor in WKWebView, with the shared
website cookie store. Slash commands, mentions, and document saving are provided
by the deployed website. Opening it requires network access and a website sign-in;
this is not a bundled offline editor. Wait for the web editor's saved status before
closing the app. Native quick capture remains available offline.

Earlier local daybooks remain under **Device notes**. **Add to device notes** in
Captures still targets those local notes; it does not insert into the web document.
Native navigation and sign-out consult the web editor's unsaved-change guard.
The guard and real-phone keyboard interactions still require runtime qualification.
See [CarPlay test](docs/CARPLAY-TEST.md) for the calendar widget setup and limits.

## Physical device qualification

Before claiming the iPhone package can install on its paired Watch, run
`bash apple/script/build_for_devices.sh "$IPHONE_UDID" "$WATCH_UDID"` with both
physical UDIDs. A generic signed build can reuse a profile that excludes the Watch.
The [installation diagnosis](docs/DEVICE-INSTALL-DIAGNOSIS.md) records the confirmed
profile defect in the first phone build and the remaining provisioning repair.
