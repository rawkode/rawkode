import Foundation

/// The single in-app handoff surface for task links opened by system integrations.
public enum TaskDeepLinkRoute: Hashable, Sendable {
  case list(TaskSmartList)
  case task(PageID, list: TaskSmartList)
  case quickAdd(TaskSmartList)

  public init?(url: URL) {
    guard url.scheme?.lowercased() == "enchiridion", url.host?.lowercased() == "tasks"
    else { return nil }

    let pathComponents = url.path.split(separator: "/", omittingEmptySubsequences: true)
    guard pathComponents.count <= 1 else { return nil }

    let list: TaskSmartList
    if let rawList = pathComponents.first {
      guard let parsedList = TaskSmartList(rawValue: rawList.lowercased()) else { return nil }
      list = parsedList
    } else {
      list = .inbox
    }

    let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    if let rawTaskID = queryItems.first(where: { $0.name == "task" })?.value {
      let taskID = rawTaskID.trimmingCharacters(in: .whitespacesAndNewlines)
      if !taskID.isEmpty {
        self = .task(PageID(rawValue: taskID), list: list)
        return
      }
    }

    if queryItems.contains(where: { $0.name == "quickAdd" && $0.value == "1" }) {
      self = .quickAdd(list)
    } else {
      self = .list(list)
    }
  }

  public var list: TaskSmartList {
    switch self {
    case .list(let list), .quickAdd(let list), .task(_, let list): list
    }
  }

  /// Prevents stale or forged task identifiers from opening an unusable detail screen.
  public func validated(against pages: [PageSnapshot]) -> Self {
    guard case .task(let pageID, let list) = self else { return self }
    let isAvailableTask = pages.contains {
      $0.id == pageID && $0.deletedAt == nil && $0.taskData != nil
    }
    return isAvailableTask ? self : .list(list)
  }
}
