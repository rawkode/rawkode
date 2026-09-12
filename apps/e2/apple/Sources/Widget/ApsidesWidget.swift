import ApsidesCore
import SwiftUI
import WidgetKit

struct AgendaEntry: TimelineEntry {
    let date: Date
    let snapshot: ContextSnapshot?
}
struct AgendaProvider: TimelineProvider {
    func placeholder(in context: Context) -> AgendaEntry { AgendaEntry(date: .now, snapshot: nil) }
    func getSnapshot(in context: Context, completion: @escaping (AgendaEntry) -> Void) { completion(entry()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<AgendaEntry>) -> Void) {
        let current = entry()
        // Schedule known changes now; a background refresh is not a precise timer.
        let expiry = current.snapshot?.fetchedAt.addingTimeInterval(3600) ?? current.date
        let midnight = Calendar.current.date(byAdding: .day, value: 1,
            to: Calendar.current.startOfDay(for: current.date)) ?? expiry
        let eventDates = current.snapshot?.events.flatMap { [$0.start, $0.end].compactMap { $0 } } ?? []
        let dates = Set(eventDates + [expiry, midnight])
            .filter { $0 > current.date && $0 <= expiry }
            .sorted()
        let entries = [current] + dates.map { AgendaEntry(date: $0, snapshot: current.snapshot) }
        completion(Timeline(entries: entries, policy: .after(current.date.addingTimeInterval(300))))
    }
    private func entry() -> AgendaEntry {
        let snapshot = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.dev.rawkode.apsides")
            .flatMap { try? Data(contentsOf: $0.appendingPathComponent("context.json")) }
            .flatMap { try? JSONDecoder().decode(ContextSnapshot.self, from: $0) }
        return AgendaEntry(date: .now, snapshot: snapshot)
    }
}
struct NextEventWidgetView: View {
    let entry: AgendaEntry
    private var isHappeningNow: Bool {
        guard let snapshot = entry.snapshot, snapshot.day == DayIdentity.key(entry.date),
              entry.date >= snapshot.fetchedAt, entry.date.timeIntervalSince(snapshot.fetchedAt) < 3600,
              let event = snapshot.nextEvent(at: entry.date), let start = event.start else { return false }
        return start <= entry.date
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(isHappeningNow ? "Now" : "Up next", systemImage: "calendar").font(.caption)
                .widgetAccentable()
            if let snapshot = entry.snapshot, snapshot.day == DayIdentity.key(entry.date),
               entry.date >= snapshot.fetchedAt, entry.date.timeIntervalSince(snapshot.fetchedAt) < 3600 {
                if let event = snapshot.nextEvent(at: entry.date) {
                    Text(event.title).font(.headline).lineLimit(2).privacySensitive()
                    if let start = event.start { Text(start, style: .time).font(.title2.monospacedDigit()) }
                } else { Text("No more events").font(.headline) }
            } else {
                Text("Refresh your day").font(.headline)
                Text("Open Apsides on iPhone before your journey.").font(.caption).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
        .widgetURL(URL(string: "apsides://today"))
    }
}
@main
struct ApsidesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ApsidesNextEvent", provider: AgendaProvider()) { NextEventWidgetView(entry: $0) }
            .configurationDisplayName("Up next")
            .description("Your next event at a glance.")
            .supportedFamilies([.systemSmall, .accessoryRectangular])
            .containerBackgroundRemovable(true)
    }
}
