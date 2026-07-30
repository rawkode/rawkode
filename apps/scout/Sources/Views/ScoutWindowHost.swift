import SwiftUI

struct ScoutWindowHost: View {
  @State private var session: BrowserSession
  @SceneStorage("ScoutBrowserWindowState") private var restorationData: Data?
  @State private var columnVisibility: NavigationSplitViewVisibility = .all

  init(appModel: ScoutAppModel) {
    _session = State(initialValue: appModel.makeSession())
  }

  var body: some View {
    ScoutBrowserView(session: session, columnVisibility: $columnVisibility)
      .frame(minWidth: 900, minHeight: 560)
      .tint(Color("ScoutAccent"))
      .focusedSceneValue(\.browserSession, session)
      .background(ScoutWindowBridge(title: session.windowTitle).frame(width: 0, height: 0))
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
  @Bindable var session: BrowserSession
  @Binding var columnVisibility: NavigationSplitViewVisibility
  @State private var exactPath = ""
  @FocusState private var searchFocused: Bool

  var body: some View {
    ZStack {
      if session.grantStore.grants.isEmpty {
        FirstRunView(grantStore: session.grantStore) { grant in
          await session.open(grant)
        }
      } else {
        NavigationSplitView(columnVisibility: $columnVisibility) {
          ScoutSidebar(session: session)
            .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 260)
        } detail: {
          browserContent
            .inspector(isPresented: $session.inspectorPresented) {
              FileInspectorView(items: session.selectedItems)
                .inspectorColumnWidth(min: 280, ideal: 320, max: 360)
            }
        }
      }

      if session.commandPalettePresented {
        Color.black.opacity(0.12)
          .ignoresSafeArea()
          .onTapGesture { session.commandPalettePresented = false }
        CommandPaletteView(session: session)
          .transition(.scale(scale: 0.98).combined(with: .opacity))
      }
    }
    .animation(.snappy(duration: 0.16), value: session.commandPalettePresented)
    .toolbar { toolbarContent }
    .safeAreaInset(edge: .bottom) {
      if let notice = session.journal.notice {
        OperationNoticeView(notice: notice) {
          Task { await session.undo() }
        } dismiss: {
          session.journal.dismissNotice()
        }
      }
    }
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

  @ViewBuilder
  private var browserContent: some View {
    Group {
      if session.rootURL == nil {
        ContentUnavailableView(
          "Location Unavailable",
          systemImage: "externaldrive.badge.exclamationmark",
          description: Text("Choose the location again to restore access.")
        )
      } else if session.isLoading {
        ProgressView("Opening Location…")
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
    .background(Color(nsColor: .controlBackgroundColor))
    .overlay(alignment: .topLeading) {
      if !session.searchText.isEmpty {
        Text("\(session.searchResults.count) Spotlight results in \(session.activeGrant?.displayName ?? "location")")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.horizontal, 10)
          .padding(.vertical, 5)
          .background(.bar, in: .capsule)
          .padding(10)
      }
    }
  }

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    ToolbarItemGroup(placement: .navigation) {
      Button { Task { await session.navigateUp() } } label: {
        Label("Enclosing Folder", systemImage: "chevron.up")
      }
      .disabled(!session.canNavigateUp)

      Button { session.pathNavigatorPresented = true } label: {
        Label("Go to Folder", systemImage: "location")
      }
    }

    ToolbarItem(placement: .principal) {
      Button { session.pathNavigatorPresented = true } label: {
        HStack(spacing: 5) {
          Image(systemName: "folder.fill")
            .foregroundStyle(Color.accentColor)
          Text(session.windowTitle)
            .lineLimit(1)
        }
        .font(.callout.weight(.medium))
      }
      .buttonStyle(.plain)
      .help("Show exact path navigation")
    }

    ToolbarItemGroup(placement: .primaryAction) {
      Picker("View", selection: $session.viewMode) {
        ForEach(BrowserViewMode.allCases) { mode in
          Label(mode.title, systemImage: mode.systemImage).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .frame(width: 126)

      TextField("Search", text: $session.searchText)
        .textFieldStyle(.roundedBorder)
        .frame(width: 190)
        .focused($searchFocused)
        .onSubmit { session.beginSearch() }
        .onChange(of: session.searchText) { _, text in
          if text.isEmpty { session.endSearch() }
        }

      Button { session.commandPalettePresented = true } label: {
        Label("Commands", systemImage: "command")
      }
      .help("Command Palette (⌘K)")

      Button { session.inspectorPresented.toggle() } label: {
        Label("Inspector", systemImage: "sidebar.right")
      }
      .help("Show Inspector (⌥⌘I)")
    }
  }
}

private struct ScoutSidebar: View {
  @Bindable var session: BrowserSession

  var body: some View {
    List {
      Section("Locations") {
        ForEach(session.grantStore.orderedGrants) { grant in
          Button {
            Task { await session.open(grant) }
          } label: {
            Label {
              Text(grant.displayName).lineLimit(1)
            } icon: {
              Image(systemName: grant.id == session.activeGrant?.id ? "folder.fill" : "folder")
            }
          }
          .buttonStyle(.plain)
          .foregroundStyle(grant.id == session.activeGrant?.id ? Color.accentColor : .primary)
          .accessibilityValue(grant.id == session.activeGrant?.id ? "Current location" : "")
        }
      }

      Section {
        Button {
          Task {
            if let grant = try? await session.grantStore.addLocation() { await session.open(grant) }
          }
        } label: {
          Label("Add Location…", systemImage: "plus")
        }
      }
    }
    .listStyle(.sidebar)
    .navigationTitle("Scout")
  }
}

private struct FirstRunView: View {
  let grantStore: AccessGrantStore
  let onGrant: (AccessGrant) async -> Void

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "chevron.forward.2")
        .font(.system(size: 54, weight: .medium))
        .symbolRenderingMode(.hierarchical)
        .foregroundStyle(Color.accentColor)
      VStack(spacing: 7) {
        Text("Choose Where Scout Can Browse")
          .font(.title2.weight(.semibold))
        Text("Scout is sandboxed. It can see only folders you choose, and securely remembers those locations for your next visit.")
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 460)
      }
      Button("Choose Home or Another Folder…") {
        Task {
          if let grant = try? await grantStore.addLocation() { await onGrant(grant) }
        }
      }
      .buttonStyle(.borderedProminent)
      Text("You can choose a narrower project folder instead of Home, and add drives later.")
        .font(.caption)
        .foregroundStyle(.tertiary)
    }
    .padding(42)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(nsColor: .controlBackgroundColor))
  }
}
