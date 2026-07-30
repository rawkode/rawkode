import XCTest
@testable import Scout

private struct SessionBookmarkResolver: BookmarkResolving {
  func resolve(_ grant: AccessGrant) throws -> (url: URL, stale: Bool) {
    (URL(fileURLWithPath: grant.lastKnownPath, isDirectory: true), false)
  }

  func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
}

@MainActor
private final class TestSearchClient: FileSearchClient {
  func startSearch(text: String, roots: [URL], onUpdate: @escaping @MainActor ([FileItem]) -> Void) {}
  func stopSearch() {}
}

private actor CountingFileSystemClient: FileSystemClient {
  private(set) var snapshotCount = 0

  func snapshot(of directory: URL, root: URL, sort: FileSort, showHidden: Bool) async throws -> DirectorySnapshot {
    snapshotCount += 1
    await Task.yield()
    let projectURL = directory.appending(path: "Projects", directoryHint: .isDirectory)
    let item = FileItem(
      id: projectURL,
      url: projectURL,
      name: "Projects",
      contentTypeIdentifier: nil,
      kindDescription: "Folder",
      fileSize: nil,
      creationDate: nil,
      modificationDate: nil,
      isDirectory: true,
      isPackage: false,
      isSymbolicLink: false,
      isHidden: false,
      isReadable: true,
      isWritable: true,
      tags: []
    )
    return DirectorySnapshot(directoryURL: directory, rootURL: root, items: [item], loadedAt: .now)
  }

  func perform(_ request: FileOperationRequest, root: URL) async -> FileOperationResult {
    FileOperationResult(id: UUID(), title: request.title, completedURLs: [], failures: [], undoRequest: nil)
  }
}

final class ModelTests: XCTestCase {
  func testCommandMatchingIncludesKeywords() {
    let command = CommandDescriptor(id: "trash", title: "Move to Trash", subtitle: nil, systemImage: "trash", keyEquivalent: "⌘⌫", keywords: ["delete", "remove"])
    XCTAssertTrue(command.matches("delete"))
    XCTAssertFalse(command.matches("compress"))
  }

  func testWindowRestorationRoundTrip() throws {
    let state = BrowserWindowState(grantID: UUID(), relativePathComponents: ["Projects", "Scout"], viewMode: .columns, inspectorPresented: true, sidebarPresented: true, searchScopeAllRoots: false)
    let data = try JSONEncoder().encode(state)
    XCTAssertEqual(try JSONDecoder().decode(BrowserWindowState.self, from: data), state)
  }

  @MainActor
  func testConcurrentStartOpensRestoredGrantOnce() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let storage = directory.appending(path: "grants.json")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let resolver = SessionBookmarkResolver()
    let root = URL(fileURLWithPath: "/fixture", isDirectory: true)
    let grant = AccessGrant(
      displayName: "Fixture",
      bookmarkData: Data(),
      lastKnownPath: root.path,
      sortOrder: 0,
      requiresSecurityScope: false
    )
    try JSONEncoder().encode([grant]).write(to: storage)
    let store = AccessGrantStore(storageURL: storage, resolver: resolver, seedFixtureWhenRequested: false)
    let broker = SecurityScopeBroker(resolver: resolver)
    let fileSystem = CountingFileSystemClient()
    let workspace = SystemWorkspaceClient()
    let session = BrowserSession(
      grantStore: store,
      scopeBroker: broker,
      fileSystem: fileSystem,
      search: TestSearchClient(),
      workspace: workspace,
      journal: OperationJournal(fileSystem: fileSystem, workspace: workspace, archive: ZIPArchiveClient())
    )

    let first = Task { await session.start() }
    let second = Task { await session.start() }
    await first.value
    await second.value

    XCTAssertEqual(session.activeGrant?.id, grant.id)
    XCTAssertEqual(session.columns.count, 1)
    XCTAssertEqual(session.columns.first?.items.map(\.name), ["Projects"])
    XCTAssertFalse(session.isLoading)
    let snapshotCount = await fileSystem.snapshotCount
    let referenceCount = await broker.activeReferenceCount(for: grant.id)
    XCTAssertEqual(snapshotCount, 1)
    XCTAssertEqual(referenceCount, 1)

    let projectID = try XCTUnwrap(session.columns.first?.items.first?.id)
    await session.select([projectID], in: root)
    XCTAssertEqual(session.columns.count, 2)
    XCTAssertEqual(session.currentDirectory, root.appending(path: "Projects", directoryHint: .isDirectory))
  }
}
