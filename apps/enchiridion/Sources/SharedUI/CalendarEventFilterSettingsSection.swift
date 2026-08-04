import EnchiridionCore
import SwiftUI

struct CalendarEventFilterSettingsSection: View {
  let store: LibraryStore
  @State private var draftPrefixes: [String] = []
  @State private var newPrefix = ""

  var body: some View {
    Section("Calendar Events") {
      NavigationLink {
        CalendarEventPagesSettingsRoute(store: store)
      } label: {
        LabeledContent("Event Pages", value: "\(store.pages.filter { $0.hasSupertag(BuiltInSupertags.event) }.count)")
      }
      Text("Connecting a calendar creates and syncs normal Event pages. Calendar accounts, raw identifiers, attendee addresses, notes, and links remain on this device.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    Section("Omit Events") {
      ForEach(draftPrefixes.indices, id: \.self) { index in
        TextField("Title prefix", text: $draftPrefixes[index])
          .onSubmit { saveDrafts() }
          .accessibilityLabel("Omitted event title prefix")
      }
      .onDelete { offsets in
        draftPrefixes.remove(atOffsets: offsets)
        saveDrafts()
      }

      HStack {
        TextField("Add a title prefix", text: $newPrefix)
          .onSubmit(addPrefix)
        Button("Add", systemImage: "plus", action: addPrefix)
          .labelStyle(.iconOnly)
          .disabled(newPrefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }

      Text("Matching is case-insensitive and only checks the beginning of an event title. These filters stay on this device.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .task { draftPrefixes = store.omissionPrefixes }
    .onChange(of: store.omissionPrefixes) { _, prefixes in
      guard prefixes != CalendarEventOmissionRules.normalizedPrefixes(draftPrefixes) else { return }
      draftPrefixes = prefixes
    }
    .onDisappear(perform: saveDrafts)
  }

  private func addPrefix() {
    let value = newPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return }
    draftPrefixes.append(value)
    newPrefix = ""
    saveDrafts()
  }

  private func saveDrafts() {
    let normalized = CalendarEventOmissionRules.normalizedPrefixes(draftPrefixes)
    guard normalized != store.omissionPrefixes else { return }
    draftPrefixes = normalized
    Task { await store.setCalendarEventOmissionPrefixes(normalized) }
  }
}

private struct CalendarEventPagesSettingsRoute: View {
  let store: LibraryStore
  @State private var path: [PageID] = []

  private var pages: [PageSnapshot] {
    store.pages.filter { $0.hasSupertag(BuiltInSupertags.event) }
  }

  var body: some View {
    List(pages) { page in
      NavigationLink(value: page.id) {
        PageRowView(page: page, calendarContext: store.calendarPageContext(for: page.id))
      }
    }
    .navigationTitle("Event Pages")
    .navigationDestination(for: PageID.self) { PageDestinationView(store: store, pageID: $0) }
  }
}
