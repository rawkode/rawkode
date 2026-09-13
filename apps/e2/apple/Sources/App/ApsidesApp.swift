import SwiftUI

@main
struct ApsidesApp: App {
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif
    @StateObject private var store = WorkspaceStore()
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    var body: some Scene {
        #if os(macOS)
        WindowGroup {
            WorkspaceView(store: store)
                .tint(theme.accent)
                .preferredColorScheme(theme.scheme)
        }
        .defaultSize(width: 1120, height: 780)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Voice Conversation") { openWindow(id: "voice") }.keyboardShortcut("v", modifiers: [.command, .shift])
                Button("Quick Capture") { store.capturePresented = true }.keyboardShortcut("n", modifiers: [.command, .shift])
                Button("Today") { NotificationCenter.default.post(name: Notification.Name("apsidesShowToday"), object: nil) }.keyboardShortcut("t", modifiers: [.command])
            }
        }
        Window("Voice — Enchiridion", id: "voice") {
            MacVoiceConversationView(session: store.session, conversation: store.voice)
                .tint(theme.accent).preferredColorScheme(theme.scheme)
        }
        .defaultSize(width: 560, height: 580)
        .windowResizability(.contentMinSize)
        Settings { SettingsView(store: store, session: store.session).frame(width: 460).tint(theme.accent).preferredColorScheme(theme.scheme) }
        #else
        WindowGroup {
            WorkspaceView(store: store).tint(theme.accent).preferredColorScheme(theme.scheme)
        }
        #endif
    }
}
