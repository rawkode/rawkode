import EnchiridionCore
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
        let snapshot = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.rawkode.academy.enchiridion")
            .flatMap { try? Data(contentsOf: $0.appendingPathComponent("context.json")) }
            .flatMap { try? JSONDecoder().decode(ContextSnapshot.self, from: $0) }
        return AgendaEntry(date: .now, snapshot: snapshot)
    }
}
struct NextEventWidgetView: View {
    let entry: AgendaEntry
    @Environment(\.widgetFamily) private var family
    private var validSnapshot: ContextSnapshot? {
        guard let snapshot = entry.snapshot, snapshot.day == DayIdentity.key(entry.date),
              entry.date >= snapshot.fetchedAt, entry.date.timeIntervalSince(snapshot.fetchedAt) < 3600 else { return nil }
        return snapshot
    }
    private var event: AgendaEvent? { validSnapshot?.nextEvent(at: entry.date) }
    private var isHappeningNow: Bool { event?.start.map { $0 <= entry.date } ?? false }
    var body: some View {
        Group {
            if family == .accessoryRectangular {
                VStack(alignment: .leading, spacing: 2) {
                    if let event {
                        HStack {
                            Text(isHappeningNow ? "Now" : "Up next")
                            if let start = event.start { Text(start, style: .time).privacySensitive() }
                        }.font(.caption).widgetAccentable()
                        Text(event.title).font(.headline).lineLimit(2).privacySensitive()
                    } else {
                        Text(validSnapshot == nil ? "Refresh your day" : "No more events").font(.headline).lineLimit(1)
                        if validSnapshot == nil { Text("Open Enchiridion on iPhone").font(.caption).lineLimit(1) }
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Label(isHappeningNow ? "Now" : "Up next", systemImage: "calendar").font(.caption).widgetAccentable()
                    if let event {
                        Text(event.title).font(.headline).lineLimit(2).privacySensitive()
                        if let start = event.start { Text(start, style: .time).font(.title2.monospacedDigit()).privacySensitive() }
                    } else if validSnapshot != nil {
                        Text("No more events").font(.headline)
                    } else {
                        Text("Refresh your day").font(.headline)
                        Text("Open Enchiridion on iPhone.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .containerBackground(.fill.tertiary, for: .widget)
            .widgetURL(URL(string: "enchiridion://today"))
    }
}
@main
struct EnchiridionWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "EnchiridionNextEvent", provider: AgendaProvider()) { NextEventWidgetView(entry: $0) }
            .configurationDisplayName("Up next")
            .description("Your next event at a glance.")
            .supportedFamilies([.systemSmall, .accessoryRectangular])
            .containerBackgroundRemovable(true)
    }
}
