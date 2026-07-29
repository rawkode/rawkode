import Foundation
import XCTest
@testable import EnchiridionCore

@MainActor
final class VaultSessionTests: XCTestCase {
  func testSwitchingVaultsReplacesWorkspaceAndKeepsGraphsIsolated() async throws {
    let fixture = try VaultSessionFixture(testCase: self)
    let session = try VaultSession(registry: fixture.registry, startImmediately: false)
    let personalID = session.selectedVault.id
    _ = try await session.repository.createFreePage(title: "Personal note")

    let work = try session.createVault(name: "Work")
    XCTAssertEqual(session.selectedVault.id, work.id)
    let initialWorkPages = try await session.repository.pages(in: .allPages)
    XCTAssertTrue(initialWorkPages.isEmpty)
    _ = try await session.repository.createFreePage(title: "Work note")

    try session.selectVault(personalID)
    let personalPages = try await session.repository.pages(in: .allPages)
    XCTAssertEqual(personalPages.map(\.title), ["Personal note"])
    XCTAssertEqual(session.snapshot.selectedVaultID, personalID)
  }

  func testDefaultCaptureSelectionDoesNotChangeActiveWorkspace() throws {
    let fixture = try VaultSessionFixture(testCase: self)
    let session = try VaultSession(registry: fixture.registry, startImmediately: false)
    let personalID = session.selectedVault.id
    let inbox = try session.createVault(name: "Inbox", select: false)

    try session.setDefaultCaptureVault(inbox.id)

    XCTAssertEqual(session.selectedVault.id, personalID)
    XCTAssertEqual(session.snapshot.defaultCaptureVaultID, inbox.id)
    XCTAssertEqual(
      try fixture.registry.graphPath(selection: .defaultCapture),
      try fixture.registry.graphPath(for: inbox.id)
    )
  }

  func testDeletingActiveVaultSwitchesToFallbackAndRemovesOnlyItsDirectory() throws {
    let fixture = try VaultSessionFixture(testCase: self)
    let session = try VaultSession(registry: fixture.registry, startImmediately: false)
    let personalID = session.selectedVault.id
    let temporary = try session.createVault(name: "Temporary")
    let removedDirectory = URL(
      fileURLWithPath: try fixture.registry.graphPath(for: temporary.id)
    ).deletingLastPathComponent()
    let retainedDirectory = URL(
      fileURLWithPath: try fixture.registry.graphPath(for: personalID)
    ).deletingLastPathComponent()

    try session.deleteVault(temporary.id)

    XCTAssertEqual(session.selectedVault.id, personalID)
    XCTAssertFalse(FileManager.default.fileExists(atPath: removedDirectory.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: retainedDirectory.path))
  }
}

private struct VaultSessionFixture {
  let registry: VaultRegistry

  init(testCase: XCTestCase) throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("VaultSessionTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    testCase.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    registry = try VaultRegistry(path: directory.appendingPathComponent("catalog.sqlite").path)
  }
}
