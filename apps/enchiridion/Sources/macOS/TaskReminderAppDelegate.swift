import AppKit

final class EnchiridionMacAppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    TaskReminderNotificationCoordinator.shared.configure(
      store: EnchiridionMacRuntime.shared.store,
      resolveStore: { vaultID in
        try EnchiridionMacRuntime.shared.store(for: vaultID)
      },
      openURL: { url in
        NSWorkspace.shared.open(url)
      }
    )
  }
}
