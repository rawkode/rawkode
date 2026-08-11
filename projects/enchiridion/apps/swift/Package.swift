// swift-tools-version: 6.2
//
// P0 SKELETON (partially superseded — see below). EnchiridionCore,
// EnchiridionSync, EnchiridionBlobs, EnchiridionStore, EnchiridionUI, and
// (this pass) EnchiridionGadgets now have real, compiling Swift sources
// (see their READMEs — still present alongside the sources — for the
// design rationale). EnchiridionSchema and EnchiridionAPI remain
// README-only aside from a one-line Placeholder.swift each — SwiftPM
// refuses to build a package containing an *empty* target even when
// building an unrelated target, so each carries a marker type until its
// own plan phase (see each target's README.md) fills it in for real.
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md.
//
// Swift tools version pinned to 6.2 to match apps/enchiridion/Package.swift
// (the old app), so both packages build under the same toolchain during the
// parallel-operation period.

import PackageDescription

let package = Package(
  name: "EnchiridionCore",
  platforms: [
    .iOS(.v26),
    .macOS(.v26),
    // P6 "watchOS workout capture" task (plan §Platform parity) — added
    // for `EnchiridionWatchKit` below. `.v26` to match this package's
    // iOS/macOS pins (Apple unified OS version numbering across
    // platforms starting with the "26" releases, so watchOS 26 is the
    // same-year release as iOS 26/macOS 26 above, not a mismatched pin).
    .watchOS(.v26),
  ],
  products: [
    .library(name: "EnchiridionCore", targets: ["EnchiridionCore"]),
    .library(name: "EnchiridionSync", targets: ["EnchiridionSync"]),
    .library(name: "EnchiridionBlobs", targets: ["EnchiridionBlobs"]),
    .library(name: "EnchiridionStore", targets: ["EnchiridionStore"]),
    .library(name: "EnchiridionSchema", targets: ["EnchiridionSchema"]),
    .library(name: "EnchiridionAPI", targets: ["EnchiridionAPI"]),
    .library(name: "EnchiridionGadgets", targets: ["EnchiridionGadgets"]),
    .library(name: "EnchiridionUI", targets: ["EnchiridionUI"]),
    // P6 "Widgets" task (plan §Platform parity) — TimelineProvider/View
    // logic shared between the `Enchiridion2iOSWidget` and
    // `Enchiridion2MacWidget` app-extension targets (project.yml), the
    // same "shared SPM library, thin per-platform Xcode target" shape
    // `EnchiridionUI` already established for the main apps (see that
    // product's own targets consuming it). WidgetKit + SwiftUI are both
    // available unmodified on iOS and macOS at this package's deployment
    // targets, so nothing about the widget's actual logic needs to differ
    // per platform — only the `@main WidgetBundle` entry point does (each
    // extension target's own one-file `Sources/iOSWidget`/
    // `Sources/macOSWidget`), mirroring how `Sources/iOS/RootView.swift`/
    // `Sources/macOS/RootView.swift` stay separate, thin, per-platform
    // files on top of shared `EnchiridionUI` logic.
    .library(name: "EnchiridionWidgetKit", targets: ["EnchiridionWidgetKit"]),
    // P6 "Share extensions" task (plan §Platform parity) — capture logic
    // shared between the `Enchiridion2iOSShareExtension`/
    // `Enchiridion2MacShareExtension` app-extension targets (project.yml).
    // Same "shared SPM library, thin per-platform Xcode target" shape as
    // `EnchiridionWidgetKit` above — see `Sources/EnchiridionShareKit/README.md`.
    .library(name: "EnchiridionShareKit", targets: ["EnchiridionShareKit"]),
    // P6 "watchOS workout capture" task (plan §Platform parity) — real
    // HealthKit workout-session capture logic + its CRDT persistence
    // write path for the new `Enchiridion2Watch` app target (project.yml).
    // Same "shared SPM library, thin per-platform Xcode target" shape as
    // `EnchiridionWidgetKit`/`EnchiridionShareKit` above — the watch app's
    // own `Sources/watchOS/` is a one-file `@main App` + root SwiftUI view
    // on top of this. See `Sources/EnchiridionWatchKit/WorkoutCapture.swift`
    // and `WorkoutSessionController.swift` headers for the write path and
    // the HealthKit-availability gating this target needs (this library
    // still builds — and is exercised by `EnchiridionWatchKitTests` below
    // — on macOS, where HealthKit doesn't exist at all, so the
    // HealthKit-specific parts are `#if canImport(HealthKit) && os(watchOS)`
    // gated; only the platform-agnostic capture/persistence logic is
    // unconditional).
    .library(name: "EnchiridionWatchKit", targets: ["EnchiridionWatchKit"]),
    // P7 "Native drawing canvas" task (plan §Core Product UI (P7), track
    // 5) — a new target, not folded into `EnchiridionUI`: this is
    // self-contained, independently-testable drawing-engine work (task
    // brief: "Build this as a self-contained, independently-testable
    // module — do NOT wire it into RootView.swift/app navigation"),
    // deliberately not depended on by `EnchiridionUI` either, so the
    // three sibling P7 tracks touching `EnchiridionUI` files concurrently
    // (day-navigation, kanban, Gmail-triage) never contend with this
    // task's own edits. Same "own target for a self-contained feature
    // area" shape `EnchiridionWatchKit`/`EnchiridionShareKit` already
    // established above.
    .library(name: "EnchiridionCanvas", targets: ["EnchiridionCanvas"]),
  ],
  dependencies: [
    // VERIFIED 2026-08-06 via GitHub API (api.github.com/repos/loro-dev/loro-swift/tags
    // and /releases) directly from this sandbox — network egress to
    // github.com/api.github.com/raw.githubusercontent.com/release-assets.githubusercontent.com
    // is available here, so this is NOT a guess:
    //   - Latest published, non-pre-release tag: 1.13.3 (published
    //     2026-07-21T16:12:34Z, commit 625f3e696fca4be3ae77de8b3404fa6753554f21).
    //   - Confirmed its Package.swift (fetched at that tag) declares
    //     product name "Loro" from library target "Loro" — matches the
    //     `.product(name: "Loro", package: "loro-swift")` reference below.
    //   - Confirmed the release ships a prebuilt `loroFFI.xcframework.zip`
    //     binaryTarget (~124 MB) with a matching checksum in Package.swift,
    //     and that release asset resolves (HTTP 302 -> Azure blob) from
    //     this sandbox. `swift package resolve` was actually run against
    //     this exact pin from this sandbox and succeeded (full 124.6 MB
    //     xcframework download + link, see `Package.resolved`) — this
    //     dependency is proven to resolve, not just plausible.
    //   - Read Sources/Loro/LoroFFI.swift (the generated UniFFI bindings,
    //     18.8k lines) at this tag directly from GitHub to confirm the
    //     LoroDoc/LoroText/LoroMap/VersionVector API surface used by
    //     LoroEngine.swift in EnchiridionSync — see the `// per loro-swift
    //     1.13.3 LoroFFI.swift` comments on each call site there.
    //
    // VERIFIED (was previously flagged here as unconfirmed — now checked
    // for real): this loro-swift 1.13.3 tag's own `loro-swift/Cargo.lock`
    // (the file pinning what actually got compiled into the shipped
    // `loroFFI.xcframework` binary) resolves `loro-ffi`/`loro-internal`/
    // `loro` all at Rust-core version **1.13.7** — note this differs from
    // the 1.13.3 Swift-binding-layer version number above; the binding
    // layer and the core it wraps are versioned independently in the
    // loro-swift repo, only the Cargo.lock tells you the real core pin.
    // `workers/vault/package.json` pins `loro-crdt` to exact `1.13.7` to
    // match (see `loro-storage.ts`'s "VERSION LOCKSTEP" header comment for
    // the full git-commit-level evidence chain — the `loro-dev/loro`
    // monorepo releases its Rust core and JS/WASM bindings under one shared
    // version number by construction, confirmed via matching `gitHead`s).
    // The real proof this pairing actually exchanges bytes correctly is
    // `apps/swift/Tests/EnchiridionSyncTests/GenerateLoroInteropFixtures.swift`
    // + `LoroSwiftTSInteropTests.swift` (Swift side) and
    // `workers/vault/src/loro-swift-interop.test.ts` (TS side) — real
    // fixture bytes, generated by each real runtime, decoded by the other
    // — not this comment.
    //
    // `exact:` is deliberate (not `from:`): lockstep upgrades of loro-swift
    // and loro-crdt must be a conscious bump on both sides, gated by the
    // cross-language golden test (plan Risk #1 / P0 task "Cross-language
    // Loro golden tests").
    .package(
      url: "https://github.com/loro-dev/loro-swift.git",
      exact: "1.13.3"
    ),
    // P1 "Importer" task ONLY — automerge-swift reads the OLD app's page
    // documents (apps/enchiridion/Sources/EnchiridionCore/PageDocument.swift),
    // which the importer decodes FROM (not the new app's Loro-backed
    // format, which it writes TO via EnchiridionSync). Pinned `exact` at
    // the same version as the old app's own pin
    // (apps/enchiridion/Package.swift: `exact: "0.7.2"`), so the importer
    // reads bytes with the identical Automerge core the old app wrote them
    // with. ONLY the `EnchiridionImporter`/`EnchiridionImporterTests`
    // targets below depend on this product — the main app targets
    // (EnchiridionCore/Sync/UI/...) must never import Automerge; the new
    // app's CRDT is Loro exclusively (plan §Pinned technology decisions,
    // "CRDT: Loro").
    .package(
      url: "https://github.com/automerge/automerge-swift.git",
      exact: "0.7.2"
    ),
    // EnchiridionStore: GRDB projections + bounded SQL executor
    // (GraphSQLExecutor.swift). Pinned to the exact same tag
    // `apps/enchiridion/Package.swift` (the old app) already pins —
    // verified directly against that file, not guessed — so
    // `GraphSQLExecutor.swift` (a near-verbatim port of the old app's file
    // of the same name, using the raw sqlite3 C API + a real
    // `sqlite3_set_authorizer`) runs against the exact GRDB/SQLite
    // pairing it was proven against; diverging the version would
    // reintroduce the exact "is this SQLite/GRDB pairing still proven"
    // question this pin exists to avoid. `exact:` for the same lockstep
    // reason as the other pins in this file.
    .package(
      url: "https://github.com/groue/GRDB.swift.git",
      exact: "7.10.0"
    ),
  ],
  targets: [
    .target(
      name: "EnchiridionCore",
      path: "Sources/EnchiridionCore",
      exclude: ["README.md"]
    ),
    .target(
      name: "EnchiridionSync",
      dependencies: [
        "EnchiridionCore",
        .product(name: "Loro", package: "loro-swift"),
      ],
      path: "Sources/EnchiridionSync",
      exclude: ["README.md"]
    ),
    .target(
      name: "EnchiridionBlobs",
      dependencies: ["EnchiridionCore"],
      path: "Sources/EnchiridionBlobs",
      exclude: ["README.md"]
    ),
    .target(
      name: "EnchiridionStore",
      dependencies: [
        "EnchiridionCore",
        // Needed for `PageDocumentProjection` — `writeProjection`'s input
        // type (LocalGraphStore.swift). Not itself part of the "add GRDB"
        // scope, but required by the task's own stated method signature
        // ("a method to write a page's projection (from
        // PageDocumentProjection)"); EnchiridionSync's own sources are
        // untouched.
        "EnchiridionSync",
        // task #66 ("Assistant read tools") addition — `AssistantReadTools.swift`
        // needs `CoreEventFieldIDs`/`CoreTaskFieldIDs` (etc.) so its SQL
        // never hardcodes a supertag/field ID string (task brief: "use
        // these instead of hardcoding tag/field ID strings"). Not
        // circular: `EnchiridionSchema` depends only on `EnchiridionCore`.
        "EnchiridionSchema",
        .product(name: "GRDB", package: "GRDB.swift"),
        // GraphSQLExecutor.swift opens its own raw sqlite3 connection
        // (see that file's header for why: GRDB has no public authorizer
        // API to hook into) via the C SQLite API GRDB itself is built on
        // — `GRDBSQLite` is a real, separately published product of
        // `GRDB.swift` (`.library(name: "GRDBSQLite", targets:
        // ["GRDBSQLite"])` in its own Package.swift), not a private
        // implementation detail reached around; declared explicitly here
        // rather than relying on it leaking in transitively through the
        // `GRDB` product dependency above.
        .product(name: "GRDBSQLite", package: "GRDB.swift"),
      ],
      path: "Sources/EnchiridionStore",
      exclude: ["README.md"]
    ),
    .target(
      name: "EnchiridionSchema",
      dependencies: ["EnchiridionCore"],
      path: "Sources/EnchiridionSchema",
      exclude: ["README.md"]
    ),
    .target(
      name: "EnchiridionAPI",
      dependencies: ["EnchiridionCore", "EnchiridionSchema"],
      path: "Sources/EnchiridionAPI",
      exclude: ["README.md"]
    ),
    .target(
      name: "EnchiridionGadgets",
      dependencies: ["EnchiridionCore"],
      path: "Sources/EnchiridionGadgets",
      exclude: ["README.md"]
    ),
    .target(
      name: "EnchiridionUI",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionBlobs",
        "EnchiridionStore",
        "EnchiridionSchema",
        "EnchiridionAPI",
        "EnchiridionGadgets",
        // Task #85 (P7 integration wave) addition — `PageEditorView`/
        // `PageEditorController` gain a real "insert canvas" action and
        // attachment-thumbnail rendering for `"canvas"`-kind
        // `PageAttachment`s (`PageCanvasEmbedding.swift`), wiring
        // `EnchiridionCanvas.CanvasEditorView`/`CanvasEmbed`/`CanvasBlobStore`
        // into the shared editor. `EnchiridionCanvas` was deliberately built
        // as a sibling target with NO dependency on `EnchiridionUI` (see its
        // own README: "not wired into RootView.swift/app navigation") —
        // this is the integration task that closes that gap, in the
        // direction the canvas module's own header always expected
        // (`EnchiridionUI` depends on `EnchiridionCanvas`, never the
        // reverse, so no cycle).
        "EnchiridionCanvas",
      ],
      path: "Sources/EnchiridionUI",
      exclude: ["README.md"]
    ),
    // P6 "Widgets" task — see the `EnchiridionWidgetKit` product comment
    // above. Depends on `EnchiridionStore` for `LocalGraphStore`/
    // `LocalGraphStoreLocation`/the `searchTasks`/`findCalendarEvents`
    // read tools it reuses (see `WidgetLocalStore.swift`'s header for why
    // reuse, not new SQL), and `EnchiridionSchema` transitively through
    // that — declared explicitly here anyway per this package's existing
    // convention (`EnchiridionStore`'s own target comment: "declared
    // explicitly here rather than relying on it leaking in transitively").
    .target(
      name: "EnchiridionWidgetKit",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionStore",
        "EnchiridionSchema",
      ],
      path: "Sources/EnchiridionWidgetKit",
      exclude: ["README.md"]
    ),
    // P6 "Share extensions" task — see the `EnchiridionShareKit` product
    // comment above. Depends on `EnchiridionSync` for `PageDocument`
    // (the real local-write path — `ShareCapture.swift`'s header) and
    // `EnchiridionStore` for `LocalGraphStore`/`LocalGraphStoreLocation`,
    // declared explicitly per this package's existing convention (see
    // `EnchiridionStore`'s own target comment).
    .target(
      name: "EnchiridionShareKit",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionStore",
      ],
      path: "Sources/EnchiridionShareKit",
      exclude: ["README.md"]
    ),
    // P6 "watchOS workout capture" task — see the `EnchiridionWatchKit`
    // product comment above. Depends on `EnchiridionSync` for
    // `PageDocument` (the real local-write path, same as
    // `EnchiridionShareKit`), `EnchiridionStore` for `LocalGraphStore`,
    // and `EnchiridionSchema` for the generated `WorkoutsWorkoutFieldIDs`/
    // `WorkoutsWorkoutActivity` constants (task #79's own
    // `supertags/workouts` module) — declared explicitly per this
    // package's existing convention (see `EnchiridionStore`'s own target
    // comment).
    .target(
      name: "EnchiridionWatchKit",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionStore",
        "EnchiridionSchema",
      ],
      path: "Sources/EnchiridionWatchKit"
    ),
    // P7 "Native drawing canvas" task — see the `EnchiridionCanvas`
    // product comment above. Depends on `EnchiridionSync` for
    // `PageDocument`/`PageTextContainer`/the new `attachmentMark`
    // mechanism this task adds there, `EnchiridionBlobs` for
    // `BlobCache`/`BlobReference`/`BlobID` (the content-addressed blob
    // storage a canvas's stroke/shape content round-trips through), and
    // `EnchiridionSchema` for the generated `CanvasCanvaspageFieldIDs`
    // (`supertags/canvas`'s codegen output) — declared explicitly per
    // this package's existing convention (see `EnchiridionStore`'s own
    // target comment above).
    .target(
      name: "EnchiridionCanvas",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionBlobs",
        "EnchiridionSchema",
      ],
      path: "Sources/EnchiridionCanvas",
      exclude: ["README.md"]
    ),
    .testTarget(
      name: "EnchiridionSyncTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        .product(name: "Loro", package: "loro-swift"),
      ],
      path: "Tests/EnchiridionSyncTests"
    ),
    .testTarget(
      name: "EnchiridionBlobsTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionBlobs",
      ],
      path: "Tests/EnchiridionBlobsTests"
    ),
    // "GRDB projections + bounded local SQL" task: schema creation,
    // `writeProjection` round-trip, and the bounded executor's real
    // `sqlite3_set_authorizer` — including adversarial bypass attempts
    // (GraphSQLExecutorTests.swift) proving the authorizer, not just the
    // allowlist text, is what denies unauthorized access.
    .testTarget(
      name: "EnchiridionStoreTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionStore",
        // task #66 addition — `AssistantReadToolsTests.swift` builds test
        // fixtures against the real generated supertag field IDs.
        "EnchiridionSchema",
        .product(name: "GRDB", package: "GRDB.swift"),
      ],
      path: "Tests/EnchiridionStoreTests"
    ),
    // Cross-language golden ID tests (plan §Verification, "Critical
    // invariant"): GoldenIdsTests.swift loads
    // packages/graph-core/src/__fixtures__/golden-ids.json directly off
    // disk (no SPM `resources:` copy step — see that file's header comment
    // for why) and asserts it against the real PageID/PredicateID
    // derivation in EnchiridionCore. Release-blocking in CI alongside the
    // TS side's `bun test` for packages/graph-core — see
    // .github/workflows/enchiridion.yml.
    .testTarget(
      name: "EnchiridionCoreTests",
      // `EnchiridionBlobs` added so GoldenIdsTests.swift's blob-ID cases can
      // call the REAL `BlobID.init(contentsOf:)` (used in production by
      // BlobCache.swift) instead of a hand-rolled CryptoKit.SHA256 dupe.
      // Not circular: EnchiridionBlobs depends on EnchiridionCore, and a
      // test target is allowed to depend "down" the graph onto both the
      // module it tests and another module built on top of it.
      dependencies: ["EnchiridionCore", "EnchiridionBlobs"],
      path: "Tests/EnchiridionCoreTests"
    ),
    // P1 "Editor" task: exercises EnchiridionUI's non-UI logic (mark
    // toggling, text diffing, the accumulate-then-flush controller, and
    // page-reference insertion planning) against the real `PageDocument`
    // API (EnchiridionSync) — no mocking needed, since `PageDocument` is
    // already snapshot-in/snapshot-out pure functions. Visual/interaction
    // behavior (SwiftUI layout, `TextEditor`/`AttributedTextSelection`
    // gestures, VoiceOver) is out of reach for a plain `swift test` run and
    // is not covered here — see EnchiridionUI's README / the P1 report.
    .testTarget(
      name: "EnchiridionUITests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionUI",
        // task #68 ("Assistant provider integration + conversation UI")
        // addition — the full-round-trip test
        // (AssistantConversationEndToEndTests.swift) exercises
        // `AssistantLocalToolDispatcher` against a REAL temporary
        // `LocalGraphStore` (`EnchiridionStore`), seeded via the real
        // generated supertag field IDs (`EnchiridionSchema`) — same
        // fixture-construction pattern `EnchiridionStoreTests/AssistantReadToolsTests.swift`
        // already established for #66, reused here rather than re-mocking
        // the store.
        "EnchiridionStore",
        "EnchiridionSchema",
        // Task #85 addition — canvas-attachment-embedding integration
        // tests (`PageCanvasEmbeddingTests.swift`) exercise the real
        // `EnchiridionCanvas.CanvasEmbed`/`CanvasDocument` types against
        // `PageEditorController`'s new attachment op.
        "EnchiridionCanvas",
      ],
      path: "Tests/EnchiridionUITests"
    ),
    // P6 "Widgets" task: exercises `EnchiridionWidgetKit`'s testable
    // entry-loading functions (`loadTodayTasksEntry`/`loadNextEventEntry`)
    // against a REAL temporary `LocalGraphStore` — same fixture-writing
    // pattern `EnchiridionStoreTests/AssistantReadToolsTests.swift`
    // established (`.testTarget` dependencies mirror that target's own
    // list for the same reason: `PageDocumentProjection` fixtures need
    // `EnchiridionSync`, field IDs need `EnchiridionSchema`). Does NOT
    // exercise `TimelineProvider.getTimeline`/`getSnapshot` themselves —
    // `WidgetKit.TimelineProviderContext` has no public initializer
    // reachable from a plain `swift test` process (same class of gap the
    // old app's own widget test coverage never had either); see
    // `Sources/EnchiridionWidgetKit/README.md` for that boundary.
    .testTarget(
      name: "EnchiridionWidgetKitTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionStore",
        "EnchiridionSchema",
        "EnchiridionWidgetKit",
      ],
      path: "Tests/EnchiridionWidgetKitTests"
    ),
    // P6 "Share extensions" task: exercises `ShareCaptureBody`'s pure
    // derivation logic, `ShareCapture`'s write path against a REAL
    // temporary `LocalGraphStore`, and `ShareExtensionContextParsing`
    // against real `NSItemProvider`s — same fixture-writing pattern
    // `EnchiridionWidgetKitTests` established (`.testTarget` dependencies
    // mirror that target's own list for the same reason).
    .testTarget(
      name: "EnchiridionShareKitTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionStore",
        "EnchiridionShareKit",
      ],
      path: "Tests/EnchiridionShareKitTests"
    ),
    // P6 "watchOS workout capture" task: exercises `WorkoutCapture`'s
    // write path against a REAL temporary `LocalGraphStore` — same
    // fixture-writing pattern `EnchiridionShareKitTests` established.
    // Deliberately does NOT exercise `WorkoutSessionController`'s actual
    // `HKWorkoutSession`/`HKLiveWorkoutBuilder` calls: this sandbox (and
    // a plain `swift test` process generally) has no watchOS
    // simulator/device, no HealthKit authorization, and
    // `HKWorkoutSession`/`HKLiveWorkoutBuilder` have no meaningful way to
    // be driven outside a real HealthKit runtime — see
    // `Sources/EnchiridionWatchKit/WorkoutSessionController.swift`'s
    // header for that boundary (same class of gap
    // `EnchiridionGadgetsTests`' own header documents for `WKWebView`).
    .testTarget(
      name: "EnchiridionWatchKitTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionStore",
        "EnchiridionSchema",
        "EnchiridionWatchKit",
      ],
      path: "Tests/EnchiridionWatchKitTests"
    ),
    // "EnchiridionGadgets" P4 task: message-passing/authorization logic
    // for the WKWebView capability bridge — `GadgetBridgeRequest` parsing
    // from a raw (untrusted) `postMessage` body, `GadgetBridge`'s local
    // grant enforcement against a mocked `GadgetBridgeTransport`
    // (task brief: "mock the authenticated network layer"),
    // `GadgetJSONValue` conversions, and the injected response's JSON
    // encoding. Deliberately NOT a WebKit/simulator-driven test — this
    // sandbox has no simulator, and `WKScriptMessage` has no public
    // initializer, so `GadgetBridgeMessageHandler`'s own glue is exercised
    // only by compilation here, not a unit test; see
    // Sources/EnchiridionGadgets/README.md's "What's still not verified".
    .testTarget(
      name: "EnchiridionGadgetsTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionGadgets",
      ],
      path: "Tests/EnchiridionGadgetsTests"
    ),
    // task #66 ("Assistant read tools") addition — `EnchiridionAPI`'s
    // first real sources (`EmailSearchClient.swift`, task brief: "check
    // how EnchiridionAPI is tested elsewhere in this package for the
    // existing mocking convention" — there was none yet, this target
    // establishes it: a `URLProtocol` stub intercepting the real
    // `URLSession` call, proving the actual GraphQL request/response wire
    // format, not just the business logic above it).
    .testTarget(
      name: "EnchiridionAPITests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionAPI",
      ],
      path: "Tests/EnchiridionAPITests"
    ),
    // P1 "Importer" task (plan §Phasing P1: "Importer reads the old app's
    // Automerge docs, not its SQL projections ... deterministic IDs make
    // it idempotent and re-runnable during parallel operation"). A
    // standalone executable, deliberately NOT a dependency of
    // EnchiridionUI/the app targets — see this file's automerge-swift
    // dependency comment above for why Automerge must stay isolated to
    // this one target. See Sources/EnchiridionImporter/README.md for the
    // decode -> re-encode -> push pipeline and how to run this against a
    // real old-app vault.
    .executableTarget(
      name: "EnchiridionImporter",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        .product(name: "Automerge", package: "automerge-swift"),
      ],
      path: "Sources/EnchiridionImporter",
      exclude: ["README.md"]
    ),
    .testTarget(
      name: "EnchiridionImporterTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionImporter",
        .product(name: "Automerge", package: "automerge-swift"),
      ],
      path: "Tests/EnchiridionImporterTests"
    ),
    // P7 "Native drawing canvas" task: golden serialization round-trips,
    // undo/redo exact-state assertions, the gesture-driven capture logic
    // (SwiftUI-free — see `CanvasEditorViewModel.swift`'s header), a real
    // `EnchiridionBlobs.BlobCache` upload/download round-trip (URLProtocol
    // stub intercepting the real `URLSession` call — same convention
    // `EnchiridionAPITests` established, see that target's own comment
    // above), and real embed-in-page attachment resolution against
    // `PageDocument`. See `Sources/EnchiridionCanvas/README.md`'s "Tests"
    // section for the one-line summary of each file.
    .testTarget(
      name: "EnchiridionCanvasTests",
      dependencies: [
        "EnchiridionCore",
        "EnchiridionSync",
        "EnchiridionBlobs",
        "EnchiridionSchema",
        "EnchiridionCanvas",
      ],
      path: "Tests/EnchiridionCanvasTests"
    ),
  ]
)
