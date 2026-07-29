import Foundation
import XCTest
@testable import Scout

final class FileSystemClientTests: XCTestCase {
  private var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  func testEnumerationSortsFoldersFirstAndKeepsUnicodeNames() async throws {
    let client = LocalFileSystemClient()
    try FileManager.default.createDirectory(at: root.appending(path: "مجلد"), withIntermediateDirectories: false)
    XCTAssertTrue(FileManager.default.createFile(atPath: root.appending(path: "éclair.txt").path, contents: Data("hello".utf8)))
    let snapshot = try await client.snapshot(of: root, root: root, sort: FileSort(), showHidden: false)
    XCTAssertEqual(snapshot.items.map(\.name), ["مجلد", "éclair.txt"])
  }

  func testCreateRenameDuplicateAndUndoRequests() async throws {
    let client = LocalFileSystemClient()
    let created = await client.perform(.createFolder(parent: root, name: "Folder"), root: root)
    XCTAssertTrue(created.succeeded)
    XCTAssertNotNil(created.undoRequest)

    let folder = root.appending(path: "Folder")
    let renamed = await client.perform(.rename(source: folder, name: "Renamed", conflict: .stop), root: root)
    XCTAssertTrue(renamed.succeeded)
    XCTAssertTrue(FileManager.default.fileExists(atPath: root.appending(path: "Renamed").path))

    let duplicated = await client.perform(.duplicate(sources: [root.appending(path: "Renamed")]), root: root)
    XCTAssertTrue(duplicated.succeeded)
    XCTAssertEqual(duplicated.completedURLs.first?.lastPathComponent, "Renamed copy")
  }

  func testSymlinkIsNotTraversable() throws {
    let outside = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: outside) }
    let link = root.appending(path: "Outside Link")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
    let values = try link.resourceValues(forKeys: [.nameKey, .isDirectoryKey, .isPackageKey, .isSymbolicLinkKey])
    XCTAssertFalse(FileItem.from(url: link, values: values).isTraversableDirectory)
  }

  func testTwentyThousandItemEnumerationWhenStressTestsEnabled() async throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["SCOUT_STRESS_TEST"] == "1")
    for index in 0..<20_000 {
      XCTAssertTrue(FileManager.default.createFile(atPath: root.appending(path: "item-\(index)").path, contents: Data()))
    }
    let snapshot = try await LocalFileSystemClient().snapshot(of: root, root: root, sort: FileSort(), showHidden: false)
    XCTAssertEqual(snapshot.items.count, 20_000)
  }
}
