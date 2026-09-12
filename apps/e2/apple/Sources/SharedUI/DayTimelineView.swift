import ApsidesCore
import SwiftUI

/// The connected day is a read-only projection. Writing remains in the shared editor.
struct DayTimelineView: View {
    @ObservedObject var store: WorkspaceStore
    var recenter: Int = 0
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var selectedEvent: AgendaEvent?
    @State private var selectedActivity: DayActivityCluster?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { clock in
            VStack(spacing: 0) { content(at: clock.date) }
                .task(id: DayIdentity.key(clock.date)) { await store.refresh() }
        }
        .background(theme.canvas).foregroundStyle(theme.ink).tint(theme.accent)
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .refreshable { await store.refresh() }
        .sheet(item: $selectedEvent) { DayEventDetails(event: $0) }
        .sheet(item: $selectedActivity) { DayActivityDetails(cluster: $0) }
    }

    @ViewBuilder private func content(at now: Date) -> some View {
        if let snapshot = store.snapshot, snapshot.day == DayIdentity.key(now) {
            connectedDay(snapshot, now: now)
        } else if store.refreshing && store.snapshot == nil {
            ProgressView("Bringing your day together…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ContextConnectionView(store: store)
                    if store.refreshing { ProgressView("Refreshing your day…") }
                    if store.snapshot != nil || store.connectionError != nil {
                        Text("Today's calendar is not available yet.").font(.headline)
                        Button("Refresh today") { Task { await store.refresh() } }
                    }
                }.padding(24)
            }
        }
    }

    private func connectedDay(_ snapshot: ContextSnapshot, now: Date) -> some View {
        let activity = (store.context?.activity ?? []).filter { Calendar.current.isDate($0.date, inSameDayAs: now) }
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Today").font(.system(.largeTitle, design: .serif).weight(.semibold))
                Text(now, format: .dateTime.weekday(.wide).month(.wide).day())
                    .font(.subheadline).foregroundStyle(theme.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24).padding(.top, 6).padding(.bottom, 16)
            status(snapshot, now: now)
            if typeSize.isAccessibilitySize || DayAgendaLayout.items(events: snapshot.events, day: now, minimumVisualMinutes: 26).contains(where: { $0.columnCount > 3 }) {
                accessibleDay(snapshot, activity: activity, now: now)
            } else {
                DayTimelineCanvas(snapshot: snapshot, activity: activity, now: now, recenter: recenter, theme: theme,
                    selectEvent: { selectedEvent = $0 }, selectActivity: { selectedActivity = $0 })
            }
        }
    }

    @ViewBuilder private func status(_ snapshot: ContextSnapshot, now: Date) -> some View {
        if store.refreshing {
            ProgressView("Refreshing your day…").font(.caption).padding(8)
        }
        if let error = store.connectionError {
            Text(error).font(.callout).padding(.horizontal, 24).padding(.vertical, 8)
        }
        if store.context?.partial == true {
            Label("Some services could not refresh", systemImage: "exclamationmark.triangle")
                .font(.callout).padding(.horizontal, 24).padding(.vertical, 8)
        }
        if store.connectionError != nil || now.timeIntervalSince(snapshot.fetchedAt) > 15 * 60 {
            Text("Last updated \(snapshot.fetchedAt.formatted(date: .omitted, time: .shortened))")
                .font(.caption).foregroundStyle(theme.secondary).padding(8)
        }
        if snapshot.events.isEmpty && store.context?.partial != true {
            Text("Nothing scheduled. Your day has room.")
                .font(.callout).foregroundStyle(theme.secondary).padding(16)
        }
    }

    private func accessibleDay(_ snapshot: ContextSnapshot, activity: [RepositoryActivity], now: Date) -> some View {
        let entries = DayTimelineEntry.entries(events: snapshot.events, activity: activity)
        let target = entries.first { entry in
            if let end = entry.event?.end { return end >= now && entry.event?.allDay != true }
            return entry.date >= now
        }?.id ?? entries.last?.id
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(entries) { entry in
                        Button {
                            if let event = entry.event { selectedEvent = event }
                            if let item = entry.activity { selectedActivity = DayActivityCluster(items: [item]) }
                        } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(entry.title).font(.headline)
                                Text(entry.subtitle).font(.body).foregroundStyle(theme.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                                .background(theme.base, in: .rect(cornerRadius: 16))
                        }.buttonStyle(.plain).id(entry.id)
                    }
                }.padding(20)
            }
            .onChange(of: recenter) { _, _ in
                if let target { proxy.scrollTo(target, anchor: .center) }
            }
        }
    }
}

