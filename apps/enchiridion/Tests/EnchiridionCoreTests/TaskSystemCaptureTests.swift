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

    XCTAssertEqual(TaskSystemSpotlight.searchableIdentifier(for: pageID), pageID.rawValue)
    let url = try XCTUnwrap(TaskSystemSpotlight.contentURL(for: pageID))
    XCTAssertEqual(
      TaskDeepLinkRoute(url: url),
      .task(pageID, list: .today)
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
