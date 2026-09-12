import ApsidesCore
import SwiftUI

/// The connected day is a read-only projection. Writing remains in the shared editor.
struct DayTimelineView: View {
    @ObservedObject var store: WorkspaceStore
    var recenter: Int = 0
    @Binding var selectedDay: Date
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .largeTitle) private var monthSize: CGFloat = 34
    @State private var selectedEvent: AgendaEvent?
    @State private var selectedActivity: DayActivityCluster?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { clock in
            VStack(spacing: 0) {
                calendarHeader
                content(at: clock.date)
            }
            .task(id: DayIdentity.key(selectedDay) + DayIdentity.key(clock.date)) {
                let requestedDay = selectedDay
                // A quick second selection waits for the in-flight request, rather
                // than being dropped by the store's single-refresh guard.
                while store.refreshing {
                    do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
                }
                guard !Task.isCancelled else { return }
                await store.refresh(for: requestedDay)
            }
        }
        .background(theme.canvas).foregroundStyle(theme.ink).tint(theme.accent)
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .refreshable { await store.refresh(for: selectedDay) }
        .sheet(item: $selectedEvent) { DayEventDetails(event: $0) }
        .sheet(item: $selectedActivity) { DayActivityDetails(cluster: $0) }
    }

    private var selectedContext: ConnectedContext? {
        let key = DayIdentity.key(selectedDay)
        if store.calendarContext?.snapshot.day == key { return store.calendarContext }
        return store.context?.snapshot.day == key ? store.context : nil
    }

    private var selectedSnapshot: ContextSnapshot? {
        selectedContext?.snapshot ?? store.snapshot.flatMap { $0.day == DayIdentity.key(selectedDay) ? $0 : nil }
    }

    private var week: [Date] {
        let calendar = Calendar.current
        let start = calendar.dateInterval(of: .weekOfYear, for: selectedDay)?.start ?? calendar.startOfDay(for: selectedDay)
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
    }

    private var calendarHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                Text(selectedDay, format: .dateTime.month(.wide))
                    .font(.system(size: monthSize, weight: .semibold, design: .serif))
                    .accessibilityAddTraits(.isHeader)
                HStack {
                    Text(selectedDay, format: .dateTime.year()).font(.subheadline)
                    Spacer()
                    if store.demo { Text("Sample day").font(.caption) }
                }.foregroundStyle(theme.secondary)
            }.padding(.horizontal, 24)
            if typeSize.isAccessibilitySize {
                DatePicker("Calendar day", selection: $selectedDay, displayedComponents: .date)
                    .padding(.horizontal, 24)
            } else {
            HStack(spacing: 0) {
                ForEach(week, id: \.self) { date in
                    let selected = Calendar.current.isDate(date, inSameDayAs: selectedDay)
                    Button { selectedDay = date } label: {
                        VStack(spacing: 5) {
                            Text(date, format: .dateTime.weekday(.abbreviated))
                                .textCase(.uppercase).font(.system(size: 10, weight: .medium))
                                .foregroundStyle(theme.secondary)
                            Text(date, format: .dateTime.day())
                                .font(.body.weight(selected ? .semibold : .regular))
                                .frame(width: 32, height: 32)
                                .foregroundStyle(selected ? theme.canvas : theme.ink)
                                .background(selected ? theme.accent : Color.clear, in: .circle)
                        }.frame(maxWidth: .infinity).frame(minHeight: 52).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityLabel(date.formatted(date: .complete, time: .omitted))
                        .accessibilityIdentifier("calendar-day-" + DayIdentity.key(date))
                        .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }.padding(.horizontal, 12)
                .gesture(DragGesture(minimumDistance: 30).onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height),
                          let next = Calendar.current.date(byAdding: .day, value: value.translation.width < 0 ? 7 : -7, to: selectedDay) else { return }
                    selectedDay = next
                })
            }
        }.padding(.top, 4).padding(.bottom, 10)
    }

    @ViewBuilder private func content(at now: Date) -> some View {
        if let snapshot = selectedSnapshot {
            connectedDay(snapshot, now: now)
        } else if store.refreshing {
            ProgressView("Bringing your day together…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ContextConnectionView(store: store)
                    Text("This day's calendar is not available yet.").font(.headline)
                    Button("Refresh calendar") { Task { await store.refresh(for: selectedDay) } }
                }.padding(24)
            }
        }
    }

    private func connectedDay(_ snapshot: ContextSnapshot, now: Date) -> some View {
        let activity = (selectedContext?.activity ?? []).filter { Calendar.current.isDate($0.date, inSameDayAs: selectedDay) }
        return VStack(spacing: 0) {
            status(snapshot, now: now)
            allDay(snapshot.events)
            if typeSize.isAccessibilitySize || DayAgendaLayout.items(events: snapshot.events, day: selectedDay, minimumVisualMinutes: 36).contains(where: { $0.columnCount > 3 }) {
                accessibleDay(snapshot, activity: activity, now: now)
            } else {
                DayTimelineCanvas(snapshot: snapshot, activity: activity, day: selectedDay, now: now, recenter: recenter, theme: theme,
                    selectEvent: { selectedEvent = $0 }, selectActivity: { selectedActivity = $0 })
            }
        }
    }

    @ViewBuilder private func allDay(_ events: [AgendaEvent]) -> some View {
        let untimed = events.filter { $0.allDay || $0.start == nil }
        if !untimed.isEmpty {
            HStack(spacing: 8) {
                Text("All-day").font(.caption).foregroundStyle(theme.secondary).frame(width: 48, alignment: .trailing)
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        ForEach(untimed) { event in
                            Button { selectedEvent = event } label: {
                                HStack(spacing: 6) {
                                    Text(event.title).font(.subheadline.weight(.medium)).lineLimit(1)
                                    if !event.allDay { Text("Time unavailable").font(.caption) }
                                }.padding(.horizontal, 10).frame(minHeight: 36)
                                    .background(calendarAccent(event.calendarColor, fallback: theme.accent).opacity(theme == .dawn ? 0.18 : 0.28), in: .rect(cornerRadius: 8))
                            }.buttonStyle(.plain).frame(minHeight: 44)
                        }
                    }.padding(.trailing, 12)
                }.scrollIndicators(.hidden)
            }.padding(.vertical, 3)
                .overlay(alignment: .top) { Rectangle().fill(theme.ink.opacity(0.08)).frame(height: 0.5) }
                .overlay(alignment: .bottom) { Rectangle().fill(theme.ink.opacity(0.08)).frame(height: 0.5) }
        }
    }

    @ViewBuilder private func status(_ snapshot: ContextSnapshot, now: Date) -> some View {
        if store.refreshing {
            ProgressView("Refreshing your day…").font(.caption).padding(8)
        }
        if let error = store.connectionError {
            Text(error).font(.callout).padding(.horizontal, 24).padding(.vertical, 8)
        }
        if selectedContext?.partial == true {
            Label("Some services could not refresh", systemImage: "exclamationmark.triangle")
                .font(.callout).padding(.horizontal, 24).padding(.vertical, 8)
        }
        if store.connectionError != nil || now.timeIntervalSince(snapshot.fetchedAt) > 15 * 60 {
            Text("Last updated \(snapshot.fetchedAt.formatted(date: .omitted, time: .shortened))")
                .font(.caption).foregroundStyle(theme.secondary).padding(8)
        }
        if snapshot.events.isEmpty && selectedContext?.partial != true {
            Text("Nothing scheduled. Your day has room.")
                .font(.callout).foregroundStyle(theme.secondary).padding(16)
        }
    }

    private func accessibleDay(_ snapshot: ContextSnapshot, activity: [RepositoryActivity], now: Date) -> some View {
        let entries = DayTimelineEntry.entries(events: snapshot.events.filter { !$0.allDay && $0.start != nil }, activity: activity)
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
    let day: Date
    let now: Date
    let recenter: Int
    let theme: ApsidesTheme
    let selectEvent: (AgendaEvent) -> Void
    let selectActivity: (DayActivityCluster) -> Void
    private let hourHeight: CGFloat = 80
    private var start: Date { Calendar.current.startOfDay(for: day) }
    private var hours: Int { Int(DayIdentity.bounds(day).1.timeIntervalSince(start) / 3600) }
    private var isToday: Bool { Calendar.current.isDate(day, inSameDayAs: now) }
    private var nowOffset: CGFloat { CGFloat(now.timeIntervalSince(start) / 3600) * hourHeight }
    private var scrollOffset: CGFloat { isToday ? nowOffset : CGFloat(items.first?.startMinute ?? 480) / 60 * hourHeight }
    private var items: [DayAgendaLayout.Item] {
        DayAgendaLayout.items(events: snapshot.events, day: day, minimumVisualMinutes: 36)
    }
    private var clusters: [DayActivityCluster] {
        var groups: [[RepositoryActivity]] = []
        // Preserve the first activity's real position, grouping only markers that would collide.
        for item in activity.sorted(by: { $0.date < $1.date }) {
            if let first = groups.last?.first, item.date.timeIntervalSince(first.date) < 36 * 60 {
                groups[groups.count - 1].append(item)
            } else {
                groups.append([item])
            }
        }
        return groups.map { DayActivityCluster(items: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
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

    private func grid(width: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(0..<hours, id: \.self) { hour in
                    HStack(alignment: .top, spacing: 12) {
                        Text(start.addingTimeInterval(Double(hour) * 3600), format: .dateTime.hour().minute())
                            .font(.caption.monospacedDigit()).foregroundStyle(theme.secondary)
                            .frame(width: 48, alignment: .trailing)
                            .opacity(isToday && abs(now.timeIntervalSince(start) / 60 - Double(hour * 60)) < 12 ? 0 : 1)
                        Rectangle().fill(theme.ink.opacity(0.08)).frame(height: 1).padding(.top, 7)
                    }.frame(height: hourHeight, alignment: .top)
                }
            }
            if isToday {
            HStack(spacing: 8) {
                Text(now, format: .dateTime.hour().minute()).font(.caption.weight(.semibold).monospacedDigit()).frame(width: 48, alignment: .trailing)
                Circle().frame(width: 5, height: 5)
                Rectangle().frame(height: 1)
            }.foregroundStyle(theme.accent).offset(y: nowOffset)
                .accessibilityElement(children: .ignore).accessibilityLabel("Current time")
                .accessibilityIdentifier("dayTimelineNow")
            }
            VStack(spacing: 0) {
                Color.clear.frame(height: max(0, scrollOffset))
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
            VStack(alignment: .leading, spacing: 2) {
                Text(item.event.title).font(.subheadline.weight(.semibold)).lineLimit(height < 80 ? 1 : 2)
                if height >= 44 { Text(dayEventTime(item.event)).font(.caption.monospacedDigit()).lineLimit(1).foregroundStyle(theme.secondary) }
                if height > 96, let calendar = item.event.calendar {
                    Spacer(minLength: 0)
                    Text(calendar).font(.caption2.weight(.medium)).lineLimit(1).foregroundStyle(theme.secondary)
                }
            }.padding(.horizontal, 10).padding(.vertical, 6).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(accent.opacity(theme == .dawn ? 0.12 : 0.20), in: .rect(cornerRadius: 8))
                .overlay(alignment: .leading) {
                    Capsule().fill(accent).frame(width: 3).padding(.vertical, 5)
                }
                .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(accent.opacity(0.12), lineWidth: 0.5) }
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
