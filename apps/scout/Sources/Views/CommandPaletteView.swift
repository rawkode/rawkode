import SwiftUI

struct CommandPaletteView: View {
  @Bindable var session: BrowserSession
  @State private var query = ""
  @FocusState private var searchFocused: Bool

  private var commands: [CommandDescriptor] {
    [
      CommandDescriptor(id: "open", title: "Open", subtitle: "Open the selection", systemImage: "arrow.down.circle", keyEquivalent: "⌘↓", keywords: ["launch", "enter"]),
      CommandDescriptor(id: "up", title: "Enclosing Folder", subtitle: nil, systemImage: "arrow.up", keyEquivalent: "⌘↑", keywords: ["parent", "back"]),
      CommandDescriptor(id: "new-folder", title: "New Folder", subtitle: nil, systemImage: "folder.badge.plus", keyEquivalent: "⇧⌘N", keywords: ["create", "directory"]),
      CommandDescriptor(id: "rename", title: "Rename", subtitle: nil, systemImage: "pencil", keyEquivalent: "↩", keywords: ["name"]),
      CommandDescriptor(id: "duplicate", title: "Duplicate", subtitle: nil, systemImage: "plus.square.on.square", keyEquivalent: "⌘D", keywords: ["copy"]),
      CommandDescriptor(id: "compress", title: "Compress", subtitle: "Create a ZIP archive", systemImage: "archivebox", keyEquivalent: nil, keywords: ["zip", "archive"]),
      CommandDescriptor(id: "extract", title: "Extract Archive", subtitle: nil, systemImage: "archivebox.fill", keyEquivalent: nil, keywords: ["zip", "unarchive"]),
      CommandDescriptor(id: "quick-look", title: "Quick Look", subtitle: nil, systemImage: "eye", keyEquivalent: "Space", keywords: ["preview"]),
      CommandDescriptor(id: "trash", title: "Move to Trash", subtitle: nil, systemImage: "trash", keyEquivalent: "⌘⌫", keywords: ["delete", "remove"]),
      CommandDescriptor(id: "icons", title: "Icon View", subtitle: nil, systemImage: "square.grid.2x2", keyEquivalent: "⌘1", keywords: ["view"]),
      CommandDescriptor(id: "list", title: "List View", subtitle: nil, systemImage: "list.bullet", keyEquivalent: "⌘2", keywords: ["view"]),
      CommandDescriptor(id: "columns", title: "Column View", subtitle: nil, systemImage: "rectangle.split.3x1", keyEquivalent: "⌘3", keywords: ["view", "miller"]),
    ].filter { $0.matches(query) }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 9) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Type a command", text: $query)
          .textFieldStyle(.plain)
          .font(.title3)
          .focused($searchFocused)
        Text("⌘K").font(.caption.monospaced()).foregroundStyle(.tertiary)
      }
      .padding(14)
      Divider()

      ScrollView {
        LazyVStack(spacing: 2) {
          ForEach(commands) { command in
            Button {
              perform(command.id)
            } label: {
              HStack(spacing: 10) {
                Image(systemName: command.systemImage).frame(width: 20).foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 1) {
                  Text(command.title)
                  if let subtitle = command.subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                if let key = command.keyEquivalent { Text(key).font(.caption.monospaced()).foregroundStyle(.tertiary) }
              }
              .padding(.horizontal, 12).padding(.vertical, 8)
              .contentShape(.rect)
            }
            .buttonStyle(.plain)
          }
        }
        .padding(6)
      }
      .frame(maxHeight: 380)
    }
    .frame(width: 560)
    .background(.regularMaterial, in: .rect(cornerRadius: 14))
    .overlay { RoundedRectangle(cornerRadius: 14).stroke(.separator.opacity(0.7)) }
    .shadow(color: .black.opacity(0.22), radius: 30, y: 12)
    .onAppear { searchFocused = true }
  }

  private func perform(_ id: String) {
    session.commandPalettePresented = false
    switch id {
    case "open": Task { await session.openSelection() }
    case "up": Task { await session.navigateUp() }
    case "new-folder": Task { await session.createFolder() }
    case "rename": session.beginRename()
    case "duplicate": Task { await session.duplicateSelection() }
    case "compress": Task { await session.compressSelection() }
    case "extract": Task { await session.extractSelection() }
    case "quick-look": QuickLookPanelController.shared.preview(session.selectedItems.map(\.url))
    case "trash": Task { await session.trashSelection() }
    case "icons": session.changeViewMode(.icons)
    case "list": session.changeViewMode(.list)
    case "columns": session.changeViewMode(.columns)
    default: break
    }
  }
}
