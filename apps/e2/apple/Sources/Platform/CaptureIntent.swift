#if os(iOS) || os(macOS)
import AppIntents
import ApsidesCore
import Foundation

struct CaptureThoughtIntent: AppIntent {
    static let title: LocalizedStringResource = "Capture a thought"
    static let description = IntentDescription("Save a thought on this device for your Apsides inbox.")
    static let openAppWhenRun = false

    @Parameter(title: "Thought", requestValueDialog: "What would you like to remember?")
    var text: String

    static var parameterSummary: some ParameterSummary { Summary("Capture \(\.$text)") }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let capture = Capture(text: text.trimmingCharacters(in: .whitespacesAndNewlines), source: .shortcut)
        try CaptureSpool(directory: CaptureSpool.defaultDirectory()).save(capture)
        await MainActor.run {
            NotificationCenter.default.post(name: Notification.Name("apsidesCaptureArrived"), object: nil)
        }
        return .result(dialog: "Saved on this device for your Apsides inbox.")
    }
}

struct ApsidesCaptureShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CaptureThoughtIntent(),
            phrases: ["Capture a thought in \(.applicationName)", "Remember this in \(.applicationName)"],
            shortTitle: "Capture a thought",
            systemImageName: "square.and.pencil"
        )
    }
}
#endif
