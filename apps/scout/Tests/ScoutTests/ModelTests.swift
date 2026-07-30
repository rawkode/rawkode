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

private actor RacingFileSystemClient: FileSystemClient {
  let root: URL

  init(root: URL) {
    self.root = root
  }

  func snapshot(of directory: URL, root: URL, sort: FileSort, showHidden: Bool) async throws -> DirectorySnapshot {
    let items: [FileItem]
    switch directory.lastPathComponent {
    case "Slow":
      try await Task.sleep(for: .milliseconds(120))
      items = [folder(named: "Old", inside: directory)]
    case "Fast":
      try await Task.sleep(for: .milliseconds(5))
      items = [folder(named: "Current", inside: directory)]
    default:
      items = [folder(named: "Slow", inside: self.root), folder(named: "Fast", inside: self.root)]
    }
    return DirectorySnapshot(directoryURL: directory, rootURL: root, items: items, loadedAt: .now)
  }

  func perform(_ request: FileOperationRequest, root: URL) async -> FileOperationResult {
    FileOperationResult(id: UUID(), title: request.title, completedURLs: [], failures: [], undoRequest: nil)
  }

  private func folder(named name: String, inside directory: URL) -> FileItem {
    let url = directory.appending(path: name, directoryHint: .isDirectory)
    return FileItem(
      id: url, url: url, name: name, contentTypeIdentifier: nil, kindDescription: "Folder",
      fileSize: nil, creationDate: nil, modificationDate: nil,
      isDirectory: true, isPackage: false, isSymbolicLink: false,
      isHidden: false, isReadable: true, isWritable: true, tags: []
    )
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

  @MainActor
  func testRapidFolderSelectionKeepsLatestColumn() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let storage = directory.appending(path: "grants.json")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let resolver = SessionBookmarkResolver()
    let root = URL(fileURLWithPath: "/fixture", isDirectory: true)
    let grant = AccessGrant(
      displayName: "Fixture", bookmarkData: Data(), lastKnownPath: root.path,
      sortOrder: 0, requiresSecurityScope: false
    )
    try JSONEncoder().encode([grant]).write(to: storage)
    let store = AccessGrantStore(storageURL: storage, resolver: resolver, seedFixtureWhenRequested: false)
    let broker = SecurityScopeBroker(resolver: resolver)
    let fileSystem = RacingFileSystemClient(root: root)
    let workspace = SystemWorkspaceClient()
    let session = BrowserSession(
      grantStore: store,
      scopeBroker: broker,
      fileSystem: fileSystem,
      search: TestSearchClient(),
      workspace: workspace,
      journal: OperationJournal(fileSystem: fileSystem, workspace: workspace, archive: ZIPArchiveClient())
    )
    await session.start()

    let slowID = try XCTUnwrap(session.columns.first?.items.first(where: { $0.name == "Slow" })?.id)
    let fastID = try XCTUnwrap(session.columns.first?.items.first(where: { $0.name == "Fast" })?.id)
    let slowSelection = Task { await session.select([slowID], in: root) }
    await Task.yield()
    let fastSelection = Task { await session.select([fastID], in: root) }
    await slowSelection.value
    await fastSelection.value

    XCTAssertEqual(session.currentDirectory, root.appending(path: "Fast", directoryHint: .isDirectory))
    XCTAssertEqual(session.columns.last?.items.map(\.name), ["Current"])
  }
}
