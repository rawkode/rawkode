import EnchiridionCore
import SwiftUI

struct PageListScreen: View {
  let store: LibraryStore
  let section: LibrarySection

  @State private var query = ""
  @State private var path: [PageID] = []
  @State private var pagePendingPermanentDeletion: PageSnapshot?

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if section == .today, !store.calendarEvents.isEmpty {
          Section("Agenda") {
            ForEach(store.events(on: Date())) { event in
              Button {
                Task {
                  if let id = await store.openCalendarEventPage(event) { path.append(id) }
                }
              } label: {
                CalendarEventRow(event: event)
              }
              .buttonStyle(.plain)
            }
          }
        }

        Section(section == .today ? "Notes" : section.title) {
          let pages = store.pages(in: section, matching: query)
          if pages.isEmpty {
            if section == .trash {
              ContentUnavailableView(
                "Trash is empty",
                systemImage: "trash",
                description: Text(
                  "Pages moved to Trash appear here until they are restored or deleted permanently."
                )
              )
            } else {
              Button(action: createPage) { Label("Create a page", systemImage: "doc.badge.plus") }
            }
          } else {
            ForEach(pages) { page in
              if let suppressed = store.suppressedBookmarkTrashPresentation(for: page.id) {
                SuppressedBookmarkTrashRow(page: page, presentation: suppressed)
                  .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                      pagePendingPermanentDeletion = page
                    } label: {
                      Label("Delete Permanently", systemImage: "trash.slash")
                    }
                    .accessibilityHint(
                      "Opens a confirmation. The content stays in Trash until deletion is safe to finish."
                    )
                  }
                  .contextMenu {
                    PageLifecycleMenuActions(
                      store: store,
                      page: page,
                      requestPermanentDeletion: { pagePendingPermanentDeletion = $0 }
                    )
                  }
              } else {
                NavigationLink(value: page.id) {
                  PageRowView(page: page, calendarContext: store.calendarPageContext(for: page.id))
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: section != .trash) {
                  if section == .trash {
                    Button(role: .destructive) {
                      pagePendingPermanentDeletion = page
                    } label: {
                      Label("Delete Permanently", systemImage: "trash.slash")
                    }
                    .accessibilityHint("Opens a confirmation before permanently deleting this page.")
                  } else {
                    Button(role: .destructive) {
                      store.moveToTrash(pageID: page.id)
                    } label: {
                      Label("Move to Trash", systemImage: "trash")
                    }
                    .accessibilityHint("Moves this page to Trash, where it can be restored.")
                  }
                }
                .swipeActions(edge: .leading) {
                  if section == .trash {
                    Button {
                      store.restore(pageID: page.id)
                    } label: {
                      Label("Restore", systemImage: "arrow.uturn.backward")
                    }
                    .tint(.blue)
                    .accessibilityHint("Returns this page to the library.")
                  } else {
                    Button {
                      store.togglePinned(pageID: page.id)
                    } label: {
                      Label(
                        page.isPinned ? "Unpin" : "Pin",
                        systemImage: page.isPinned ? "pin.slash" : "pin")
                    }
                    .tint(.orange)
                    .accessibilityHint(
                      page.isPinned ? "Removes this page from Pinned." : "Adds this page to Pinned.")
                  }
                }
                .contextMenu {
                  PageLifecycleMenuActions(
                    store: store,
                    page: page,
                    requestPermanentDeletion: { pagePendingPermanentDeletion = $0 }
                  )
                }
              }
            }
          }
        }
      }
      .navigationTitle(section.title)
      .navigationDestination(for: PageID.self) { pageID in
        PageDestinationView(store: store, pageID: pageID)
      }
      .searchable(text: $query, prompt: "Search pages")
      .toolbar {
        if section != .trash {
          ToolbarItem(placement: .primaryAction) {
            Button(action: createPage) { Label("New Page", systemImage: "square.and.pencil") }
          }
        }
      }
      .confirmsPermanentPageDeletion(page: $pagePendingPermanentDeletion) {
        store.purge(pageID: $0)
      }
      .onChange(of: Set(store.suppressedBookmarkTrash.keys)) { _, _ in
        path.removeAll { !store.canOpenPage($0) }
      }
    }
  }

  private func createPage() {
    Task {
      if let id = await store.createFreePage() { path.append(id) }
    }
  }
}
