// AssistantConversationAuthorization.swift
// EnchiridionUI
//
// Task #85 (P7 integration wave). `AssistantConversationController.init`'s
// `retrievalAuthorization`/`writeAuthorization` parameters are closures the
// APP constructs from real state, "before the request leaves the device"
// (`AssistantTurnRetrievalAuthorization.swift`'s header) — P5 built the
// authorization TYPES and the grounding contract that consumes them, but
// (per that header, and the plan's P5 "Tracked, not fixed" note) never
// built a real, app-state-driven FACTORY for one, because nothing
// constructed the controller in a live app yet. This file is that factory
// — the missing half task #73/#85's brief pointed at.
//
// THE CORE DESIGN PROBLEM THIS FILE SOLVES: `AssistantApprovedQuery`
// requires the app to pre-approve a CLOSED set of query strings before the
// model ever runs (`OpenAIResponsesRequestBuilder.swift` literally builds
// the model's tool-call JSON Schema as an enum of exactly
// `approvedQueryTerms` — the model cannot supply a query string outside
// that set even if it wanted to). But `AssistantConversationController
// .send(_:)` calls this file's closures with NO argument — see that file's
// header for the two write-facade halves it's careful to keep apart; the
// SAME "narrow closure signature, no model-supplied input in scope" care
// applies to retrieval. So how does an interactive, free-text conversation
// ever get a non-empty approved-term set for THIS turn's actual question?
//
// THE ANSWER: `retrievalAuthorization` closures in this codebase are
// re-invoked fresh on every `send(_:)` call (unlike a value captured once
// at construction) — `AssistantConversationController.swift`'s `send(_:)`
// appends the user's trimmed utterance to `messages` BEFORE calling
// `retrievalAuthorization()`. This file's `makeConversationController`
// (AssistantSceneAssembly.swift) exploits exactly that ordering: the
// closure it hands to `AssistantConversationController.init` reads
// `controller.messages.last(where: { $0.role == .user })?.text` — the
// utterance THIS turn is actually about — and pre-approves that utterance
// (verbatim) plus its individual significant words as this turn's query
// vocabulary. This is still "the app decides, before the model runs, what
// this turn may search for" (the model can pick any word the PERSON just
// typed, never a word it invented) — not a weakening of the pre-flight
// contract, just applying it against real per-turn state instead of a
// fixed compile-time constant the way `DayAgendaLoader.swift`/
// `AssistantAppIntents.swift` get away with using `""` for their
// non-free-text, scope/date-bounded call sites.
//
// UPDATE (task #96, plan §Live Backend Connectivity (P8) scope item 3):
// `emailSearch` and every remote write tool are now authorized when their
// underlying pre-flight bounds construct successfully — see
// `AssistantSceneAssembly.swift`'s header for exactly what "authorized" and
// "re-enabled" mean here (a real client is always wired; whether a call
// SUCCEEDS still depends on this device holding a real enrolled credential
// and a real deployed backend existing, neither of which this sandbox has
// — see `AppBackendConfiguration.swift`'s header). Authorizing a tool here
// is independent of whether the underlying transport can currently reach a
// server — that's the whole point of the pre-flight authorization pattern
// this file's header describes: the app decides what's ALLOWED this turn,
// not whether the network happens to cooperate.
//
// WHAT THIS FILE STILL DOES NOT AUTHORIZE:
//   - `meetingBrief` — only authorized (non-nil) when this turn's own
//     calendar window actually contains at least one event, since
//     `AssistantMeetingBriefAuthorization.init` rejects an empty
//     `allowedSourceIDs` set outright (`AssistantTurnRetrievalAuthorization
//     .swift`). Seeded from a REAL bounded `findCalendarEvents` call over
//     the same window/query this file already authorizes for
//     `calendarSearch` — not a second, wider query.
import EnchiridionCore
import EnchiridionStore
import Foundation

public enum AssistantConversationAuthorizationFactory {
  /// How far back/forward `calendarSearch`/`meetingBrief` look from `now` —
  /// deliberately AT the `AssistantRetrievalLimits.maximumCalendarDays`
  /// (31-day) ceiling `AssistantCalendarSearchAuthorization.init` enforces,
  /// biased slightly into the past (3 days) so "what did I have last
  /// weekend" style questions still resolve, not just forward-looking ones.
  private static let calendarLookbackDays = 3
  private static let calendarWindowDays = 31

