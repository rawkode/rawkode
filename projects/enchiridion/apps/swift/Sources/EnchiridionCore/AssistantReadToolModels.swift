// AssistantReadToolModels.swift
// EnchiridionCore
//
// Task #66 ("Assistant read tools"). Per-tool result containers and small
// shared helpers for the assistant's local read tools
// (`searchPages`/`searchTasks`/`findCalendarEvents`/`meetingBrief`) plus
// the new `searchEmailThreads` tool, ported concept (shape, not code) from
// the old app's `apps/enchiridion/Sources/EnchiridionCore/AssistantModels.swift`
// result types (`AssistantCalendarResults`/`AssistantNoteResults`/
// `AssistantTaskResults`/`AssistantMeetingBrief`) and
// `AssistantDataAccess.swift`'s private static helpers
// (`assistantBounded`/`assistantExcerpt`/`assistantPageEvidence`/
// `assistantEventEvidence`), made `public` here so both this module's own
// `searchEmailThreads` and `EnchiridionStore`'s local tool executors
// (`AssistantReadTools.swift` there) can share one evidence-fact-authoring
// implementation.
//
// *** WHY THE LOCAL TOOLS' TYPES LIVE HERE BUT THEIR EXECUTORS DO NOT ***
//
// The task brief's suggested layout ("New files in Sources/EnchiridionCore/
// ... AssistantReadTools.swift") assumes `EnchiridionCore` can reach the
// on-device bounded SQL executor. It cannot: `EnchiridionStore` (which owns
// `GraphSQLExecutor`/`LocalGraphStore`) depends ON `EnchiridionCore`, not
// the other way around (see `apps/swift/Package.swift`'s target graph) —
// putting a function here that calls `GraphSQLExecutor.execute` would be
// circular and would not compile. So:
//   - Pure data (this file): result containers, evidence-fact/source
//     construction helpers, bounds-checking that needs no database.
//   - `searchPages`/`searchTasks`/`findCalendarEvents`/`meetingBrief`
//     (`EnchiridionStore/AssistantReadTools.swift`): the actual SQL-backed
//     executors, added as `LocalGraphStore` extension methods (matching
//     that actor's existing pattern of `nonisolated` methods wrapping its
//     own bounded `query(...)` — see that file's header) — they import
//     `EnchiridionCore` and call the helpers below.
//   - `searchEmailThreads` (this file, in full): the one tool that needs
//     no local database at all — just an injected `AssistantEmailSearchClient`
//     — so nothing prevents it from living here in one piece. The concrete
//     network implementation of that protocol lives in `EnchiridionAPI`
//     (which already depends on `EnchiridionCore`, so it can conform to a
//     protocol declared here without any circularity) — the same
//     dependency-inversion shape `EnchiridionGadgets`' capability bridge
//     already uses elsewhere in this codebase.

import Foundation

// MARK: - Shared evidence/source construction helpers

/// Ported concept from `AssistantDataAccess.swift`'s private `static`
/// helpers of the same names — made `public` and namespaced here so both
/// `EnchiridionStore`'s local tool executors and this file's
/// `searchEmailThreads` can share one implementation instead of forking it.
public enum AssistantReadToolSupport {
  /// Truncates trusted repository text to `maximum` characters, appending
  /// an ellipsis — used on every title/location/excerpt before it becomes
  /// part of an `AssistantSource`/`AssistantEvidenceFact`, matching the old
  /// app's "excerpt is deliberately bounded before it leaves the
  /// repository" comment on `AssistantSource`.
  public static func bounded(_ text: String, maximum: Int) -> String {
    guard text.count > maximum else { return text }
    return String(text.prefix(maximum - 1)) + "…"
  }

  /// A compact, query-centered excerpt of `text`, bounded to
  /// `maximumExcerptCharacters`. Ported near-verbatim from
  /// `AssistantDataAccess.assistantExcerpt`.
  public static let maximumExcerptCharacters = 400

  public static func excerpt(_ text: String, matching query: String) -> String? {
    let compact = text
      .split(whereSeparator: { $0.isWhitespace })
      .joined(separator: " ")
    guard !compact.isEmpty else { return nil }
    let match = compact.range(of: query, options: [.caseInsensitive, .diacriticInsensitive])
    let center = match?.lowerBound ?? compact.startIndex
    let leading = compact.distance(from: compact.startIndex, to: center)
    let startOffset = max(0, leading - maximumExcerptCharacters / 3)
    let start = compact.index(compact.startIndex, offsetBy: startOffset)
    let end = compact.index(
      start,
      offsetBy: min(maximumExcerptCharacters, compact.distance(from: start, to: compact.endIndex))
    )
    var result = String(compact[start..<end])
    if start != compact.startIndex { result = "…\(result)" }
    if end != compact.endIndex { result += "…" }
    return result
  }