private struct DayTimelineCanvas: View {
    let snapshot: ContextSnapshot
    let activity: [RepositoryActivity]
    let now: Date
    let recenter: Int
    let theme: ApsidesTheme
    let selectEvent: (AgendaEvent) -> Void
    let selectActivity: (DayActivityCluster) -> Void
    private let hourHeight: CGFloat = 112
    private var start: Date { Calendar.current.startOfDay(for: now) }
    private var hours: Int { Int(DayIdentity.bounds(now).1.timeIntervalSince(start) / 3600) }
    private var nowOffset: CGFloat { CGFloat(now.timeIntervalSince(start) / 3600) * hourHeight }
    private var items: [DayAgendaLayout.Item] {
        DayAgendaLayout.items(events: snapshot.events, day: now, minimumVisualMinutes: 26)
    }
    private var clusters: [DayActivityCluster] {
        var groups: [[RepositoryActivity]] = []
        // Preserve the first activity's real position, grouping only markers that would collide.
        for item in activity.sorted(by: { $0.date < $1.date }) {
            if let first = groups.last?.first, item.date.timeIntervalSince(first.date) < 26 * 60 {
                groups[groups.count - 1].append(item)
            } else {
                groups.append([item])
            }
        }
        return groups.map { DayActivityCluster(items: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            allDay
            ScrollViewReader { proxy in
                ScrollView {
                    GeometryReader { geometry in
                        grid(width: geometry.size.width)
                    }.frame(height: CGFloat(hours) * hourHeight + 44)
                }
                .accessibilityIdentifier("dayTimelineScroll")
                .task(id: snapshot.day) { proxy.scrollTo("day-now", anchor: .center) }
                .onChange(of: recenter) { _, _ in proxy.scrollTo("day-now", anchor: .center) }
            }
        }
    }

    @ViewBuilder private var allDay: some View {
        let events = snapshot.events.filter { $0.allDay || $0.start == nil }
        if !events.isEmpty {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(events) { event in
                        Button { selectEvent(event) } label: {
                            HStack(spacing: 8) {
                                Circle().fill(calendarAccent(event.calendarColor, fallback: theme.accent)).frame(width: 6, height: 6)
                                Text(event.title).font(.subheadline.weight(.medium))
                                Text(event.allDay ? "All day" : "Time unavailable").font(.caption).foregroundStyle(theme.secondary)
                            }.padding(.horizontal, 12).padding(.vertical, 10)
                                .background(theme.base, in: .capsule)
                        }.buttonStyle(.plain)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 8)
            }
        }
    }

    private func grid(width: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(0..<hours, id: \.self) { hour in
                    HStack(alignment: .top, spacing: 12) {
                        Text(start.addingTimeInterval(Double(hour) * 3600), format: .dateTime.hour().minute())
                            .font(.caption.monospacedDigit()).foregroundStyle(theme.secondary)
                            .frame(width: 48, alignment: .trailing)
                            .opacity(abs(now.timeIntervalSince(start) / 60 - Double(hour * 60)) < 12 ? 0 : 1)
                        Rectangle().fill(theme.ink.opacity(0.08)).frame(height: 1).padding(.top, 7)
                    }.frame(height: hourHeight, alignment: .top)
                }
            }
            HStack(spacing: 8) {
                Text("Now").font(.caption.weight(.semibold)).frame(width: 48, alignment: .trailing)
                Circle().frame(width: 5, height: 5)
                Rectangle().frame(height: 1)
            }.foregroundStyle(theme.accent).offset(y: nowOffset)
                .accessibilityElement(children: .ignore).accessibilityLabel("Current time")
                .accessibilityIdentifier("dayTimelineNow")
            VStack(spacing: 0) {
                Color.clear.frame(height: nowOffset)
                Color.clear.frame(width: 1, height: 1).id("day-now")
            }.accessibilityHidden(true)
            ForEach(items) { item in
                DayTimelineEvent(item: item, width: max(1, width - 116), hourHeight: hourHeight,
                    theme: theme, select: { selectEvent(item.event) })
            }
            ForEach(clusters) { cluster in
                activityButton(cluster)
                    .offset(x: max(0, width - 48), y: CGFloat(cluster.date.timeIntervalSince(start) / 3600) * hourHeight)
            }
        }.padding(.trailing, 8)
    }

    private func activityButton(_ cluster: DayActivityCluster) -> some View {
        Button { selectActivity(cluster) } label: {
            VStack(spacing: 2) {
                GitHubMark().frame(width: 22, height: 22)
                if cluster.items.count > 1 { Text("\(cluster.items.count)").font(.caption2.monospacedDigit()) }
            }.foregroundStyle(theme.secondary).frame(width: 44, height: 44)
        }.buttonStyle(.plain)
            .accessibilityLabel("GitHub, \(cluster.items.count) activities at \(cluster.date.formatted(date: .omitted, time: .shortened))")
            .accessibilityHint("Show activity details")
    }
}

