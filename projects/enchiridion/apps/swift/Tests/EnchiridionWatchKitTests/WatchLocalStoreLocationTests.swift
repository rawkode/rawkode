// WatchLocalStoreLocationTests.swift
// EnchiridionWatchKitTests
//
// P6 "watchOS workout capture" task. Proves
// `WatchLocalStoreLocation`/`LocalGraphStore.openWatchLocalStore` actually
// resolve to, and can round-trip through, a real independent SQLite file
// — same pattern `EnchiridionStoreTests/LocalGraphStoreLocationTests.swift`
// established for the (differently-mechanismed) App Group case: point 2
// there ("a REAL, independently reopenable SQLite database") is exactly
// as true here, just via Application Support instead of an App Group
// container.

import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionStore
@testable import EnchiridionWatchKit

final class WatchLocalStoreLocationTests: XCTestCase {
  private func makeTemporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-watch-store-fixture-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  func testDatabasePathJoinsTheDirectoryNameAndFileNameOntoApplicationSupport() throws {
    let applicationSupport = try makeTemporaryDirectory()
    let path = WatchLocalStoreLocation.databasePath(inApplicationSupport: applicationSupport)
    XCTAssertEqual(
      path,
      applicationSupport.appendingPathComponent("Enchiridion2Watch", isDirectory: true)
        .appendingPathComponent("graph.sqlite").path)
  }

  func testResolvedDatabasePathCreatesTheDirectoryAndJoinsTheFileNameOntoWhateverFileManagerReturns() throws {
    let applicationSupport = try makeTemporaryDirectory()
    let fileManager = FakeApplicationSupportFileManager(applicationSupportURL: applicationSupport)

    let path = try WatchLocalStoreLocation.resolvedDatabasePath(fileManager: fileManager)

    XCTAssertEqual(path, WatchLocalStoreLocation.databasePath(inApplicationSupport: applicationSupport))
    var isDirectory: ObjCBool = false
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: applicationSupport.appendingPathComponent("Enchiridion2Watch").path, isDirectory: &isDirectory))
    XCTAssertTrue(isDirectory.boolValue, "resolvedDatabasePath must create the directory, not just compute its path")
  }

  func testResolvedDatabasePathThrowsWhenFileManagerReturnsNoApplicationSupportDirectory() {
    let fileManager = FakeApplicationSupportFileManager(applicationSupportURL: nil)

    XCTAssertThrowsError(try WatchLocalStoreLocation.resolvedDatabasePath(fileManager: fileManager)) { error in
      XCTAssertEqual(
        error as? WatchLocalStoreLocation.ResolutionError, .applicationSupportDirectoryUnavailable)
    }
  }

  /// The real property this store depends on: its OWN process (the watch
  /// app), reopening the SAME resolved path across launches, still sees
  /// what it wrote last time — proving this is a real durable file, not
  /// an in-memory stand-in. Deliberately does NOT prove — and per this
  /// task's own scope, must NOT prove — that the phone's own
  /// `LocalGraphStore` can see this data; see `WorkoutCapture.swift`'s
  /// header for why that cross-device reconciliation is explicitly out of
  /// scope here.
  func testAStoreOpenedAtTheResolvedPathIsReadableFromASecondIndependentlyOpenedInstance() async throws {
    let applicationSupport = try makeTemporaryDirectory()
    let fileManager = FakeApplicationSupportFileManager(applicationSupportURL: applicationSupport)
    let path = try WatchLocalStoreLocation.resolvedDatabasePath(fileManager: fileManager)

    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000091")!)
    do {
      // Stands in for the watch app's first launch.
      let writer = try LocalGraphStore(path: path)
      try await writer.writeProjection(
        pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
        projection: .init(
          title: "Watch-local page", plainText: "Watch-local page", deletedAt: nil,
          isPinned: false, references: [], graphEdges: [], objectMetadata: .init()))
    }

    // Stands in for a later relaunch: a SEPARATE `LocalGraphStore`
    // instance, opened independently at the identical resolved path.
    let reader = try LocalGraphStore(path: path)
    let row = try await reader.node(for: pageID)
    XCTAssertEqual(row?.title, "Watch-local page")
  }

  func testOpenWatchLocalStoreSurfacesTheSameResolutionErrorWhenApplicationSupportIsUnavailable() {
    let fileManager = FakeApplicationSupportFileManager(applicationSupportURL: nil)

    XCTAssertThrowsError(try LocalGraphStore.openWatchLocalStore(fileManager: fileManager)) { error in
      XCTAssertEqual(
        error as? WatchLocalStoreLocation.ResolutionError, .applicationSupportDirectoryUnavailable)
    }
  }
}

/// A minimal `FileManager` subclass overriding only
/// `urls(for:in:)` — same "real subtype substitution, not a
/// protocol-shaped fake" approach
/// `LocalGraphStoreLocationTests.FakeAppGroupFileManager` already
/// established for the App Group case.
private final class FakeApplicationSupportFileManager: FileManager, @unchecked Sendable {
  private let applicationSupportURL: URL?

  init(applicationSupportURL: URL?) {
    self.applicationSupportURL = applicationSupportURL
    super.init()
  }

  override func urls(
    for directory: FileManager.SearchPathDirectory, in domainMask: FileManager.SearchPathDomainMask
  ) -> [URL] {
    guard directory == .applicationSupportDirectory, domainMask == .userDomainMask,
      let applicationSupportURL
    else {
      return []
    }
    return [applicationSupportURL]
  }
}
