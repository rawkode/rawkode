// WatchLocalStoreLocation.swift
// EnchiridionWatchKit
//
// P6 "watchOS workout capture" task (plan §Platform parity). Where the
// watch app's OWN, private `LocalGraphStore` database lives — deliberately
// NOT `LocalGraphStoreLocation.openAppGroupStore()`
// (`EnchiridionStore/LocalGraphStoreLocation.swift`, the P6 "Widgets"
// task's mechanism): that App Group container is shared between the main
// app and an extension running IN THE SAME OS PROCESS SPACE ON THE SAME
// DEVICE — a widget or share extension. A watchOS app runs on a
// physically separate device from its iPhone companion; there is no
// shared filesystem container between them the simple way there is
// between an app and its own extension (see `WorkoutCapture.swift`'s
// header for the full investigation writeup).
//
// So this file does NOT touch `LocalGraphStoreLocation.swift` at all
// (task #79's brief: don't touch #75/#77's completed work without a real
// bug) — it's a new, parallel, watch-only location type, deliberately
// shaped like `LocalGraphStoreLocation` (same "pure path-joining is
// independently testable" split) but resolving to the watch app's own
// `Application Support` directory instead of an App Group container.
//
// A page written here is invisible to the phone's own `LocalGraphStore`
// until some future sync mechanism reconciles them — see
// `WorkoutCapture.swift`'s header, "out of this task's scope."

import EnchiridionStore
import Foundation

public enum WatchLocalStoreLocation {
  /// Matches `LocalGraphStore.openTemporary()`'s own filename choice
  /// (`graph.sqlite`) purely for naming consistency — this is an entirely
  /// separate file in an entirely separate directory on an entirely
  /// separate device from either the phone's App-Group-shared store or a
  /// test's temporary one.
  public static let databaseFileName = "graph.sqlite"

  /// Subdirectory name under Application Support this database lives in
  /// — namespaced the same way `LocalGraphStoreLocation.appGroupIdentifier`
  /// is (`enchiridion2`, not the old app's own watch storage), so a
  /// future watchOS build of the old app (if one ever existed on this
  /// device) can't collide with this one.
  public static let directoryName = "Enchiridion2Watch"

  public enum ResolutionError: Error, LocalizedError, Equatable, Sendable {
    case applicationSupportDirectoryUnavailable

    public var errorDescription: String? {
      switch self {
      case .applicationSupportDirectoryUnavailable:
        "No Application Support directory is available for the watch app's local store."
      }
    }
  }

  /// Pure path-joining — no `FileManager` directory-creation call. Given
  /// the real (or, in a test, a stand-in) Application Support directory,
  /// returns the path `LocalGraphStore` should be opened at.
  public static func databasePath(inApplicationSupport applicationSupportURL: URL) -> String {
    applicationSupportURL
      .appendingPathComponent(directoryName, isDirectory: true)
      .appendingPathComponent(databaseFileName)
      .path
  }

  /// Resolves the REAL on-disk Application Support directory via
  /// `FileManager`, creates `directoryName` inside it if needed, then
  /// joins on `databaseFileName` (`databasePath(inApplicationSupport:)`).
  /// `fileManager` is overridable so a test can substitute a fake without
  /// touching the real filesystem, mirroring
  /// `LocalGraphStoreLocation.resolvedDatabasePath`'s own injectable shape.
  public static func resolvedDatabasePath(fileManager: FileManager = .default) throws -> String {
    guard
      let applicationSupportURL = fileManager.urls(
        for: .applicationSupportDirectory, in: .userDomainMask
      ).first
    else {
      throw ResolutionError.applicationSupportDirectoryUnavailable
    }
    let directory = applicationSupportURL.appendingPathComponent(directoryName, isDirectory: true)
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    return databasePath(inApplicationSupport: applicationSupportURL)
  }
}

extension LocalGraphStore {
  /// Opens (creating on first launch, same as `openAppGroupStore`) the
  /// watch app's OWN, private `LocalGraphStore` — see this file's header
  /// for why this is a genuinely separate store from the phone's, not the
  /// same one reached a different way.
  public static func openWatchLocalStore(fileManager: FileManager = .default) throws -> LocalGraphStore {
    let path = try WatchLocalStoreLocation.resolvedDatabasePath(fileManager: fileManager)
    return try LocalGraphStore(path: path)
  }
}
