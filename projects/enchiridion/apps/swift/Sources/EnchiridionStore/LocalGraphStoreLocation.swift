// LocalGraphStoreLocation.swift
// EnchiridionStore
//
// P6 "Widgets" task (plan §Platform parity: "Requires an App Group
// entitlement so the widget extension and the main app share a
// container"). Before this task, NOTHING in this package opened
// `LocalGraphStore` at a real, persistent, app-owned path in production —
// `LocalGraphStore.openTemporary()` (a unique file under
// `FileManager.default.temporaryDirectory`) was used only by tests, and
// neither `Sources/iOS/RootView.swift` nor `Sources/macOS/RootView.swift`
// instantiates a `LocalGraphStore` at all yet (they hand a brand-new,
// unsaved-to-disk `PageEditorController` straight to the editor — see that
// file's own header comment). So this is NOT a migration of an existing
// on-disk location (there was nothing to migrate): it's the first place
// this package decides where its production database file lives at all,
// chosen up front to be the shared App Group container so a widget
// extension process (which cannot see the main app's private container)
// can read the exact same file once a real projection-writing pipeline
// exists to populate it.
//
// Split into two layers specifically so the interesting part — joining the
// container directory onto a stable filename — is testable without a real
// App Group entitlement (which a plain `swift test` process does not have,
// and cannot be granted):
//   - `databasePath(inContainer:)` is pure path-joining, tested directly
//     against an arbitrary temporary directory standing in for a real
//     container (`LocalGraphStoreLocationTests.swift`).
//   - `resolvedDatabasePath(appGroupIdentifier:fileManager:)` is the thin,
//     production-only wrapper that actually calls
//     `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)` —
//     injectable via `fileManager` so a test can substitute a fake that
//     returns `nil` (the FileManager contract for a missing/unentitled
//     group) and assert `resolvedDatabasePath` turns that into
//     `LocalGraphStoreLocationError.containerUnavailable`, without needing
//     real entitlements to exercise that branch either.

import Foundation

/// Where the App-Group-shared `LocalGraphStore` database lives — the one
/// production location both the main app targets (`Enchiridion2Mac`,
/// `Enchiridion2iOS`) and the widget extension targets
/// (`Enchiridion2MacWidget`, `Enchiridion2iOSWidget`) resolve to, via the
/// SAME App Group identifier declared in each target's own `.entitlements`
/// file (`Configuration/EnchiridionMac.entitlements`,
/// `Configuration/EnchiridionIOS.entitlements`,
/// `Configuration/EnchiridionMacWidget.entitlements`,
/// `Configuration/EnchiridionIOSWidget.entitlements` — `project.yml` wires
/// `CODE_SIGN_ENTITLEMENTS` to each).
public enum LocalGraphStoreLocation {
  /// Must match the `<string>` inside every target's
  /// `com.apple.security.application-groups` array exactly — see this
  /// type's header. Namespaced under `enchiridion2` (not the old app's
  /// `group.dev.rawkode.enchiridion`) so both apps' App Groups can coexist
  /// on one device during the plan's "old app keeps running... until
  /// parity" parallel-operation period.
  public static let appGroupIdentifier = "group.dev.rawkode.enchiridion2"

  /// Filename of the local graph database inside the App Group container.
  /// Matches `LocalGraphStore.openTemporary()`'s own filename choice
  /// (`graph.sqlite`) purely for naming consistency — the two are
  /// unrelated files in unrelated directories, never the same path.
  public static let databaseFileName = "graph.sqlite"

  public enum ResolutionError: Error, LocalizedError, Equatable, Sendable {
    /// `FileManager` returned `nil` for the App Group container — either
    /// the running process's entitlements don't declare
    /// `appGroupIdentifier` (a build/signing configuration bug, not a
    /// runtime condition an end user can hit), or, on a fresh install
    /// before the group's on-disk directory has ever been materialized,
    /// a transient absence. Callers (the widget's `TimelineProvider`, a
    /// future app-side projection pipeline) must treat this as "local
    /// graph data isn't available yet," never crash.
    case containerUnavailable(appGroupIdentifier: String)

    public var errorDescription: String? {
      switch self {
      case .containerUnavailable(let appGroupIdentifier):
        "No App Group container is available for \"\(appGroupIdentifier)\". "
          + "Confirm the running target's entitlements declare this App Group."
      }
    }
  }

  /// Pure path-joining — no `FileManager` call, no I/O. Given the real (or,
  /// in a test, a stand-in) App Group container directory, returns the
  /// path `LocalGraphStore` should be opened at.
  public static func databasePath(inContainer containerURL: URL) -> String {
    containerURL.appendingPathComponent(databaseFileName).path
  }

  /// Resolves the REAL on-disk App Group container via `FileManager`, then
  /// joins on `databaseFileName` (`databasePath(inContainer:)`). This is
  /// what production call sites use — `fileManager` defaults to `.default`
  /// but is overridable so a test can inject a fake that returns `nil`
  /// (simulating a missing entitlement) without needing one for real.
  public static func resolvedDatabasePath(
    appGroupIdentifier: String = appGroupIdentifier,
    fileManager: FileManager = .default
  ) throws -> String {
    guard
      let containerURL = fileManager.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier)
    else {
      throw ResolutionError.containerUnavailable(appGroupIdentifier: appGroupIdentifier)
    }
    return databasePath(inContainer: containerURL)
  }
}

extension LocalGraphStore {
  /// Opens (creating on first launch — `LocalGraphStore.init(path:)` runs
  /// `LocalGraphSchema.migrator.migrate` unconditionally) the ONE
  /// production `LocalGraphStore` shared by the main app and its widget
  /// extension, at `LocalGraphStoreLocation.resolvedDatabasePath(...)`.
  /// The widget's `TimelineProvider` (`EnchiridionWidgetKit`) is this
  /// method's first real caller; a future app-side projection-writing
  /// pipeline (see `LocalGraphStore.swift`'s "Design note" at the bottom
  /// of that file) is expected to call this same method rather than
  /// picking its own path, so the two processes never diverge.
  public static func openAppGroupStore(
    appGroupIdentifier: String = LocalGraphStoreLocation.appGroupIdentifier,
    fileManager: FileManager = .default
  ) throws -> LocalGraphStore {
    let path = try LocalGraphStoreLocation.resolvedDatabasePath(
      appGroupIdentifier: appGroupIdentifier, fileManager: fileManager)
    return try LocalGraphStore(path: path)
  }
}
