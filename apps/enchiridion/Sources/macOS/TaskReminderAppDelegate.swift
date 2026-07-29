import AppKit

final class EnchiridionMacAppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    TaskReminderNotificationCoordinator.shared.configure(
      store: EnchiridionMacRuntime.shared.store,
      openURL: { url in
        NSWorkspace.shared.open(url)
      }
    )
  }
}
