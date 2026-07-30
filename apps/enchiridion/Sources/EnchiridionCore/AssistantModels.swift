import Foundation

public enum AssistantSourceKind: String, Codable, Hashable, Sendable {
  case calendarEvent
  case page
}

public enum AssistantEvidenceKind: String, Codable, Hashable, Sendable {
  case eventSchedule
  case eventLocation
  case eventAttendees
  case pageExcerpt
  case pageTitle
  case taskSummary
}

/// A factual sentence rendered by trusted local code. The model may select facts,
/// but it never authors the factual prose returned to the user.
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

/// A compact, local-only citation that can safely accompany a spoken answer.
/// `excerpt` is deliberately bounded before it leaves the repository.
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

public struct AssistantCalendarEvent: Identifiable, Codable, Hashable, Sendable {
  public var source: AssistantSource
  public var startDate: Date
  public var endDate: Date
  public var isAllDay: Bool
  public var location: String?
  public var attendees: [String]
  public var isRecurring: Bool
  public var evidence: [AssistantEvidenceFact]

  public var id: String { source.id }

  public init(
    source: AssistantSource,
    startDate: Date,
    endDate: Date,
    isAllDay: Bool,
    location: String?,
    attendees: [String],
    isRecurring: Bool,
    evidence: [AssistantEvidenceFact]
  ) {
    self.source = source
    self.startDate = startDate
    self.endDate = endDate
    self.isAllDay = isAllDay
    self.location = location
    self.attendees = attendees
    self.isRecurring = isRecurring
    self.evidence = evidence
  }
}

public struct AssistantCalendarResults: Codable, Hashable, Sendable {
  public var events: [AssistantCalendarEvent]
  public var truncated: Bool
  public var containsStaleProjection: Bool

  public init(
    events: [AssistantCalendarEvent],
    truncated: Bool,
    containsStaleProjection: Bool
  ) {
    self.events = events
    self.truncated = truncated
    self.containsStaleProjection = containsStaleProjection
  }

  public var sources: [AssistantSource] { events.map(\.source) }
  public var evidence: [AssistantEvidenceFact] { events.flatMap(\.evidence) }
}

public struct AssistantNoteResults: Codable, Hashable, Sendable {
  public var sources: [AssistantSource]
  public var truncated: Bool
  public var ambiguousTitles: [String]
  public var evidence: [AssistantEvidenceFact]

  public init(
    sources: [AssistantSource],
    truncated: Bool,
    ambiguousTitles: [String],
    evidence: [AssistantEvidenceFact]
  ) {
    self.sources = sources
    self.truncated = truncated
    self.ambiguousTitles = ambiguousTitles
    self.evidence = evidence
  }
}

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

public struct AssistantMeetingBrief: Codable, Hashable, Sendable {
  public var event: AssistantCalendarEvent
  public var occurrenceNote: AssistantSource?
  public var seriesNote: AssistantSource?
  public var people: [AssistantSource]
  public var evidence: [AssistantEvidenceFact]
  public var peopleTruncated: Bool

  public init(
    event: AssistantCalendarEvent,
    occurrenceNote: AssistantSource?,
    seriesNote: AssistantSource?,
    people: [AssistantSource],
    evidence: [AssistantEvidenceFact],
    peopleTruncated: Bool
  ) {
    self.event = event
    self.occurrenceNote = occurrenceNote
    self.seriesNote = seriesNote
    self.people = people
    self.evidence = evidence
    self.peopleTruncated = peopleTruncated
  }

  public var sources: [AssistantSource] {
    var values = [event.source]
    if let occurrenceNote { values.append(occurrenceNote) }
    if let seriesNote { values.append(seriesNote) }
    values.append(contentsOf: people)
    return values
  }
}

public enum AssistantResponseStatus: String, Codable, Hashable, Sendable {
  case answered
  case noResults
  case ambiguous
  case stale
  case conflicting
  case unavailable
  case ungrounded
}

public enum AssistantRequestModality: String, Equatable, Sendable {
  case text
  case voice
}

