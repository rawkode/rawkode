import Foundation

public enum AssistantSourceKind: String, Codable, Hashable, Sendable {
  case calendarEvent
  case page
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

  public var id: String { source.id }

  public init(
    source: AssistantSource,
    startDate: Date,
    endDate: Date,
    isAllDay: Bool,
    location: String?,
    attendees: [String],
    isRecurring: Bool
  ) {
    self.source = source
    self.startDate = startDate
    self.endDate = endDate
    self.isAllDay = isAllDay
    self.location = location
    self.attendees = attendees
    self.isRecurring = isRecurring
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
}

public struct AssistantNoteResults: Codable, Hashable, Sendable {
  public var sources: [AssistantSource]
  public var truncated: Bool
  public var ambiguousTitles: [String]

  public init(sources: [AssistantSource], truncated: Bool, ambiguousTitles: [String]) {
    self.sources = sources
    self.truncated = truncated
    self.ambiguousTitles = ambiguousTitles
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

public struct GroundedAssistantResponse: Codable, Hashable, Sendable {
  public var answer: String
  public var status: AssistantResponseStatus
  public var sources: [AssistantSource]

  public init(answer: String, status: AssistantResponseStatus, sources: [AssistantSource] = []) {
    self.answer = answer
    self.status = status
    self.sources = sources
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
      "The on-device assistant requires iOS 26 or later."
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

  public var errorDescription: String? {
    switch self {
    case .emptyQuery: "A search term is required."
    case .queryTooLong: "The search term is too long."
    case .invalidDateRange: "The calendar search range is invalid."
    case .dateRangeTooLarge: "Calendar searches are limited to 31 days."
    }
  }
}

public enum AssistantGroundingError: Error, LocalizedError, Equatable {
  case emptyAnswer
  case noSources
  case unknownSource(String)

  public var errorDescription: String? {
    switch self {
    case .emptyAnswer: "The assistant returned an empty answer."
    case .noSources: "The assistant did not cite local sources."
    case .unknownSource(let sourceID): "The assistant cited an unknown source: \(sourceID)."
    }
  }
}

public enum AssistantGroundingPolicy {
  public static func groundedResponse(
    answer: String,
    citedSourceIDs: [String],
    availableSources: [AssistantSource]
  ) throws -> GroundedAssistantResponse {
    let value = answer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { throw AssistantGroundingError.emptyAnswer }

    let sourceByID = Dictionary(uniqueKeysWithValues: availableSources.map { ($0.id, $0) })
    let uniqueIDs = citedSourceIDs.reduce(into: [String]()) { result, id in
      if !result.contains(id) { result.append(id) }
    }
    guard !uniqueIDs.isEmpty else { throw AssistantGroundingError.noSources }
    for id in uniqueIDs where sourceByID[id] == nil {
      throw AssistantGroundingError.unknownSource(id)
    }
    let sources = uniqueIDs.compactMap { sourceByID[$0] }
    let status: AssistantResponseStatus
    if sources.contains(where: \.hasConflicts) {
      status = .conflicting
    } else if sources.contains(where: \.isStale) {
      status = .stale
    } else if hasAmbiguousTitles(sources) {
      status = .ambiguous
    } else {
      status = .answered
    }
    return GroundedAssistantResponse(answer: value, status: status, sources: sources)
  }

  public static func noResults() -> GroundedAssistantResponse {
    GroundedAssistantResponse(
      answer: "I couldn't find anything in your local calendar or notes that supports an answer.",
      status: .noResults
    )
  }

  public static func unavailable(_ availability: AssistantAvailability) -> GroundedAssistantResponse {
    GroundedAssistantResponse(answer: availability.message, status: .unavailable)
  }

  private static func hasAmbiguousTitles(_ sources: [AssistantSource]) -> Bool {
    let normalized = sources.map { $0.title.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current) }
    return Set(normalized).count < normalized.count
  }
}
