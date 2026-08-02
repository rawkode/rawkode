import Foundation

struct OpenAILocalToolResult {
  let output: String
  let sources: [AssistantSource]
  let facts: [AssistantEvidenceFact]
  let ambiguousTitles: [String]
  let trustedEmptyAnswer: String?
  let eligibleCalendarSourceIDs: Set<String>
}

struct OpenAITurnCollector {
  private(set) var sources: [AssistantSource] = []
  private(set) var facts: [AssistantEvidenceFact] = []
  private(set) var ambiguousTitles: [String] = []
  private(set) var trustedEmptyAnswer: String?
  private(set) var eligibleCalendarSourceIDs: Set<String> = []
  private var sourceIDs: Set<String> = []
  private var factIDs: Set<String> = []

  mutating func record(_ result: OpenAILocalToolResult) {
    for source in result.sources where sourceIDs.insert(source.id).inserted {
      sources.append(source)
    }
    for fact in result.facts where factIDs.insert(fact.id).inserted {
      facts.append(fact)
    }
    for title in result.ambiguousTitles where !ambiguousTitles.contains(title) {
      ambiguousTitles.append(title)
    }
    eligibleCalendarSourceIDs.formUnion(result.eligibleCalendarSourceIDs)
    if result.facts.isEmpty, let empty = result.trustedEmptyAnswer {
      trustedEmptyAnswer = empty
    }
  }
}

struct OpenAILocalToolExecutor {
  let repository: LibraryRepository

  func execute(
    _ call: OpenAILocalToolCall,
    now: Date,
    eligibleCalendarSourceIDs: Set<String>,
    authorization: AssistantTurnRetrievalAuthorization?
  ) async throws -> OpenAILocalToolResult {
    let arguments = try Self.arguments(call.arguments)
    switch call.name {
    case "findCalendarEvents":
      guard let rule = authorization?.calendarSearch else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      try Self.requireKeys(
        arguments,
        exactly: ["query", "start", "end", "limit", "includeOngoing"]
      )
      guard let query = arguments["query"]?.stringValue,
        let startString = arguments["start"]?.stringValue,
        let endString = arguments["end"]?.stringValue,
        let start = Self.date(startString),
        let end = Self.date(endString),
        let limit = arguments["limit"]?.integerValue,
        let includeOngoing = Self.bool(arguments["includeOngoing"])
      else { throw OpenAIResponsesAssistantError.invalidResponse }
      guard rule.query.permits(query),
        start >= rule.start,
        end <= rule.end,
        end > start,
        (1...rule.maximumResults).contains(limit),
        includeOngoing == rule.includeOngoing
      else { throw OpenAIResponsesAssistantError.invalidResponse }
      let result = try await repository.findCalendarEvents(
        matching: query,
        from: start,
        through: end,
        limit: limit,
        includeOngoing: includeOngoing,
        now: now
      )
      let returnedCalendarSourceIDs = Set(
        result.events.map(\.source.id).filter(Self.isCanonicalCalendarSourceID)
      )
      return try Self.toolResult(
        result,
        sources: result.sources,
        facts: result.evidence,
        trustedEmptyAnswer: "I couldn't find a matching calendar event.",
        eligibleCalendarSourceIDs: returnedCalendarSourceIDs
      )
    case "briefCalendarEvent":
      guard let rule = authorization?.calendarBrief else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      try Self.requireKeys(arguments, exactly: ["sourceID", "peopleLimit"])
      guard let sourceID = arguments["sourceID"]?.stringValue,
        Self.isCanonicalCalendarSourceID(sourceID),
        rule.allowedSourceIDs.contains(sourceID),
        eligibleCalendarSourceIDs.contains(sourceID),
        let peopleLimit = arguments["peopleLimit"]?.integerValue,
        (1...rule.maximumPeople).contains(peopleLimit)
      else { throw OpenAIResponsesAssistantError.invalidResponse }
      let result = try await repository.meetingBrief(
        forEventSourceID: sourceID,
        peopleLimit: peopleLimit,
        now: now
      )
      return try Self.toolResult(
        result,
        sources: result.sources,
        facts: result.evidence
      )
    case "searchTasks":
      guard let rule = authorization?.taskSearch else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      try Self.requireKeys(arguments, exactly: ["scope", "query", "limit"])
      guard let rawScope = arguments["scope"]?.stringValue,
        let scope = AssistantTaskScope(rawValue: rawScope),
        let query = arguments["query"]?.stringValue,
        let limit = arguments["limit"]?.integerValue
      else { throw OpenAIResponsesAssistantError.invalidResponse }
      guard scope == rule.scope,
        rule.query.permits(query),
        (1...rule.maximumResults).contains(limit)
      else { throw OpenAIResponsesAssistantError.invalidResponse }
      let result = try await repository.searchTasks(
        scope: scope,
        matching: query,
        limit: limit,
        now: now
      )
      return try Self.toolResult(
        result,
        sources: result.sources,
        facts: result.evidence,
        trustedEmptyAnswer: scope.emptyAnswer
      )
    case "searchNotes":
      guard let rule = authorization?.noteSearch else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      try Self.requireKeys(arguments, exactly: ["query", "limit"])
      guard let query = arguments["query"]?.stringValue,
        let limit = arguments["limit"]?.integerValue
      else { throw OpenAIResponsesAssistantError.invalidResponse }
      guard rule.query.permits(query), (1...rule.maximumResults).contains(limit) else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      let result = try await repository.searchNotes(matching: query, limit: limit)
      return try Self.toolResult(
        result,
        sources: result.sources,
        facts: result.evidence,
        ambiguousTitles: result.ambiguousTitles,
        trustedEmptyAnswer: "I couldn't find a matching note."
      )
    default:
      throw OpenAIResponsesAssistantError.invalidResponse
    }
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

  private static func arguments(_ value: String) throws -> [String: OpenAIJSONValue] {
    guard value.utf8.count <= 16 * 1_024,
      let data = value.data(using: .utf8),
      let object = try JSONDecoder().decode(OpenAIJSONValue.self, from: data).objectValue
    else { throw OpenAIResponsesAssistantError.invalidResponse }
    return object
  }

  private static func requireKeys(
    _ object: [String: OpenAIJSONValue],
    exactly keys: Set<String>
  ) throws {
    guard Set(object.keys) == keys else { throw OpenAIResponsesAssistantError.invalidResponse }
  }

  private static func bool(_ value: OpenAIJSONValue?) -> Bool? {
    guard case .bool(let result) = value else { return nil }
    return result
  }

  private static func date(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }

  private static func toolResult<Value: Encodable>(
    _ value: Value,
    sources: [AssistantSource],
    facts: [AssistantEvidenceFact],
    ambiguousTitles: [String] = [],
    trustedEmptyAnswer: String? = nil,
    eligibleCalendarSourceIDs: Set<String> = []
  ) throws -> OpenAILocalToolResult {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    encoder.dateEncodingStrategy = .iso8601
    let data = try encoder.encode(value)
    guard data.count <= 64 * 1_024 else { throw OpenAIResponsesAssistantError.invalidResponse }
    return OpenAILocalToolResult(
      output: String(decoding: data, as: UTF8.self),
      sources: sources,
      facts: facts,
      ambiguousTitles: ambiguousTitles,
      trustedEmptyAnswer: facts.isEmpty ? trustedEmptyAnswer : nil,
      eligibleCalendarSourceIDs: eligibleCalendarSourceIDs
    )
  }
}