  /// A page's title + (optional) excerpt evidence facts. Ported from
  /// `AssistantDataAccess.assistantPageEvidence`.
  public static func pageEvidence(source: AssistantSource) -> [AssistantEvidenceFact] {
    var facts = [
      AssistantEvidenceFact(
        id: "\(source.id)#title",
        sourceID: source.id,
        kind: .pageTitle,
        spokenText: "A local page is titled \(source.title)."
      )
    ]
    if let excerpt = source.excerpt, !excerpt.isEmpty {
      facts.append(
        AssistantEvidenceFact(
          id: "\(source.id)#excerpt",
          sourceID: source.id,
          kind: .pageExcerpt,
          spokenText: "\(source.title) says: \(excerpt)"
        )
      )
    }
    return facts
  }

  /// Groups `sources` by case/diacritic-folded title and returns the
  /// titles that appear more than once — the ambiguity signal
  /// `AssistantGroundingPolicy.groundedResponse` folds into `.ambiguous`.
  /// Ported from `AssistantDataAccess.searchNotes`'s inline grouping.
  public static func ambiguousTitles(among sources: [AssistantSource]) -> [String] {
    let groups = Dictionary(grouping: sources) {
      $0.title.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
    return groups.values.filter { $0.count > 1 }.compactMap { $0.first?.title }.sorted()
  }

  /// The canonical, cloud-safe `AssistantSource.id` for a calendar event —
  /// `calendar:<base64(pageID)>`. `AssistantMeetingBriefAuthorization`
  /// already validates this exact shape
  /// (`isCanonicalCalendarSourceID`) — kept in lockstep with it here.
  /// Unlike the old app (which base64-encoded a provider-derived
  /// `stableKey`), this rebuild's calendar events already ARE pages with a
  /// deterministic, cloud-safe `PageID` (`PageID.digestIdentified(prefix:
  /// "event", ...)` — see `EnchiridionCore/Identity.swift`), so the page ID
  /// itself is what gets encoded; no separate event-identity digest is
  /// needed.
  public static func calendarSourceID(pageID: String) -> String {
    "calendar:\(Data(pageID.utf8).base64EncodedString())"
  }

  /// The inverse of `calendarSourceID(pageID:)` — decodes a previously
  /// returned source ID back to the `PageID.rawValue` it was built from, or
  /// `nil` if `sourceID` isn't in that exact shape.
  public static func pageID(fromCalendarSourceID sourceID: String) -> String? {
    let prefix = "calendar:"
    guard sourceID.hasPrefix(prefix),
      let data = Data(base64Encoded: String(sourceID.dropFirst(prefix.count))),
      let value = String(data: data, encoding: .utf8)
    else { return nil }
    return value
  }
}

// MARK: - Calendar

/// One calendar event, projected for assistant use. Ported shape from the
/// old app's `AssistantCalendarEvent`.
public struct AssistantCalendarEvent: Codable, Hashable, Sendable {
  public var source: AssistantSource
  public var startDate: Date?
  public var endDate: Date?
  public var isAllDay: Bool
  public var location: String?
  public var attendees: [String]
  public var evidence: [AssistantEvidenceFact]

  public init(
    source: AssistantSource,
    startDate: Date?,
    endDate: Date?,
    isAllDay: Bool,
    location: String? = nil,
    attendees: [String] = [],
    evidence: [AssistantEvidenceFact]
  ) {
    self.source = source
    self.startDate = startDate
    self.endDate = endDate
    self.isAllDay = isAllDay
    self.location = location
    self.attendees = attendees
    self.evidence = evidence
  }
}

/// `findCalendarEvents`'s result. Ported shape from the old app's
/// `AssistantCalendarResults`.
public struct AssistantCalendarResults: Codable, Hashable, Sendable {
  public var events: [AssistantCalendarEvent]
  public var truncated: Bool

  public var sources: [AssistantSource] { events.map(\.source) }
  public var evidence: [AssistantEvidenceFact] { events.flatMap(\.evidence) }

  public init(events: [AssistantCalendarEvent], truncated: Bool) {
    self.events = events
    self.truncated = truncated
  }
}

// MARK: - Pages

/// `searchPages`'s result — was `AssistantNoteResults` in the old app;
/// renamed because there is no separate "note" concept in this rebuild
/// ("everything is a page" — see `AssistantSourceKind`'s own doc comment
/// in `AssistantModels.swift`).
public struct AssistantPageResults: Codable, Hashable, Sendable {
  public var sources: [AssistantSource]
  public var evidence: [AssistantEvidenceFact]
  public var truncated: Bool
  public var ambiguousTitles: [String]

