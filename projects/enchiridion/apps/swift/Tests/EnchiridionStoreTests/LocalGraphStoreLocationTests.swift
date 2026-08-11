// LocalGraphStoreLocationTests.swift
// EnchiridionStoreTests
//
// P6 "Widgets" task (plan §Platform parity). Proves
// `LocalGraphStoreLocation`/`LocalGraphStore.openAppGroupStore` actually do
// what the widget extension and the main app both need:
//   1. `databasePath(inContainer:)` joins the expected filename onto an
//      arbitrary container directory (no real App Group entitlement
//      needed — any directory stands in for "the container").
//   2. A `LocalGraphStore` opened at that resolved path is a REAL,
//      independently reopenable SQLite database: write a projection through
//      one `LocalGraphStore` instance, close it (deinit), open a SECOND
//      `LocalGraphStore` instance at the exact same
//      `databasePath(inContainer:)`-derived path, and confirm the data is
//      still there — this is the property the widget extension actually
//      depends on (its own process, its own `LocalGraphStore` instance,
//      reading data the main app's process wrote).
//   3. `resolvedDatabasePath` composes `FileManager`'s real
//      App-Group-resolution call correctly on both branches: a fake
//      `FileManager` returning a container URL yields
//      `databasePath(inContainer:)`'s exact result; one returning `nil`
//      (the documented behavior for a missing/unentitled group — this
//      sandbox's plain `swift test` process has no real App Group
//      entitlement, so exercising the "container exists" branch against
//      the REAL `FileManager.default` is not possible here) throws
//      `.containerUnavailable` rather than crashing or silently picking a
//      different path.

import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionStore

final class LocalGraphStoreLocationTests: XCTestCase {
  private func makeTemporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-app-group-fixture-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  func testDatabasePathJoinsTheExpectedFileNameOntoTheContainerDirectory() throws {
    let container = try makeTemporaryDirectory()
    let path = LocalGraphStoreLocation.databasePath(inContainer: container)
    XCTAssertEqual(path, container.appendingPathComponent("graph.sqlite").path)
  }

  func testAStoreOpenedAtTheResolvedPathIsReadableFromASecondIndependentlyOpenedInstance() async throws {
    let container = try makeTemporaryDirectory()
    let path = LocalGraphStoreLocation.databasePath(inContainer: container)

    let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000090")!)
    do {
      // Stands in for the main app's process, first launch: opens the
      // store at the App-Group-derived path and writes a page.
      let writer = try LocalGraphStore(path: path)
      try await writer.writeProjection(
        pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
        projection: .init(
          title: "Shared via App Group", plainText: "Shared via App Group", deletedAt: nil,
          isPinned: false, references: [], graphEdges: [], objectMetadata: .init()))
    }

    // Stands in for the widget extension's own process: a SEPARATE
    // `LocalGraphStore` instance, opened independently at the identical
    // resolved path — proving this is real cross-process-shaped file
    // sharing, not merely "the same Swift object read back its own write."
    let reader = try LocalGraphStore(path: path)
    let row = try await reader.node(for: pageID)
    XCTAssertEqual(row?.title, "Shared via App Group")
  }

  func testResolvedDatabasePathJoinsTheFileNameOntoWhateverContainerFileManagerReturns() throws {
    let container = try makeTemporaryDirectory()
    let fileManager = FakeAppGroupFileManager(containerURL: container)

    let path = try LocalGraphStoreLocation.resolvedDatabasePath(
      appGroupIdentifier: "group.dev.rawkode.enchiridion2", fileManager: fileManager)

    XCTAssertEqual(path, LocalGraphStoreLocation.databasePath(inContainer: container))
    XCTAssertEqual(fileManager.requestedIdentifier, "group.dev.rawkode.enchiridion2")
  }

  func testResolvedDatabasePathThrowsContainerUnavailableWhenFileManagerReturnsNil() {
    let fileManager = FakeAppGroupFileManager(containerURL: nil)

    XCTAssertThrowsError(
      try LocalGraphStoreLocation.resolvedDatabasePath(
        appGroupIdentifier: "group.dev.rawkode.enchiridion2", fileManager: fileManager)
    ) { error in
      XCTAssertEqual(
        error as? LocalGraphStoreLocation.ResolutionError,
        .containerUnavailable(appGroupIdentifier: "group.dev.rawkode.enchiridion2"))
    }
  }

  func testOpenAppGroupStoreSurfacesTheSameResolutionErrorWhenTheContainerIsUnavailable() {
    let fileManager = FakeAppGroupFileManager(containerURL: nil)

    XCTAssertThrowsError(
      try LocalGraphStore.openAppGroupStore(
        appGroupIdentifier: "group.dev.rawkode.enchiridion2", fileManager: fileManager)
    ) { error in
      XCTAssertEqual(
        error as? LocalGraphStoreLocation.ResolutionError,
        .containerUnavailable(appGroupIdentifier: "group.dev.rawkode.enchiridion2"))
    }
  }
}

/// A minimal `FileManager` subclass overriding only
/// `containerURL(forSecurityApplicationGroupIdentifier:)` — `FileManager`
/// is an `open` class and this method isn't `final`, so this is real
/// subtype substitution, not a protocol-shaped fake standing in for
/// `Foundation.FileManager`. Records the requested identifier so tests can
/// assert `resolvedDatabasePath` passes the identifier through unchanged.
private final class FakeAppGroupFileManager: FileManager, @unchecked Sendable {
  private let containerURL: URL?
  private(set) var requestedIdentifier: String?

  init(containerURL: URL?) {
    self.containerURL = containerURL
    super.init()
  }

  override func containerURL(forSecurityApplicationGroupIdentifier groupIdentifier: String) -> URL? {
    requestedIdentifier = groupIdentifier
    return containerURL
  }
}
