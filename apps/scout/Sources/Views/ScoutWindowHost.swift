import SwiftUI

struct ScoutWindowHost: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  @State private var session: BrowserSession
  @SceneStorage("ScoutBrowserWindowState") private var restorationData: Data?
  @State private var columnVisibility: NavigationSplitViewVisibility = .all

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  init(appModel: ScoutAppModel) {
    _session = State(initialValue: appModel.makeSession())
  }

  var body: some View {
    ScoutBrowserView(session: session, columnVisibility: $columnVisibility)
      .frame(minWidth: 900, minHeight: 560)
      .tint(palette.accent)
      .focusedSceneValue(\.browserSession, session)
      .background(ScoutWindowBridge(title: session.windowTitle))
      .task {
        if let restorationData,
           let state = try? JSONDecoder().decode(BrowserWindowState.self, from: restorationData) {
          await session.restore(state)
        } else {
          await session.start()
        }
      }
      .onDisappear {
        restorationData = try? JSONEncoder().encode(session.restorationState())
      }
      .onChange(of: columnVisibility) { _, value in
        session.sidebarPresented = value != .detailOnly
      }
  }
}

private struct ScoutBrowserView: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  @Bindable var session: BrowserSession
  @Binding var columnVisibility: NavigationSplitViewVisibility
  @State private var exactPath = ""
  @FocusState private var searchFocused: Bool

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  private var isOnboarding: Bool {
    session.grantStore.grants.isEmpty && !session.isICloudDriveAvailable
  }

  var body: some View {
    ZStack {
      palette.canvas.ignoresSafeArea()

      if isOnboarding {
        FirstRunView(grantStore: session.grantStore) { grant in
          await session.open(grant)
        }
      } else {
        NavigationSplitView(columnVisibility: $columnVisibility) {
          ScoutSidebar(session: session)
            .navigationSplitViewColumnWidth(min: 190, ideal: 218, max: 258)
        } detail: {
          browserWorkspace
            .inspector(isPresented: $session.inspectorPresented) {
              FileInspectorView(session: session)
                .inspectorColumnWidth(min: 280, ideal: 310, max: 350)
            }
        }
      }

      if session.commandPalettePresented {
        Color.black.opacity(0.24)
          .ignoresSafeArea()
          .onTapGesture { session.commandPalettePresented = false }
        CommandPaletteView(session: session)
          .transition(.scale(scale: 0.985).combined(with: .opacity))
      }
    }
    .foregroundStyle(palette.primary)
    .animation(.snappy(duration: 0.14), value: session.commandPalettePresented)
    .toolbar { toolbarContent }
    .sheet(isPresented: $session.pathNavigatorPresented) {
      PathNavigatorSheet(path: $exactPath) {
        session.pathNavigatorPresented = false
        Task { await session.navigate(to: exactPath) }
      }
    }
    .sheet(isPresented: $session.renamePresented) {
      RenameSheet(name: $session.renameText) {
        Task { await session.commitRename() }
      }
    }
    .sheet(isPresented: $session.tagsPresented) {
      TagEditorSheet(tags: $session.tagText) {
        Task { await session.commitTags() }
      }
    }
    .onChange(of: session.searchFieldRequested) { _, requested in
      guard requested else { return }
      searchFocused = true
      session.searchFieldRequested = false
    }
    .alert("Scout Couldn’t Complete That", isPresented: Binding(
      get: { session.errorMessage != nil },
      set: { if !$0 { session.errorMessage = nil } }
    )) {
      Button("OK") { session.errorMessage = nil }
    } message: {
      Text(session.errorMessage ?? "")
    }
    .confirmationDialog(
      "An Item Already Exists",
      isPresented: Binding(
        get: { session.pendingConflict != nil },
        set: { if !$0 { session.pendingConflict = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button("Keep Both") { Task { await session.resolveConflict(.keepBoth) } }
      Button("Replace", role: .destructive) { Task { await session.resolveConflict(.replace) } }
      Button("Stop", role: .cancel) { session.pendingConflict = nil }
    } message: {
      let count = session.pendingConflict?.conflictingURLs.count ?? 1
      Text(count == 1 ? "Choose how Scout should handle the existing item." : "Choose how Scout should handle all \(count) conflicts in this batch.")
    }
  }

  private var browserWorkspace: some View {
    VStack(spacing: 0) {
      ScoutPathBar(session: session) {
        exactPath = session.currentDirectory?.path(percentEncoded: false) ?? ""
        session.pathNavigatorPresented = true
      }
      Divider().overlay(palette.separator)
      browserContent
      Divider().overlay(palette.separator)
      BrowserFooterBar(session: session)

      if let notice = session.journal.notice {
        Divider().overlay(palette.separator)
        OperationNoticeView(notice: notice) {
          Task { await session.undo() }
        } dismiss: {
          session.journal.dismissNotice()
        }
      }
    }
    .background(palette.canvas)
  }

  @ViewBuilder
  private var browserContent: some View {
    Group {
      if session.rootURL == nil {
        ScoutEmptyState(
          title: "Location Unavailable",
          message: "Choose this location again to restore access.",
          systemImage: "externaldrive.badge.exclamationmark"
        )
      } else if session.isLoading {
        VStack(spacing: 10) {
          ProgressView()
          Text("Opening Location…").font(.callout).foregroundStyle(palette.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        switch session.viewMode {
        case .columns:
          MillerColumnsView(session: session)
        case .list:
          FileListView(session: session)
        case .icons:
          FileIconGridView(session: session)
        }
      }
    }
    .background(palette.canvas)
    .overlay(alignment: .topLeading) {
      if !session.searchText.isEmpty {
        Label(
          "\(session.searchResults.count) results in \(session.activeGrant?.displayName ?? "location")",
          systemImage: "sparkle.magnifyingglass"
        )
        .font(.caption)
        .foregroundStyle(palette.secondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(palette.elevated, in: .capsule)
        .overlay { Capsule().stroke(palette.separator) }
        .padding(10)
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    if !isOnboarding {
      ToolbarItemGroup(placement: .navigation) {
        Button { Task { await session.navigateUp() } } label: {
          Label("Enclosing Folder", systemImage: "chevron.up")
        }
        .disabled(!session.canNavigateUp)

        Button {
          exactPath = session.currentDirectory?.path(percentEncoded: false) ?? ""
          session.pathNavigatorPresented = true
        } label: {
          Label("Go to Folder", systemImage: "location")
        }
      }

      ToolbarItem(placement: .principal) {
        HStack(spacing: 7) {
          Image(systemName: "folder.fill")
            .foregroundStyle(palette.secondary)
          Text(session.windowTitle)
            .font(.callout.weight(.semibold))
            .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
      }

      ToolbarItemGroup(placement: .primaryAction) {
        Button { Task { await session.createFolder() } } label: {
          Label("New Folder", systemImage: "folder.badge.plus")
        }
        .help("New Folder (⇧⌘N)")

        Menu {
          ForEach(BrowserViewMode.allCases) { mode in
            Button {
              session.changeViewMode(mode)
            } label: {
              Label(mode.title, systemImage: mode.systemImage)
            }
          }
        } label: {
          Label(session.viewMode.title, systemImage: session.viewMode.systemImage)
        }
        .help("Change View")

        TextField("Search", text: $session.searchText)
          .textFieldStyle(.roundedBorder)
          .frame(width: 176)
          .focused($searchFocused)
          .onSubmit { session.beginSearch() }
          .onChange(of: session.searchText) { _, text in
            if text.isEmpty { session.endSearch() }
          }

        Button { session.commandPalettePresented = true } label: {
          HStack(spacing: 5) {
            Image(systemName: "command")
            Text("K").font(.caption.monospaced().weight(.medium))
          }
        }
        .help("Command Palette (⌘K)")

        Button { session.inspectorPresented.toggle() } label: {
          Label("Inspector", systemImage: "sidebar.right")
        }
        .help("Show Inspector (⌥⌘I)")
      }
    }
  }
}

private struct ScoutPathBar: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  @Bindable var session: BrowserSession
  let showExactPath: () -> Void

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  private var breadcrumbURLs: [URL] {
    guard let root = session.rootURL?.standardizedFileURL,
          let current = session.currentDirectory?.standardizedFileURL
    else { return [] }

    var result = [root]
    var cursor = root
    let components = current.pathComponents.dropFirst(root.pathComponents.count)
    for component in components {
      cursor.append(path: component, directoryHint: .isDirectory)
      result.append(cursor)
    }
    return result
  }

  var body: some View {
    HStack(spacing: 4) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 3) {
          ForEach(Array(breadcrumbURLs.enumerated()), id: \.element) { index, url in
            if index > 0 {
              Image(systemName: "chevron.right")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(palette.tertiary)
            }
            Button {
              Task { await session.navigate(to: url.path(percentEncoded: false)) }
            } label: {
              HStack(spacing: 5) {
                if index == 0 {
                  Image(systemName: "folder.fill")
                    .foregroundStyle(palette.accent)
                }
                Text(index == 0 ? (session.activeGrant?.displayName ?? url.lastPathComponent) : url.lastPathComponent)
                  .lineLimit(1)
              }
              .font(.caption.weight(index == breadcrumbURLs.count - 1 ? .semibold : .regular))
              .foregroundStyle(index == breadcrumbURLs.count - 1 ? palette.primary : palette.secondary)
              .padding(.horizontal, 6)
              .padding(.vertical, 3)
              .background(index == breadcrumbURLs.count - 1 ? palette.quietFill : .clear, in: .rect(cornerRadius: 5))
            }
            .buttonStyle(.plain)
          }
        }
      }

      Spacer(minLength: 8)

      Button(action: showExactPath) {
        Image(systemName: "text.magnifyingglass")
          .foregroundStyle(palette.secondary)
      }
      .buttonStyle(.plain)
      .help("Go to Folder (⇧⌘G)")
    }
    .padding(.horizontal, 10)
    .frame(height: 30)
    .background(palette.chrome)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Current path")
  }
}

private struct BrowserFooterBar: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  @Bindable var session: BrowserSession

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  var body: some View {
    HStack(spacing: 8) {
      let selectionCount = session.selectedItems.count
      Text(selectionCount > 0 ? "\(selectionCount) selected" : "\(session.displayedItems.count) items")
      Text("•").foregroundStyle(palette.tertiary)
      Label(session.viewMode.title, systemImage: session.viewMode.systemImage)
      Spacer()
      Text("Space to preview")
        .foregroundStyle(palette.tertiary)
    }
    .font(.caption)
    .foregroundStyle(palette.secondary)
    .padding(.horizontal, 10)
    .frame(height: 28)
    .background(palette.chrome)
  }
}

private struct ScoutSidebar: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  @Bindable var session: BrowserSession

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  var body: some View {
    List {
      Section("Locations") {
        Button {
          Task { await session.openICloudDrive() }
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "icloud")
              .foregroundStyle(session.activeGrant?.id == session.iCloudDriveDestination?.id ? palette.accent : palette.secondary)
            Text("iCloud Drive")
              .lineLimit(1)
            Spacer(minLength: 2)
            if session.activeGrant?.id == session.iCloudDriveDestination?.id {
              Circle().fill(palette.accent).frame(width: 5, height: 5)
            }
          }
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!session.isICloudDriveAvailable)
        .listRowBackground(
          RoundedRectangle(cornerRadius: 6)
            .fill(session.activeGrant?.id == session.iCloudDriveDestination?.id ? palette.selection : .clear)
        )
        .accessibilityValue(session.isICloudDriveAvailable ? "" : "Unavailable")

        ForEach(session.grantStore.orderedGrants) { grant in
          Button {
            Task {
              if grant.needsLocalBookmark {
                if let refreshed = try? await session.grantStore.reconnect(grant) {
                  await session.open(refreshed)
                }
              } else {
                await session.open(grant)
              }
            }
          } label: {
            HStack(spacing: 8) {
              Image(systemName: grant.needsLocalBookmark ? "folder.badge.questionmark" : "folder.fill")
                .foregroundStyle(grant.id == session.activeGrant?.id ? palette.accent : palette.secondary)
              Text(grant.displayName)
                .lineLimit(1)
              Spacer(minLength: 2)
              if grant.needsLocalBookmark {
                Text("Reconnect")
                  .font(.caption)
                  .foregroundStyle(palette.secondary)
              }
              if grant.id == session.activeGrant?.id {
                Circle().fill(palette.accent).frame(width: 5, height: 5)
              }
            }
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .listRowBackground(
            RoundedRectangle(cornerRadius: 6)
              .fill(grant.id == session.activeGrant?.id ? palette.selection : .clear)
          )
          .accessibilityValue(grant.id == session.activeGrant?.id ? "Current location" : "")
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(palette.sidebar)
    .listStyle(.sidebar)
    .safeAreaInset(edge: .bottom) {
      Button {
        Task {
          if let grant = try? await session.grantStore.addLocation() { await session.open(grant) }
        }
      } label: {
        Label("Add Location…", systemImage: "plus")
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .font(.callout)
      .padding(.horizontal, 14)
      .frame(height: 38)
      .background(palette.chrome)
      .overlay(alignment: .top) { Divider().overlay(palette.separator) }
    }
    .navigationTitle("Scout")
  }
}

private struct FirstRunView: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  let grantStore: AccessGrantStore
  let onGrant: (AccessGrant) async -> Void

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        ScoutBrandMark(size: 58)
        Spacer()
        Text("Your files,\nin reach.")
          .font(.system(size: 42, weight: .semibold, design: .rounded))
          .tracking(-1.2)
          .foregroundStyle(palette.primary)
        Text("A fast, spatial file manager made for the keyboard.")
          .font(.title3)
          .foregroundStyle(palette.secondary)
          .frame(maxWidth: 360, alignment: .leading)
          .padding(.top, 14)
      }
      .padding(42)
      .frame(minWidth: 390, maxWidth: 470, maxHeight: .infinity, alignment: .leading)
      .background(palette.sidebar)

      VStack(alignment: .leading, spacing: 26) {
        VStack(alignment: .leading, spacing: 8) {
          Text("Choose where Scout can browse")
            .font(.title2.weight(.semibold))
          Text("Scout is sandboxed by design. It can see only the folders you choose and securely remembers them for your next visit.")
            .font(.body)
            .foregroundStyle(palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        VStack(alignment: .leading, spacing: 15) {
          AccessStep(number: "1", title: "Choose a location", detail: "Home gives Scout broad access, or start with a smaller folder.")
          AccessStep(number: "2", title: "Browse its contents", detail: "Everything beneath that folder remains available while you use Scout.")
          AccessStep(number: "3", title: "Add more anytime", detail: "External drives and cloud folders can be granted separately.")
        }

        Button {
          Task {
            if let grant = try? await grantStore.addLocation() { await onGrant(grant) }
          }
        } label: {
          Label("Choose a Folder…", systemImage: "folder.badge.plus")
            .frame(minWidth: 180)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .accessibilityHint("Opens the macOS folder picker")

        Text("Scout never requests Full Disk Access.")
          .font(.caption)
          .foregroundStyle(palette.tertiary)
      }
      .padding(48)
      .frame(maxWidth: 560, maxHeight: .infinity, alignment: .leading)
      .background(palette.elevated)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct AccessStep: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  let number: String
  let title: LocalizedStringKey
  let detail: LocalizedStringKey

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text(number)
        .font(.caption.monospaced().weight(.bold))
        .foregroundStyle(palette.accent)
        .frame(width: 25, height: 25)
        .background(palette.quietFill, in: .circle)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.callout.weight(.semibold))
        Text(detail).font(.callout).foregroundStyle(palette.secondary)
      }
    }
  }
}

private struct ScoutEmptyState: View {
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  let title: LocalizedStringKey
  let message: LocalizedStringKey
  let systemImage: String

  private var palette: ScoutThemePalette { theme.palette(for: colorScheme) }

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: systemImage)
        .font(.system(size: 28, weight: .light))
        .foregroundStyle(palette.accent)
      Text(title).font(.headline)
      Text(message).font(.callout).foregroundStyle(palette.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
