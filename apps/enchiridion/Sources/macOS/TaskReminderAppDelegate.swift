import AppKit

final class EnchiridionMacAppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    EnchiridionMacRuntime.shared.workspaceDidChange()
  }
}
