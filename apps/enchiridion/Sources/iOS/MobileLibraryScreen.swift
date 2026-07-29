import EnchiridionCore
import SwiftUI

struct MobileLibraryScreen: View {
  let store: LibraryStore
  let contactsResolver: DeviceContactsResolver
  let vaultSession: VaultSession?
  let selectVault: @MainActor (VaultID) throws -> Void
  let workspaceDidChange: @MainActor () -> Void
  @State private var query = ""
  @State private var editingTag: SupertagDefinition?
  @State private var editingView: LiveQueryDefinition?

  init(
    store: LibraryStore,
    contactsResolver: DeviceContactsResolver = DeviceContactsResolver(),
    vaultSession: VaultSession? = nil,
    selectVault: @escaping @MainActor (VaultID) throws -> Void = { _ in },
    workspaceDidChange: @escaping @MainActor () -> Void = {}
  ) {
    self.store = store
    self.contactsResolver = contactsResolver
    self.vaultSession = vaultSession
    self.selectVault = selectVault
    self.workspaceDidChange = workspaceDidChange
  }

  var body: some View {
    NavigationStack {
      List {
        if let vaultSession {
          Section("Vault") {
            VaultSwitcherMenu(session: vaultSession, selectVault: selectVault)
          }
        }

        Section("Pages") {
          NavigationLink {
            PageListScreen(store: store, section: .allPages)
          } label: {
            Label("All Pages", systemImage: "books.vertical")
          }
          NavigationLink {
            PageListScreen(store: store, section: .pinned)
          } label: {
            Label("Pinned", systemImage: "pin")
          }
          NavigationLink {
            PageListScreen(store: store, section: .trash)
          } label: {
            Label("Trash", systemImage: "trash")
          }
        }

        Section("Supertags") {
          ForEach(store.supertags) { tag in
            NavigationLink {
              SupertagMobileCollection(store: store, tag: tag)
            } label: {
              Label {
                HStack {
                  Text(tag.name)
                  Spacer()
                  Text(store.pages(with: tag.id).count.formatted())
                    .foregroundStyle(.secondary)
                }
              } icon: {
                Image(systemName: tag.symbol)
              }
            }
          }
          Button {
            editingTag = .draft()
          } label: {
            Label("New Supertag", systemImage: "plus")
          }
        }

        Section("Views") {
          ForEach(store.savedViews.filter { !$0.isTaskListPerspective }) { view in
            NavigationLink {
              MobileLiveViewDestination(store: store, definition: view)
            } label: {
              Label(view.name, systemImage: view.viewKind.systemImage)
            }
          }
          Button {
            editingView = .init(name: "New View", source: .pages)
          } label: {
            Label("New View", systemImage: "plus")
          }
        }

        Section("Graph") {
          NavigationLink {
            MobileGraphQueryDestination(store: store)
          } label: {
            Label("Query", systemImage: "point.3.connected.trianglepath.dotted")
          }
          NavigationLink {
            GraphRelationDefinitionsView(store: store)
          } label: {
            Label("Relationship Types", systemImage: "arrow.left.arrow.right")
          }
          NavigationLink {
            MobileGraphIssuesDestination(store: store)
          } label: {
            Label("Needs Attention", systemImage: "exclamationmark.triangle")
          }
        }
      }
      .navigationTitle("Library")
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          NavigationLink {
            MobileSettingsView(
              store: store,
              contactsResolver: contactsResolver,
              vaultSession: vaultSession,
              selectVault: selectVault,
              workspaceDidChange: workspaceDidChange
            )
          } label: {
            Label("Settings", systemImage: "gearshape")
          }
        }
      }
      .sheet(item: $editingTag) { tag in
        SupertagSchemaEditor(store: store, definition: tag)
      }
      .sheet(item: $editingView) { view in
        LiveViewEditor(store: store, definition: view)
      }
    }
  }
}

private struct MobileGraphQueryDestination: View {
  let store: LibraryStore
  @State private var openedPageID: PageID?

  var body: some View {
    GraphQueryWorkspace(store: store) { openedPageID = $0 }
      .sheet(item: $openedPageID) { pageID in
        NavigationStack { PageDestinationView(store: store, pageID: pageID) }
      }
  }
}

private struct MobileGraphIssuesDestination: View {
  let store: LibraryStore
  @State private var openedPageID: PageID?

  var body: some View {
    GraphIssuesView(store: store) { openedPageID = $0 }
      .sheet(item: $openedPageID) { pageID in
        NavigationStack { PageDestinationView(store: store, pageID: pageID) }
      }
  }
}

private struct MobileLiveViewDestination: View {
  let store: LibraryStore
  let definition: LiveQueryDefinition
  @State private var openedPageID: PageID?

  var body: some View {
    LiveViewScreen(store: store, definition: definition) { pageID in
      openedPageID = pageID
    }
    .sheet(item: $openedPageID) { pageID in
      NavigationStack {
        PageDestinationView(store: store, pageID: pageID)
      }
    }
  }
}

private struct SupertagMobileCollection: View {
  let store: LibraryStore
  let tag: SupertagDefinition
  @State private var query = ""
  @State private var editingTag: SupertagDefinition?

  var body: some View {
    List(filteredPages) { page in
      NavigationLink {
        PageDestinationView(store: store, pageID: page.id)
      } label: {
        PageRowView(page: page, calendarContext: store.calendarPageContext(for: page.id))
      }
    }
    .overlay {
      if filteredPages.isEmpty {
        ContentUnavailableView.search(text: query)
      }
    }
    .navigationTitle(tag.name)
    .searchable(text: $query, prompt: "Search \(tag.name.lowercased())")
    .toolbar {
      ToolbarItem {
        Button {
          editingTag = tag
        } label: {
          Label("Edit Schema", systemImage: "slider.horizontal.3")
        }
      }
      ToolbarItem(placement: .primaryAction) {
        Button {
          Task {
            _ = await store.createTaggedPage(title: "Untitled \(tag.name)", supertagID: tag.id)
          }
        } label: {
          Label("New \(tag.name)", systemImage: "plus")
        }
      }
    }
    .sheet(item: $editingTag) { tag in
      SupertagSchemaEditor(store: store, definition: tag)
    }
  }

  private var filteredPages: [PageSnapshot] {
    store.pages(with: tag.id).filter {
      query.isEmpty || $0.title.localizedStandardContains(query)
        || $0.plainText.localizedStandardContains(query)
    }
  }
}
