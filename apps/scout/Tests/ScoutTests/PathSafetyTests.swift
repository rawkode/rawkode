import Foundation
import XCTest
@testable import Scout

final class PathSafetyTests: XCTestCase {
  func testRootContainmentUsesWholePathComponents() {
    let root = URL(fileURLWithPath: "/tmp/scout/root", isDirectory: true)
    XCTAssertTrue(PathSafety.contains(root.appending(path: "child"), within: root))
    XCTAssertFalse(PathSafety.contains(URL(fileURLWithPath: "/tmp/scout/root-escape"), within: root))
    XCTAssertFalse(PathSafety.contains(root.appending(path: "../escape"), within: root))
  }

  func testArchiveTraversalIsRejected() {
    let destination = URL(fileURLWithPath: "/tmp/scout/extract", isDirectory: true)
    XCTAssertNil(PathSafety.safeArchiveDestination(for: "../outside", within: destination))
    XCTAssertNil(PathSafety.safeArchiveDestination(for: "/absolute", within: destination))
    XCTAssertNil(PathSafety.safeArchiveDestination(for: "safe/../../outside", within: destination))
    XCTAssertNotNil(PathSafety.safeArchiveDestination(for: "safe/document.txt", within: destination))
  }

  func testConflictNamingPreservesExtension() throws {
    let base = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let original = base.appending(path: "Scout.zip")
    XCTAssertTrue(FileManager.default.createFile(atPath: original.path, contents: Data()))
    XCTAssertEqual(PathSafety.uniqueURL(for: original).lastPathComponent, "Scout 2.zip")
  }
}
