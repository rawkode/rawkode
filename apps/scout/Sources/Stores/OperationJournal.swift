import Foundation
import Observation
import os

@MainActor
@Observable
final class OperationJournal {
  private(set) var notice: OperationNotice?
  private(set) var isBusy = false
  private(set) var progress: Progress?

  private let fileSystem: any FileSystemClient
  private let workspace: any WorkspaceClient
  private let archive: any ArchiveClient
  private let logger = Logger(subsystem: "dev.rawkode.scout", category: "FileOperations")
  private var undoRequest: FileOperationRequest?

  init(
    fileSystem: any FileSystemClient,
    workspace: any WorkspaceClient,
    archive: any ArchiveClient
  ) {
    self.fileSystem = fileSystem
    self.workspace = workspace
    self.archive = archive
  }

  var canUndo: Bool { undoRequest != nil && !isBusy }

  @discardableResult
  func perform(_ request: FileOperationRequest, root: URL) async -> FileOperationResult {
    isBusy = true
    defer {
      isBusy = false
      progress = nil
    }

    let result: FileOperationResult
    switch request {
    case let .trash(sources):
      result = await workspace.trash(sources, root: root)
    case let .compress(sources, destination):
      let progress = Progress(totalUnitCount: Int64(max(1, sources.count)))
      self.progress = progress
      result = await archive.compress(sources: sources, destination: destination, root: root, progress: progress)
    case let .extract(archiveURL, destination):
      let progress = Progress(totalUnitCount: -1)
      self.progress = progress
      result = await archive.extract(archive: archiveURL, destination: destination, root: root, progress: progress)
    default:
      result = await fileSystem.perform(request, root: root)
    }

    undoRequest = result.undoRequest
    publish(result)
    return result
  }

  func undo(root: URL) async {
    guard let request = undoRequest else { return }
    undoRequest = nil
    isBusy = true
    defer { isBusy = false }

    let result: FileOperationResult
    if case let .movePairs(pairs, _) = request,
       pairs.contains(where: { !PathSafety.contains($0.source, within: root) }) {
      result = await workspace.restore(pairs, root: root)
    } else {
      result = await fileSystem.perform(request, root: root)
    }
    publish(result)
  }

  func cancel() { progress?.cancel() }
  func dismissNotice() { notice = nil }

  private func publish(_ result: FileOperationResult) {
    if result.failures.isEmpty {
      notice = OperationNotice(
        id: result.id,
        title: result.title,
        detail: result.completedURLs.count == 1
          ? String(localized: "1 item completed")
          : String(localized: "\(result.completedURLs.count) items completed"),
        isError: false,
        canUndo: result.undoRequest != nil
      )
      logger.info("\(result.title, privacy: .public) completed: \(result.completedURLs.count)")
    } else {
      notice = OperationNotice(
        id: result.id,
        title: result.completedURLs.isEmpty ? String(localized: "Operation Failed") : String(localized: "Completed with Issues"),
        detail: result.failures.map(\.message).joined(separator: "\n"),
        isError: true,
        canUndo: result.undoRequest != nil
      )
      logger.error("\(result.title, privacy: .public) failures: \(result.failures.count)")
    }
  }
}
