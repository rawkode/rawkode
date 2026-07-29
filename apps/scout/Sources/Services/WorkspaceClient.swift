import AppKit
import Foundation

@MainActor
protocol WorkspaceClient: Sendable {
  func open(_ urls: [URL])
  func reveal(_ urls: [URL])
  func applications(toOpen url: URL) -> [URL]
  func open(_ url: URL, with applicationURL: URL) async throws
  func trash(_ urls: [URL], root: URL) async -> FileOperationResult
  func restore(_ pairs: [FileMovePair], root: URL) async -> FileOperationResult
}

@MainActor
final class SystemWorkspaceClient: WorkspaceClient {
  func open(_ urls: [URL]) {
    for url in urls { NSWorkspace.shared.open(url) }
  }

  func reveal(_ urls: [URL]) {
    NSWorkspace.shared.activateFileViewerSelecting(urls)
  }

  func applications(toOpen url: URL) -> [URL] {
    NSWorkspace.shared.urlsForApplications(toOpen: url)
  }

  func open(_ url: URL, with applicationURL: URL) async throws {
    let configuration = NSWorkspace.OpenConfiguration()
    _ = try await NSWorkspace.shared.open(
      [url],
      withApplicationAt: applicationURL,
      configuration: configuration
    )
  }

  func trash(_ urls: [URL], root: URL) async -> FileOperationResult {
    var completed: [URL] = []
    var failures: [FileOperationFailure] = []
    var inverse: [FileMovePair] = []

    for url in urls {
      guard PathSafety.contains(url, within: root) else {
        failures.append(FileOperationFailure(url: url, message: String(localized: "This item is outside the granted location.")))
        continue
      }

      do {
        var resultingURL: NSURL?
        try FileManager.default.trashItem(at: url, resultingItemURL: &resultingURL)
        guard let trashedURL = resultingURL as URL? else { continue }
        completed.append(trashedURL)
        inverse.append(FileMovePair(source: trashedURL, destination: url))
      } catch {
        failures.append(FileOperationFailure(url: url, message: error.localizedDescription))
      }
    }

    return FileOperationResult(
      id: UUID(),
      title: String(localized: "Move to Trash"),
      completedURLs: completed,
      failures: failures,
      undoRequest: inverse.isEmpty ? nil : .movePairs(inverse, conflict: .stop)
    )
  }

  func restore(_ pairs: [FileMovePair], root: URL) async -> FileOperationResult {
    var completed: [URL] = []
    var failures: [FileOperationFailure] = []

    for pair in pairs {
      guard PathSafety.contains(pair.destination, within: root) else {
        failures.append(FileOperationFailure(url: pair.destination, message: String(localized: "The restore destination is outside the granted location.")))
        continue
      }
      do {
        try FileManager.default.moveItem(at: pair.source, to: pair.destination)
        completed.append(pair.destination)
      } catch {
        failures.append(FileOperationFailure(url: pair.source, message: error.localizedDescription))
      }
    }

    return FileOperationResult(
      id: UUID(),
      title: String(localized: "Restore from Trash"),
      completedURLs: completed,
      failures: failures,
      undoRequest: nil
    )
  }
}
