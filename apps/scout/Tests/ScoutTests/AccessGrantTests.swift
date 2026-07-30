import Foundation
import XCTest
@testable import Scout

private struct TestBookmarkResolver: BookmarkResolving {
  var stale = false
  func resolve(_ grant: AccessGrant) throws -> (url: URL, stale: Bool) {
    (URL(fileURLWithPath: grant.lastKnownPath, isDirectory: true), stale)
  }
  func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
}

@MainActor
private final class InMemoryGrantMetadataSync: GrantMetadataSyncing {
  var isAvailable: Bool
  var data: Data?
  var notificationObject: AnyObject? { nil }

  init(isAvailable: Bool = true, data: Data? = nil) {
    self.isAvailable = isAvailable
    self.data = data
  }

  func loadEnvelopeData() -> Data? { data }
  func saveEnvelopeData(_ data: Data) { self.data = data }
  func synchronize() -> Bool { isAvailable }
}

final class AccessGrantTests: XCTestCase {
  func testReferenceCountingBalancesLeases() async throws {
    let broker = SecurityScopeBroker(resolver: TestBookmarkResolver())
    let grant = AccessGrant(displayName: "Fixture", bookmarkData: Data(), lastKnownPath: "/tmp", sortOrder: 0, requiresSecurityScope: false)
    _ = try await broker.acquire(grant)
    _ = try await broker.acquire(grant)
    let initialCount = await broker.activeReferenceCount(for: grant.id)
    XCTAssertEqual(initialCount, 2)
    await broker.release(grantID: grant.id)
    let secondCount = await broker.activeReferenceCount(for: grant.id)
    XCTAssertEqual(secondCount, 1)
    await broker.release(grantID: grant.id)
    let finalCount = await broker.activeReferenceCount(for: grant.id)
    XCTAssertEqual(finalCount, 0)
  }

  @MainActor
  func testGrantPersistenceAndOrdering() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let storage = directory.appending(path: "grants.json")
    defer { try? FileManager.default.removeItem(at: directory) }

    let store = AccessGrantStore(storageURL: storage, resolver: TestBookmarkResolver(), seedFixtureWhenRequested: false)
    _ = try store.add(url: URL(fileURLWithPath: "/tmp/Second", isDirectory: true))
    _ = try store.add(url: URL(fileURLWithPath: "/tmp/First", isDirectory: true))
    try store.move(from: IndexSet(integer: 1), to: 0)

