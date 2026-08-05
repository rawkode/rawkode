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
      CalendarRefreshStatusView(
        phase: store.calendarRefreshPhase,
        progress: store.calendarRefreshProgress,
        error: store.calendarError
      )
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
    List {
      CalendarRefreshStatusView(
        phase: store.calendarRefreshPhase,
        progress: store.calendarRefreshProgress,
        error: store.calendarError
      )
      if pages.isEmpty {
        ContentUnavailableView(
          "No Event Pages Yet",
          systemImage: "calendar.badge.clock",
          description: Text("Event Pages will appear here as your calendar is prepared.")
        )
      } else {
        ForEach(pages) { page in
          NavigationLink(value: page.id) {
            PageRowView(page: page, calendarContext: store.calendarPageContext(for: page.id))
          }
        }
      }
    }
    .navigationTitle("Event Pages")
    .navigationDestination(for: PageID.self) { PageDestinationView(store: store, pageID: $0) }
  }
}

/// A nonblocking summary of the aggregate calendar import state. It deliberately
/// uses no provider or event identity so it is safe to show wherever Event Pages
/// are surfaced.
struct CalendarRefreshStatusView: View {
  let phase: CalendarRefreshPhase
  let progress: CalendarRefreshProgress
  let error: String?

  var body: some View {
    if phase != .idle || progress.skippedEventCount > 0 || error != nil {
      VStack(alignment: .leading, spacing: 6) {
        if phase != .idle {
          Label(statusTitle, systemImage: statusSymbol)
            .font(.subheadline.weight(.semibold))
          if phase == .materializing, progress.totalEventCount > 0 {
            ProgressView(value: completion)
              .accessibilityLabel("Event Pages progress")
              .accessibilityValue("\(progress.processedEventCount) of \(progress.totalEventCount) Event Pages ready")
            Text("\(progress.processedEventCount) of \(progress.totalEventCount) Event Pages ready")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            HStack(spacing: 8) {
              ProgressView()
                .controlSize(.small)
                .accessibilityHidden(true)
              Text(statusDetail)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
          }
        }

        if progress.skippedEventCount > 0 {
          Label(
            "\(progress.skippedEventCount) events remain in your calendar but cannot become Event Pages because they lack a stable sync identity.",
            systemImage: "info.circle"
          )
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }

        if let error {
          Label("Calendar needs attention", systemImage: "exclamationmark.triangle")
            .font(.subheadline.weight(.semibold))
          Text(error)
            .font(.caption)
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Calendar error: \(error)")
        }
      }
      .padding(.vertical, 4)
      .accessibilityElement(children: .contain)
    }
  }

  private var statusTitle: String {
    switch phase {
    case .idle:
      ""
    case .refreshing:
      "Refreshing calendar"
    case .materializing:
      "Preparing Event Pages"
    }
  }

  private var statusDetail: String {
    switch phase {
    case .idle:
      ""
    case .refreshing:
      "Updating your cached agenda in the background."
    case .materializing:
      "Creating Event Pages in the background."
    }
  }

  private var statusSymbol: String {
    switch phase {
    case .idle:
      "calendar"
    case .refreshing:
      "arrow.triangle.2.circlepath"
    case .materializing:
      "calendar.badge.clock"
    }
  }

  private var completion: Double {
    guard progress.totalEventCount > 0 else { return 0 }
    return min(1, Double(progress.processedEventCount) / Double(progress.totalEventCount))
  }
}
