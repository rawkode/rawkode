import EnchiridionCore
import SwiftUI

struct PageListScreen: View {
  let store: LibraryStore
  let section: LibrarySection

  @State private var query = ""
  @State private var path: [PageID] = []

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
            Button(action: createPage) { Label("Create a page", systemImage: "doc.badge.plus") }
          } else {
            ForEach(pages) { page in
              NavigationLink(value: page.id) {
                PageRowView(page: page, calendarContext: store.calendarPageContext(for: page.id))
              }
                .swipeActions(edge: .trailing) {
                  Button("Trash", role: .destructive) { store.moveToTrash(pageID: page.id) }
                }
                .swipeActions(edge: .leading) {
                  Button(page.isPinned ? "Unpin" : "Pin") { store.togglePinned(pageID: page.id) }
                    .tint(.orange)
                }
            }
          }
        }
      }
      .navigationTitle(section.title)
      .navigationDestination(for: PageID.self) { pageID in
        PageEditorView(store: store, pageID: pageID)
      }
      .searchable(text: $query, prompt: "Search pages")
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button(action: createPage) { Label("New Page", systemImage: "square.and.pencil") }
        }
      }
    }
  }

  private func createPage() {
    Task {
      if let id = await store.createFreePage() { path.append(id) }
    }
  }
}
