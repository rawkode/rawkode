import AppKit

final class EnchiridionMacAppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    EnchiridionMacRuntime.shared.workspaceDidChange()
    Task { await MacBookmarkCaptureRuntime.shared.drainInbox() }
  }

  func applicationDidBecomeActive(_ notification: Notification) {
    Task { await MacBookmarkCaptureRuntime.shared.drainInbox() }
  }
}
