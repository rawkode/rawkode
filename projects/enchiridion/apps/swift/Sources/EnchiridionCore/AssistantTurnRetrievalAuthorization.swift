// AssistantTurnRetrievalAuthorization.swift
// EnchiridionCore
//
// Ported near-verbatim from
// `apps/enchiridion/Sources/EnchiridionCore/AssistantTurnRetrievalAuthorization.swift`,
// with two adaptations for this package:
//   1. Per-tool cases are renamed to match this rebuild's actual planned
//      tool names (plan's "Assistant (P5)" section: "searchPages,
//      searchTasks, findCalendarEvents, meetingBrief") rather than the old
//      app's `searchNotes`/`briefCalendarEvent` — "everything is a page"
//      here, there is no separate "note" concept to search.
//   2. Bound constants (query length, calendar day span, per-tool result
//      caps) are defined locally in `AssistantRetrievalLimits` below
//      instead of on `LibraryRepository` (the old app's on-device data
//      layer, which has no equivalent in this package yet — that's
//      `EnchiridionStore`'s bounded SQL executor, task #66/#67/#68). These
//      are the assistant's own pre-flight bounds, independent of whatever
//      caps the eventual query executor enforces separately.
//
// The plan's "Assistant (P5)" section states the property this type
// exists to enforce: "the app constructs an immutable
// `AssistantTurnRetrievalAuthorization` *before* the request leaves the
// device — which tools, which query terms/date ranges/result caps are
// permitted this turn. A model's tool-call arguments can only select from
// what's already inside this authorization ... they cannot expand scope,
// dates, or result caps by crafting different arguments."
//
// Concretely, this is enforced two ways:
//   - `AssistantApprovedQuery.permits(_:)` is a normalize-then-membership
//     check against a fixed, pre-approved term set — a query term the
//     model invents that isn't in that set is rejected, not fuzzy-matched.
//   - Every per-tool authorization struct validates its own bounds in
//     `init`, so an authorization wider than policy allows (an
//     out-of-range date span, an oversized result cap, an empty/malformed
//     source-ID allowlist) can never be constructed in the first place —
//     there is no "authorize now, clamp later" path.

import Foundation

/// The assistant's own pre-flight bounds — independent of whatever
/// separate caps a bounded SQL executor (task #66/#67/#68,
/// `EnchiridionStore`) enforces on the data-access side. Kept here rather
/// than duplicated across each authorization struct's `init`.
public enum AssistantRetrievalLimits {
  public static let maximumQueryLength = 160
  public static let maximumCalendarDays: TimeInterval = 31 * 24 * 60 * 60
  public static let maximumCalendarResults = 10
  public static let maximumPageResults = 8
  public static let maximumTaskResults = 10
  public static let maximumMeetingBriefPeople = 8
  // task #66 addition — see `AssistantEmailSearchAuthorization` below.
  // `searchEmailThreads` is a remote call (vault's `emailSearch` GraphQL
  // field); the plan's Assistant (P5) section is explicit that "a remote
  // call gets no more trust than a local one," so this bound lives here
  // alongside every other tool's cap rather than being looser.
  public static let maximumEmailResults = 8
}

/// A local, immutable approval for the data one assistant turn may read.
///
/// The application creates this before a request leaves the device. Remote
/// tool arguments can only select work already contained in this value;
/// they cannot expand its query, scope, dates, result caps, or source IDs.
/// Every stored property is `let` — there is no mutating API on this type
/// or any of the per-tool authorization structs it holds, so once
/// constructed an authorization cannot be widened for the remainder of the
/// turn.
public struct AssistantTurnRetrievalAuthorization: Equatable, Sendable {
  public let pageSearch: AssistantPageSearchAuthorization?
  public let taskSearch: AssistantTaskSearchAuthorization?
  public let calendarSearch: AssistantCalendarSearchAuthorization?
  public let meetingBrief: AssistantMeetingBriefAuthorization?
  // task #66 addition — `searchEmailThreads` is new for this rebuild (P3
  // added Gmail; the old app has no equivalent), so it has no old-app
  // authorization struct to port. Added following the exact shape of every
  // sibling authorization above: optional, `let`-only, non-widenable.
  public let emailSearch: AssistantEmailSearchAuthorization?

