import SwiftUI

@main
struct RockoCarPlayApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var store = LiveSessionStore.shared

  var body: some Scene {
    WindowGroup {
      SessionDashboardView(store: store)
    }
  }
}
