import XCTest
@testable import ApsidesCore

final class CalendarColorTests: XCTestCase {
    func testLegacySnapshotDecodesWithoutColor() throws {
        let data = Data(##"{"id":"old","title":"Meeting","allDay":false,"calendar":"Work"}"##.utf8)
        let event = try JSONDecoder().decode(AgendaEvent.self, from: data)
        XCTAssertNil(event.calendarColor)
        XCTAssertNil(event.calendarColorRGB)
    }

    func testProviderColorSurvivesConnectedContextAndCache() throws {
        let data = Data(##"{"data":{"me":{"today":{"googleEvents":[{"id":"event","summary":"Meeting","calendarName":"Work","calendarColor":"#Ab12Ef"}]}}}}"##.utf8)
        let context = try ConnectedContext.decode(data, day: "2026-09-12")
        let event = try XCTUnwrap(context.snapshot.events.first)
        XCTAssertEqual(event.calendarColor, "#Ab12Ef")
        XCTAssertEqual(event.calendarColorRGB, 0xAB12EF)
        let cached = try JSONDecoder().decode(ContextSnapshot.self, from: JSONEncoder().encode(context.snapshot))
        XCTAssertEqual(cached.events.first?.calendarColorRGB, 0xAB12EF)
    }

    func testMalformedColorsHaveNoDisplayValue() {
        for color in ["red", "#fff", "#12345678", "123456", "#GG0000", " #123456", "#123456\n"] {
            XCTAssertNil(AgendaEvent(id: "event", title: "Meeting", calendarColor: color).calendarColorRGB, color)
        }
    }
}
