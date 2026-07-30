import AppKit
import Foundation
import Observation
import os
import UniformTypeIdentifiers

@MainActor
@Observable
final class BrowserSession: Identifiable {
  let id = UUID()
  var viewMode: BrowserViewMode = .columns
  var columns: [BrowserColumn] = []
  var searchText = ""
  var searchResults: [FileItem] = []
  var inspectorPresented = false
  var sidebarPresented = true
  var searchScopeAllRoots = false
  var showHiddenItems = false
  var sort = FileSort()
  var isLoading = false
  var errorMessage: String?
  var commandPalettePresented = false
  var pathNavigatorPresented = false
  var renamePresented = false
  var renameText = ""
  var tagsPresented = false
  var tagText = ""
  var searchFieldRequested = false
  var pendingConflict: PendingConflict?

  private(set) var activeGrant: AccessGrant?
  private(set) var rootURL: URL?
  private(set) var selectedIDs: Set<FileItem.ID> = []

  let grantStore: AccessGrantStore
  let workspace: any WorkspaceClient
  let journal: OperationJournal

  private let scopeBroker: SecurityScopeBroker
  private let fileSystem: any FileSystemClient
  private let search: any FileSearchClient
  private let presentationController = DirectoryPresentationController()
  private let iCloudDriveProvider: any ICloudDriveProviding
  private let logger = Logger(subsystem: "dev.rawkode.scout", category: "BrowserSession")
  private var hasStarted = false
  private var openingGrantID: AccessGrant.ID?
  private var selectionRevision = 0

  init(
    grantStore: AccessGrantStore,
    scopeBroker: SecurityScopeBroker,
    fileSystem: any FileSystemClient,
    search: any FileSearchClient,
    workspace: any WorkspaceClient,
    journal: OperationJournal,
    iCloudDriveProvider: any ICloudDriveProviding = SystemICloudDriveProvider()
  ) {
    self.grantStore = grantStore
    self.scopeBroker = scopeBroker
    self.fileSystem = fileSystem
    self.search = search
    self.workspace = workspace
    self.journal = journal
    self.iCloudDriveProvider = iCloudDriveProvider
  }

  isolated deinit {
    let broker = scopeBroker
    let grantID = activeGrant?.id
    Task {
      if let grantID { await broker.release(grantID: grantID) }
    }
  }

  var displayedItems: [FileItem] {
    searchText.isEmpty ? (columns.last?.items ?? []) : searchResults
  }

  var selectedItems: [FileItem] {
    let allItems = searchText.isEmpty ? columns.flatMap(\.items) : searchResults
    return allItems.filter { selectedIDs.contains($0.id) }
  }

  var currentDirectory: URL? {
    columns.last?.directoryURL ?? rootURL
  }

  var canNavigateUp: Bool {
    guard let currentDirectory, let rootURL else { return false }
    return currentDirectory.standardizedFileURL != rootURL.standardizedFileURL
  }

  var windowTitle: String {
    currentDirectory?.lastPathComponent ?? activeGrant?.displayName ?? String(localized: "Scout")
  }

  var iCloudDriveDestination: AccessGrant? {
    guard let rootURL = iCloudDriveProvider.rootURL() else { return nil }
    return .iCloudDrive(rootURL: rootURL)
  }

  var isICloudDriveAvailable: Bool {
    iCloudDriveDestination != nil
  }

  func start() async {
    guard !hasStarted else { return }
    hasStarted = true
    if activeGrant == nil {
      if iCloudDriveDestination != nil {
        await openICloudDrive()
      } else if let first = grantStore.orderedGrants.first {
        await open(first)
      }
    }
  }

