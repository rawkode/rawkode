import AppKit
import SwiftUI

@main
struct MultipassApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store = MultipassStore()

    var body: some Scene {
        WindowGroup("Multipass", id: "multipass") {
            ContentView(store: store)
        }
        .defaultSize(width: 580, height: 710)
        .windowResizability(.contentSize)

        MenuBarExtra("Multipass", systemImage: store.enabled ? "keyboard.badge.ellipsis" : "keyboard") {
            MenuContent(store: store)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
    }
}

private struct MenuContent: View {
    @ObservedObject var store: MultipassStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(store.enabled ? "Automatic switching on" : "Automatic switching paused")
        Text(store.keyboardPresent.map { $0 ? "Keyboard connected" : "Keyboard not connected here" } ?? "Keyboard status unknown")
        Divider()
        Button("Open Multipass…") {
            openWindow(id: "multipass")
            NSApp.activate(ignoringOtherApps: true)
        }
        Button(store.enabled ? "Pause switching" : "Resume switching") {
            store.setEnabled(!store.enabled)
        }.disabled(!store.paired || !store.available)
        Divider()
        Button("Quit Multipass") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
