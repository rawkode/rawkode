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

/// Menu bar app that behaves like a regular app while its window is open: the
/// Dock icon and application menu (including Quit) appear with the window and
/// go away when it closes, leaving only the menu bar extra.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var observers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { note in
            guard let window = note.object as? NSWindow, Self.isMainWindow(window) else { return }
            if NSApp.activationPolicy() != .regular {
                NSApp.setActivationPolicy(.regular)
                NSApp.activate(ignoringOtherApps: true)
            }
        })
        observers.append(center.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { note in
            let closing = note.object as? NSWindow
            DispatchQueue.main.async {
                let stillOpen = NSApp.windows.contains { $0 !== closing && $0.isVisible && Self.isMainWindow($0) }
                if !stillOpen { NSApp.setActivationPolicy(.accessory) }
            }
        })
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// The setup window, as opposed to the status item's menu or other panels.
    private static func isMainWindow(_ window: NSWindow) -> Bool {
        window.canBecomeMain && !(window is NSPanel) && window.styleMask.contains(.titled)
    }
}

private struct MenuContent: View {
    @ObservedObject var store: MultipassStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(store.enabled ? "Automatic switching on" : "Automatic switching paused")
        Text(store.keyboardPresent.map { $0 ? "Keyboard connected" : "Keyboard not connected here" } ?? "Keyboard status unknown")
        if let pairing = store.pairing {
            Divider()
            Button(pairing.incoming ? "Pairing request from \(pairing.peerName)…" : "Pairing with \(pairing.peerName)…") {
                openWindow(id: "multipass")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
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