  public init(
    sources: [AssistantSource],
    evidence: [AssistantEvidenceFact],
    truncated: Bool,
    ambiguousTitles: [String] = []
  ) {
    self.sources = sources
    self.evidence = evidence
    self.truncated = truncated
    self.ambiguousTitles = ambiguousTitles
  }
}

// MARK: - Tasks

/// `searchTasks`'s result. Ported shape from the old app's
/// `AssistantTaskResults`.
public struct AssistantTaskResults: Codable, Hashable, Sendable {
  public var scope: AssistantTaskScope
  public var sources: [AssistantSource]
  public var evidence: [AssistantEvidenceFact]
  public var truncated: Bool

  public init(
    scope: AssistantTaskScope,
    sources: [AssistantSource],
    evidence: [AssistantEvidenceFact],
    truncated: Bool
  ) {
    self.scope = scope
    self.sources = sources
    self.evidence = evidence
    self.truncated = truncated
  }
}

// MARK: - Meeting brief

/// `meetingBrief`'s result. Adapted shape from the old app's
/// `AssistantMeetingBrief`: that type also carried `occurrenceNote`/
/// `seriesNote` (separate note pages linked to a calendar event via
/// `event_page_map`/`series_page_map` tables). Neither table — nor the
/// occurrence/series page split they implemented — exists in this
/// rebuild's schema: a calendar event materializes as ONE page
/// (`PageKind.calendarMaterializedEvent`, plan §Google gatekeeper), so any
/// user notes about that meeting already live on `event`'s own page body,
/// not a separate note page. `people` now also folds in anyone mentioned
/// via an inline `[[page]]` reference on the event page itself (the
/// `system-relation:mentions` edge `LocalGraphStore.writeProjection`
/// already populates), not just declared attendees — the closest available
/// equivalent to the old app's `page_references`/`page_property_values`
/// "referenced people" query, which has no direct schema counterpart here
/// either.
public struct AssistantMeetingBrief: Codable, Hashable, Sendable {
  public var event: AssistantCalendarEvent
  public var people: [AssistantSource]
  public var evidence: [AssistantEvidenceFact]
  public var peopleTruncated: Bool

  public init(
    event: AssistantCalendarEvent,
    people: [AssistantSource],
    evidence: [AssistantEvidenceFact],
    peopleTruncated: Bool
  ) {
    self.event = event
    self.people = people
    self.evidence = evidence
    self.peopleTruncated = peopleTruncated
  }
}

// MARK: - Email (new — P3 added Gmail, the old app has no equivalent)

/// One Gmail message, trimmed to what an assistant evidence fact needs.
/// Deliberately NOT the full `EmailMessage` GraphQL shape (no `bodyHtml`,
/// full `to`/`cc`, or attachment metadata) — matching the plan's "message
/// bodies stay out of the CRDT graph" posture, the assistant only ever
/// gets a bounded, already-excerpted slice of a message, the same way
/// `searchPages` never returns a page's full body.
public struct AssistantEmailMessage: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var threadPageID: String
  public var from: String?
  public var subject: String?
  public var snippet: String?
  public var receivedAt: Date

  public init(
    id: String,
    threadPageID: String,
    from: String? = nil,
    subject: String? = nil,
    snippet: String? = nil,
    receivedAt: Date
  ) {
    self.id = id
    self.threadPageID = threadPageID
    self.from = from
    self.subject = subject
    self.snippet = snippet
    self.receivedAt = receivedAt
  }
}

/// `searchEmailThreads`'s result. Same shape as every other local tool's
/// result container (`sources`/`evidence`/`truncated`) — see the plan's
/// Assistant (P5) section: "wrapped in the same evidence-fact shape ...
/// as the local tools."
public struct AssistantEmailThreadResults: Codable, Hashable, Sendable {
  public var sources: [AssistantSource]
  public var evidence: [AssistantEvidenceFact]
  public var truncated: Bool
  /// `AssistantEmailMessage.threadPageID` for every message this call
  /// actually returned, deduplicated (multiple messages can share one
  /// thread). The eligibility set the 5 Gmail triage write tools
  /// (`proposeArchiveEmail`/`proposeApplyLabel`/`proposeRemoveLabel`/
  /// `proposeMarkRead`/`proposeMarkUnread`) must check a candidate
  /// `threadPageID` argument against — see
  /// `AssistantRetrievalToolOutput.eligibleEmailThreadIDs`. Unlike
  /// `AssistantSource.id` (which for an email result is `"email:\(message.id)"`,
  /// a Gmail MESSAGE id, not usable for thread-level triage), this is the
  /// separate, correct field for that purpose.
  public var threadPageIDs: Set<String>

