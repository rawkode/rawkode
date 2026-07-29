import Foundation
import UserNotifications

public enum TaskReminderAuthorizationStatus: String, Sendable {
  case unavailable
  case notDetermined
  case denied
  case authorized
  case provisional
  case ephemeral
}

public enum TaskReminderEffectOutcome: Equatable, Sendable {
  case applied
  case unavailable
  case authorizationRequired(TaskReminderAuthorizationStatus)
  case authorizationRequestFailed(String)
  case schedulingFailed(String)
}

public enum TaskReminderAction: String, CaseIterable, Equatable, Sendable {
  case complete
  case snooze
  case open

  public var notificationActionIdentifier: String {
    switch self {
    case .complete: "ENCHIRIDION_TASK_COMPLETE"
    case .snooze: "ENCHIRIDION_TASK_SNOOZE"
    case .open: "ENCHIRIDION_TASK_OPEN"
    }
  }
}

public struct TaskReminderNotificationRoute: Equatable, Sendable {
  public let identity: VaultScopedNodeID
  public let action: TaskReminderAction

  public init(identity: VaultScopedNodeID, action: TaskReminderAction) {
    self.identity = identity
    self.action = action
  }
}

public enum TaskReminderActionPlan: Equatable, Sendable {
  case complete(VaultScopedNodeID)
  case snooze(VaultScopedNodeID, until: Date)
  case open(VaultScopedNodeID)

  public static func make(
    route: TaskReminderNotificationRoute,
    now: Date,
    snoozeInterval: TimeInterval = 60 * 60
  ) -> Self {
    switch route.action {
    case .complete: .complete(route.identity)
    case .snooze: .snooze(route.identity, until: now.addingTimeInterval(snoozeInterval))
    case .open: .open(route.identity)
    }
  }
}

