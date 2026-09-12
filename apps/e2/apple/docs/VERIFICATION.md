# Verification record — 12 September 2026

This is local development evidence, not release approval. Product and QA
criteria are in PRODUCT.md and QA.md. Builds use Xcode 27.0 (27A5209h) and
minimum deployment targets of iOS/iPadOS 26, macOS 26, and watchOS 26. No
production deployment or App Store/TestFlight submission occurred.

The following baseline predates the dedicated WebView editor. See
[editor qualification](EDITOR-QUALIFICATION.md) for the current iPhone layout,
interaction checks, screenshots, and deployment blocker.

## Executed

- 18 core Swift tests passed: atomic vault persistence,
  corruption/future-version retention, immutable capture deduplication,
  concurrent incoming-spool writers and replay, native/server document
  compatibility, calendar overlap and both DST transitions.
- macOS app built and launched as an ad-hoc signed .app bundle. Native controls,
  sidebar navigation, capture sheet and saving were exercised through
  accessibility.
- iPhone 17 Pro / iOS 26.5: capture, whitespace rejection, empty launch and
  immediate daybook relaunch persistence passed. Expanded context journeys
  recorded below.
- iPad Pro 13-inch M5 / iPadOS 26.5: the same four persistence/capture journeys
  passed.
- Watch Series 11 46mm / watchOS 26.2: app installed and launched; native system
  keyboard input and capture submission exercised. This is not dictation or
  paired device transport evidence.
- iPhone calendar, people detail and repository/type picker exercised with
  explicit sample data; no sample data is shown by default or sent to an
  account.
- All declared native targets compile, including embedded Watch and WidgetKit.
- Repository deno task verify passed: format, lint, TypeScript, Astro/Vue checks
  and the full registered test suite, including capture-feed owner/prefix
  isolation.
- Worker and website builds passed. Local website runtime passed three
  consecutive runs, including native capture discovery and cross-owner
  isolation. Two earlier fixture forwarding attempts failed before assertions;
  their original nested cause was unavailable. The fixture now retains nested
  error diagnostics.
- Independent review found and fixed mismatched upload/import envelopes, an
  account-change race across preflight/write, and calendar context date leakage.
  The shared capture format was also checked through the real server parser.

## Design and platform boundaries

Native SwiftUI navigation, sidebars, tab bars, sheets, pickers and toolbars own
the Liquid Glass layer. Primary capture/save controls use glassProminent. iOS
capture uses the native source-to-sheet zoom transition.
Reading/writing/calendar content uses Rosé Pine without putting glass on every
row. Watch uses native navigation and input, and gives success haptics only
after durable save. Widgets use their host's system presentation. These choices
follow
[Apple's Liquid Glass guidance](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass).

Screenshots are actual native runtime frames, not mockups. Labelled sample
context is solely a QA fixture. The Mac locked during visual QA; it could not be
unlocked by the UI tool, so a readable final Mac screenshot remains pending user
unlock.

## Not yet qualified

- Real provider sign-in, expired sessions, live account switching, cloud capture
  round trips and a production deployment of the capture-feed extension.
- Shared rich documents, native Supertags/mentions and daily-note
  synchronization.
- Physical Watch delivery while disconnected/backgrounded, Siri/dictation,
  interruption handling, and receipt continuity across paired devices.
- Widget installation, locked-device privacy, CarPlay rendering and voice use.
  There is no custom CarPlay template entitlement or approved category claim.
- Full VoiceOver, large-type and contrast sweeps on every device, real-device
  performance/energy measurements, and multiple-window editing qualification.
- Distribution signing, app icon assets, privacy manifest/store metadata and
  TestFlight/App Store review. An Apple Design Award is a quality ambition; this
  development build does not establish that standard.

The PR remains draft. These gaps are release gates, not hidden fallback
behavior.

Secondary text colors are explicitly chosen for content readability: Dawn
#6f6886 on #fffaf3 computes to 5.05:1; Dark #aaa5bd on #1f1d2e computes to
6.93:1. These calculations do not replace a complete rendered accessibility
audit.

UI result bundles for this qualification are
/tmp/apsides-phone-liquid-glass-tests.xcresult (seven journeys passed; a
settings-control selector needed correction),
/tmp/apsides-phone-palette-tests.xcresult (corrected theme journey passed), and
/tmp/apsides-ipad-liquid-glass-tests.xcresult (all eight passed). Final contrast
screenshots use /tmp/apsides-final-screenshots.xcresult. Build products live
under /tmp/apsides-apple-build and /tmp/apsides-ios-build. These temporary
artifacts are machine-local; committed screenshots preserve visual evidence.