  public init(
    sources: [AssistantSource], evidence: [AssistantEvidenceFact], truncated: Bool,
    threadPageIDs: Set<String> = []
  ) {
    self.sources = sources
    self.evidence = evidence
    self.truncated = truncated
    self.threadPageIDs = threadPageIDs
  }
}

/// The one external boundary `searchEmailThreads` needs — implemented
/// concretely by `EnchiridionAPI` (a real `URLSession`-backed GraphQL call
/// against vault's `emailSearch` field) and by tests as an in-memory fake.
/// Declared here (not in `EnchiridionAPI`) so `searchEmailThreads` itself
/// can live in `EnchiridionCore` without a circular dependency — see this
/// file's header.
public protocol AssistantEmailSearchClient: Sendable {
  /// Returns at most `limit` messages matching `query`, most-recent first.
  /// Implementations MUST NOT return more than `limit` results silently
  /// truncated client-side after the fact — `searchEmailThreads` below
  /// treats "more than `limit` came back" as a hard authorization
  /// violation (`AssistantTurnRetrievalAuthorizationError.invalidResultLimit`),
  /// not a truncation to apply quietly, since that would mean a remote
  /// service handed back MORE than this turn approved.
  func searchEmail(query: String, limit: Int) async throws -> [AssistantEmailMessage]
}

/// Errors specific to `searchEmailThreads`'s remote boundary. Distinct
/// from `AssistantDataAccessError` (which is about tool-argument bounds)
/// and `AssistantTurnRetrievalAuthorizationError` (pre-flight authorization
/// violations) — this is a transport/contract failure once a call was
/// already authorized to happen.
public enum AssistantEmailSearchError: Error, LocalizedError, Equatable, Sendable {
  case resultLimitExceeded

  public var errorDescription: String? {
    switch self {
    case .resultLimitExceeded:
      "The email search returned more results than this turn was authorized to read."
    }
  }
}

/// The `searchEmailThreads` tool. Pre-flight-authorization-checked exactly
/// like every local tool (plan's Assistant (P5) section: "a remote call
/// gets no more trust than a local one") — `candidateQuery` is what a
/// model's tool-call claims as its search term; it is rejected outright
/// (never clamped or fuzzy-matched) unless `authorization.query.permits(_:)`
/// says it was pre-approved this turn. The actual network call is made
/// through the injected `client`, never directly, so this function has
/// zero networking code of its own to get wrong.
public func searchEmailThreads(
  authorization: AssistantEmailSearchAuthorization,
  candidateQuery: String,
  client: any AssistantEmailSearchClient
) async throws -> AssistantEmailThreadResults {
  guard authorization.query.permits(candidateQuery) else {
    throw AssistantTurnRetrievalAuthorizationError.invalidQuery
  }
  let messages = try await client.searchEmail(
    query: authorization.query.originalQuery,
    limit: authorization.maximumResults
  )
  guard messages.count <= authorization.maximumResults else {
    throw AssistantEmailSearchError.resultLimitExceeded
  }

  var sources: [AssistantSource] = []
  var evidence: [AssistantEvidenceFact] = []
  for message in messages {
    let sourceID = "email:\(message.id)"
    let title = AssistantReadToolSupport.bounded(
      message.subject?.isEmpty == false ? message.subject! : "(no subject)", maximum: 120)
    let source = AssistantSource(
      id: sourceID,
      kind: .page,
      title: title,
      excerpt: message.snippet.map { AssistantReadToolSupport.bounded($0, maximum: 400) },
      occurredAt: message.receivedAt,
      modifiedAt: message.receivedAt
    )
    sources.append(source)
    var spokenText = "An email titled \(title)"
    if let from = message.from, !from.isEmpty { spokenText += " from \(from)" }
    spokenText += "."
    evidence.append(
      AssistantEvidenceFact(id: "\(sourceID)#title", sourceID: sourceID, kind: .pageTitle, spokenText: spokenText))
    if let snippet = source.excerpt, !snippet.isEmpty {
      evidence.append(
        AssistantEvidenceFact(
          id: "\(sourceID)#excerpt", sourceID: sourceID, kind: .pageExcerpt,
          spokenText: "\(title) says: \(snippet)"))
    }
  }
  return AssistantEmailThreadResults(
    sources: sources, evidence: evidence, truncated: false,
    threadPageIDs: Set(messages.map(\.threadPageID)))
}
