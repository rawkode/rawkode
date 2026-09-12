# Enchiridion via Xcode Cloud

The checked-in `Apsides.xcodeproj` is the cloud build input. Its internal target
names remain stable; the installed app is Enchiridion. The local Swift package
has no external dependencies. Cloud builds need no Homebrew, XcodeGen, Deno,
1Password, local signing certificate, or device registration. Regenerate the
project locally after editing `project.yml` and commit both files.

## First workflow

1. In Apple Developer, register `rawkode.academy.enchiridion`,
   `rawkode.academy.enchiridion.watchkitapp`, and
   `rawkode.academy.enchiridion.widget` under team `6KXCJGJ45W`. Enable App
   Groups on the iOS and widget IDs and associate
   `group.rawkode.academy.enchiridion`.
2. Create the Enchiridion iOS app record with that iOS bundle ID in App Store
   Connect. The Watch app is embedded in the iOS app, not a separate app record.
3. Open `apps/e2/apple/Apsides.xcodeproj` in Xcode. Start Xcode Cloud
   onboarding, choose the iOS product and authorize repository access to
   `rawkode/rawkode`.
4. Create an **Enchiridion Internal TestFlight** workflow using the shared
   `ApsidesIOS` scheme. Select an available Xcode version supporting all APIs in
   this project (locally validated with Xcode 27; deployment targets remain 26).
   Use an Archive action for iOS, Release configuration, and TestFlight internal
   testing distribution. Enable automatic signing. Start with a manual build of
   the reviewed release branch; add a branch-change condition after it succeeds.
5. Add a TestFlight internal testing group containing the intended App Store
   Connect users, enable automatic distribution, and select it in the workflow's
   TestFlight post-action. Complete any required beta information and export
   compliance questions in App Store Connect.
6. Start the build. Confirm archive, signing, upload, processing, and tester
   availability separately. A successful local build proves none of the later
   stages. After onboarding, manage or start builds in App Store Connect from
   any device with an authorized browser session.

Xcode Cloud supplies incrementing distribution build numbers. Keep the marketing
version in `project.yml`; do not write a competing timestamp/version script. The
shared scheme archives Release. No bootstrap script is required because the
project and all Swift dependencies are already in the repository.

## Identity and installation

The new bundle ID installs alongside the old Apsides development app. Its native
sandbox and App Group are new: existing on-device notes and captures do not move
automatically. Connected server notes remain on the existing service. Keep the
old app installed to retain access to its local data.

The Mac product uses `rawkode.academy.enchiridion.mac`; it needs its own App
Store Connect product/workflow and distribution qualification. The first
workflow above targets iPhone, iPad, and the embedded Watch app.

## Privacy and release boundaries

`Configuration/PrivacyInfo.xcprivacy` declares UserDefaults reason `CA92.1` for
the iOS and Mac app's own appearance preference. The source audit found no
direct required-reason file timestamp, disk space, boot time, or keyboard
enumeration calls. Watch and widget do not use UserDefaults. The manifest
intentionally does not claim that connected account, note, calendar, or people
data is uncollected; App Store privacy answers require a separate audit of the
server and web editor.

Native networking uses system URLSession/WebKit HTTPS. No custom encryption was
found in the native sources. Export compliance still requires the account
holder's accurate answers covering the shipped product; no exemption declaration
has been guessed into the Info.plist.

The editor loads the production `/apple/editor` route. Verify that route is
deployed before inviting testers. The Apple cloud pipeline does not deploy the
website. CarPlay currently exposes a widget, not a launcher app. Cloud
distribution avoids the development Watch UDID profile problem but still needs
real Watch installation and interaction qualification.

## Apple references

