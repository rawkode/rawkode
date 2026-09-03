import XCTest
@testable import AthenaeumDomain

/// Verifies `DailyNoteID.swift` produces byte-identical ids/titles to
/// `packages/web/src/daily-note-id.ts` for the same calendar date — the actual guarantee that
/// makes "the macOS/iOS app addresses the same daily note as the web client" true. A UTC calendar
/// is used throughout so this test is deterministic regardless of the machine's local timezone
/// (the production code path uses `.current`, matching the web client's own "local calendar day"
/// intent — the UTC calendar here is purely a fixed, reproducible stand-in for "some local
/// timezone" in a test environment).
final class DailyNoteIDTests: XCTestCase {

    func testDailyNoteIdForLocalDateNeverReinterpretsTheCivilDayThroughUTC() throws {
        XCTAssertEqual(
            dailyNoteIdForLocalDate(try LocalDate(validating: "2026-08-27")).rawValue,
            "00000000-0000-4000-8000-000020260827"
        )
    }

    func testLocalDateFromDailyNoteIdRoundTripsTheCanonicalDailyIdentity() throws {
        let localDate = try LocalDate(validating: "2026-08-27")

        XCTAssertEqual(
            localDateFromDailyNoteId(dailyNoteIdForLocalDate(localDate).rawValue),
            localDate
        )
    }

    func testLocalDateFromDailyNoteIdRejectsNonDailyAndImpossibleDates() {
        XCTAssertNil(localDateFromDailyNoteId("018f6a5e-0000-7000-8000-000000000000"))
        XCTAssertNil(localDateFromDailyNoteId("00000000-0000-0000-0000-000000000001"))
        XCTAssertNil(localDateFromDailyNoteId("00000000-0000-4000-8000-000099999999"))
    }

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int) -> Date {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.timeZone = TimeZone(identifier: "UTC")
        return utc.date(from: components)!
    }

    func testLocalDateStampFormatsWithZeroPadding() {
        // Matches daily-note-id.ts's `localDateStamp`: month and day are always zero-padded to 2
        // digits via `pad2`; the year is never padded.
        XCTAssertEqual(localDateStamp(date(2026, 8, 20), calendar: utc), "2026-08-20")
        XCTAssertEqual(localDateStamp(date(2026, 1, 5), calendar: utc), "2026-01-05")
    }

    /// The load-bearing case: matches `daily-note-id.ts`'s own documented example scheme —
    /// `"00000000-0000-4000-8000-" + YYYYMMDD` zero-padded to 12 hex chars.
    func testDailyNoteIdMatchesTypeScriptScheme() {
        let id = dailyNoteIdForDate(date(2026, 8, 20), calendar: utc)
        XCTAssertEqual(id.rawValue, "00000000-0000-4000-8000-000020260820")
    }

    func testDailyNoteIdZeroPadsSingleDigitMonthAndDay() {
        let id = dailyNoteIdForDate(date(2026, 1, 5), calendar: utc)
        XCTAssertEqual(id.rawValue, "00000000-0000-4000-8000-000020260105")
    }

    /// Never collides with `BaseTagIds`' all-zero-group reserved ids (Tag.swift) — the two
    /// reserved-id families are disambiguated by construction (`4000-8000` vs. `0000-0000`).
    func testDailyNoteIdDoesNotCollideWithBaseTagIdFamily() {
        let id = dailyNoteIdForDate(date(2026, 8, 20), calendar: utc)
        XCTAssertFalse(BASE_TAGS.map(\.id).contains(id))
    }

    func testDailyNoteTitleFormat() {
        XCTAssertEqual(dailyNoteTitleForDate(date(2026, 8, 20), calendar: utc), "Daily Note — 2026-08-20")
    }

    func testDifferentDatesProduceDifferentIds() {
        let first = dailyNoteIdForDate(date(2026, 8, 20), calendar: utc)
        let second = dailyNoteIdForDate(date(2026, 8, 21), calendar: utc)
        XCTAssertNotEqual(first, second)
    }

    func testSameDateProducesSameIdDeterministically() {
        let first = dailyNoteIdForDate(date(2026, 8, 20), calendar: utc)
        let second = dailyNoteIdForDate(date(2026, 8, 20), calendar: utc)
        XCTAssertEqual(first, second)
    }
}
