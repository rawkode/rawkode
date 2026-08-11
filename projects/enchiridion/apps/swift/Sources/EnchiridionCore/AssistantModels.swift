// AssistantModels.swift
// EnchiridionCore
//
// Ported near-verbatim (pure domain logic, no CRDT/Automerge dependency)
// from `apps/enchiridion/Sources/EnchiridionCore/AssistantModels.swift`.
// See the plan's "Assistant (P5)" section for the full grounding-contract
// rationale: "the model never authors the final answer's factual prose.
// Trusted local code executes a tool call and returns a set of pre-written
// `AssistantEvidenceFact`s (`spokenText` authored by app code, not the
// model) plus the `AssistantSource`s they're grounded in."
//
// Scope note (task #65): this file carries the grounding contract's value
// types and the two small error enums that go with them
// (`AssistantDataAccessError`, `AssistantGroundingError`). The validator
// itself (`AssistantGroundingPolicy`) lives in its own file,
// `AssistantGroundingPolicy.swift`, since it's called out as the most
// important piece to review in isolation.
//
// Deliberately NOT ported here (left to the follow-on tasks named in the
// plan's Assistant section, #66/#67/#68):
// - Per-tool result container types (`AssistantCalendarResults`,
//   `AssistantNoteResults`, `AssistantTaskResults`, `AssistantMeetingBrief`,
//   `AssistantCalendarEvent`) — these are shaped around specific read
//   tools (`searchPages`, `searchTasks`, `findCalendarEvents`,
//   `meetingBrief`) that #66/#67/#68 build against `EnchiridionStore`'s
//   bounded SQL executor, which does not exist yet in this package. They
//   compose from `AssistantSource`/`AssistantEvidenceFact` below, so
//   nothing here blocks defining them later.
// - `AssistantResponseMetadata`/`AssistantTokenUsage`/
//   `AssistantConversationRoute`/`AssistantRouteProvider`/
//   `AssistantRecoveryAction`/`AssistantResponseCompletion` — these are
//   provider/route presentation data (OpenAI Responses API usage, retry
//   bookkeeping) that belong to the provider-integration task, not the
//   grounding contract. `GroundedAssistantResponse` below is trimmed to
//   `answer`/`status`/`sources` accordingly; a provider-integration task
//   can add a `metadata` field later without touching
//   `AssistantGroundingPolicy`'s validation logic.
// - `AssistantTaskScope` lives in this file (not skipped) because
//   `AssistantTurnRetrievalAuthorization.swift`'s `AssistantTaskSearchAuthorization`
//   needs a concrete scope type to bound — see that file.

import Foundation

/// What kind of local record an `AssistantSource` points at. Deliberately a
/// closed, small vocabulary — see the file header for why per-tool result
/// shapes are not ported here yet; new source kinds should be added only
/// alongside a real read tool that produces them.
public enum AssistantSourceKind: String, Codable, Hashable, Sendable {
  case calendarEvent
  case page
}

/// What a single evidence fact is about. `taskSummary` gets special
/// treatment in `AssistantGroundingPolicy`'s ambiguity check below — task
/// titles are expected to repeat far more often than page/event titles, so
/// a duplicate task title alone should not flip a response to `.ambiguous`.
public enum AssistantEvidenceKind: String, Codable, Hashable, Sendable {
  case eventSchedule
  case eventLocation
  case eventAttendees
  case pageExcerpt
  case pageTitle
  case taskSummary
}

/// A factual sentence rendered by trusted local code. The model may select
/// facts by ID, but it never authors the factual prose returned to the
/// user — `AssistantGroundingPolicy.groundedResponse` assembles the final
/// answer only by concatenating selected facts' own `spokenText`.
public struct AssistantEvidenceFact: Identifiable, Codable, Hashable, Sendable {
  public var id: String
  public var sourceID: String
  public var kind: AssistantEvidenceKind
  public var spokenText: String

  public init(id: String, sourceID: String, kind: AssistantEvidenceKind, spokenText: String) {
    self.id = id
    self.sourceID = sourceID
    self.kind = kind
    self.spokenText = spokenText
  }
}

/// A compact, local-only citation that can safely accompany a spoken
/// answer. `excerpt` is deliberately bounded before it leaves the
/// repository (future read-tool responsibility, not enforced here).
public struct AssistantSource: Identifiable, Codable, Hashable, Sendable {
  public var id: String
  public var kind: AssistantSourceKind
  public var title: String
  public var excerpt: String?
  public var occurredAt: Date?
  public var modifiedAt: Date?
  public var isStale: Bool
  public var hasConflicts: Bool

  public init(
    id: String,
    kind: AssistantSourceKind,
    title: String,
    excerpt: String? = nil,
    occurredAt: Date? = nil,
    modifiedAt: Date? = nil,
    isStale: Bool = false,
    hasConflicts: Bool = false
  ) {
    self.id = id
    self.kind = kind
    self.title = title
    self.excerpt = excerpt
    self.occurredAt = occurredAt
    self.modifiedAt = modifiedAt
    self.isStale = isStale
    self.hasConflicts = hasConflicts
  }
}

