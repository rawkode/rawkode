import EnchiridionCore
import Foundation
@preconcurrency import UserNotifications

@MainActor
final class TaskReminderNotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
  static let shared = TaskReminderNotificationCoordinator()

  private var resolveStore: (@MainActor @Sendable (VaultID) throws -> LibraryStore?)?
  private var openURL: (@MainActor @Sendable (URL) -> Void)?

  func configure(
    store: LibraryStore,
    resolveStore: (@MainActor @Sendable (VaultID) throws -> LibraryStore?)? = nil,
    openURL: @escaping @MainActor @Sendable (URL) -> Void
  ) {
    self.resolveStore = resolveStore ?? { vaultID in
      vaultID == store.vaultID ? store : nil
    }
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
    guard let resolveStore,
      let store = try? resolveStore(route.identity.vaultID),
      let task = await task(for: route.identity.nodeID, in: store),
      let data = task.taskData
    else { return }

    let plan = TaskReminderActionPlan.make(route: route, now: Date())
    switch plan {
    case .complete(let identity):
      guard data.state == .active else { return }
      await store.completeTask(identity.nodeID)
    case .snooze(let identity, let until):
      guard data.state == .active else { return }
      var updatedData = data
      updatedData.reminder = until
      await store.updateTask(pageID: identity.nodeID, data: updatedData)
    case .open(let identity):
      openTask(identity)
    }
  }

  private func task(for pageID: PageID, in store: LibraryStore) async -> PageSnapshot? {
    if let task = store.page(id: pageID) { return task }
    await store.reload()
    return store.page(id: pageID)
  }

  private func openTask(_ identity: VaultScopedNodeID) {
    guard let url = TaskReminderScheduler.taskURL(for: identity) else { return }
    openURL?(url)
  }
}