    let restored = AccessGrantStore(storageURL: storage, resolver: TestBookmarkResolver(), seedFixtureWhenRequested: false)
    XCTAssertEqual(restored.orderedGrants.map(\.displayName), ["First", "Second"])
  }

  func testStaleBookmarkReturnsReplacementData() async throws {
    let broker = SecurityScopeBroker(resolver: TestBookmarkResolver(stale: true))
    let grant = AccessGrant(displayName: "Fixture", bookmarkData: Data(), lastKnownPath: "/tmp", sortOrder: 0, requiresSecurityScope: false)
    let access = try await broker.acquire(grant)
    XCTAssertEqual(access.refreshedBookmarkData, Data("/tmp".utf8))
    await broker.release(grantID: grant.id)
  }

  @MainActor
  func testMetadataSyncExcludesBookmarksAndLocalPaths() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let sync = InMemoryGrantMetadataSync()
    let store = AccessGrantStore(
      storageURL: directory.appending(path: "grants.json"),
      resolver: TestBookmarkResolver(),
      metadataSync: sync,
      deviceID: UUID(uuidString: "94B94248-DC71-4AF9-878E-219A70E62B6E")!,
      seedFixtureWhenRequested: false
    )

    let grant = try store.add(url: URL(fileURLWithPath: "/private/Very Personal Folder", isDirectory: true))
    let data = try XCTUnwrap(sync.data)
    let envelope = try JSONDecoder().decode(GrantMetadataEnvelope.self, from: data)

    XCTAssertEqual(envelope.version, GrantMetadataEnvelope.currentVersion)
    XCTAssertEqual(envelope.grants.map(\.id), [grant.id])
    XCTAssertEqual(envelope.grants.map(\.displayName), ["Very Personal Folder"])
    XCTAssertFalse(data.contains(grant.bookmarkData))
    XCTAssertFalse(String(decoding: data, as: UTF8.self).contains(grant.lastKnownPath))
  }

  @MainActor
  func testSyncedMetadataCreatesReconnectRequiredLocalPlaceholder() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let sharedSync = InMemoryGrantMetadataSync()
    let firstStore = AccessGrantStore(
      storageURL: directory.appending(path: "first.json"),
      resolver: TestBookmarkResolver(),
      metadataSync: sharedSync,
      seedFixtureWhenRequested: false
    )
    let original = try firstStore.add(url: URL(fileURLWithPath: "/tmp/Projects", isDirectory: true))

    let secondStore = AccessGrantStore(
      storageURL: directory.appending(path: "second.json"),
      resolver: TestBookmarkResolver(),
      metadataSync: sharedSync,
      seedFixtureWhenRequested: false
    )
    let mirrored = try XCTUnwrap(secondStore.grants.first)

    XCTAssertEqual(mirrored.id, original.id)
    XCTAssertEqual(mirrored.displayName, "Projects")
    XCTAssertTrue(mirrored.needsLocalBookmark)
    XCTAssertTrue(mirrored.bookmarkData.isEmpty)
    XCTAssertTrue(mirrored.lastKnownPath.isEmpty)
  }

  @MainActor
  func testUnavailableMetadataSyncKeepsLocalGrantUsable() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let sync = InMemoryGrantMetadataSync(isAvailable: false)
    let store = AccessGrantStore(
      storageURL: directory.appending(path: "grants.json"),
      resolver: TestBookmarkResolver(),
      metadataSync: sync,
      seedFixtureWhenRequested: false
    )

    let grant = try store.add(url: URL(fileURLWithPath: "/tmp/Local", isDirectory: true))

    XCTAssertEqual(store.syncStatus, .unavailable)
    XCTAssertFalse(grant.needsLocalBookmark)
    XCTAssertNil(sync.data)
  }

  @MainActor
  func testRemoteDeleteRemovesEstablishedSyncedGrant() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let sharedSync = InMemoryGrantMetadataSync()
    let firstStore = AccessGrantStore(
      storageURL: directory.appending(path: "first.json"), resolver: TestBookmarkResolver(),
      metadataSync: sharedSync, seedFixtureWhenRequested: false
    )
    let original = try firstStore.add(url: URL(fileURLWithPath: "/tmp/Projects", isDirectory: true))
    let secondStore = AccessGrantStore(
      storageURL: directory.appending(path: "second.json"), resolver: TestBookmarkResolver(),
      metadataSync: sharedSync, seedFixtureWhenRequested: false
    )
    XCTAssertEqual(secondStore.grants.map(\.id), [original.id])

    try firstStore.remove(original)
    secondStore.refreshSyncedMetadata()

    XCTAssertTrue(secondStore.grants.isEmpty)
    let envelope = try JSONDecoder().decode(
      GrantMetadataEnvelope.self, from: try XCTUnwrap(sharedSync.data)
    )
    XCTAssertEqual(envelope.deletedGrantIDs, [original.id])
  }

  func testICloudDriveDestinationPrecedesManualLocations() {
    let iCloud = AccessGrant.iCloudDrive(rootURL: URL(fileURLWithPath: "/iCloud/Scout/Documents", isDirectory: true))
    let manual = AccessGrant(
      displayName: "Projects", bookmarkData: Data(), lastKnownPath: "/tmp/Projects", sortOrder: 0
    )

    XCTAssertLessThan(iCloud.sortOrder, manual.sortOrder)
    XCTAssertFalse(iCloud.requiresSecurityScope)
  }
}
