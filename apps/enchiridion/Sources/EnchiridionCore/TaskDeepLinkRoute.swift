import Foundation

/// The single vault-scoped in-app handoff surface for task links opened by system integrations.
public enum TaskDeepLinkRoute: Hashable, Sendable {
  case list(TaskSmartList, vaultID: VaultID)
  case task(VaultScopedNodeID, list: TaskSmartList)
  case quickAdd(TaskSmartList, vaultID: VaultID)

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
    let vaultID: VaultID
    if let rawVaultID = queryItems.first(where: { $0.name == "vault" })?.value?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    {
      guard rawVaultID.hasPrefix("vault_"), !rawVaultID.isEmpty else { return nil }
      vaultID = VaultID(rawValue: rawVaultID)
    } else {
      // Notifications, widgets, and Spotlight links created before vault support are Personal.
      vaultID = .personal
    }

    if let rawTaskID = queryItems.first(where: { $0.name == "task" })?.value {
      let taskID = rawTaskID.trimmingCharacters(in: .whitespacesAndNewlines)
      if !taskID.isEmpty {
        self = .task(
          VaultScopedNodeID(vaultID: vaultID, nodeID: PageID(rawValue: taskID)),
          list: list
        )
        return
      }
    }

    if queryItems.contains(where: { $0.name == "quickAdd" && $0.value == "1" }) {
      self = .quickAdd(list, vaultID: vaultID)
    } else {
      self = .list(list, vaultID: vaultID)
    }
  }

  public var list: TaskSmartList {
    switch self {
    case .list(let list, _), .quickAdd(let list, _), .task(_, let list): list
    }
  }

  public var vaultID: VaultID {
    switch self {
    case .list(_, let vaultID), .quickAdd(_, let vaultID): vaultID
    case .task(let identity, _): identity.vaultID
    }
  }

  public static func url(
    vaultID: VaultID,
    list: TaskSmartList,
    taskID: PageID? = nil,
    quickAdd: Bool = false
  ) -> URL? {
    var components = URLComponents()
    components.scheme = "enchiridion"
    components.host = "tasks"
    components.path = "/\(list.rawValue)"
    var queryItems = [URLQueryItem(name: "vault", value: vaultID.rawValue)]
    if let taskID { queryItems.append(URLQueryItem(name: "task", value: taskID.rawValue)) }
    if quickAdd { queryItems.append(URLQueryItem(name: "quickAdd", value: "1")) }
    components.queryItems = queryItems
    return components.url
  }

  /// Prevents stale or forged task identifiers from opening an unusable detail screen.
  public func validated(against pages: [PageSnapshot]) -> Self {
    guard case .task(let identity, let list) = self else { return self }
    let isAvailableTask = pages.contains {
      $0.id == identity.nodeID && $0.deletedAt == nil && $0.taskData != nil
    }
    return isAvailableTask ? self : .list(list, vaultID: identity.vaultID)
  }
}
