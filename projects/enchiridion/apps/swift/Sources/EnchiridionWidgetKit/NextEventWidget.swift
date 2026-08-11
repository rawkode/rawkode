// NextEventWidget.swift
// EnchiridionWidgetKit
//
// Read-only "next calendar event" widget (plan §Platform parity: "Widgets
// ... — read-only surfaces (today's tasks, next calendar event)"). Same
// thin-`TimelineProvider`-over-`WidgetEntryDataSource` shape as
// `TodayTasksWidget.swift` — see that file's header (including for why
// `EnchiridionNextEventWidget` below is safely `public` and consumed
// directly from both platforms' extension targets).

import SwiftUI
import WidgetKit

// See `TodayTasksWidget.swift`'s equivalent comment: `NextEventWidgetEntry`
// lives in `WidgetEntryDataSource.swift` without a WidgetKit import;
// `TimelineEntry` conformance is added here instead.
extension NextEventWidgetEntry: TimelineEntry {}

struct NextEventTimelineProvider: TimelineProvider {
  func placeholder(in context: Context) -> NextEventWidgetEntry {
    NextEventWidgetEntry(
      date: Date(), title: "Team standup", startDate: Date().addingTimeInterval(1_800), isAllDay: false)
  }

  func getSnapshot(in context: Context, completion: @escaping @Sendable (NextEventWidgetEntry) -> Void) {
    completion(Self.loadEntry())
  }

  func getTimeline(
    in context: Context, completion: @escaping @Sendable (Timeline<NextEventWidgetEntry>) -> Void
  ) {
    let entry = Self.loadEntry()
    let fifteenMinutesOut = Date(timeIntervalSinceNow: 900)
    // Refresh policy: the sooner of "15 minutes from now" or "the shown
    // event's own start time" (if that's still in the future) — a widget
    // that just displayed "starts in 5 minutes" should refresh right as
    // that event starts, not sit stale for a further 10 minutes claiming
    // an event is still upcoming after it began. Falls back to the fixed
    // 15-minute cadence whenever there's no future start time to race
    // against (no event found, or the shown event already started).
    let nextRefresh: Date
    if let startDate = entry.startDate, startDate > Date() {
      nextRefresh = min(startDate, fifteenMinutesOut)
    } else {
      nextRefresh = fifteenMinutesOut
    }
    completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
  }

  private static func loadEntry() -> NextEventWidgetEntry {
    switch WidgetLocalStore.shared {
    case .failure:
      return NextEventWidgetEntry(date: Date(), statusMessage: "Open Enchiridion to finish setup.")
    case .success(let store):
      return WidgetEntryDataSource.loadNextEventEntry(store: store)
    }
  }
}

struct NextEventWidgetView: View {
  let entry: NextEventWidgetEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Next Up", systemImage: "calendar")
        .font(.headline)

      if let statusMessage = entry.statusMessage {
        Spacer(minLength: 0)
        Text(statusMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
      } else if let title = entry.title {
        Spacer(minLength: 0)
        Text(title)
          .font(.subheadline.weight(.semibold))
          .lineLimit(2)
          .privacySensitive()
        if let startDate = entry.startDate {
          Text(
            startDate.formatted(
              date: .abbreviated, time: entry.isAllDay ? .omitted : .shortened)
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        if let location = entry.location, !location.isEmpty {
          Label {
            Text(location).lineLimit(1).privacySensitive()
          } icon: {
            Image(systemName: "location")
          }
          .font(.caption2)
          .foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      } else {
        Spacer(minLength: 0)
        Label("Nothing coming up", systemImage: "checkmark.circle")
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
      }
    }
    .containerBackground(.fill.tertiary, for: .widget)
  }
}

public struct EnchiridionNextEventWidget: Widget {
  public static let kind = "dev.rawkode.enchiridion2.widget.nextEvent"

  public init() {}

  public var body: some WidgetConfiguration {
    StaticConfiguration(kind: Self.kind, provider: NextEventTimelineProvider()) { entry in
      NextEventWidgetView(entry: entry)
    }
    .configurationDisplayName("Next Event")
    .description("See your next upcoming calendar event, read-only.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
