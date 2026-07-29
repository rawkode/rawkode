import Foundation
import UserNotifications

public actor TaskReminderScheduler {
  public static let shared = TaskReminderScheduler()

  private let identifierPrefix = "dev.rawkode.enchiridion.task."

  private var center: UNUserNotificationCenter? {
    guard Bundle.main.bundleURL.pathExtension == "app" else { return nil }
    return UNUserNotificationCenter.current()
  }

  public func schedule(
    _ task: PageSnapshot,
    requestingAuthorization: Bool = false,
    now: Date = Date(),
    calendar: Calendar = .current
  ) async {
    guard let center else { return }
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
    content.userInfo = ["pageID": task.id.rawValue]
    content.categoryIdentifier = "ENCHIRIDION_TASK"

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
