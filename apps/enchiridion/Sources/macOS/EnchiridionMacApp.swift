import EnchiridionCore
import SwiftUI

@main
struct EnchiridionMacApp: App {
  @FocusedValue(\.newPageAction) private var newPageAction

  var body: some Scene {
    WindowGroup {
      MacRootView()
        .frame(minWidth: 820, minHeight: 520)
    }
    .commands {
      CommandGroup(after: .newItem) {
        Button("New Page") {
          newPageAction?()
        }
        .keyboardShortcut("n", modifiers: .command)
        .disabled(newPageAction == nil)
      }
    }

    Settings {
      MacSettingsView()
    }
  }
}
