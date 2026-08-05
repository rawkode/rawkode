import EnchiridionCore
import Foundation
import OSLog
@preconcurrency import UserNotifications

@MainActor
final class TaskReminderNotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
  static let shared = TaskReminderNotificationCoordinator()

  private let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion",
    category: "TaskReminders"
  )
  private var resolveStore: (@MainActor @Sendable (VaultID) async throws -> LibraryStore?)?
  private var openURL: (@MainActor @Sendable (URL) -> Void)?

  func configure(
    store: LibraryStore,
    resolveStore: (@MainActor @Sendable (VaultID) async throws -> LibraryStore?)? = nil,
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
    if await MeetingPromptNotificationCoordinator.shared.handle(response) { return }
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
    let plan = TaskReminderActionPlan.make(route: route, now: Date())
    if case .open(let identity) = plan {
      openTask(identity)
      return
    }

    guard let resolveStore else { return }
    do {
      guard let store = try await resolveStore(route.identity.vaultID),
        let task = await task(for: route.identity.nodeID, in: store),
        let data = task.taskData
      else {
        logger.error("reminder_action_unavailable")
        return
      }

      guard data.state == .active else { return }
      let applied: Bool
      switch plan {
      case .complete(let identity):
        applied = await store.completeTask(identity.nodeID) != nil
      case .snooze(let identity, let until):
        var updatedData = data
        updatedData.reminder = until
        applied = await store.updateTask(pageID: identity.nodeID, data: updatedData) != nil
      case .open:
        return
      }
      if !applied { logger.error("reminder_action_failed") }
    } catch {
      logger.error("reminder_store_resolution_failed: \(error.localizedDescription, privacy: .public)")
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
