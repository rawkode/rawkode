// DayNavigation.swift
// EnchiridionUI
//
// Task #81 (plan §"Core Product UI (P7)", tracks 1+2 — day-page screen).
// Pure `DayKey` arithmetic for the day-page screen's prev/next navigation
// and its display title — no SwiftUI, no `LocalGraphStore` access, so it's
// testable as plain date math (`DayNavigationTests.swift`) independent of
// `DayPageController`'s async open/persist machinery.
//
// UTC, MATCHING `DayKey.init(date:calendar:)` EXACTLY
// (`EnchiridionCore/Identity.swift`): that initializer always forces its
// calendar's `timeZone` to UTC before deriving `year`/`month`/`day` — the
// day a given instant "belongs to" for identity purposes is a UTC-calendar
// day, not the device's local day. Every function below matches that by
// forcing the same override, so "the next day after `day`" and "which day a
// given `Date` belongs to" both agree with the definition the deterministic
// page ID itself is keyed on. Get this wrong and prev/next could silently
// skip or repeat a day right at a local-midnight boundary while UTC hasn't
// rolled over yet (or vice versa) — or, for `DayAgendaLoader.swift`'s day
// boundary, silently shift which events count as "in" a given day.

import EnchiridionCore
import Foundation

public enum DayNavigation {
  /// `calendar` with its `timeZone` forced to UTC, matching
  /// `DayKey.init(date:calendar:)`'s own override exactly.
  public static func utcCalendar(from calendar: Calendar) -> Calendar {
    var utc = calendar
    utc.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone
    return utc
  }

  /// `day` parsed back to the `Date` at UTC midnight it was derived from —
  /// the inverse of `DayKey.init(date:calendar:)`. `nil` only if `day`'s
  /// `rawValue` isn't well-formed `YYYY-MM-DD` (a malformed/hand-constructed
  /// `DayKey` — `DayKey.init(rawValue:)` doesn't validate shape, per that
  /// initializer's own doc comment).
  public static func dayStart(
    for day: DayKey, calendar: Calendar = Calendar(identifier: .gregorian)
  ) -> Date? {
    let parts = day.rawValue.split(separator: "-")
    guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]),
      let dayOfMonth = Int(parts[2])
    else { return nil }
    return utcCalendar(from: calendar).date(
      from: DateComponents(year: year, month: month, day: dayOfMonth))
  }

  /// `day` offset by `days` (negative goes backward), correctly crossing
  /// month/year/leap-year boundaries via `Calendar.date(byAdding:)` rather
  /// than any hand-rolled arithmetic. Falls back to returning `day`
  /// unchanged only if `day` itself doesn't parse (see `dayStart`'s doc
  /// comment) — never silently produces a different malformed key.
  public static func adjacentDay(
    to day: DayKey, byAdding days: Int, calendar: Calendar = Calendar(identifier: .gregorian)
  ) -> DayKey {
    let utc = utcCalendar(from: calendar)
    guard let start = dayStart(for: day, calendar: calendar),
      let shifted = utc.date(byAdding: .day, value: days, to: start)
    else { return day }
    return DayKey(date: shifted, calendar: utc)
  }

  public static func previousDay(
    before day: DayKey, calendar: Calendar = Calendar(identifier: .gregorian)
  ) -> DayKey {
    adjacentDay(to: day, byAdding: -1, calendar: calendar)
  }

  public static func nextDay(
    after day: DayKey, calendar: Calendar = Calendar(identifier: .gregorian)
  ) -> DayKey {
    adjacentDay(to: day, byAdding: 1, calendar: calendar)
  }

  /// A user-facing display title for `day` — e.g. "Thursday, August 6,
  /// 2026". Ported concept from the old app's
  /// `LibraryRepository.dailyTitle(_:)`
  /// (`apps/enchiridion/Sources/EnchiridionCore/LibraryRepository.swift`),
  /// used both as the day-page header's label and as
  /// `PageEditorController.open`'s `title` fallback for a brand-new daily
  /// page (`DayPageController.swift`).
  ///
  /// Formats through the SAME UTC calendar/time zone `dayStart` parsed
  /// `day` with (not the device's local time zone) — deliberately, so the
  /// printed day always matches `day`'s own `YYYY-MM-DD` regardless of the
  /// device's UTC offset. Formatting `dayStart`'s UTC-midnight `Date` in a
  /// negative-offset local time zone would otherwise print the PREVIOUS
  /// calendar day (e.g. UTC midnight is still "yesterday evening" west of
  /// Greenwich), silently mislabeling the very page being viewed.
  public static func displayTitle(
    for day: DayKey, calendar: Calendar = Calendar(identifier: .gregorian), locale: Locale = .current
  ) -> String {
    guard let start = dayStart(for: day, calendar: calendar) else { return day.rawValue }
    let formatter = DateFormatter()
    formatter.calendar = utcCalendar(from: calendar)
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.locale = locale
    formatter.dateStyle = .full
    formatter.timeStyle = .none
    return formatter.string(from: start)
  }
}