/// Where a task-scoped assistant query is aimed. Ported ahead of the task
/// read-tool itself (task #65 scope) purely because
/// `AssistantTaskSearchAuthorization` (AssistantTurnRetrievalAuthorization.swift)
/// needs a concrete, bounded vocabulary to restrict a tool call's `scope`
/// argument to.
public enum AssistantTaskScope: String, Codable, CaseIterable, Hashable, Sendable {
  case today
  case tomorrow
  case inbox
  case upcoming
  case anytime
  case someday
  case logbook
  case all

  public var emptyAnswer: String {
    switch self {
    case .today: "You have no active tasks scheduled or due today."
    case .tomorrow: "You have no active tasks scheduled or due tomorrow."
    case .inbox: "Your task inbox is empty."
    case .upcoming: "You have no upcoming tasks."
    case .anytime: "You have no active Anytime tasks."
    case .someday: "You have no Someday tasks."
    case .logbook: "Your task logbook is empty."
    case .all: "I couldn't find a matching task."
    }
  }
}

/// The outcome classification for one grounded assistant turn. Every case
/// but `.answered` signals the caller not to present `answer` as a settled
/// fact without the corresponding UI treatment (e.g. `.stale` should show a
/// "may be out of date" affordance).
public enum AssistantResponseStatus: String, Codable, Hashable, Sendable {
  case answered
  case noResults
  case ambiguous
  case stale
  case conflicting
  case unavailable
  case ungrounded
}

/// The result of one grounded assistant turn. `answer` is only ever
/// assembled from trusted `AssistantEvidenceFact.spokenText` values (see
/// `AssistantGroundingPolicy.groundedResponse`) or from the fixed strings
/// in `AssistantGroundingPolicy.noResults()`/`.unavailable(_:)` — never
/// from unvalidated model output.
public struct GroundedAssistantResponse: Codable, Hashable, Sendable {
  public var answer: String
  public var status: AssistantResponseStatus
  public var sources: [AssistantSource]

  public init(
    answer: String,
    status: AssistantResponseStatus,
    sources: [AssistantSource] = []
  ) {
    self.answer = answer
    self.status = status
    self.sources = sources
  }
}

/// On-device model availability, mirrored from the old app's
/// `FoundationModelAssistant` availability surface. Kept here (rather than
/// deferred to the provider-integration task) because
/// `AssistantGroundingPolicy.unavailable(_:)` needs it to build a safe
/// non-factual response when no provider can be reached.
public enum AssistantAvailability: Equatable, Sendable {
  case available
  case unsupportedOperatingSystem
  case deviceNotEligible
  case appleIntelligenceNotEnabled
  case modelNotReady
  case unsupportedLanguage

  public var message: String {
    switch self {
    case .available:
      "The on-device assistant is available."
    case .unsupportedOperatingSystem:
      "The on-device assistant requires iOS 26 or macOS 26, or later."
    case .deviceNotEligible:
      "This device does not support the on-device language model."
    case .appleIntelligenceNotEnabled:
      "Turn on Apple Intelligence to use the on-device assistant."
    case .modelNotReady:
      "The on-device language model is not ready yet."
    case .unsupportedLanguage:
      "The on-device assistant does not support the selected language."
    }
  }
}

/// Errors a local read tool (task #66/#67/#68) is expected to throw when a
/// tool-call argument fails bounds validation before it ever reaches the
/// data layer. Ported ahead of those tools existing so their error surface
/// is pinned now.
public enum AssistantDataAccessError: Error, LocalizedError, Equatable, Sendable {
  case emptyQuery
  case queryTooLong
  case invalidDateRange
  case dateRangeTooLarge
  case invalidSource
  case invalidTaskScope

  public var errorDescription: String? {
    switch self {
    case .emptyQuery: "A search term is required."
    case .queryTooLong: "The search term is too long."
    case .invalidDateRange: "The calendar search range is invalid."
    case .dateRangeTooLarge: "Calendar searches are limited to 31 days."
    case .invalidSource: "The selected calendar event is no longer available."
    case .invalidTaskScope: "The selected task list is not available."
    }
  }
}

/// Errors `AssistantGroundingPolicy.groundedResponse` throws. Each case is
/// a rejection, never a silent downgrade — see that type's header comment.
public enum AssistantGroundingError: Error, LocalizedError, Equatable, Sendable {
  case emptyAnswer
  case noSources
  case unknownSource(String)
  case unknownFact(String)
  case tooManyFacts

  public var errorDescription: String? {
    switch self {
    case .emptyAnswer: "The assistant returned an empty answer."
    case .noSources: "The assistant did not cite local sources."
    case .unknownSource(let sourceID): "The assistant cited an unknown source: \(sourceID)."
    case .unknownFact(let factID): "The assistant selected an unknown fact: \(factID)."
    case .tooManyFacts: "The assistant selected too many facts for a concise spoken response."
    }
  }
}
