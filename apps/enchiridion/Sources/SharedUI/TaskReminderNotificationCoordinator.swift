import EnchiridionCore
import Foundation
@preconcurrency import UserNotifications

@MainActor
final class TaskReminderNotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
  static let shared = TaskReminderNotificationCoordinator()

  private var store: LibraryStore?
  private var openURL: (@MainActor @Sendable (URL) -> Void)?

  func configure(
    store: LibraryStore,
    openURL: @escaping @MainActor @Sendable (URL) -> Void
  ) {
    self.store = store
    self.openURL = openURL
    UNUserNotificationCenter.current().delegate = self
    Task { await TaskReminderScheduler.shared.registerNotificationCategory() }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    let route = TaskReminderScheduler.route(
      actionIdentifier: response.actionIdentifier,
      userInfo: response.notification.request.content.userInfo,
      defaultActionIdentifier: UNNotificationDefaultActionIdentifier
    )
    guard let route else { return }
    await handle(route: route)
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }

  private func handle(route: TaskReminderNotificationRoute) async {
    guard let store, let task = await task(for: route.pageID, in: store),
      let data = task.taskData
    else { return }

    let plan = TaskReminderActionPlan.make(route: route, now: Date())
    switch plan {
    case .complete(let pageID):
      guard data.state == .active else { return }
      await store.completeTask(pageID)
    case .snooze(let pageID, let until):
      guard data.state == .active else { return }
      var updatedData = data
      updatedData.reminder = until
      await store.updateTask(pageID: pageID, data: updatedData)
    case .open(let pageID):
      openTask(pageID)
    }
  }

  private func task(for pageID: PageID, in store: LibraryStore) async -> PageSnapshot? {
    if let task = store.page(id: pageID) { return task }
    await store.reload()
    return store.page(id: pageID)
  }

  private func openTask(_ pageID: PageID) {
    guard let url = TaskReminderScheduler.taskURL(for: pageID) else { return }
    openURL?(url)
  }
}
