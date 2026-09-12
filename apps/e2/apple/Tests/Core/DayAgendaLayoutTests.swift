import XCTest
@testable import ApsidesCore

final class DayAgendaLayoutTests: XCTestCase {
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }
    private func date(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }
    private func event(_ id: String, _ start: String, _ end: String? = nil) -> AgendaEvent {
        AgendaEvent(id: id, title: id, start: date(start), end: end.map(date))
    }

    func testTransitiveOverlapUsesConsistentWidthsAndReusesAdjacentColumn() {
        let events = [
            event("a", "2026-09-12T09:00:00Z", "2026-09-12T10:00:00Z"),
            event("b", "2026-09-12T09:30:00Z", "2026-09-12T11:00:00Z"),
            event("c", "2026-09-12T10:00:00Z", "2026-09-12T10:30:00Z"),
            event("d", "2026-09-12T11:00:00Z", "2026-09-12T11:30:00Z"),
        ]
        let items = DayAgendaLayout.items(events: events.reversed(), day: date("2026-09-12T12:00:00Z"), calendar: utc)
        XCTAssertEqual(items.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(items.map(\.column), [0, 1, 0, 0])
        XCTAssertEqual(items.map(\.columnCount), [2, 2, 2, 1])
    }

    func testClipsOvernightAndOmitsOutsideAllDayAndInvalidIntervals() {
        var allDay = event("all", "2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z")
        allDay.allDay = true
        let events = [
            event("before", "2026-09-11T23:00:00Z", "2026-09-12T00:00:00Z"),
            event("overnight", "2026-09-11T23:00:00Z", "2026-09-12T01:00:00Z"),
            event("late", "2026-09-12T23:45:00Z"),
            event("after", "2026-09-13T00:00:00Z"),
            event("invalid", "2026-09-12T10:00:00Z", "2026-09-12T09:00:00Z"),
            event("empty", "2026-09-12T10:00:00Z", "2026-09-12T10:00:00Z"),
            allDay,
        ]
        let items = DayAgendaLayout.items(events: events, day: date("2026-09-12T12:00:00Z"), calendar: utc)
        XCTAssertEqual(items.map(\.id), ["overnight", "late"])
        XCTAssertEqual(items[0].startMinute, 0)
        XCTAssertEqual(items[0].endMinute, 60)
        XCTAssertEqual(items[1].startMinute, 1_425)
        XCTAssertEqual(items[1].endFraction, 1)
    }

    func testMissingEndGetsThirtyMinutes() {
        let item = DayAgendaLayout.items(events: [event("missing", "2026-09-12T09:00:00Z")], day: date("2026-09-12T12:00:00Z"), calendar: utc)[0]
        XCTAssertEqual(item.endMinute - item.startMinute, 30)
    }

    func testMinimumVisualFootprintSeparatesShortAdjacentMeetingsWithoutChangingTimes() {
        let events = [
            event("a", "2026-09-12T09:00:00Z", "2026-09-12T09:05:00Z"),
            event("b", "2026-09-12T09:05:00Z", "2026-09-12T09:10:00Z"),
            event("c", "2026-09-12T09:18:00Z", "2026-09-12T09:23:00Z"),
        ]
        let day = date("2026-09-12T12:00:00Z")
        let actual = DayAgendaLayout.items(events: events, day: day, calendar: utc)
        XCTAssertEqual(actual.map(\.columnCount), [1, 1, 1])
        let visual = DayAgendaLayout.items(events: events, day: day, calendar: utc, minimumVisualMinutes: 18)
        XCTAssertEqual(visual.map(\.column), [0, 1, 0])
        XCTAssertEqual(visual.map(\.columnCount), [2, 2, 2])
        XCTAssertEqual(visual.map(\.startMinute), actual.map(\.startMinute))
        XCTAssertEqual(visual.map(\.endMinute), actual.map(\.endMinute))
    }

    func testDSTDaysUseActualDurationAndRepeatedHourRemainsPositive() {
        var london = utc
        london.timeZone = TimeZone(identifier: "Europe/London")!
        let spring = DayAgendaLayout.items(events: [event("spring", "2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z")], day: date("2026-03-29T12:00:00Z"), calendar: london)[0]
        XCTAssertEqual(spring.dayDurationMinutes, 1_380)
        XCTAssertEqual(spring.endMinute - spring.startMinute, 60)
        let fall = DayAgendaLayout.items(events: [event("fall", "2026-10-25T00:45:00Z", "2026-10-25T01:15:00Z")], day: date("2026-10-25T12:00:00Z"), calendar: london)[0]
        XCTAssertEqual(fall.dayDurationMinutes, 1_500)
        XCTAssertEqual(fall.endMinute - fall.startMinute, 30)
        XCTAssertGreaterThan(fall.endFraction, fall.startFraction)
    }
}
