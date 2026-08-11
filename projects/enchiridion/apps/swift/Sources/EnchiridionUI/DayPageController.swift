// DayPageController.swift
// EnchiridionUI
//
// Task #81 (plan §"Core Product UI (P7)", tracks 1+2). The day-page
// screen's controller: opens/creates the deterministic daily page for a
// given `DayKey` via `PageID.daily(_:)` (`EnchiridionCore/Identity.swift`),
// reusing `PageEditorController.open` (task #78's load-or-create path) for
// the actual CRDT document — a day page is still just a page (task brief),
// so there is no parallel page-rendering mechanism here. Also owns
// day-to-day navigation (`goToPreviousDay`/`goToNextDay`/`goTo(day:)`/
// `goTo(date:)`), each resolving through the same deterministic ID so
// revisiting any day — "today" twice, or any arbitrary day — always
// reuses that day's one real page, and the agenda for whichever day is
// currently open (`DayAgendaLoader.swift`).
//
// SELF-CONTAINED BY DESIGN (task brief, matching `TaskListView`/
// `TaskBoardView`'s established "SELF-CONTAINED BY DESIGN" precedent in
// this same module): takes only a `LocalGraphStore` — no
// navigation-shell/`RootView` dependency. A future integration task wires
// this screen into the app's real navigation.
//
// SWITCHING DAYS FLUSHES FIRST: matching `TaskDetailEditorSheet.close()`'s
// "flush before dismiss" discipline, `goTo(_:)` awaits the currently-open
// day's `flush()` (and then `invalidate()`s it) before opening the next
// day, so navigating away from a day with unsaved typing never silently
// drops it — `PageEditorController.flush()`'s own doc comment: a dirty
// session must be flushed explicitly before its controller is abandoned.

import EnchiridionCore
import EnchiridionStore
import Foundation
import Observation

@MainActor
@Observable
public final class DayPageController {
  public private(set) var day: DayKey
  public private(set) var editor: PageEditorController?
  public private(set) var agenda: [AssistantCalendarEvent] = []
  public private(set) var isLoading = false
  public private(set) var loadError: String?

  private let store: LocalGraphStore
  private let calendar: Calendar

  public init(
    store: LocalGraphStore,
    day: DayKey = DayKey(date: Date()),
    calendar: Calendar = Calendar(identifier: .gregorian)
  ) {
    self.store = store
    self.day = day
    self.calendar = calendar
  }

  /// Display title for the currently open day — e.g. "Thursday, August 6,
  /// 2026" (`DayNavigation.displayTitle(for:calendar:)`). Also used as
  /// `PageEditorController.open`'s new-page `title` fallback below —
  /// ported concept from the old app's `LibraryRepository.dailyPage(for:)`
  /// defaulting to `dailyTitle(day)` when no explicit title is supplied.
  public var dayTitle: String { DayNavigation.displayTitle(for: day, calendar: calendar) }

  /// `true` when the currently open day is not the device's real "today" —
  /// a host view can use this to enable/disable a "Today" jump button.
  public var isToday: Bool { day == DayKey(date: Date(), calendar: calendar) }

  /// Loads (or creates, on first visit) the deterministic daily page for
  /// `day` and refreshes its agenda. Call once after init (e.g. from a
  /// SwiftUI `.task`); `goTo...` below call this again internally, after
  /// flushing whatever was open before.
  public func load() async {
    isLoading = true
    loadError = nil
    defer { isLoading = false }
    do {
      editor = try await PageEditorController.open(
        pageID: PageID.daily(day), kind: .daily(day), title: dayTitle, store: store)
    } catch {
      editor = nil
      loadError = error.localizedDescription
    }
    await refreshAgenda()
  }

  /// Reloads just the agenda for the currently open day, without touching
  /// the page editor — e.g. after the app learns about newly synced
  /// calendar events while this day is already on screen.
  public func refreshAgenda() async {
    do {
      agenda = try DayAgendaLoader.loadEvents(for: day, store: store, calendar: calendar)
    } catch {
      // An agenda failure doesn't block the page itself from being usable
      // — surfaced as an empty list only, matching every other bounded
      // read tool's posture elsewhere in this package (e.g.
      // `WidgetEntryDataSource`'s `catch` branches never propagate a
      // read-tool failure as a hard UI error).
      agenda = []
    }
  }

  public func goToPreviousDay() async {
    await goTo(DayNavigation.previousDay(before: day, calendar: calendar))
  }

  public func goToNextDay() async {
    await goTo(DayNavigation.nextDay(after: day, calendar: calendar))
  }

  public func goToToday() async {
    await goTo(DayKey(date: Date(), calendar: calendar))
  }

  public func goTo(date: Date) async {
    await goTo(DayKey(date: date, calendar: calendar))
  }

  /// Navigates to an arbitrary day, resolving through the same
  /// deterministic `PageID.daily(_:)` `load()` uses — so jumping to any
  /// day (via prev/next or a date picker) never creates a duplicate page
  /// for a day already visited. A no-op if `newDay == day` (nothing to
  /// flush or reload).
  public func goTo(_ newDay: DayKey) async {
    guard newDay != day else { return }
    await editor?.flush()
    editor?.invalidate()
    day = newDay
    await load()
  }
}