public enum AssistantRouteProvider: String, Codable, Hashable, Sendable {
  case appleOnDevice
  case openAI
}

/// An immutable route selected for one assistant attempt. Retries carry this
/// value forward so a settings change cannot silently alter the provider or
/// model attached to the original user action.
public struct AssistantConversationRoute: Equatable, Hashable, Sendable {
  public var provider: AssistantRouteProvider
  public var modelID: String?

  public init(provider: AssistantRouteProvider, modelID: String? = nil) {
    self.provider = provider
    self.modelID = modelID
  }

  public static let appleOnDevice = AssistantConversationRoute(provider: .appleOnDevice)
}

public struct AssistantTokenUsage: Codable, Hashable, Sendable {
  public var input: Int
  public var cachedInput: Int
  public var cacheWrite: Int
  public var output: Int
  public var reasoning: Int
  public var total: Int

  public init(
    input: Int = 0,
    cachedInput: Int = 0,
    cacheWrite: Int = 0,
    output: Int = 0,
    reasoning: Int = 0,
    total: Int = 0
  ) {
    self.input = max(0, input)
    self.cachedInput = max(0, cachedInput)
    self.cacheWrite = max(0, cacheWrite)
    self.output = max(0, output)
    self.reasoning = max(0, reasoning)
    self.total = max(0, total)
  }
}

public enum AssistantRecoveryAction: String, Codable, Hashable, Sendable {
  case retry
  case openSettings
}

public enum AssistantResponseCompletion: String, Codable, Hashable, Sendable {
  case completed
  case failed
  case incomplete
}

/// Ephemeral presentation metadata for one completed assistant turn. It is
/// deliberately attached to in-memory conversation values, never persisted.
public struct AssistantResponseMetadata: Codable, Hashable, Sendable {
  public var requestedProvider: AssistantRouteProvider
  public var requestedModelID: String?
  public var actualModelID: String?
  public var routeLabel: String
  public var usage: AssistantTokenUsage?
  public var requestIDs: [String]
  public var completion: AssistantResponseCompletion
  public var priorOpenAITurnCount: Int
  public var localContextCount: Int
  public var recoveryAction: AssistantRecoveryAction?

  public init(
    requestedProvider: AssistantRouteProvider,
    requestedModelID: String? = nil,
    actualModelID: String? = nil,
    routeLabel: String,
    usage: AssistantTokenUsage? = nil,
    requestID: String? = nil,
    requestIDs: [String] = [],
    completion: AssistantResponseCompletion = .completed,
    priorOpenAITurnCount: Int = 0,
    localContextCount: Int = 0,
    recoveryAction: AssistantRecoveryAction? = nil
  ) {
    self.requestedProvider = requestedProvider
    self.requestedModelID = requestedModelID
    self.actualModelID = actualModelID
    self.routeLabel = routeLabel
    self.usage = usage
    self.requestIDs = (requestIDs + [requestID].compactMap { $0 }).reduce(into: []) {
      if !$0.contains($1) { $0.append($1) }
    }
    self.completion = completion
    self.priorOpenAITurnCount = max(0, priorOpenAITurnCount)
    self.localContextCount = max(0, localContextCount)
    self.recoveryAction = recoveryAction
  }

  public var requestID: String? { requestIDs.last }

  public var routeContextIdentity: AssistantConversationRoute {
    AssistantConversationRoute(provider: requestedProvider, modelID: requestedModelID)
  }
}

public struct GroundedAssistantResponse: Codable, Hashable, Sendable {
  public var answer: String
  public var status: AssistantResponseStatus
  public var sources: [AssistantSource]
  public var metadata: AssistantResponseMetadata?

  public init(
    answer: String,
    status: AssistantResponseStatus,
    sources: [AssistantSource] = [],
    metadata: AssistantResponseMetadata? = nil
  ) {
    self.answer = answer
    self.status = status
    self.sources = sources
    self.metadata = metadata
  }
}

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

