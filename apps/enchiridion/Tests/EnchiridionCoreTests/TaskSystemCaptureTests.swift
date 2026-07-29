import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskSystemCaptureTests: XCTestCase {
  private final class FailingCopyFileManager: FileManager, @unchecked Sendable {
    override func copyItem(at srcURL: URL, to dstURL: URL) throws {
      if srcURL.path.hasSuffix("-wal") {
        throw CocoaError(.fileWriteUnknown)
      }
      try super.copyItem(at: srcURL, to: dstURL)
    }
  }

  func testFailedSQLiteMigrationNeverPublishesMainDatabase() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.appendingPathComponent("legacy.sqlite")
    let destination = directory.appendingPathComponent("shared.sqlite")
    try Data("main".utf8).write(to: source)
    try Data("wal".utf8).write(to: URL(fileURLWithPath: source.path + "-wal"))

    XCTAssertThrowsError(
      try LibraryRepository.migrateSQLiteDatabaseIfNeeded(
        from: source,
        to: destination,
        manager: FailingCopyFileManager()
      )
    )
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path + "-wal"))
  }

  func testSpotlightUsesOneStableIdentifierAndRoutesToTheExactTask() throws {
    let pageID = PageID(rawValue: "spotlight-task")
    let identity = VaultScopedNodeID(
      vaultID: .init(rawValue: "vault_personal"),
      nodeID: pageID
    )

    XCTAssertEqual(TaskSystemSpotlight.searchableIdentifier(for: identity), identity.id)
    let url = try XCTUnwrap(TaskSystemSpotlight.contentURL(for: identity))
    XCTAssertEqual(
      TaskDeepLinkRoute(url: url),
      .task(identity, list: .today)
    )
  }

  func testSQLiteMigrationPublishesMainDatabaseAndSidecars() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.appendingPathComponent("legacy.sqlite")
    let destination = directory.appendingPathComponent("shared.sqlite")
    try Data("main".utf8).write(to: source)
    try Data("wal".utf8).write(to: URL(fileURLWithPath: source.path + "-wal"))
    try Data("shm".utf8).write(to: URL(fileURLWithPath: source.path + "-shm"))

    try LibraryRepository.migrateSQLiteDatabaseIfNeeded(from: source, to: destination)

    XCTAssertEqual(try Data(contentsOf: destination), Data("main".utf8))
    XCTAssertEqual(
      try Data(contentsOf: URL(fileURLWithPath: destination.path + "-wal")),
      Data("wal".utf8)
    )
    XCTAssertEqual(
      try Data(contentsOf: URL(fileURLWithPath: destination.path + "-shm")),
      Data("shm".utf8)
    )
  }

  func testSQLiteMigrationDoesNotReplaceExistingDestination() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.appendingPathComponent("legacy.sqlite")
    let destination = directory.appendingPathComponent("shared.sqlite")
    try Data("legacy".utf8).write(to: source)
    try Data("current".utf8).write(to: destination)

    try LibraryRepository.migrateSQLiteDatabaseIfNeeded(from: source, to: destination)

    XCTAssertEqual(try Data(contentsOf: destination), Data("current".utf8))
  }

  func testSQLiteMigrationRecoversOrphanSidecarsAndInterruptedStaging() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.appendingPathComponent("legacy.sqlite")
    let destination = directory.appendingPathComponent("shared.sqlite")
    let interruptedStaging =
      directory
      .appendingPathComponent(".library-migration-interrupted", isDirectory: true)
    try FileManager.default.createDirectory(
      at: interruptedStaging,
      withIntermediateDirectories: false
    )
    try Data("stale".utf8).write(
      to: interruptedStaging.appendingPathComponent("library.sqlite")
    )
    try Data("stale-wal".utf8).write(
      to: URL(fileURLWithPath: destination.path + "-wal")
    )
    try Data("stale-shm".utf8).write(
      to: URL(fileURLWithPath: destination.path + "-shm")
    )
    try Data("current-main".utf8).write(to: source)
    try Data("current-wal".utf8).write(
      to: URL(fileURLWithPath: source.path + "-wal")
    )

    try LibraryRepository.migrateSQLiteDatabaseIfNeeded(from: source, to: destination)

    XCTAssertEqual(try Data(contentsOf: destination), Data("current-main".utf8))
    XCTAssertEqual(
      try Data(contentsOf: URL(fileURLWithPath: destination.path + "-wal")),
      Data("current-wal".utf8)
    )
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path + "-shm"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: interruptedStaging.path))
  }

  func testConcurrentMigrationAndRepositoryOpenPreserveLegacyRows() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.appendingPathComponent("legacy.sqlite")
    let destination = directory.appendingPathComponent("shared.sqlite")
    let sourceRepository = try LibraryRepository(path: source.path)
    let legacyTask = try await sourceRepository.createTask(
      TaskDraft(title: "Preserved across first open")
    )

    async let firstMigration: Void = Task.detached {
      try LibraryRepository.migrateSQLiteDatabaseIfNeeded(
        from: source,
        to: destination
      )
    }.value
    async let secondMigration: Void = Task.detached {
      try LibraryRepository.migrateSQLiteDatabaseIfNeeded(
        from: source,
        to: destination
      )
    }.value
    try await firstMigration
    try await secondMigration

    async let firstOpen = Task.detached {
      try LibraryRepository(path: destination.path)
    }.value
    async let secondOpen = Task.detached {
      try LibraryRepository(path: destination.path)
    }.value
    let (firstRepository, secondRepository) = try await (firstOpen, secondOpen)
    let firstTitle = try await firstRepository.page(id: legacyTask.id)?.title
    let secondTitle = try await secondRepository.page(id: legacyTask.id)?.title

    XCTAssertEqual(firstTitle, legacyTask.title)
    XCTAssertEqual(secondTitle, legacyTask.title)
  }

  func testConcurrentRepositoryInitializationAndWritesWaitForContention() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("library.sqlite").path

    async let firstOpen = Task.detached { try LibraryRepository(path: path) }.value
    async let secondOpen = Task.detached { try LibraryRepository(path: path) }.value
    let (firstRepository, secondRepository) = try await (firstOpen, secondOpen)

    async let firstWrite = firstRepository.createTask(TaskDraft(title: "First process"))
    async let secondWrite = secondRepository.createTask(TaskDraft(title: "Second process"))
    let (firstTask, secondTask) = try await (firstWrite, secondWrite)
    let visibleIDs = Set(
      try await firstRepository.pages(with: BuiltInSupertags.task).map(\.id)
    )

    XCTAssertEqual(visibleIDs, Set([firstTask.id, secondTask.id]))
  }

  func testSelectedTextUsesFirstLineAsTitleAndPreservesContext() throws {
    let draft = try XCTUnwrap(
      TaskSystemCapture.draft(text: "Review proposal\nThe decision is due next week.")
    )

    XCTAssertEqual(draft.title, "Review proposal")
    XCTAssertEqual(draft.notes, "Review proposal\nThe decision is due next week.")
    XCTAssertEqual(draft.data.placement, .inbox)
  }

  func testURLOnlyCaptureUsesHostAndKeepsFullURL() throws {
    let url = try XCTUnwrap(URL(string: "https://example.com/reading?id=42"))
    let draft = try XCTUnwrap(TaskSystemCapture.draft(text: nil, urls: [url]))

    XCTAssertEqual(draft.title, "example.com")
    XCTAssertEqual(draft.notes, url.absoluteString)
  }

  func testDuplicateURLIsNotRepeatedInNotes() throws {
    let url = try XCTUnwrap(URL(string: "https://example.com/item"))
    let draft = try XCTUnwrap(
      TaskSystemCapture.draft(text: "Read https://example.com/item", urls: [url])
    )

    XCTAssertEqual(draft.title, "Read https://example.com/item")
    XCTAssertTrue(draft.notes.isEmpty)
  }

  func testEmptyCaptureIsRejected() {
    XCTAssertNil(TaskSystemCapture.draft(text: "  "))
  }
}