private struct DayTimelineEvent: View {
    let item: DayAgendaLayout.Item
    let width: CGFloat
    let hourHeight: CGFloat
    let theme: ApsidesTheme
    let select: () -> Void
    private var columnWidth: CGFloat { width / CGFloat(item.columnCount) }
    private var accent: Color { calendarAccent(item.event.calendarColor, fallback: theme.accent) }
    private var height: CGFloat { max(44, CGFloat(item.endMinute - item.startMinute) / 60 * hourHeight - 4) }
    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.event.title).font(.subheadline.weight(.semibold)).lineLimit(height < 70 ? 1 : 2)
                if height > 80 { Text(dayEventTime(item.event)).font(.caption.monospacedDigit()).lineLimit(1).foregroundStyle(theme.secondary) }
                if height > 96, let calendar = item.event.calendar {
                    Spacer(minLength: 0)
                    Text(calendar).font(.caption2.weight(.medium)).lineLimit(1).foregroundStyle(theme.secondary)
                }
            }.padding(10).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(accent.opacity(theme == .dawn ? 0.09 : 0.12), in: .rect(cornerRadius: 14))
                .overlay(alignment: .leading) {
                    Capsule().fill(accent).frame(width: 3).padding(.vertical, 12)
                }
                .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(accent.opacity(0.12), lineWidth: 0.5) }
        }.buttonStyle(.plain)
            .frame(width: max(1, columnWidth - 4), height: height)
            .offset(x: 60 + CGFloat(item.column) * columnWidth, y: CGFloat(item.startMinute) / 60 * hourHeight)
            .accessibilityLabel(item.event.title + ", " + dayEventTime(item.event))
            .accessibilityHint("Show event details")
    }
}

private struct DayActivityCluster: Identifiable {
    let items: [RepositoryActivity]
    var id: String { items.map(\.id).joined(separator: "|") }
    var date: Date { items.first?.date ?? .distantPast }
}

private struct DayActivityDetails: View {
    let cluster: DayActivityCluster
    @Environment(\.dismiss) private var dismiss
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    ForEach(cluster.items.sorted { $0.date > $1.date }) { item in
                        GitHubActivityCard(item: item)
                    }
                }.padding(24)
            }.background(theme.base).foregroundStyle(theme.ink)
                .navigationTitle("GitHub activity")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .tint(theme.accent)
        }.presentationBackground(theme.base)
    }
}

private struct DayEventDetails: View {
    let event: AgendaEvent
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Text(event.title).font(.system(.title2, design: .serif)).textSelection(.enabled)
                LabeledContent("When", value: dayEventTime(event))
                if let calendar = event.calendar { LabeledContent("Calendar", value: calendar) }
            }.navigationTitle("Event")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct DayTimelineEntry: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let date: Date
    let event: AgendaEvent?
    let activity: RepositoryActivity?
    static func entries(events: [AgendaEvent], activity: [RepositoryActivity]) -> [Self] {
        let calendar = events.map { Self(id: "event:" + $0.id, title: $0.title, subtitle: dayEventTime($0),
            date: $0.allDay ? .distantPast : $0.start ?? .distantPast, event: $0, activity: nil) }
        let github = activity.map { Self(id: "github:" + $0.id, title: $0.title,
            subtitle: "GitHub · " + $0.repository + " · " + $0.date.formatted(date: .omitted, time: .shortened),
            date: $0.date, event: nil, activity: $0) }
        return (calendar + github).sorted { $0.date == $1.date ? $0.id < $1.id : $0.date < $1.date }
    }
}

private func dayEventTime(_ event: AgendaEvent) -> String {
    if event.allDay { return "All day" }
    guard let start = event.start else { return "Time unavailable" }
    let time = start.formatted(date: .omitted, time: .shortened)
    return event.end.map { time + " – " + $0.formatted(date: .omitted, time: .shortened) } ?? time
}
