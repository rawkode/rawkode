// DayAgendaLoader.swift
// EnchiridionUI
//
// Task #81. The day-page agenda component's data source: that day's
// Event-supertagged calendar pages (time/title/location), reusing
// `LocalGraphStore.findCalendarEvents` (`EnchiridionStore/AssistantReadTools.swift`,
// P5) — the exact bounded, `personVisibility`-respecting query pattern
// every other assistant-adjacent read surface in this codebase already
// uses for calendar events — rather than a parallel hand-rolled SQL query.
//
// DIRECT CALL, NOT A TURN-SCOPED ASSISTANT AUTHORIZATION: `findCalendarEvents`
// is gated by a pre-flight `AssistantCalendarSearchAuthorization` meant for
// one assistant turn's approved query/date range/result cap (see that
// type's header in `AssistantTurnRetrievalAuthorization.swift`) — there is
// no model-supplied "candidate" argument to validate here, since browsing a
// day's own agenda inside the app is not an assistant turn at all.
// `EnchiridionWidgetKit`'s `WidgetEntryDataSource.loadNextEventEntry`
// already established the precedent this loader follows exactly: construct
// a fixed, hardcoded-safe authorization locally (empty/no query, the
// caller's own date range, `includeOngoing: true`) and call the tool
// directly. Nothing about calling it directly bypasses what actually
// matters inside `findCalendarEvents` itself — the query correctness (only
// events overlapping the requested window) and the `personVisibility ==
// .other` attendee exclusion both still fully apply, proven by
// `DayAgendaLoaderTests.swift`.
//
// DAY BOUNDARY: `[start, start + 1 day)` where `start` is `day` parsed at
// UTC midnight (`DayNavigation.dayStart(for:calendar:)`) — the same
// UTC-day definition `DayKey.init(date:calendar:)` itself uses
// (`EnchiridionCore/Identity.swift`), so an event this loader includes or
// excludes always agrees with which deterministic daily page the caller
// actually has open, independent of the device's local time zone.

import EnchiridionCore
import EnchiridionStore
import Foundation

public enum DayAgendaLoaderError: Error, LocalizedError, Equatable {
  case invalidDay

  public var errorDescription: String? {
    switch self {
    case .invalidDay: "That day couldn't be resolved to a calendar date."
    }
  }
}

public enum DayAgendaLoader {
  /// At most this many events per day —
  /// `AssistantRetrievalLimits.maximumCalendarResults`, the same fixed cap
  /// `findCalendarEvents` enforces for every caller. A day with more
  /// events than this is vanishingly unlikely for a single-user calendar,
  /// but a truncated agenda is still correct behavior (not a crash), same
  /// as every other bounded read tool in this package.
  public static let maximumEventsPerDay = AssistantRetrievalLimits.maximumCalendarResults

  /// That day's calendar events, time-ordered (ascending — matching
  /// `findCalendarEvents`' own sort), each already carrying the
  /// `personVisibility == .other` attendee exclusion `findCalendarEvents`
  /// applies internally.
  public static func loadEvents(
    for day: DayKey,
    store: LocalGraphStore,
    calendar: Calendar = Calendar(identifier: .gregorian)
  ) throws -> [AssistantCalendarEvent] {
    guard let start = DayNavigation.dayStart(for: day, calendar: calendar),
      let end = DayNavigation.utcCalendar(from: calendar).date(byAdding: .day, value: 1, to: start)
    else { throw DayAgendaLoaderError.invalidDay }

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantCalendarSearchAuthorization(
      query: query, start: start, end: end, maximumResults: maximumEventsPerDay, includeOngoing: true)
    let results = try store.findCalendarEvents(authorization: authorization, candidateQuery: "")
    return results.events
  }
}
