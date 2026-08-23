# Athenaeum watchOS quick-capture — build/run notes

Scope: `native/watchOS/AthenaeumWatchUI` (the logic+UI SPM package) and `native/watchOS/App` (the
thin xcodegen Xcode project shell), following the same split `native/AthenaeumApp` +
`native/iOS`/`native/macOS` already use.

## What builds and runs (verified for real, not assumed)

- `swift build` / `swift test` for `AthenaeumWatchUI` on the host Mac — 3 offline unit tests
  (`QuickCaptureClientTests`, pure `truncatedTitle` logic) + 3 live integration tests
  (`QuickCaptureClientLiveTests`, gated on `ATHENAEUM_TEST_BACKEND_URL`) all pass.
- `xcodebuild build -scheme AthenaeumWatchUI -destination 'generic/platform=watchOS'` —
  **BUILD SUCCEEDED**, both `arm64` and `arm64_32` slices (real watchOS device architectures, not
  just the Simulator).
- `xcodebuild build -project AthenaeumWatch.xcodeproj -scheme AthenaeumWatch -destination
  'platform=watchOS Simulator,id=...'` — **BUILD SUCCEEDED**.
- Installed and launched on a real watchOS Simulator (`Apple Watch SE 3 (44mm)`, watchOS 26.2) via
  `simctl install`/`simctl launch` — the process actually starts (`simctl spawn ... launchctl
  list` shows the running PID) and the `QuickCaptureView` genuinely renders (title, `TextField`
  with placeholder, disabled `Save` button on an empty draft) — see `quickcapture-simulator.png`
  in this directory, a real screenshot via `simctl io screenshot`, not a mockup.
- The full capture round trip (`QuickCaptureClient.capture(text:)` → `createNode` + `assignTag`
  (`BaseTagIds.task`) + `addFact` (`quick-capture-text`)) was exercised against a real local
  `wrangler dev` backend by `QuickCaptureClientLiveTests`, including independent server-side
  verification via a second `WorkspaceRPCClient` and a `syncFeed` check — this is the same logic
  `QuickCaptureViewModel.submit()` calls, so the on-simulator UI and the tested logic are the same
  code path, not a parallel demo path.

## Not attempted / explicitly out of scope

- **No real device run, no TestFlight/App Store, no code signing beyond "Sign to Run Locally".**
  Per this task's hard constraints — a paid Apple Developer account is required for any of that
  and genuinely isn't available here.
- **No actual iPhone↔Watch pairing exercised.** `WKCompanionAppBundleIdentifier` is set (required
  for `simctl install` to accept a standalone-format watch app at all — see `project.yml`'s doc
  comment for the exact two install failures that forced this), but no pairing handshake, Watch
  Connectivity session, or companion-app install/launch was tested — this app was installed and
  launched directly on a watch-only Simulator, independent of `native/iOS`'s `AthenaeumiOS`.
- **No UI-automation-driven typed-text-then-tap-Save simulator test.** The screenshot confirms the
  view renders and the Save button correctly starts disabled; the actual capture *logic* behind
  that button is what `QuickCaptureClientLiveTests` exercises directly (same actor, same method).
  Driving the Simulator's keyboard/dictation sheet via UI scripting was judged not worth the
  fragility for what it would additionally prove, given the logic itself is already tested.
- **No offline retry queue.** A capture that fails its network round trip throws through to
  `QuickCaptureViewModel.state = .error(...)`, leaving the draft text in place so nothing dictated
  is lost — but there's no local persistence/automatic-retry-when-reachable behavior. See
  `QuickCaptureClient.swift`'s doc comment for why (no on-device SQLite authority exists in this
  package, unlike `AthenaeumCore`'s `LocalWorkspaceStore` on macOS/iOS).

## Honest watchOS-specific constraints vs. the macOS/iOS app

- **No Automerge CRDT on-device at all — confirmed a hard library gap, not a design choice made
  for this stage.** The Decisions stage (`native/docs/decisions.md`) already proved
  `automerge-swift` 0.7.2 ships no `watchos` slice in its binary xcframework and fails a real
  `xcodebuild -destination 'generic/platform=watchOS'` build. This package's `Package.swift`
  structurally enforces that boundary: it depends only on `AthenaeumDomain`/`AthenaeumRPC`, never
  `AthenaeumCore`/`Automerge`, so an accidental future `import AthenaeumCore` here would be a
  compile error, not a silent watchOS build break discovered later.
- **No `TextEditor` on watchOS.** SwiftUI's multi-line rich `TextEditor` (used by
  `DailyNoteView` on macOS/iOS) doesn't exist on watchOS at all — this is exactly why the quick
  capture screen uses a single-line `TextField`, which is also the right UX for the platform
  (tapping it opens the system dictation/Scribble/QWERTY input sheet automatically — a real
  platform affordance, not something this app builds itself).
- **No WKWebView on watchOS either**, for what it's worth — reinforcing (from a different angle
  than the CRDT-library gap) why any future rich-text approach on this platform would need to be
  a genuinely native SwiftUI construct, not a WebKit-hosted one; watchOS has neither option today.
- **Single-target app, not the legacy WatchKit-extension-process model.** Since watchOS 7,
  `application`-type watch apps (what this target is — see `project.yml`'s doc comment on why
  `application`, not xcodegen's `.watchapp2`) run as one process, not a host "WatchKit App" stub
  plus separate "WatchKit Extension" process — so there's no separate extension lifecycle to
  reason about here, unlike watchOS 1–6. `WKRunsIndependentlyOfCompanionApp` +
  `SUPPORTS_RUNNING_WITHOUT_IOS_APP_INSTALL` make it launchable with no phone present at all,
  which is exactly the standalone quick-capture use case.
- **No local storage authority means no offline queue (see above)** — a real device with a flaky
  Bluetooth/WiFi connection to the paired phone (or no WiFi at all, if not on the always-on-LTE/
  WiFi-standalone models) would lose an unsynced capture on a network failure, unlike the
  macOS/iOS app's durable-before-sync `LocalWorkspaceStore` write. This is the plan's own accepted
  tradeoff for the watchOS fallback path, not an oversight — but worth restating plainly: watchOS
  quick-capture is "best-effort while connected," not "durable regardless of connectivity."
- **Backend reachability from a real watch is a real, unsolved gap**, separate from anything
  above: `WatchWorkspaceConfiguration.defaultBackendURL` is `http://127.0.0.1:8787`, which only
  resolves on a paired Simulator/host-network setup, not a real watch talking over Bluetooth/WiFi
  to a phone or a real deployed backend URL. This stage never attempted real device networking —
  flagging it explicitly so a later stage doesn't assume it's already solved.
- **Memory/CPU headroom was not empirically measured** (no real-device profiling was possible —
  see "not attempted" above). watchOS apps run under materially tighter memory ceilings than
  iOS/macOS, especially for background/extended-runtime work; this stage's code footprint is
  intentionally tiny (no CRDT library linked, no local database, a handful of small actors) which
  should help, but that's an informed expectation, not a measured fact.
