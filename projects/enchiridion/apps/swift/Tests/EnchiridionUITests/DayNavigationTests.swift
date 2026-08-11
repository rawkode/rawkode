// DayNavigationTests.swift
// EnchiridionUITests
//
// Task #81. Pure `DayKey` arithmetic (`DayNavigation.swift`) — no store, no
// SwiftUI, no async. Required coverage per the task brief: "Day navigation
// produces correct adjacent dates including month/year/leap-year
// boundaries" — proven via `Calendar.date(byAdding:)`-backed real date math
// (not string increment), including the two trickiest leap-year edges
// (Feb 29 -> Mar 1, and stepping back from Mar 1 in a leap year lands on
// Feb 29 rather than Feb 28).

import EnchiridionCore
import Foundation
import XCTest

@testable import EnchiridionUI

final class DayNavigationTests: XCTestCase {
  private func day(_ rawValue: String) -> DayKey { DayKey(rawValue: rawValue) }

  // MARK: - Within a month

  func testNextDayAdvancesWithinAMonth() {
    XCTAssertEqual(DayNavigation.nextDay(after: day("2026-08-06")), day("2026-08-07"))
  }

  func testPreviousDayGoesBackWithinAMonth() {
    XCTAssertEqual(DayNavigation.previousDay(before: day("2026-08-06")), day("2026-08-05"))
  }

  // MARK: - Month boundaries

  func testNextDayCrossesAMonthBoundary() {
    XCTAssertEqual(DayNavigation.nextDay(after: day("2026-08-31")), day("2026-09-01"))
  }

  func testPreviousDayCrossesAMonthBoundary() {
    XCTAssertEqual(DayNavigation.previousDay(before: day("2026-09-01")), day("2026-08-31"))
  }

  func testNextDayCrossesAShortMonthBoundary() {
    // April has 30 days.
    XCTAssertEqual(DayNavigation.nextDay(after: day("2026-04-30")), day("2026-05-01"))
  }

  // MARK: - Year boundaries

  func testNextDayCrossesAYearBoundary() {
    XCTAssertEqual(DayNavigation.nextDay(after: day("2025-12-31")), day("2026-01-01"))
  }

  func testPreviousDayCrossesAYearBoundary() {
    XCTAssertEqual(DayNavigation.previousDay(before: day("2026-01-01")), day("2025-12-31"))
  }

  // MARK: - Leap-year boundaries

  func testNextDayCrossesALeapYearFebruaryBoundary() {
    XCTAssertEqual(DayNavigation.nextDay(after: day("2024-02-29")), day("2024-03-01"))
  }

  func testPreviousDayFromMarchFirstInALeapYearLandsOnFebTwentyNine() {
    XCTAssertEqual(DayNavigation.previousDay(before: day("2024-03-01")), day("2024-02-29"))
  }

  func testNextDaySkipsFebTwentyNineInANonLeapYear() {
    XCTAssertEqual(DayNavigation.nextDay(after: day("2025-02-28")), day("2025-03-01"))
  }

  func testNextDayCrossesALeapYearFebruaryBoundaryIntoALeapYearItself() {
    // 2000 is a leap year (divisible by 400) — a common leap-year-rule
    // trap (divisible by 100 but NOT by 400 years, e.g. 1900/2100, are
    // NOT leap years). Exercised via `Calendar`, so this is really a test
    // that we defer to `Calendar` rather than any hand-rolled rule.
    XCTAssertEqual(DayNavigation.nextDay(after: day("2000-02-28")), day("2000-02-29"))
    XCTAssertEqual(DayNavigation.nextDay(after: day("2000-02-29")), day("2000-03-01"))
  }

  // MARK: - Round trip / multi-step

  func testSteppingForwardThenBackwardReturnsToTheOriginalDay() {
    let original = day("2024-02-28")
    let forward = DayNavigation.nextDay(after: original)
    let back = DayNavigation.previousDay(before: forward)
    XCTAssertEqual(back, original)
  }

  func testTwoStepsForwardAcrossALeapDayMatchesOneCalendarAdditionOfTwoDays() {
    XCTAssertEqual(
      DayNavigation.nextDay(after: DayNavigation.nextDay(after: day("2024-02-28"))), day("2024-03-01"))
  }

  // MARK: - Malformed input (defensive)

  func testAdjacentDayFallsBackToTheSameDayForAMalformedDayKey() {
    let malformed = day("not-a-day")
    XCTAssertEqual(DayNavigation.nextDay(after: malformed), malformed)
    XCTAssertEqual(DayNavigation.previousDay(before: malformed), malformed)
  }

  // MARK: - Display title

  func testDisplayTitleFormatsTheFullWeekdayMonthDayYear() {
    XCTAssertEqual(
      DayNavigation.displayTitle(for: day("2026-08-06"), locale: Locale(identifier: "en_US")),
      "Thursday, August 6, 2026")
  }

  func testDisplayTitleIsStableRegardlessOfTheHostCalendarsTimeZone() {
    // A device set to a negative UTC offset must not print the PREVIOUS
    // calendar day for this `DayKey` — see `DayNavigation.displayTitle`'s
    // doc comment for why this matters (UTC midnight formatted in a
    // western time zone would otherwise read as "yesterday evening").
    var pacific = Calendar(identifier: .gregorian)
    pacific.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    XCTAssertEqual(
      DayNavigation.displayTitle(for: day("2026-08-06"), calendar: pacific, locale: Locale(identifier: "en_US")),
      "Thursday, August 6, 2026")
  }
}
