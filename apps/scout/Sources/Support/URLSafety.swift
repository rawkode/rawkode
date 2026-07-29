import Foundation

enum PathSafety {
  static func contains(_ child: URL, within root: URL) -> Bool {
    let rootComponents = root.standardizedFileURL.pathComponents
    let childComponents = child.standardizedFileURL.pathComponents
    guard childComponents.count >= rootComponents.count else { return false }
    return Array(childComponents.prefix(rootComponents.count)) == rootComponents
  }

  static func safeArchiveDestination(for entryPath: String, within destination: URL) -> URL? {
    guard !entryPath.hasPrefix("/"), !entryPath.contains("\0") else { return nil }
    let candidate = destination.appending(path: entryPath, directoryHint: .inferFromPath)
    return contains(candidate, within: destination) ? candidate : nil
  }

  static func uniqueURL(for proposedURL: URL, fileManager: FileManager = .default) -> URL {
    guard fileManager.fileExists(atPath: proposedURL.path) else { return proposedURL }

    let parent = proposedURL.deletingLastPathComponent()
    let extensionName = proposedURL.pathExtension
    let stem = proposedURL.deletingPathExtension().lastPathComponent

    for index in 2...10_000 {
      let candidateName = extensionName.isEmpty
        ? "\(stem) \(index)"
        : "\(stem) \(index).\(extensionName)"
      let candidate = parent.appending(path: candidateName)
      if !fileManager.fileExists(atPath: candidate.path) {
        return candidate
      }
    }

    return parent.appending(path: "\(stem) \(UUID().uuidString).\(extensionName)")
  }
}
