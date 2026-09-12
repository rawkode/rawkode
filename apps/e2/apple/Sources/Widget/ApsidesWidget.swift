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
        completion(Timeline(entries: [current], policy: .after(Date().addingTimeInterval(300))))
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
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Up next", systemImage: "calendar").font(.caption)
            if let snapshot = entry.snapshot, snapshot.day == DayIdentity.key(entry.date), entry.date.timeIntervalSince(snapshot.fetchedAt) < 3600 {
                if let event = snapshot.nextEvent(at: entry.date) {
                    Text(event.title).font(.headline).lineLimit(2).privacySensitive()
                    if let start = event.start { Text(start, style: .time).font(.title2.monospacedDigit()) }
                } else { Text("No more events").font(.headline) }
            } else {
                Text("Open Apsides on iPhone to refresh your day.").font(.callout)
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
    }
}
