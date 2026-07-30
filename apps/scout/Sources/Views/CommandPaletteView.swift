import SwiftUI

struct CommandPaletteView: View {
  @Bindable var session: BrowserSession
  @State private var query = ""
  @State private var selectedID: String?
  @State private var hoveredID: String?
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
      CommandDescriptor(id: "tags", title: "Edit Tags", subtitle: nil, systemImage: "tag", keyEquivalent: nil, keywords: ["label", "color"]),
      CommandDescriptor(id: "open-with", title: "Open With…", subtitle: nil, systemImage: "app.badge", keyEquivalent: nil, keywords: ["application", "app"]),
      CommandDescriptor(id: "package", title: "Show Package Contents", subtitle: nil, systemImage: "shippingbox", keyEquivalent: nil, keywords: ["bundle", "folder"]),
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
        Image(systemName: "magnifyingglass")
          .foregroundStyle(ScoutTheme.accent)
        TextField("Type a command", text: $query)
          .textFieldStyle(.plain)
          .font(.title3)
          .focused($searchFocused)
        Text("⌘K")
          .font(.caption.monospaced().weight(.medium))
          .foregroundStyle(.tertiary)
          .padding(.horizontal, 6)
          .padding(.vertical, 3)
          .background(ScoutTheme.quietFill, in: .rect(cornerRadius: 4))
      }
      .padding(.horizontal, 14)
      .frame(height: 50)

      Divider().overlay(ScoutTheme.separator)

      if commands.isEmpty {
        VStack(spacing: 7) {
          Image(systemName: "command")
            .font(.title2)
            .foregroundStyle(.tertiary)
          Text("No matching commands").font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 150)
      } else {
        ScrollView {
          LazyVStack(spacing: 2) {
            ForEach(commands) { command in
              Button {
                perform(command.id)
              } label: {
                HStack(spacing: 10) {
                  Image(systemName: command.systemImage)
                    .frame(width: 26, height: 26)
                    .foregroundStyle(command.id == selectedID ? Color.white : ScoutTheme.accent)
                    .background(
                      command.id == selectedID ? ScoutTheme.accent : ScoutTheme.quietFill,
                      in: .rect(cornerRadius: 6)
                    )
                  VStack(alignment: .leading, spacing: 1) {
                    Text(command.title)
                      .font(.callout.weight(.medium))
                    if let subtitle = command.subtitle {
                      Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                  }
                  Spacer()
                  if let key = command.keyEquivalent {
                    Text(key)
                      .font(.caption.monospaced())
                      .foregroundStyle(.tertiary)
                  }
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .contentShape(.rect)
                .background(rowBackground(for: command.id), in: .rect(cornerRadius: 7))
              }
              .buttonStyle(.plain)
              .onHover { hovering in hoveredID = hovering ? command.id : nil }
            }
          }
          .padding(6)
        }
        .frame(maxHeight: 370)
      }

      Divider().overlay(ScoutTheme.separator)

      HStack(spacing: 12) {
        Label("Navigate", systemImage: "arrow.up.arrow.down")
        Label("Run", systemImage: "return")
        Spacer()
        Text("Esc to close")
      }
      .font(.caption)
      .foregroundStyle(.tertiary)
      .padding(.horizontal, 12)
      .frame(height: 30)
      .background(ScoutTheme.chrome)
    }
    .frame(width: 520)
    .background(ScoutTheme.elevated, in: .rect(cornerRadius: 12))
    .overlay { RoundedRectangle(cornerRadius: 12).stroke(ScoutTheme.separator) }
    .shadow(color: .black.opacity(0.20), radius: 8, y: 4)
    .onAppear {
      selectedID = commands.first?.id
      searchFocused = true
    }
    .onChange(of: query) { _, _ in selectedID = commands.first?.id }
    .onKeyPress(.downArrow) {
      moveSelection(by: 1)
      return .handled
    }
    .onKeyPress(.upArrow) {
      moveSelection(by: -1)
      return .handled
    }
    .onKeyPress(.return) {
      if let selectedID { perform(selectedID) }
      return .handled
    }
    .onKeyPress(.escape) {
      session.commandPalettePresented = false
      return .handled
    }
  }

  private func rowBackground(for id: String) -> Color {
    if id == selectedID { return ScoutTheme.selection }
    if id == hoveredID { return ScoutTheme.quietFill }
    return .clear
  }

  private func moveSelection(by offset: Int) {
    guard !commands.isEmpty else { selectedID = nil; return }
    let current = selectedID.flatMap { id in commands.firstIndex(where: { $0.id == id }) } ?? 0
    let next = min(max(current + offset, 0), commands.count - 1)
    selectedID = commands[next].id
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
    case "tags": session.beginEditingTags()
    case "open-with": Task { await session.chooseApplicationForSelection() }
    case "package": Task { await session.showPackageContents() }
    case "quick-look": QuickLookPanelController.shared.preview(session.selectedItems.map(\.url))
    case "trash": Task { await session.trashSelection() }
    case "icons": session.changeViewMode(.icons)
    case "list": session.changeViewMode(.list)
    case "columns": session.changeViewMode(.columns)
    default: break
    }
  }
}