- [First workflow](https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow)
- [TestFlight distribution](https://developer.apple.com/documentation/xcode/distributing-your-xcode-cloud-builds-through-testflight)
- [Cloud build numbers](https://developer.apple.com/documentation/xcode/setting-the-next-build-number-for-xcode-cloud-builds/)
- [Custom scripts](https://developer.apple.com/documentation/xcode/writing-custom-build-scripts)
- [Required-reason API declarations](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)

## Local packaging evidence (12 September 2026)

The unsigned Release iOS archive succeeded with Xcode 27, including embedded
Watch and widget products. Bundle IDs, display names and Watch companion ID were
inspected in the archive. The Watch catalog uses a universal watchOS icon;
`assetutil` confirmed its runtime `watch` rendition (a marketing-only entry did
not provide one). This is packaging evidence, not distribution signing or App
Store Connect validation. Seven device-profile checker tests, shell syntax
checks and privacy manifest plist validation passed.

## Current delivery evidence

On 12 September 2026, an unsigned Release archive completed with the Enchiridion
app, embedded Watch app, and widget at `/tmp/Enchiridion-cloud.xcarchive`.
Identifiers and icon renditions were inspected, including the Watch runtime
icon. Seven device-package verifier tests passed. This is build evidence, not a
signed upload or a cloud run.

Xcode Cloud repository authorization completed remotely by the user. Xcode
confirmed `rawkode/rawkode Connected`, then created the cloud product and its
Default build workflow. The initial start was blocked by an updated Apple
Developer agreement; after the account holder accepted it, Build 1 ran on
Apple's servers for `spike/native-web-rich-editor` at `ba0390c1` using Xcode
26.6 / Swift 6.3.3. Although the batch log ends at NativeSession.swift, the
crash stack identifies IR generation for LocalDaybookView.swift and an isolated
String callback reabstraction thunk. The local daybook Binding setter now calls
`store.setDayText(value)` through an explicit closure instead of passing the
actor-isolated method reference directly. This preserves synchronous save
behavior and avoids that method-reference conversion. The cloud compiler must
confirm the workaround; local Xcode 27 uses Swift 6.4. The downloaded logs are
at `/tmp/enchiridion-cloud-build1-logs`.

Cloud product registration is recorded in the Xcode-generated shared manifest.
The current Default workflow is build-only, not TestFlight distribution.
Distribution onboarding confirmed name Enchiridion and bundle ID
`rawkode.academy.enchiridion`, but Apple reports an existing app in this team
already reserves the Enchiridion name. The user has been asked to rename that
prototype record, preserving it. No new App Store app record, signed archive,
TestFlight upload, or tester availability has been confirmed yet.

## Icon and screenshots

The production icon was generated with the built-in image generation tool, then
resized into the Apple asset catalogs using `sips`. The source artwork is
opaque; iOS/watch share `Resources/Assets.xcassets/AppIcon.appiconset`, and Mac
has its required size variants in
`Resources/MacAssets.xcassets/AppIcon.appiconset`.

Prompt: “A production Apple app icon for Enchiridion: one opaque full-bleed
square, a sculptural open pocket-book with folded ivory pages suggesting an E, a
muted rose inner leaf and pale teal edge on deep Rosé Pine ink. Bold centered
silhouette, premium editorial craft, restrained depth, no text, badge,
watermark, device mockup, transparency, or rounded outer mask.”

Actual editor screenshots are in
[editor qualification](EDITOR-QUALIFICATION.md). They show the shared editor
layout; they predate the bundle/name change. They are QA evidence and have not
been submitted as App Store marketing screenshots.

## Distribution registration update

After the user renamed the older prototype record, Xcode confirmed **Enchiridion
is Set Up for Distribution** for `rawkode.academy.enchiridion` and generated an
internal TestFlight distribution workflow. The release branch is
`spike/native-web-rich-editor`.

Cloud Build 2 passed the earlier compiler crash but stopped on Swift 6.3.3's
type-checking limit in AgendaView's event button expression. The event button is
now a separate view with explicit CGFloat layout values; the formulas and
selection behavior are preserved. Local Debug compilation passed. The next cloud
run must verify this change before signing/upload can be claimed.
