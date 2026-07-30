import SwiftUI

@main
struct ScoutApp: App {
  @State private var model = ScoutAppModel()

  var body: some Scene {
    WindowGroup {
      ScoutWindowHost(appModel: model)
    }
    .defaultSize(width: 1_280, height: 780)
    .windowResizability(.contentMinSize)
    .commands {
      ScoutCommands()
    }

    Settings {
      ScoutSettingsView(grantStore: model.grantStore)
        .frame(width: 520, height: 360)
    }
  }
}

private struct FocusedBrowserSessionKey: FocusedValueKey {
  typealias Value = BrowserSession
}

extension FocusedValues {
  var browserSession: BrowserSession? {
    get { self[FocusedBrowserSessionKey.self] }
    set { self[FocusedBrowserSessionKey.self] = newValue }
  }
}

struct ScoutCommands: Commands {
  @FocusedValue(\.browserSession) private var session

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button("New Window") { NSApp.sendAction(#selector(NSWindow.newWindowForTab(_:)), to: nil, from: nil) }
        .keyboardShortcut("n", modifiers: .command)
      Button("New Folder") { Task { await session?.createFolder() } }
        .keyboardShortcut("n", modifiers: [.command, .shift])
        .disabled(session?.currentDirectory == nil)
    }

    CommandGroup(replacing: .pasteboard) {
      Button("Copy") { session?.copySelection() }
        .keyboardShortcut("c", modifiers: .command)
      Button("Paste") { Task { await session?.paste() } }
        .keyboardShortcut("v", modifiers: .command)
      Button("Paste and Move") { Task { await session?.paste(move: true) } }
        .keyboardShortcut("v", modifiers: [.command, .option])
      Divider()
      Button("Duplicate") { Task { await session?.duplicateSelection() } }
        .keyboardShortcut("d", modifiers: .command)
      Button("Move to Trash") { Task { await session?.trashSelection() } }
        .keyboardShortcut(.delete, modifiers: .command)
      Button("Rename") { session?.beginRename() }
        .keyboardShortcut(.return, modifiers: [])
    }

    CommandMenu("Navigate") {
      Button("Open") { Task { await session?.openSelection() } }
        .keyboardShortcut(.downArrow, modifiers: .command)
      Button("Enclosing Folder") { Task { await session?.navigateUp() } }
        .keyboardShortcut(.upArrow, modifiers: .command)
      Button("Go to Folder…") { session?.pathNavigatorPresented = true }
        .keyboardShortcut("g", modifiers: [.command, .shift])
      Button("Search") { session?.searchFieldRequested = true }
        .keyboardShortcut("f", modifiers: .command)
      Button("Quick Look") { QuickLookPanelController.shared.preview(session?.selectedItems.map(\.url) ?? []) }
        .keyboardShortcut(.space, modifiers: [])
      Divider()
      Button("Command Palette") { session?.commandPalettePresented = true }
        .keyboardShortcut("k", modifiers: .command)
      Divider()
      Button("Show Package Contents") { Task { await session?.showPackageContents() } }
        .disabled(session?.selectedItems.first?.isPackage != true)
      Button("Open With…") { Task { await session?.chooseApplicationForSelection() } }
        .disabled(session?.selectedItems.count != 1)
    }

    CommandGroup(before: .toolbar) {
      ForEach(BrowserViewMode.allCases) { mode in
        Button(mode.title) { session?.changeViewMode(mode) }
          .keyboardShortcut(KeyEquivalent(Character(String(BrowserViewMode.allCases.firstIndex(of: mode)! + 1))), modifiers: .command)
      }
      Divider()
      Toggle("Show Inspector", isOn: Binding(
        get: { session?.inspectorPresented ?? false },
        set: { session?.inspectorPresented = $0 }
      ))
        .keyboardShortcut("i", modifiers: [.command, .option])
    }

    CommandGroup(replacing: .undoRedo) {
      Button("Undo") { Task { await session?.undo() } }
        .keyboardShortcut("z", modifiers: .command)
        .disabled(session?.journal.canUndo != true)
    }
  }
}