  /// Builds this turn's retrieval authorization from `store` (real local
  /// data — used only to seed `meetingBrief`'s allowlist, see this file's
  /// header) and `utterance` (this turn's actual question — see this
  /// file's header for why that's safe and how the closure that calls this
  /// obtains it). Never throws: any individual sub-authorization that fails
  /// to construct (an all-whitespace utterance, a calendar window that
  /// somehow fails to build) is simply omitted — a turn with fewer
  /// authorized tools than intended is safe; a turn that crashes assembling
  /// its own authorization is not.
  public static func retrievalAuthorization(
    store: LocalGraphStore, utterance: String, now: Date = Date(), calendar: Calendar = Calendar(identifier: .gregorian)
  ) -> AssistantTurnRetrievalAuthorization {
    let query = approvedQuery(for: utterance)

    let pageSearch = query.flatMap { try? AssistantPageSearchAuthorization(query: $0, maximumResults: AssistantRetrievalLimits.maximumPageResults) }
    let taskSearch = query.flatMap {
      try? AssistantTaskSearchAuthorization(scope: .all, query: $0, maximumResults: AssistantRetrievalLimits.maximumTaskResults)
    }

    var calendarSearch: AssistantCalendarSearchAuthorization?
    var meetingBrief: AssistantMeetingBriefAuthorization?
    if let query, let window = calendarWindow(now: now, calendar: calendar) {
      calendarSearch = try? AssistantCalendarSearchAuthorization(
        query: query, start: window.start, end: window.end,
        maximumResults: AssistantRetrievalLimits.maximumCalendarResults, includeOngoing: true)
      if calendarSearch != nil {
        // Seeds `meetingBrief`'s allowlist with an INTERNAL, app-code-only
        // scan of this same window — deliberately a SEPARATE, empty-query
        // authorization from `calendarSearch` above (never exposed to the
        // model): `calendarSearch.query`'s approved terms are the
        // utterance's own words, which are a SUBSTRING filter against
        // event title/location/attendees
        // (`LocalGraphStore.findCalendarEvents`) — matching against a
        // multi-word question like "what's my next meeting" would almost
        // never substring-match a real event's title, silently starving
        // `meetingBrief` even when the window plainly has events. An
        // internal `""` query (the same "no text filter, scope/date-bounded
        // only" pattern `DayAgendaLoader.swift`/`AssistantAppIntents.swift`
        // already establish for non-free-text call sites) scans the whole
        // window instead.
        let seedQuery = try? AssistantApprovedQuery(originalQuery: "")
        let seedAuthorization = seedQuery.flatMap {
          try? AssistantCalendarSearchAuthorization(
            query: $0, start: window.start, end: window.end,
            maximumResults: AssistantRetrievalLimits.maximumCalendarResults, includeOngoing: true)
        }
        let sourceIDs = seedAuthorization
          .flatMap { try? store.findCalendarEvents(authorization: $0, candidateQuery: "") }
          .map { Set($0.events.map(\.source.id)) } ?? []
        if !sourceIDs.isEmpty {
          meetingBrief = try? AssistantMeetingBriefAuthorization(
            allowedSourceIDs: sourceIDs, maximumPeople: AssistantRetrievalLimits.maximumMeetingBriefPeople)
        }
      }
    }

    // task #96 addition: `emailSearch` authorized the same way `pageSearch`/
    // `taskSearch` already are — one approved query (this turn's utterance
    // + its words), bounded the same way. `AssistantSceneAssembly.swift`
    // now always constructs a real `VaultEmailSearchClient`, so this is no
    // longer withheld for "no client wired" reasons — see this file's
    // header.
    let emailSearch = query.flatMap {
      try? AssistantEmailSearchAuthorization(query: $0, maximumResults: AssistantRetrievalLimits.maximumEmailResults)
    }

    return AssistantTurnRetrievalAuthorization(
      pageSearch: pageSearch,
      taskSearch: taskSearch,
      calendarSearch: calendarSearch,
      meetingBrief: meetingBrief,
      emailSearch: emailSearch
    )
  }

  /// Local task creation, plus every remote write tool (task #96 — see this
  /// file's header). `allowTaskUpdate`/`allowTaskComplete` stay off — no
  /// production `AssistantTaskSnapshotProviding` exists yet, an
  /// already-documented, pre-existing gap this task doesn't close (see
  /// `AssistantSceneAssembly.swift`'s header).
  public static let writeAuthorization = AssistantTurnWriteAuthorization(
    allowTaskCreate: true,
    allowCreateEvent: true,
    allowRsvp: true,
    allowSendEmail: true,
    allowArchiveEmail: true,
    allowApplyLabel: true,
    allowRemoveLabel: true,
    allowMarkRead: true,
    allowMarkUnread: true
  )

  // MARK: - Helpers

  /// This turn's pre-approved query vocabulary: the trimmed utterance
  /// itself, plus its individual words (length >= 2, so single letters/
  /// punctuation noise don't bloat the model's enum for no benefit) — see
  /// this file's header for why deriving this from the utterance is sound.
  /// `nil` only for a genuinely empty/all-whitespace utterance (a
  /// conversational turn with no text to search for at all — the same case
  /// `AssistantConversationController.send(_:)` already guards against
  /// submitting).
  private static func approvedQuery(for utterance: String) -> AssistantApprovedQuery? {
    let trimmed = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= AssistantRetrievalLimits.maximumQueryLength else { return nil }
    let words = trimmed
      .components(separatedBy: .whitespacesAndNewlines)
      .map { $0.trimmingCharacters(in: .punctuationCharacters) }
      .filter { $0.count >= 2 && $0.count <= AssistantRetrievalLimits.maximumQueryLength }
    return try? AssistantApprovedQuery(originalQuery: trimmed, approvedQueryTerms: Set(words))
  }

  private static func calendarWindow(now: Date, calendar: Calendar) -> (start: Date, end: Date)? {
    var utc = calendar
    utc.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone
    let today = utc.startOfDay(for: now)
    guard let start = utc.date(byAdding: .day, value: -calendarLookbackDays, to: today),
      let end = utc.date(byAdding: .day, value: calendarWindowDays - calendarLookbackDays, to: today)
    else { return nil }
    return (start, end)
  }
}