public enum AssistantDataAccessError: Error, LocalizedError, Equatable {
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

public enum AssistantGroundingError: Error, LocalizedError, Equatable {
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

public enum AssistantGroundingPolicy {
  public static let maximumSelectedFacts = 5
  public static let maximumSpokenWords = 70
  public static let maximumSpokenCharacters = 600

  public static func groundedResponse(
    selectedFactIDs: [String],
    availableFacts: [AssistantEvidenceFact],
    availableSources: [AssistantSource],
    ambiguousTitles: [String] = []
  ) throws -> GroundedAssistantResponse {
    let sourceByID = Dictionary(uniqueKeysWithValues: availableSources.map { ($0.id, $0) })
    let factByID = Dictionary(uniqueKeysWithValues: availableFacts.map { ($0.id, $0) })
    let uniqueFactIDs = selectedFactIDs.reduce(into: [String]()) { result, id in
      if !result.contains(id) { result.append(id) }
    }
    guard !uniqueFactIDs.isEmpty else { throw AssistantGroundingError.noSources }
    guard uniqueFactIDs.count <= maximumSelectedFacts else {
      throw AssistantGroundingError.tooManyFacts
    }
    for id in uniqueFactIDs where factByID[id] == nil {
      throw AssistantGroundingError.unknownFact(id)
    }
    let facts = uniqueFactIDs.compactMap { factByID[$0] }
    let sourceIDs = facts.reduce(into: [String]()) { result, fact in
      if !result.contains(fact.sourceID) { result.append(fact.sourceID) }
    }
    for id in sourceIDs where sourceByID[id] == nil {
      throw AssistantGroundingError.unknownSource(id)
    }
    let sources = sourceIDs.compactMap { sourceByID[$0] }
    let answer = boundedSpeech(facts.map(\.spokenText).joined(separator: " "))
    guard !answer.isEmpty else { throw AssistantGroundingError.emptyAnswer }
    let status: AssistantResponseStatus
    if sources.contains(where: \.hasConflicts) {
      status = .conflicting
    } else if sources.contains(where: \.isStale) {
      status = .stale
    } else if !ambiguousTitles.isEmpty
      || (facts.contains { $0.kind != .taskSummary } && hasAmbiguousTitles(sources))
    {
      status = .ambiguous
    } else {
      status = .answered
    }
    return GroundedAssistantResponse(answer: answer, status: status, sources: sources)
  }

  /// Renders trusted repository facts in their supplied order when model-selected
  /// identifiers are unusable. This never incorporates model-authored factual prose.
  public static func groundedResponseUsingTrustedFacts(
    availableFacts: [AssistantEvidenceFact],
    availableSources: [AssistantSource],
    ambiguousTitles: [String] = []
  ) throws -> GroundedAssistantResponse {
    try groundedResponse(
      selectedFactIDs: availableFacts.prefix(maximumSelectedFacts).map(\.id),
      availableFacts: availableFacts,
      availableSources: availableSources,
      ambiguousTitles: ambiguousTitles
    )
  }

  public static func noResults() -> GroundedAssistantResponse {
    GroundedAssistantResponse(
      answer: "I couldn't find a relevant result in your local Enchiridion data.",
      status: .noResults
    )
  }

  public static func unavailable(_ availability: AssistantAvailability) -> GroundedAssistantResponse
  {
    GroundedAssistantResponse(answer: availability.message, status: .unavailable)
  }

  private static func hasAmbiguousTitles(_ sources: [AssistantSource]) -> Bool {
    let normalized = sources.map {
      $0.title.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
    return Set(normalized).count < normalized.count
  }

  private static func boundedSpeech(_ value: String) -> String {
    let words = value.split(whereSeparator: { $0.isWhitespace })
    var result = words.prefix(maximumSpokenWords).joined(separator: " ")
    if result.count > maximumSpokenCharacters {
      result = String(result.prefix(maximumSpokenCharacters - 1))
    }
    if words.count > maximumSpokenWords || result.count < value.count {
      result += "…"
    }
    return result
  }
}