public actor TaskReminderScheduler {
  public static let shared = TaskReminderScheduler()

  public nonisolated static let notificationCategoryIdentifier = "ENCHIRIDION_TASK"
  public nonisolated static let pageIDUserInfoKey = "pageID"
  public nonisolated static let vaultIDUserInfoKey = "vaultID"

  private let identifierPrefix = "dev.rawkode.enchiridion.task."

  private var center: UNUserNotificationCenter? {
    guard Bundle.main.bundleURL.pathExtension == "app" else { return nil }
    return UNUserNotificationCenter.current()
  }

  public func registerNotificationCategory() {
    guard let center else { return }
    let actions = [
      UNNotificationAction(
        identifier: TaskReminderAction.complete.notificationActionIdentifier,
        title: "Complete",
        options: []
      ),
      UNNotificationAction(
        identifier: TaskReminderAction.snooze.notificationActionIdentifier,
        title: "Snooze 1 Hour",
        options: []
      ),
      UNNotificationAction(
        identifier: TaskReminderAction.open.notificationActionIdentifier,
        title: "Open",
        options: [.foreground]
      ),
    ]
    let category = UNNotificationCategory(
      identifier: Self.notificationCategoryIdentifier,
      actions: actions,
      intentIdentifiers: [],
      options: []
    )
    center.setNotificationCategories([category])
  }

  public func authorizationStatus() async -> TaskReminderAuthorizationStatus {
    guard let center else { return .unavailable }
    return switch await center.notificationSettings().authorizationStatus {
    case .notDetermined: TaskReminderAuthorizationStatus.notDetermined
    case .denied: TaskReminderAuthorizationStatus.denied
    case .authorized: TaskReminderAuthorizationStatus.authorized
    case .provisional: TaskReminderAuthorizationStatus.provisional
    #if os(iOS)
      case .ephemeral: TaskReminderAuthorizationStatus.ephemeral
    #endif
    @unknown default: TaskReminderAuthorizationStatus.unavailable
    }
  }

  @discardableResult
  public func schedule(
    _ task: PageSnapshot,
    vaultID: VaultID,
    requestingAuthorization: Bool = false,
    now: Date = Date(),
    calendar: Calendar = .current
  ) async -> TaskReminderEffectOutcome {
    guard let center else { return .unavailable }
    registerNotificationCategory()
    guard let data = task.taskData, data.state == .active,
      let reminder = data.reminder, reminder > now
    else {
      return cancel(.init(vaultID: vaultID, nodeID: task.id))
    }

    var settings = await center.notificationSettings()
    if settings.authorizationStatus == .notDetermined, requestingAuthorization {
      do {
        _ = try await center.requestAuthorization(options: [.alert, .badge, .sound])
      } catch {
        return .authorizationRequestFailed(error.localizedDescription)
      }
      settings = await center.notificationSettings()
    }
    switch settings.authorizationStatus {
    case .authorized, .provisional:
      break
    #if os(iOS)
      case .ephemeral:
        break
    #endif
    case .notDetermined:
      return .authorizationRequired(.notDetermined)
    case .denied:
      return .authorizationRequired(.denied)
    @unknown default:
      return .authorizationRequired(.unavailable)
    }

    let content = UNMutableNotificationContent()
    content.title = task.displayTitle
    content.body = notificationBody(for: data)
    content.sound = .default
    content.userInfo = [
      Self.pageIDUserInfoKey: task.id.rawValue,
      Self.vaultIDUserInfoKey: vaultID.rawValue,
    ]
    content.categoryIdentifier = Self.notificationCategoryIdentifier
    content.targetContentIdentifier = "\(vaultID.rawValue)/\(task.id.rawValue)"

    let components = calendar.dateComponents(
      [.calendar, .timeZone, .year, .month, .day, .hour, .minute],
      from: reminder
    )
    let request = UNNotificationRequest(
      identifier: identifier(for: .init(vaultID: vaultID, nodeID: task.id)),
      content: content,
      trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
    )
    do {
      try await center.add(request)
      return .applied
    } catch {
      return .schedulingFailed(error.localizedDescription)
    }
  }

  public func reconcile(_ tasks: [PageSnapshot], vaultID: VaultID) async {
    guard let center else { return }
    let settings = await center.notificationSettings()
    guard
      settings.authorizationStatus == .authorized
        || settings.authorizationStatus == .provisional
    else { return }

    let activeIDs = Set(
      tasks.compactMap { task -> String? in
        guard let data = task.taskData, data.state == .active,
          data.reminder.map({ $0 > Date() }) == true
        else { return nil }
        return identifier(for: .init(vaultID: vaultID, nodeID: task.id))
      })
    let pending = await center.pendingNotificationRequests()
    let stale = pending.map(\.identifier).filter {
      $0.hasPrefix(identifierPrefix + vaultID.rawValue + ".") && !activeIDs.contains($0)
    }
    if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: stale) }
    for task in tasks { await schedule(task, vaultID: vaultID) }
  }

  @discardableResult
  public func cancel(_ identity: VaultScopedNodeID) -> TaskReminderEffectOutcome {
    guard let center else { return .unavailable }
    center.removePendingNotificationRequests(withIdentifiers: [identifier(for: identity)])
    center.removeDeliveredNotifications(withIdentifiers: [identifier(for: identity)])
    return .applied
  }

  public nonisolated static func route(
    actionIdentifier: String,
    userInfo: [AnyHashable: Any],
    defaultActionIdentifier: String? = nil
  ) -> TaskReminderNotificationRoute? {
    guard let rawPageID = userInfo[pageIDUserInfoKey] as? String,
      let rawVaultID = userInfo[vaultIDUserInfoKey] as? String,
      !rawPageID.isEmpty, rawVaultID.hasPrefix("vault_")
    else { return nil }

    let action: TaskReminderAction?
    if actionIdentifier == defaultActionIdentifier {
      action = .open
    } else {
      action = TaskReminderAction.allCases.first {
        $0.notificationActionIdentifier == actionIdentifier
      }
    }
    guard let action else { return nil }
    return TaskReminderNotificationRoute(
      identity: .init(
        vaultID: .init(rawValue: rawVaultID),
        nodeID: .init(rawValue: rawPageID)
      ),
      action: action
    )
  }

  public nonisolated static func taskURL(for identity: VaultScopedNodeID) -> URL? {
    TaskDeepLinkRoute.url(
      vaultID: identity.vaultID,
      list: .today,
      taskID: identity.nodeID
    )
  }

  private func identifier(for identity: VaultScopedNodeID) -> String {
    identifierPrefix + identity.vaultID.rawValue + "." + identity.nodeID.rawValue
  }

  private func notificationBody(for data: TaskData) -> String {
    if let deadline = data.deadline {
      return "Deadline \(deadline.formatted(date: .abbreviated, time: .omitted))"
    }
    if let scheduled = data.scheduledAt {
      return "Scheduled \(scheduled.formatted(date: .abbreviated, time: .shortened))"
    }
    return "A task is ready for your attention."
  }
}
