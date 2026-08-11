// TodayTasksWidget.swift
// EnchiridionWidgetKit
//
// Read-only "today's tasks" widget (plan §Platform parity: "Widgets (iOS +
// macOS, WidgetKit) — read-only surfaces (today's tasks, next calendar
// event)"). NO interactive `AppIntent` button (unlike the old app's
// `TodayTasksWidget.swift`, which has a "complete task" intent) — this
// task's own brief is explicit that App Intents are sibling task #74's
// scope, not this one's; see this target's README "Explicit non-goals."
//
// `TimelineProvider` conformance is a thin wrapper around
// `WidgetEntryDataSource.loadTodayTasksEntry` (`WidgetEntryDataSource.swift`)
// — all the actual data logic lives there and is unit tested; this file is
// deliberately not (see this target's README for why WidgetKit's own
// context types make that impractical outside a real widget host).
//
// The `EnchiridionTodayTasksWidget` type below (the actual
// `Widget`-conforming, `WidgetBundle`-embeddable entry) is `public` and IS
// consumed directly from both platforms' extension targets
// (`Sources/macOSWidget/`, `Sources/iOSWidget/`) — a `Widget`-conforming
// type defined in an SPM library compiles and links fine when the
// consuming file also `import SwiftUI` alongside `import WidgetKit`
// (needed for the `some Widget`/`some WidgetConfiguration` opaque return
// types either file uses); confirmed by direct experiment after an earlier
// version of this comment wrongly suspected a toolchain limitation — the
// actual cause was a missing `import SwiftUI` in the widget-bundle files,
// nothing about where `Widget` conformances are declared.

import EnchiridionStore
import SwiftUI
import WidgetKit

// `TodayTasksWidgetEntry` itself lives in `WidgetEntryDataSource.swift`,
// which deliberately does NOT import WidgetKit (see that file's header —
// keeping it testable without a WidgetKit-hosting process). Conformance is
// added here instead, in the one file that already imports WidgetKit for
// the `TimelineProvider` below — `TimelineEntry` needs only the `date`
// property both entry types already declare (`relevance` has a default via
// WidgetKit's own protocol extension).
extension TodayTasksWidgetEntry: TimelineEntry {}

struct TodayTasksTimelineProvider: TimelineProvider {
  func placeholder(in context: Context) -> TodayTasksWidgetEntry {
    TodayTasksWidgetEntry(date: Date(), taskTitles: ["Review inbox", "Plan tomorrow"], truncated: false)
  }

  func getSnapshot(in context: Context, completion: @escaping @Sendable (TodayTasksWidgetEntry) -> Void) {
    completion(Self.loadEntry())
  }

  func getTimeline(
    in context: Context, completion: @escaping @Sendable (Timeline<TodayTasksWidgetEntry>) -> Void
  ) {
    let entry = Self.loadEntry()
    // Fixed 15-minute refresh — the widget has no cheaper way to learn
    // "a task's due/scheduled date just rolled into today" than polling;
    // matches the old app's `TodayTasksWidget.swift`'s own refresh cadence.
    let nextRefresh =
      Calendar.current.date(byAdding: .minute, value: 15, to: Date())
      ?? Date(timeIntervalSinceNow: 900)
    completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
  }

  private static func loadEntry() -> TodayTasksWidgetEntry {
    switch WidgetLocalStore.shared {
    case .failure:
      return TodayTasksWidgetEntry(
        date: Date(), taskTitles: [], truncated: false, statusMessage: "Open Enchiridion to finish setup.")
    case .success(let store):
      return WidgetEntryDataSource.loadTodayTasksEntry(store: store)
    }
  }
}

struct TodayTasksWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: TodayTasksWidgetEntry

  private var visibleTitles: ArraySlice<String> {
    entry.taskTitles.prefix(family == .systemSmall ? 3 : 6)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Today", systemImage: "checklist")
        .font(.headline)

      if let statusMessage = entry.statusMessage {
        Text(statusMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
      } else if visibleTitles.isEmpty {
        Spacer(minLength: 0)
        Label("Nothing scheduled", systemImage: "checkmark.circle")
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
      } else {
        ForEach(Array(visibleTitles.enumerated()), id: \.offset) { _, title in
          Label {
            Text(title)
              .lineLimit(1)
              .privacySensitive()
          } icon: {
            Image(systemName: "circle")
              .foregroundStyle(.secondary)
          }
          .font(.caption)
        }
        Spacer(minLength: 0)
      }
    }
    .containerBackground(.fill.tertiary, for: .widget)
  }
}

public struct EnchiridionTodayTasksWidget: Widget {
  public static let kind = "dev.rawkode.enchiridion2.widget.todayTasks"

  public init() {}

  public var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: TodayTasksTimelineProvider()) { entry in
      TodayTasksWidgetView(entry: entry)
    }
    .configurationDisplayName("Today's Tasks")
    .description("See what's due or scheduled today, read-only.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