  public init(
    pageSearch: AssistantPageSearchAuthorization? = nil,
    taskSearch: AssistantTaskSearchAuthorization? = nil,
    calendarSearch: AssistantCalendarSearchAuthorization? = nil,
    meetingBrief: AssistantMeetingBriefAuthorization? = nil,
    emailSearch: AssistantEmailSearchAuthorization? = nil
  ) {
    self.pageSearch = pageSearch
    self.taskSearch = taskSearch
    self.calendarSearch = calendarSearch
    self.meetingBrief = meetingBrief
    self.emailSearch = emailSearch
  }

  /// No tool may be called this turn. The safe default for, e.g., a purely
  /// conversational turn that never needed local retrieval.
  public static let none = AssistantTurnRetrievalAuthorization()

  /// Which local tools this turn is allowed to call at all, derived
  /// entirely from which per-tool authorizations are non-nil. A tool with
  /// no authorization here must never be invoked, regardless of what a
  /// model's tool-call arguments claim.
  public var allowedTools: [AssistantRetrievalTool] {
    var result: [AssistantRetrievalTool] = []
    if calendarSearch != nil { result.append(.findCalendarEvents) }
    if meetingBrief != nil { result.append(.meetingBrief) }
    if taskSearch != nil { result.append(.searchTasks) }
    if pageSearch != nil { result.append(.searchPages) }
    if emailSearch != nil { result.append(.searchEmailThreads) }
    return result
  }
}

/// Identifies one of the assistant's local read tools. Naming matches the
/// plan's "Assistant (P5)" section verbatim ("searchPages, searchTasks,
/// findCalendarEvents, meetingBrief"). This is only an identity
/// enumeration — the tools themselves are built by #66/#67/#68.
public enum AssistantRetrievalTool: String, CaseIterable, Equatable, Hashable, Sendable {
  case findCalendarEvents
  case meetingBrief
  case searchTasks
  case searchPages
  // task #66 addition — see `AssistantEmailSearchAuthorization` below.
  case searchEmailThreads
}

public enum AssistantTurnRetrievalAuthorizationError: Error, Equatable, Sendable {
  case invalidQuery
  case invalidResultLimit
  case invalidDateRange
  case invalidSourceID
}

/// Complete query strings or terms explicitly approved for one local
/// search this turn. A model may choose only one of these values verbatim
/// — `permits(_:)` normalizes its candidate and checks set membership,
/// nothing more permissive than that.
public struct AssistantApprovedQuery: Equatable, Sendable {
  public let originalQuery: String
  public let approvedQueryTerms: Set<String>

  public init(
    originalQuery: String,
    approvedQueryTerms: Set<String> = []
  ) throws {
    let original = try Self.normalize(originalQuery)
    let approved = try Set(approvedQueryTerms.map { try Self.normalize($0) }).union([original])
    self.originalQuery = original
    self.approvedQueryTerms = approved
  }

  /// Returns whether `candidate` — after the same normalization applied at
  /// construction — is one of this turn's pre-approved terms. A term that
  /// merely resembles an approved one (extra words appended, different
  /// casing beyond what normalization accounts for, etc.) is rejected: this
  /// is an exact-match-after-normalization check, not a fuzzy one.
  public func permits(_ candidate: String) -> Bool {
    guard let normalized = try? Self.normalize(candidate) else { return false }
    return approvedQueryTerms.contains(normalized)
  }

  private static func normalize(_ query: String) throws -> String {
    let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard normalized.count <= AssistantRetrievalLimits.maximumQueryLength else {
      throw AssistantTurnRetrievalAuthorizationError.invalidQuery
    }
    return normalized
  }
}

