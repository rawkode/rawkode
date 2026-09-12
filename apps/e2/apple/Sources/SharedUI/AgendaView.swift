import ApsidesCore
import SwiftUI

struct AgendaView: View {
    @ObservedObject var store: WorkspaceStore
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var day = Date()
    @State private var showList = false
    @State private var selectedEvent: AgendaEvent?

    private var snapshot: ContextSnapshot? {
        if let calendar = store.calendarContext?.snapshot, calendar.day == DayIdentity.key(day) { return calendar }
        return store.snapshot.flatMap { $0.day == DayIdentity.key(day) ? $0 : nil }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                DatePicker("Calendar day", selection: $day, displayedComponents: .date)
                    .labelsHidden().disabled(store.demo || store.refreshing)
                Spacer()
                if store.refreshing { ProgressView().controlSize(.small) }
            }.padding(.horizontal, 24).padding(.vertical, 12)
            if let snapshot {
                if showList || typeSize.isAccessibilitySize {
                    agendaList(snapshot)
                } else {
                    DayCalendar(snapshot: snapshot, day: day, selectedEvent: $selectedEvent)
                }
            } else {
                ScrollView { ContextConnectionView(store: store).padding(24) }
            }
            if let error = store.connectionError {
                Text(error).font(.callout).padding().frame(maxWidth: .infinity, alignment: .leading)
            }
            if store.calendarContext?.partial == true {
                Label("Some calendars could not refresh.", systemImage: "exclamationmark.triangle").font(.callout).padding()
            }
        }
        .background(theme.canvas).foregroundStyle(theme.ink)
        .navigationTitle("Day calendar")
        .toolbar {
            ToolbarItemGroup {
                Menu {
                    Picker("Calendar layout", selection: $showList) {
                        Label("Day timeline", systemImage: "calendar.day.timeline.left").tag(false)
                        Label("Agenda list", systemImage: "list.bullet").tag(true)
                    }
                } label: { Label("Calendar layout", systemImage: showList ? "list.bullet" : "calendar.day.timeline.left") }
                Button { Task { await store.refresh(for: day) } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(store.refreshing || store.demo)
            }
        }
        .task(id: DayIdentity.key(day)) { if snapshot == nil { await store.refresh(for: day) } }
        .sheet(item: $selectedEvent) { EventDetailView(event: $0) }
    }
    private func agendaList(_ snapshot: ContextSnapshot) -> some View {
        List {
            ForEach(snapshot.events.sorted { ($0.start ?? .distantPast) < ($1.start ?? .distantPast) }) { event in
                Button { selectedEvent = event } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(event.title).font(.headline)
                        Text(eventTime(event)).font(.subheadline).foregroundStyle(theme.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8).contentShape(Rectangle())
                }.buttonStyle(.plain).listRowBackground(theme.canvas)
            }
            if snapshot.events.isEmpty { Text("Nothing scheduled for this day.").listRowBackground(theme.canvas) }
        }.scrollContentBackground(.hidden)
    }
}

private struct DayCalendar: View {
    let snapshot: ContextSnapshot
    let day: Date
    @Binding var selectedEvent: AgendaEvent?
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    private let hourHeight: Double = 80
    private var start: Date { Calendar.current.startOfDay(for: day) }
    private var items: [DayAgendaLayout.Item] { DayAgendaLayout.items(events: snapshot.events, day: day, minimumVisualMinutes: 18) }
    private var hours: Int { Int(DayIdentity.bounds(day).1.timeIntervalSince(start) / 3600) }
    private var initialHour: Int { max(0, min(hours - 1, Int((items.first?.startMinute ?? 480) / 60) - 1)) }

    var body: some View {
        VStack(spacing: 0) {
            let allDay = snapshot.events.filter(\.allDay)
            if !allDay.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        Text("All day").font(.caption).foregroundStyle(theme.secondary)
                        ForEach(allDay) { event in
                            Button(event.title) { selectedEvent = event }.buttonStyle(.bordered)
                        }
                    }.padding(.horizontal, 24).padding(.vertical, 8)
                }
            }
            ScrollViewReader { proxy in
                ScrollView {
                    GeometryReader { geometry in
                        ZStack(alignment: .topLeading) {
                            VStack(spacing: 0) {
                                ForEach(0..<hours, id: \.self) { hour in
                                    HStack(alignment: .top, spacing: 8) {
                                        Text(start.addingTimeInterval(Double(hour) * 3600), format: .dateTime.hour().minute())
                                            .font(.caption.monospacedDigit()).foregroundStyle(theme.secondary)
                                            .frame(width: 52, alignment: .trailing)
                                        Rectangle().fill(theme.ink.opacity(0.12)).frame(height: 0.5).padding(.top, 7)
                                    }.frame(height: hourHeight, alignment: .top).id(hour)
                                }
                            }
                            ForEach(items) { item in
                                CalendarEventButton(item: item, availableWidth: geometry.size.width - 68,
                                    hourHeight: hourHeight, theme: theme) {
                                    selectedEvent = item.event
                                }
                            }
                        }
                    }.frame(height: Double(hours) * hourHeight + 24).padding(.trailing, 16)
                }.task(id: snapshot.day) { proxy.scrollTo(initialHour, anchor: .top) }
            }
            Text("Updated \(snapshot.fetchedAt.formatted(date: .omitted, time: .shortened)) · \(TimeZone.current.abbreviation() ?? TimeZone.current.identifier)")
                .font(.caption).foregroundStyle(theme.secondary).padding(10)
        }
    }
}

private struct CalendarEventButton: View {
    let item: DayAgendaLayout.Item
    let availableWidth: CGFloat
    let hourHeight: Double
    let theme: ApsidesTheme
    let select: () -> Void

    private var columnWidth: CGFloat { max(0, availableWidth) / CGFloat(item.columnCount) }
    private var eventHeight: CGFloat { CGFloat(max(24, (item.endMinute - item.startMinute) / 60 * hourHeight - 3)) }
    private var horizontalOffset: CGFloat { 64 + CGFloat(item.column) * columnWidth }
    private var verticalOffset: CGFloat { CGFloat(item.startMinute / 60 * hourHeight + 7) }

    var body: some View {
        Button(action: select) { label }
            .buttonStyle(.plain).foregroundStyle(theme.ink)
            .frame(width: max(1, columnWidth - 5), height: eventHeight)
            .offset(x: horizontalOffset, y: verticalOffset)
            .accessibilityLabel(item.event.title + ", " + eventTime(item.event))
            .accessibilityHint("Show event details")
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.event.title).font(.subheadline.weight(.medium)).lineLimit(2)
            if item.endMinute - item.startMinute >= 45 {
                Text(eventTime(item.event)).font(.caption).lineLimit(1)
            }
        }.padding(8).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(calendarAccent(item.event.calendarColor, fallback: theme.accent).opacity(0.12), in: .rect(cornerRadius: 8))
    }
}

private struct EventDetailView: View {
    let event: AgendaEvent
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Text(event.title).font(.system(.title2, design: .serif)).textSelection(.enabled)
                LabeledContent("When", value: eventTime(event)).accessibilityIdentifier("eventTime")
                if let calendar = event.calendar { LabeledContent("Calendar", value: calendar) }
            }
            .formStyle(.grouped).navigationTitle("Event")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 320)
        #endif
    }
}

private func eventTime(_ event: AgendaEvent) -> String {
    if event.allDay { return "All day" }
    guard let start = event.start else { return "Time unavailable" }
    let value = start.formatted(date: .omitted, time: .shortened)
    return event.end.map { value + " – " + $0.formatted(date: .omitted, time: .shortened) } ?? value
}
