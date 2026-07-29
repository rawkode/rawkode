import Foundation

protocol FileSystemClient: Sendable {
  func snapshot(of directory: URL, root: URL, sort: FileSort, showHidden: Bool) async throws -> DirectorySnapshot
  func perform(_ request: FileOperationRequest, root: URL) async -> FileOperationResult
}

actor LocalFileSystemClient: FileSystemClient {
  private let fileManager = FileManager()

  func snapshot(
    of directory: URL,
    root: URL,
    sort: FileSort,
    showHidden: Bool
  ) async throws -> DirectorySnapshot {
    guard PathSafety.contains(directory, within: root) else {
      throw CocoaError(.fileReadNoPermission, userInfo: [NSURLErrorKey: directory])
    }

    let resourceKeys: Set<URLResourceKey> = [
      .nameKey, .contentTypeKey, .fileSizeKey, .creationDateKey,
      .contentModificationDateKey, .isDirectoryKey, .isPackageKey,
      .isSymbolicLinkKey, .isHiddenKey, .isReadableKey, .isWritableKey, .tagNamesKey,
    ]
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var result: Result<[FileItem], Error>!

    coordinator.coordinate(readingItemAt: directory, options: [.withoutChanges], error: &coordinationError) { coordinatedURL in
      do {
        let urls = try fileManager.contentsOfDirectory(
          at: coordinatedURL,
          includingPropertiesForKeys: Array(resourceKeys),
          options: showHidden ? [] : [.skipsHiddenFiles]
        )
        let items = try urls.map { url in
          let values = try url.resourceValues(forKeys: resourceKeys)
          return FileItem.from(url: url, values: values)
        }
        result = .success(Self.sorted(items, by: sort))
      } catch {
        result = .failure(error)
      }
    }

    if let coordinationError { throw coordinationError }
    let items = try result.get()
    return DirectorySnapshot(directoryURL: directory, rootURL: root, items: items, loadedAt: .now)
  }

  func perform(_ request: FileOperationRequest, root: URL) async -> FileOperationResult {
    var completed: [URL] = []
    var failures: [FileOperationFailure] = []
    var undo: FileOperationRequest?

    func recordFailure(_ url: URL, _ error: Error) {
      failures.append(FileOperationFailure(url: url, message: error.localizedDescription))
    }

    do {
      switch request {
      case let .createFolder(parent, name):
        try requireContained(parent, root: root)
        let destination = parent.appending(path: name, directoryHint: .isDirectory)
        try requireContained(destination, root: root)
        try coordinatedWrite(destination) { url in
          try fileManager.createDirectory(at: url, withIntermediateDirectories: false)
        }
        completed = [destination]
        undo = .removeCreatedItems(completed)

      case let .rename(source, name, conflict):
        try requireContained(source, root: root)
        let requested = source.deletingLastPathComponent().appending(path: name)
        let destination = try resolvedDestination(requested, conflict: conflict)
        try requireContained(destination, root: root)
        try coordinatedMove(source, destination)
        completed = [destination]
        undo = .movePairs([FileMovePair(source: destination, destination: source)], conflict: .stop)

      case let .copy(sources, destination, conflict):
        try requireContained(destination, root: root)
        for source in sources {
          do {
            try requireContained(source, root: root)
            let requested = destination.appending(path: source.lastPathComponent)
            let target = try resolvedDestination(requested, conflict: conflict)
            try coordinatedWrite(target) { target in try fileManager.copyItem(at: source, to: target) }
            completed.append(target)
          } catch { recordFailure(source, error) }
        }
        if !completed.isEmpty { undo = .removeCreatedItems(completed) }

      case let .move(sources, destination, conflict):
        try requireContained(destination, root: root)
        var inverse: [FileMovePair] = []
        for source in sources {
          do {
            try requireContained(source, root: root)
            let target = try resolvedDestination(destination.appending(path: source.lastPathComponent), conflict: conflict)
            try coordinatedMove(source, target)
            completed.append(target)
            inverse.append(FileMovePair(source: target, destination: source))
          } catch { recordFailure(source, error) }
        }
        if !inverse.isEmpty { undo = .movePairs(inverse, conflict: .stop) }

      case let .movePairs(pairs, conflict):
        var inverse: [FileMovePair] = []
        for pair in pairs {
          do {
            try requireContained(pair.source, root: root)
            try requireContained(pair.destination, root: root)
            let destination = try resolvedDestination(pair.destination, conflict: conflict)
            try coordinatedMove(pair.source, destination)
            completed.append(destination)
            inverse.append(FileMovePair(source: destination, destination: pair.source))
          } catch { recordFailure(pair.source, error) }
        }
        if !inverse.isEmpty { undo = .movePairs(inverse, conflict: .stop) }

      case let .duplicate(sources):
        for source in sources {
          do {
            try requireContained(source, root: root)
            let destination = PathSafety.uniqueURL(
              for: source.deletingLastPathComponent().appending(path: source.deletingPathExtension().lastPathComponent + " copy")
                .appendingPathExtension(source.pathExtension),
              fileManager: fileManager
            )
            try coordinatedWrite(destination) { destination in try fileManager.copyItem(at: source, to: destination) }
            completed.append(destination)
          } catch { recordFailure(source, error) }
        }
        if !completed.isEmpty { undo = .removeCreatedItems(completed) }

      case .trash:
        failures.append(FileOperationFailure(url: root, message: String(localized: "Trash is handled by the workspace service.")))

      case let .setTags(sources, tags):
        for source in sources {
          do {
            try requireContained(source, root: root)
            var values = URLResourceValues()
            values.tagNames = tags
            var mutableSource = source
            try mutableSource.setResourceValues(values)
            completed.append(source)
          } catch { recordFailure(source, error) }
        }

      case .compress, .extract:
        failures.append(FileOperationFailure(url: root, message: String(localized: "Archives are handled by the archive service.")))

      case let .removeCreatedItems(urls):
        for url in urls {
          do {
            try requireContained(url, root: root)
            try coordinatedWrite(url) { url in try fileManager.removeItem(at: url) }
            completed.append(url)
          } catch { recordFailure(url, error) }
        }
      }
    } catch {
      failures.append(FileOperationFailure(url: root, message: error.localizedDescription))
    }

    return FileOperationResult(
      id: UUID(), title: request.title, completedURLs: completed, failures: failures, undoRequest: undo
    )
  }

  private func requireContained(_ url: URL, root: URL) throws {
    guard PathSafety.contains(url, within: root) else {
      throw CocoaError(.fileWriteNoPermission, userInfo: [NSURLErrorKey: url])
    }
  }

  private func resolvedDestination(_ requested: URL, conflict: ConflictResolution) throws -> URL {
    guard fileManager.fileExists(atPath: requested.path) else { return requested }
    switch conflict {
    case .stop:
      throw CocoaError(.fileWriteFileExists, userInfo: [NSURLErrorKey: requested])
    case .keepBoth:
      return PathSafety.uniqueURL(for: requested, fileManager: fileManager)
    case .replace:
      try coordinatedWrite(requested) { url in try fileManager.removeItem(at: url) }
      return requested
    }
  }

  private func coordinatedMove(_ source: URL, _ destination: URL) throws {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var operationError: Error?
    coordinator.coordinate(
      writingItemAt: source, options: .forMoving,
      writingItemAt: destination, options: .forReplacing,
      error: &coordinationError
    ) { coordinatedSource, coordinatedDestination in
      do { try fileManager.moveItem(at: coordinatedSource, to: coordinatedDestination) }
      catch { operationError = error }
    }
    if let coordinationError { throw coordinationError }
    if let operationError { throw operationError }
  }

  private func coordinatedWrite(_ url: URL, operation: (URL) throws -> Void) throws {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var operationError: Error?
    coordinator.coordinate(writingItemAt: url, options: [], error: &coordinationError) { coordinatedURL in
      do { try operation(coordinatedURL) } catch { operationError = error }
    }
    if let coordinationError { throw coordinationError }
    if let operationError { throw operationError }
  }

  private static func sorted(_ items: [FileItem], by sort: FileSort) -> [FileItem] {
    items.sorted { lhs, rhs in
      if sort.foldersFirst && lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
      let comparison: ComparisonResult
      switch sort.field {
      case .name: comparison = lhs.name.localizedStandardCompare(rhs.name)
      case .kind: comparison = lhs.kindDescription.localizedStandardCompare(rhs.kindDescription)
      case .size: comparison = (lhs.fileSize ?? 0) < (rhs.fileSize ?? 0) ? .orderedAscending : .orderedDescending
      case .modified: comparison = (lhs.modificationDate ?? .distantPast) < (rhs.modificationDate ?? .distantPast) ? .orderedAscending : .orderedDescending
      }
      return sort.ascending ? comparison != .orderedDescending : comparison == .orderedDescending
    }
  }
}