  func openICloudDrive(relativePathComponents: [String] = []) async {
    guard let destination = iCloudDriveDestination else {
      errorMessage = String(localized: "iCloud Drive is unavailable. Sign in to iCloud and try again.")
      return
    }

    do {
      try FileManager.default.createDirectory(
        at: URL(fileURLWithPath: destination.lastKnownPath, isDirectory: true),
        withIntermediateDirectories: true
      )
      await open(destination, relativePathComponents: relativePathComponents)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func open(_ grant: AccessGrant, relativePathComponents: [String] = []) async {
    guard openingGrantID != grant.id else { return }
    openingGrantID = grant.id
    isLoading = true
    errorMessage = nil
    defer {
      openingGrantID = nil
      isLoading = false
    }
    presentationController.stop()
    search.stopSearch()
    selectionRevision += 1

    if let previousID = activeGrant?.id { await scopeBroker.release(grantID: previousID) }
    activeGrant = nil
    rootURL = nil
    columns = []
    selectedIDs = []

    do {
      let access = try await scopeBroker.acquire(grant)
      activeGrant = grant
      rootURL = access.url.standardizedFileURL
      if let refreshedBookmarkData = access.refreshedBookmarkData {
        try grantStore.updateLocalBookmark(
          grantID: grant.id, bookmarkData: refreshedBookmarkData, url: access.url
        )
      }

      var destination = access.url
      for component in relativePathComponents {
        destination.append(path: component, directoryHint: .isDirectory)
      }
      if !PathSafety.contains(destination, within: access.url) { destination = access.url }
      await loadPath(to: destination)
      logger.info("Opened grant \(grant.displayName, privacy: .public)")
    } catch {
      errorMessage = error.localizedDescription
      logger.error("Unable to open grant: \(error.localizedDescription, privacy: .public)")
    }
  }

  func refresh() async {
    guard !isLoading, let rootURL else { return }
    let directories = columns.map(\.directoryURL)
    for (index, directory) in directories.enumerated() {
      do {
        let snapshot = try await fileSystem.snapshot(
          of: directory, root: rootURL, sort: sort, showHidden: showHiddenItems
        )
        guard columns.indices.contains(index), columns[index].directoryURL == directory else { continue }
        columns[index].items = snapshot.items
        columns[index].selectedIDs.formIntersection(Set(snapshot.items.map(\.id)))
      } catch {
        errorMessage = error.localizedDescription
      }
    }
    updatePresentation()
  }

  func select(_ ids: Set<FileItem.ID>, in directory: URL? = nil) async {
    selectionRevision += 1
    let revision = selectionRevision
    selectedIDs = ids
    if let directory, let index = columns.firstIndex(where: { $0.directoryURL == directory }) {
      columns[index].selectedIDs = ids
      if ids.count == 1,
         let selectedID = ids.first,
         let item = columns[index].items.first(where: { $0.id == selectedID }),
         item.isTraversableDirectory {
        await loadDirectory(item.url, afterColumn: index, selectedID: item.id, revision: revision)
      } else {
        columns.removeSubrange((index + 1)..<columns.endIndex)
      }
    }
  }

  func activate(_ item: FileItem) async {
    if item.isTraversableDirectory {
      await loadPath(to: item.url)
    } else {
      workspace.open([item.url])
    }
  }

  func openSelection() async {
    let selection = selectedItems
    guard !selection.isEmpty else { return }
    if selection.count == 1, let item = selection.first, item.isTraversableDirectory {
      await loadPath(to: item.url)
    } else {
      workspace.open(selection.map(\.url))
    }
  }

  func showPackageContents() async {
    guard selectedItems.count == 1, let item = selectedItems.first, item.isPackage else { return }
    await loadPath(to: item.url)
  }

  func navigateUp() async {
    guard let currentDirectory, let rootURL, canNavigateUp else { return }
    let parent = currentDirectory.deletingLastPathComponent()
    if PathSafety.contains(parent, within: rootURL) { await loadPath(to: parent) }
  }

  func navigate(to exactPath: String) async {
    guard let rootURL else { return }
    let expanded = NSString(string: exactPath).expandingTildeInPath
    let url = URL(fileURLWithPath: expanded, isDirectory: true).standardizedFileURL
    guard PathSafety.contains(url, within: rootURL) else {
      errorMessage = String(localized: "That path is outside the granted location.")
      return
    }
    await loadPath(to: url)
  }

  func changeViewMode(_ mode: BrowserViewMode) {
    viewMode = mode
  }

  func beginSearch() {
    guard let rootURL else { return }
    search.startSearch(text: searchText, roots: [rootURL]) { [weak self] items in
      self?.searchResults = items
      self?.selectedIDs.formIntersection(Set(items.map(\.id)))
    }
  }

  func endSearch() {
    search.stopSearch()
    searchResults = []
  }

  func createFolder(named name: String = String(localized: "Untitled Folder")) async {
    guard let currentDirectory, let rootURL else { return }
    let target = currentDirectory.appending(path: name, directoryHint: .isDirectory)
    let finalName = PathSafety.uniqueURL(for: target).lastPathComponent
    _ = await journal.perform(.createFolder(parent: currentDirectory, name: finalName), root: rootURL)
    await refresh()
  }

  func beginRename() {
    guard selectedItems.count == 1, let item = selectedItems.first else { return }
    renameText = item.name
    renamePresented = true
  }

  func commitRename() async {
    defer { renamePresented = false }
    guard selectedItems.count == 1,
          let item = selectedItems.first,
          let rootURL,
          !renameText.isEmpty,
          renameText != item.name
    else { return }
    let request = FileOperationRequest.rename(source: item.url, name: renameText, conflict: .stop)
    guard await performCheckingConflicts(request, root: rootURL) else { return }
    await refresh()
  }

  func duplicateSelection() async {
    guard let rootURL, !selectedItems.isEmpty else { return }
    _ = await journal.perform(.duplicate(sources: selectedItems.map(\.url)), root: rootURL)
    await refresh()
  }

  func trashSelection() async {
    guard let rootURL, !selectedItems.isEmpty else { return }
    _ = await journal.perform(.trash(sources: selectedItems.map(\.url)), root: rootURL)
    selectedIDs = []
    await refresh()
  }

  func compressSelection() async {
    guard let rootURL, let currentDirectory, !selectedItems.isEmpty else { return }
    let name = selectedItems.count == 1 ? selectedItems[0].url.deletingPathExtension().lastPathComponent : String(localized: "Archive")
    let destination = PathSafety.uniqueURL(for: currentDirectory.appending(path: name).appendingPathExtension("zip"))
    _ = await journal.perform(.compress(sources: selectedItems.map(\.url), destination: destination), root: rootURL)
    await refresh()
  }

  func extractSelection() async {
    guard let rootURL, let currentDirectory, selectedItems.count == 1, let item = selectedItems.first else { return }
    _ = await journal.perform(.extract(archive: item.url, destination: currentDirectory), root: rootURL)
    await refresh()
  }

  func setTags(_ tags: [String]) async {
    guard let rootURL, !selectedItems.isEmpty else { return }
    _ = await journal.perform(.setTags(sources: selectedItems.map(\.url), tags: tags), root: rootURL)
    await refresh()
  }

  func beginEditingTags() {
    guard !selectedItems.isEmpty else { return }
    tagText = selectedItems.first?.tags.joined(separator: ", ") ?? ""
    tagsPresented = true
  }

  func commitTags() async {
    let tags = tagText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    tagsPresented = false
    await setTags(tags)
  }

  func chooseApplicationForSelection() async {
    guard selectedItems.count == 1, let item = selectedItems.first else { return }
    let panel = NSOpenPanel()
    panel.title = String(localized: "Open With")
    panel.prompt = String(localized: "Open")
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = false
    panel.allowedContentTypes = [.application]
    panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
    guard await panel.begin() == .OK, let applicationURL = panel.url else { return }
    do {
      try await workspace.open(item.url, with: applicationURL)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func copySelection() {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.writeObjects(selectedItems.map(\.url) as [NSURL])
  }

  func paste(move: Bool = false) async {
    guard let rootURL, let currentDirectory else { return }
    let urls = NSPasteboard.general.readObjects(forClasses: [NSURL.self]) as? [URL] ?? []
    let contained = urls.filter { PathSafety.contains($0, within: rootURL) }
    guard !contained.isEmpty else {
      errorMessage = String(localized: "Scout can only paste items from the active granted location.")
      return
    }
    let request: FileOperationRequest = move
      ? .move(sources: contained, destination: currentDirectory, conflict: .stop)
      : .copy(sources: contained, destination: currentDirectory, conflict: .stop)
    guard await performCheckingConflicts(request, root: rootURL) else { return }
    await refresh()
  }

  func transfer(_ urls: [URL], move: Bool) async {
    guard let rootURL, let currentDirectory else { return }
    let contained = urls.filter { PathSafety.contains($0, within: rootURL) }
    guard contained.count == urls.count else {
      errorMessage = String(localized: "Scout can only transfer items inside the active granted location.")
      return
    }
    let request: FileOperationRequest = move
      ? .move(sources: contained, destination: currentDirectory, conflict: .stop)
      : .copy(sources: contained, destination: currentDirectory, conflict: .stop)
    guard await performCheckingConflicts(request, root: rootURL) else { return }
    await refresh()
  }

  func resolveConflict(_ resolution: ConflictResolution) async {
    guard let pendingConflict, let rootURL else { return }
    self.pendingConflict = nil
    guard resolution != .stop else { return }
    let request = pendingConflict.request.withConflictResolution(resolution)
    _ = await journal.perform(request, root: rootURL)
    await refresh()
  }

  func undo() async {
    guard let rootURL else { return }
    await journal.undo(root: rootURL)
    await refresh()
  }

  func restorationState() -> BrowserWindowState {
    let relative: [String]
    if let rootURL, let currentDirectory, PathSafety.contains(currentDirectory, within: rootURL) {
      relative = Array(currentDirectory.standardizedFileURL.pathComponents.dropFirst(rootURL.standardizedFileURL.pathComponents.count))
    } else {
      relative = []
    }
    return BrowserWindowState(
      grantID: activeGrant?.id,
      relativePathComponents: relative,
      viewMode: viewMode,
      inspectorPresented: inspectorPresented,
      sidebarPresented: sidebarPresented,
      searchScopeAllRoots: searchScopeAllRoots
    )
  }

  func restore(_ state: BrowserWindowState) async {
    guard !hasStarted else { return }
    hasStarted = true
    viewMode = state.viewMode
    inspectorPresented = state.inspectorPresented
    sidebarPresented = state.sidebarPresented
    searchScopeAllRoots = state.searchScopeAllRoots
    if let id = state.grantID,
       id == iCloudDriveDestination?.id {
      await openICloudDrive(relativePathComponents: state.relativePathComponents)
    } else if let id = state.grantID, let grant = grantStore.grants.first(where: { $0.id == id }) {
      await open(grant, relativePathComponents: state.relativePathComponents)
    } else {
      if iCloudDriveDestination != nil {
        await openICloudDrive()
      } else if let first = grantStore.orderedGrants.first {
        await open(first)
      }
    }
  }

  private func loadPath(to destination: URL) async {
    guard let rootURL, PathSafety.contains(destination, within: rootURL) else { return }
    let relative = Array(destination.standardizedFileURL.pathComponents.dropFirst(rootURL.standardizedFileURL.pathComponents.count))
    var directories = [rootURL]
    var cursor = rootURL
    for component in relative {
      cursor.append(path: component, directoryHint: .isDirectory)
      directories.append(cursor)
    }

    var loaded: [BrowserColumn] = []
    do {
      for directory in directories {
        let snapshot = try await fileSystem.snapshot(of: directory, root: rootURL, sort: sort, showHidden: showHiddenItems)
        loaded.append(BrowserColumn(directoryURL: directory, items: snapshot.items))
      }
      columns = loaded
      selectedIDs = []
      updatePresentation()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func loadDirectory(
    _ directory: URL,
    afterColumn index: Int,
    selectedID: FileItem.ID,
    revision: Int
  ) async {
    guard let rootURL else { return }
    do {
      let snapshot = try await fileSystem.snapshot(of: directory, root: rootURL, sort: sort, showHidden: showHiddenItems)
      guard revision == selectionRevision,
            columns.indices.contains(index),
            columns[index].selectedIDs == [selectedID]
      else { return }
      if index + 1 < columns.count { columns.removeSubrange((index + 1)..<columns.endIndex) }
      columns.append(BrowserColumn(directoryURL: directory, items: snapshot.items))
      updatePresentation()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func updatePresentation() {
    guard let currentDirectory else { return }
    presentationController.observe(currentDirectory) { [weak self] in
      Task { await self?.refresh() }
    }
  }

  private func performCheckingConflicts(_ request: FileOperationRequest, root: URL) async -> Bool {
    let conflicts = request.conflictingDestinations(fileManager: .default)
    if !conflicts.isEmpty {
      pendingConflict = PendingConflict(request: request, conflictingURLs: conflicts)
      return false
    }
    _ = await journal.perform(request, root: root)
    return true
  }
}

private extension FileOperationRequest {
  func conflictingDestinations(fileManager: FileManager) -> [URL] {
    let destinations: [URL]
    switch self {
    case let .rename(source, name, _):
      destinations = [source.deletingLastPathComponent().appending(path: name)]
    case let .copy(sources, destination, _), let .move(sources, destination, _):
      destinations = sources.map { destination.appending(path: $0.lastPathComponent) }
    case let .movePairs(pairs, _):
      destinations = pairs.map(\.destination)
    default:
      destinations = []
    }
    return destinations.filter { fileManager.fileExists(atPath: $0.path) }
  }

  func withConflictResolution(_ resolution: ConflictResolution) -> FileOperationRequest {
    switch self {
    case let .rename(source, name, _): .rename(source: source, name: name, conflict: resolution)
    case let .copy(sources, destination, _): .copy(sources: sources, destination: destination, conflict: resolution)
    case let .move(sources, destination, _): .move(sources: sources, destination: destination, conflict: resolution)
    case let .movePairs(pairs, _): .movePairs(pairs, conflict: resolution)
    default: self
    }
  }
}