public struct AssistantPageSearchAuthorization: Equatable, Sendable {
  public let query: AssistantApprovedQuery
  public let maximumResults: Int

  public init(query: AssistantApprovedQuery, maximumResults: Int) throws {
    guard (1...AssistantRetrievalLimits.maximumPageResults).contains(maximumResults) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.query = query
    self.maximumResults = maximumResults
  }
}

public struct AssistantTaskSearchAuthorization: Equatable, Sendable {
  public let scope: AssistantTaskScope
  public let query: AssistantApprovedQuery
  public let maximumResults: Int

  public init(
    scope: AssistantTaskScope,
    query: AssistantApprovedQuery,
    maximumResults: Int
  ) throws {
    guard (1...AssistantRetrievalLimits.maximumTaskResults).contains(maximumResults) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.scope = scope
    self.query = query
    self.maximumResults = maximumResults
  }
}

public struct AssistantCalendarSearchAuthorization: Equatable, Sendable {
  public let query: AssistantApprovedQuery
  public let start: Date
  public let end: Date
  public let maximumResults: Int
  public let includeOngoing: Bool

  public init(
    query: AssistantApprovedQuery,
    start: Date,
    end: Date,
    maximumResults: Int,
    includeOngoing: Bool
  ) throws {
    guard end > start,
      end.timeIntervalSince(start) <= AssistantRetrievalLimits.maximumCalendarDays
    else { throw AssistantTurnRetrievalAuthorizationError.invalidDateRange }
    guard (1...AssistantRetrievalLimits.maximumCalendarResults).contains(maximumResults) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.query = query
    self.start = start
    self.end = end
    self.maximumResults = maximumResults
    self.includeOngoing = includeOngoing
  }
}

public struct AssistantMeetingBriefAuthorization: Equatable, Sendable {
  public let allowedSourceIDs: Set<String>
  public let maximumPeople: Int

  public init(allowedSourceIDs: Set<String>, maximumPeople: Int) throws {
    guard !allowedSourceIDs.isEmpty,
      allowedSourceIDs.allSatisfy(Self.isCanonicalCalendarSourceID)
    else { throw AssistantTurnRetrievalAuthorizationError.invalidSourceID }
    guard (1...AssistantRetrievalLimits.maximumMeetingBriefPeople).contains(maximumPeople) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.allowedSourceIDs = allowedSourceIDs
    self.maximumPeople = maximumPeople
  }

  private static func isCanonicalCalendarSourceID(_ value: String) -> Bool {
    let prefix = "calendar:"
    guard value.hasPrefix(prefix) else { return false }
    let encoded = String(value.dropFirst(prefix.count))
    guard !encoded.isEmpty, let data = Data(base64Encoded: encoded),
      !data.isEmpty, String(data: data, encoding: .utf8) != nil
    else { return false }
    return data.base64EncodedString() == encoded
  }
}

/// task #66 addition. Pre-flight authorization for `searchEmailThreads` —
/// vault's server-only `emailSearch` GraphQL field (plan's Assistant (P5)
/// section: "calls vault's server-only `emailSearch`/`thread.messages`
/// GraphQL fields ... wrapped in ... the same pre-flight-authorization
/// discipline as the local tools — a remote call gets no more trust than a
/// local one"). Same shape as `AssistantPageSearchAuthorization` exactly
/// (one approved query, one fixed result cap) — email search has no date
/// range or scope concept to bound beyond that.
public struct AssistantEmailSearchAuthorization: Equatable, Sendable {
  public let query: AssistantApprovedQuery
  public let maximumResults: Int

  public init(query: AssistantApprovedQuery, maximumResults: Int) throws {
    guard (1...AssistantRetrievalLimits.maximumEmailResults).contains(maximumResults) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.query = query
    self.maximumResults = maximumResults
  }
}
