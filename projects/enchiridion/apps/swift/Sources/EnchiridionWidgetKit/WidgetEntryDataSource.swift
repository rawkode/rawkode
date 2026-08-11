// WidgetEntryDataSource.swift
// EnchiridionWidgetKit
//
// The testable half of both widgets: plain functions from an already-open
// `LocalGraphStore` to a widget's `TimelineEntry` value, with NO WidgetKit
// import and no dependency on `WidgetLocalStore`'s App-Group-resolution —
// that's deliberate, so `EnchiridionWidgetKitTests` can call these directly
// against a real temporary store (`LocalGraphStore.openTemporary()`),
// exactly like `EnchiridionStoreTests/AssistantReadToolsTests.swift`
// already does for the read tools these build on. `TodayTasksWidget.swift`/
// `NextEventWidget.swift`'s `TimelineProvider`s are thin callers of these
// (see that file's header for why THEY aren't unit tested).
//
// Both functions are built entirely on `EnchiridionStore`'s existing
// `searchTasks`/`findCalendarEvents` (task #66,
// `EnchiridionStore/AssistantReadTools.swift`) rather than new hand-written
// SQL — the widget's needs (today's active tasks; the single next
// calendar event) are a strict subset of what those two tools already do,
// including the `personVisibility` privacy-gate exclusion `findCalendarEvents`
// already applies to attendee evidence. Writing parallel SQL here would
// duplicate that exclusion logic with a real chance of missing it — this
// task's own brief explicitly allows this ("Prefer reusing existing code if
// it fits cleanly; don't force it if the shapes genuinely mismatch" — here
// it fits cleanly, both tools take a fixed, hardcoded-safe pre-flight
// authorization with no query term, matching a widget's fully-fixed,
// non-model-driven need).

import EnchiridionCore
import EnchiridionStore
import Foundation

// MARK: - Entry types

/// `TodayTasksWidget`'s timeline entry — plain data, no WidgetKit
/// dependency, so it's constructible and comparable from a plain test.
public struct TodayTasksWidgetEntry: Hashable, Sendable {
  public var date: Date
  public var taskTitles: [String]
  public var truncated: Bool
  /// Set only when the store couldn't be read at all (App Group container
  /// unavailable, or a query failed) — distinguishes "genuinely no tasks
  /// today" (empty `taskTitles`, `statusMessage == nil`) from "couldn't
  /// find out" (also empty `taskTitles`, but `statusMessage != nil`),
  /// exactly like `AssistantSource`'s own posture elsewhere in this
  /// package: a failure state is never silently rendered as an empty
  /// success state.
  public var statusMessage: String?

  public init(date: Date, taskTitles: [String], truncated: Bool, statusMessage: String? = nil) {
    self.date = date
    self.taskTitles = taskTitles
    self.truncated = truncated
    self.statusMessage = statusMessage
  }
}

/// `NextEventWidget`'s timeline entry. `nil` `title` with `statusMessage
/// == nil` means "no upcoming event in the lookahead window" (a real,
/// successfully-read empty result); `statusMessage != nil` means the read
/// itself failed — same distinction as `TodayTasksWidgetEntry` above.
public struct NextEventWidgetEntry: Hashable, Sendable {
  public var date: Date
  public var title: String?
  public var startDate: Date?
  public var isAllDay: Bool
  public var location: String?
  public var statusMessage: String?

  public init(
    date: Date, title: String? = nil, startDate: Date? = nil, isAllDay: Bool = false,
    location: String? = nil, statusMessage: String? = nil
  ) {
    self.date = date
    self.title = title
    self.startDate = startDate
    self.isAllDay = isAllDay
    self.location = location
    self.statusMessage = statusMessage
  }
}

// MARK: - Data source

public enum WidgetEntryDataSource {
  /// Widget real estate is small — this is well under
  /// `AssistantRetrievalLimits.maximumTaskResults` (10), matching the old
  /// app's own `TodayTasksWidget`'s `.prefix(8)` choice.
  public static let maximumTaskTitles = 8

  /// How far ahead the next-event widget looks for a next event. Kept
  /// well inside `AssistantRetrievalLimits.maximumCalendarDays` (31 days).
  public static let calendarLookaheadDays = 7

  /// `TodayTasksWidget`'s data load: today's active tasks (scope `.today`
  /// — overdue + due/scheduled today, matching `AssistantTaskScope.today`'s
  /// documented semantics in `AssistantReadTools.swift`), no query term
  /// (a widget has no user-typed search — the fixed, hardcoded-safe
  /// authorization the task brief calls for), through the SAME
  /// pre-flight-authorization-checked `searchTasks` the assistant uses.
  public static func loadTodayTasksEntry(
    store: LocalGraphStore,
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> TodayTasksWidgetEntry {
    do {
      let query = try AssistantApprovedQuery(originalQuery: "")
      let authorization = try AssistantTaskSearchAuthorization(
        scope: .today, query: query, maximumResults: maximumTaskTitles)
      let results = try store.searchTasks(
        authorization: authorization, candidateScope: .today, now: now, calendar: calendar)
      return TodayTasksWidgetEntry(
        date: now, taskTitles: results.sources.map(\.title), truncated: results.truncated)
    } catch {
      return TodayTasksWidgetEntry(
        date: now, taskTitles: [], truncated: false, statusMessage: "Couldn’t load today’s tasks.")
    }
  }

  /// `NextEventWidget`'s data load: the single soonest calendar event
  /// starting between `now` and `now + calendarLookaheadDays`, including
  /// an event already in progress (`includeOngoing: true` — a meeting
  /// that started five minutes ago is still the thing the widget should
  /// show as "next"). `findCalendarEvents` already returns events sorted
  /// by start time ascending, so the first result is the soonest.
  public static func loadNextEventEntry(
    store: LocalGraphStore,
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> NextEventWidgetEntry {
    do {
      let query = try AssistantApprovedQuery(originalQuery: "")
      let horizon =
        calendar.date(byAdding: .day, value: calendarLookaheadDays, to: now)
        ?? now.addingTimeInterval(TimeInterval(calendarLookaheadDays * 24 * 60 * 60))
      let authorization = try AssistantCalendarSearchAuthorization(
        query: query, start: now, end: horizon, maximumResults: 1, includeOngoing: true)
      let results = try store.findCalendarEvents(authorization: authorization)
      guard let next = results.events.first else {
        return NextEventWidgetEntry(date: now)
      }
      return NextEventWidgetEntry(
        date: now, title: next.source.title, startDate: next.startDate, isAllDay: next.isAllDay,
        location: next.location)
    } catch {
      return NextEventWidgetEntry(date: now, statusMessage: "Couldn’t load your calendar.")
    }
  }
}
