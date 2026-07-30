import Foundation
import ZIPFoundation

protocol ArchiveClient: Sendable {
  func compress(sources: [URL], destination: URL, root: URL, progress: Progress) async -> FileOperationResult
  func extract(archive: URL, destination: URL, root: URL, progress: Progress) async -> FileOperationResult
}

actor ZIPArchiveClient: ArchiveClient {
  private let fileManager = FileManager()

  func compress(
    sources: [URL],
    destination: URL,
    root: URL,
    progress: Progress
  ) async -> FileOperationResult {
    var failures: [FileOperationFailure] = []

    do {
      guard !sources.isEmpty,
            sources.allSatisfy({ PathSafety.contains($0, within: root) }),
            PathSafety.contains(destination, within: root)
      else { throw CocoaError(.fileWriteNoPermission) }

      let archive = try Archive(url: destination, accessMode: .create)
      progress.totalUnitCount = Int64(sources.count)
      for source in sources {
        if progress.isCancelled { throw CancellationError() }
        let itemProgress = Progress(totalUnitCount: 1, parent: progress, pendingUnitCount: 1)
        try archive.addEntry(
          with: source.lastPathComponent,
          relativeTo: source.deletingLastPathComponent(),
          compressionMethod: .deflate,
          progress: itemProgress
        )
      }
    } catch {
      try? fileManager.removeItem(at: destination)
      failures.append(FileOperationFailure(url: destination, message: error.localizedDescription))
    }

    return FileOperationResult(
      id: UUID(),
      title: String(localized: "Compress"),
      completedURLs: failures.isEmpty ? [destination] : [],
      failures: failures,
      undoRequest: failures.isEmpty ? .removeCreatedItems([destination]) : nil
    )
  }

  func extract(
    archive archiveURL: URL,
    destination: URL,
    root: URL,
    progress: Progress
  ) async -> FileOperationResult {
    var completed: [URL] = []
    var failures: [FileOperationFailure] = []

    do {
      guard PathSafety.contains(archiveURL, within: root),
            PathSafety.contains(destination, within: root)
      else { throw CocoaError(.fileWriteNoPermission) }

      let archive = try Archive(url: archiveURL, accessMode: .read)

      let entries = Array(archive)
      for entry in entries {
        guard PathSafety.safeArchiveDestination(for: entry.path, within: destination) != nil,
              entry.type != .symlink
        else { throw ArchiveSafetyError.unsafeEntry(entry.path) }
      }

      progress.totalUnitCount = Int64(entries.count)
      for entry in entries {
        if progress.isCancelled { throw CancellationError() }
        guard let target = PathSafety.safeArchiveDestination(for: entry.path, within: destination) else {
          throw ArchiveSafetyError.unsafeEntry(entry.path)
        }
        let entryProgress = Progress(totalUnitCount: 1, parent: progress, pendingUnitCount: 1)
        _ = try archive.extract(entry, to: target, progress: entryProgress)
        completed.append(target)
      }
    } catch {
      for url in completed.sorted(by: { $0.pathComponents.count > $1.pathComponents.count }) {
        try? fileManager.removeItem(at: url)
      }
      completed = []
      failures.append(FileOperationFailure(url: archiveURL, message: error.localizedDescription))
    }

    return FileOperationResult(
      id: UUID(),
      title: String(localized: "Extract"),
      completedURLs: completed,
      failures: failures,
      undoRequest: completed.isEmpty ? nil : .removeCreatedItems(completed)
    )
  }
}

enum ArchiveSafetyError: LocalizedError, Equatable {
  case unsafeEntry(String)

  var errorDescription: String? {
    switch self {
    case let .unsafeEntry(path):
      String(localized: "The archive contains an unsafe path: \(path)")
    }
  }
}
