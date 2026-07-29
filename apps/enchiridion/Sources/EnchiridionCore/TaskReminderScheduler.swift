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
  public let pageID: PageID
  public let action: TaskReminderAction

  public init(pageID: PageID, action: TaskReminderAction) {
    self.pageID = pageID
    self.action = action
  }
}

public enum TaskReminderActionPlan: Equatable, Sendable {
  case complete(PageID)
  case snooze(PageID, until: Date)
  case open(PageID)

  public static func make(
    route: TaskReminderNotificationRoute,
    now: Date,
    snoozeInterval: TimeInterval = 60 * 60
  ) -> Self {
    switch route.action {
    case .complete: .complete(route.pageID)
    case .snooze: .snooze(route.pageID, until: now.addingTimeInterval(snoozeInterval))
    case .open: .open(route.pageID)
    }
  }
}

public actor TaskReminderScheduler {
  public static let shared = TaskReminderScheduler()

  public nonisolated static let notificationCategoryIdentifier = "ENCHIRIDION_TASK"
  public nonisolated static let pageIDUserInfoKey = "pageID"

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
    case .ephemeral: TaskReminderAuthorizationStatus.ephemeral
    @unknown default: TaskReminderAuthorizationStatus.unavailable
    }
  }

  public func schedule(
    _ task: PageSnapshot,
    requestingAuthorization: Bool = false,
    now: Date = Date(),
    calendar: Calendar = .current
  ) async {
    guard let center else { return }
    registerNotificationCategory()
    guard let data = task.taskData, data.state == .active,
      let reminder = data.reminder, reminder > now
    else {
      cancel(task.id)
      return
    }

    var settings = await center.notificationSettings()
    if settings.authorizationStatus == .notDetermined, requestingAuthorization {
      _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
      settings = await center.notificationSettings()
    }
    guard settings.authorizationStatus == .authorized
      || settings.authorizationStatus == .provisional
    else { return }

    let content = UNMutableNotificationContent()
    content.title = task.displayTitle
    content.body = notificationBody(for: data)
    content.sound = .default
    content.userInfo = [Self.pageIDUserInfoKey: task.id.rawValue]
    content.categoryIdentifier = Self.notificationCategoryIdentifier
    content.targetContentIdentifier = task.id.rawValue

    let components = calendar.dateComponents(
      [.calendar, .timeZone, .year, .month, .day, .hour, .minute],
      from: reminder
    )
    let request = UNNotificationRequest(
      identifier: identifier(for: task.id),
      content: content,
      trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
    )
    try? await center.add(request)
  }

  public func reconcile(_ tasks: [PageSnapshot]) async {
    guard let center else { return }
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .authorized
      || settings.authorizationStatus == .provisional
    else { return }

    let activeIDs = Set(tasks.compactMap { task -> String? in
      guard let data = task.taskData, data.state == .active,
        data.reminder.map({ $0 > Date() }) == true
      else { return nil }
      return identifier(for: task.id)
    })
    let pending = await center.pendingNotificationRequests()
    let stale = pending.map(\.identifier).filter {
      $0.hasPrefix(identifierPrefix) && !activeIDs.contains($0)
    }
    if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: stale) }
    for task in tasks { await schedule(task) }
  }

  public func cancel(_ pageID: PageID) {
    guard let center else { return }
    center.removePendingNotificationRequests(withIdentifiers: [identifier(for: pageID)])
    center.removeDeliveredNotifications(withIdentifiers: [identifier(for: pageID)])
  }

  public nonisolated static func route(
    actionIdentifier: String,
    userInfo: [AnyHashable: Any],
    defaultActionIdentifier: String? = nil
  ) -> TaskReminderNotificationRoute? {
    guard let rawPageID = userInfo[pageIDUserInfoKey] as? String,
      !rawPageID.isEmpty
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
    return TaskReminderNotificationRoute(pageID: PageID(rawValue: rawPageID), action: action)
  }

  public nonisolated static func taskURL(for pageID: PageID) -> URL? {
    var components = URLComponents()
    components.scheme = "enchiridion"
    components.host = "tasks"
    components.path = "/today"
    components.queryItems = [URLQueryItem(name: "task", value: pageID.rawValue)]
    return components.url
  }

  private func identifier(for pageID: PageID) -> String {
    identifierPrefix + pageID.rawValue
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
