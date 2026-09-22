import Foundation

public enum DayAgendaLayout {
    public struct Item: Identifiable, Equatable, Sendable {
        public let event: AgendaEvent
        /// Elapsed minutes from the local day's start, including a repeated DST hour.
        public let startMinute: Double
        public let endMinute: Double
        public let dayDurationMinutes: Double
        public let column: Int
        public let columnCount: Int
        public var id: String { event.id }
        public var startFraction: Double { startMinute / dayDurationMinutes }
        public var endFraction: Double { endMinute / dayDurationMinutes }
    }

    /// Layout uses actual instants and half-open intervals. All-day events belong to another row.
    /// An absent end gets 30 minutes; an explicitly invalid end is omitted rather than invented.
    /// A minimum visual footprint changes collision columns only, never the event's reported times.
    public static func items(events: [AgendaEvent], day: Date, calendar: Calendar = .current, minimumVisualMinutes: Double = 0) -> [Item] {
        let dayStart = calendar.startOfDay(for: day)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        let duration = dayEnd.timeIntervalSince(dayStart) / 60
        guard duration.isFinite, duration > 0 else { return [] }
        let minimum = minimumVisualMinutes.isFinite ? min(duration, max(0, minimumVisualMinutes)) : 0
        let slots = events.compactMap { event -> Slot? in
            guard !event.allDay, let start = event.start, start.timeIntervalSinceReferenceDate.isFinite else { return nil }
            let end = event.end ?? start.addingTimeInterval(30 * 60)
            guard end.timeIntervalSinceReferenceDate.isFinite, end > start,
                  start < dayEnd, end > dayStart else { return nil }
            let clippedStart = max(start, dayStart)
            let clippedEnd = min(end, dayEnd)
            return Slot(event: event, start: clippedStart, end: clippedEnd,
                        collisionEnd: min(dayEnd, max(clippedEnd, clippedStart.addingTimeInterval(minimum * 60))))
        }.sorted {
            if $0.start != $1.start { return $0.start < $1.start }
            if $0.end != $1.end { return $0.end < $1.end }
            return $0.event.id < $1.event.id
        }

        var result: [Item] = []
        var group: [(Slot, Int)] = []
        var columnEnds: [Date] = []
        var groupEnd = Date.distantPast
        func finishGroup() {
            result += group.map { slot, column in
                Item(event: slot.event,
                     startMinute: slot.start.timeIntervalSince(dayStart) / 60,
                     endMinute: slot.end.timeIntervalSince(dayStart) / 60,
                     dayDurationMinutes: duration,
                     column: column, columnCount: columnEnds.count)
            }
            group = []
            columnEnds = []
        }
        for slot in slots {
            if !group.isEmpty && slot.start >= groupEnd { finishGroup() }
            let column = columnEnds.firstIndex { $0 <= slot.start } ?? columnEnds.count
            if column == columnEnds.count { columnEnds.append(slot.collisionEnd) }
            else { columnEnds[column] = slot.collisionEnd }
            group.append((slot, column))
            groupEnd = max(groupEnd, slot.collisionEnd)
        }
        finishGroup()
        return result
    }

    private struct Slot {
        let event: AgendaEvent
        let start: Date
        let end: Date
        let collisionEnd: Date
    }
}
