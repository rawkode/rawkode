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
}
