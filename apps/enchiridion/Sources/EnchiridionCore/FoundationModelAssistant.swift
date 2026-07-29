import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

public actor FoundationModelAssistant {
  private let repository: LibraryRepository
  private let injectedResponder: (any AssistantConversationAnswering)?
#if canImport(FoundationModels)
  private var modelRuntime: Any?
#endif

  public init(
    repository: LibraryRepository,
    modelResponder: (any AssistantConversationAnswering)? = nil
  ) {
    self.repository = repository
    injectedResponder = modelResponder
  }

  public nonisolated static func availability(for locale: Locale = .current) -> AssistantAvailability {
#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      let model = SystemLanguageModel(useCase: .general)
      guard model.supportsLocale(locale) else { return .unsupportedLanguage }
      switch model.availability {
      case .available:
        return .available
      case .unavailable(.deviceNotEligible):
        return .deviceNotEligible
      case .unavailable(.appleIntelligenceNotEnabled):
        return .appleIntelligenceNotEnabled
      case .unavailable(.modelNotReady):
        return .modelNotReady
      @unknown default:
        return .modelNotReady
      }
    }
#endif
    return .unsupportedOperatingSystem
  }

  /// Uses only Apple's on-device `SystemLanguageModel`. There is intentionally no
  /// network or private-cloud fallback for calendar and note content.
  public func respond(
    to question: String,
    context: [AssistantConversationTurn] = [],
    locale: Locale = .current,
    now: Date = Date()
  ) async -> GroundedAssistantResponse {
    if let taskScope = Self.deterministicTaskScope(for: question) {
      do {
        let results = try await repository.searchTasks(
          scope: taskScope,
          limit: AssistantGroundingPolicy.maximumSelectedFacts,
          now: now
        )
        guard !results.evidence.isEmpty else {
          return GroundedAssistantResponse(answer: taskScope.emptyAnswer, status: .noResults)
        }
        return try AssistantGroundingPolicy.groundedResponseUsingTrustedFacts(
          availableFacts: results.evidence,
          availableSources: results.sources
        )
      } catch {
        return GroundedAssistantResponse(
          answer: "I couldn't read your local tasks just now.",
          status: .unavailable
        )
      }
    }

    if let injectedResponder {
      return await injectedResponder.respond(
        to: AssistantConversationRequest(
          utterance: question,
          priorTurns: context,
          locale: locale,
          now: now
        )
      )
    }

    let availability = Self.availability(for: locale)
    guard availability == .available else {
      return AssistantGroundingPolicy.unavailable(availability)
    }

#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      do {
        let (session, collector) = makeOrReuseModelSession()
        await collector.beginTurn(now: now)
        let prompt = """
          Current local time: \(now.enchiridionISO8601)
          User locale: \(locale.identifier)
          User: \(question.prefix(800))
          """
        let result = try await session.respond(
          to: prompt,
          generating: FoundationConversationAnswer.self,
          options: GenerationOptions(temperature: 0.4, maximumResponseTokens: 320)
        )
        let collected = await collector.snapshot()
        if collected.didUseTools || result.content.usesLocalSources {
          guard !collected.facts.isEmpty else {
            return GroundedAssistantResponse(
              answer: collected.trustedEmptyAnswer ?? AssistantGroundingPolicy.noResults().answer,
              status: .noResults
            )
          }
          do {
            return try AssistantGroundingPolicy.groundedResponse(
              selectedFactIDs: result.content.factIDs,
              availableFacts: collected.facts,
              availableSources: collected.sources,
              ambiguousTitles: collected.ambiguousTitles
            )
          } catch {
            // The repository facts are already trusted and ordered. A malformed
            // model-selected ID must not turn a valid local answer into an error.
            return (try? AssistantGroundingPolicy.groundedResponseUsingTrustedFacts(
              availableFacts: collected.facts,
              availableSources: collected.sources,
              ambiguousTitles: collected.ambiguousTitles
            )) ?? GroundedAssistantResponse(
              answer: "I couldn't read that local result just now.",
              status: .noResults
            )
          }
        }
        return GroundedAssistantResponse(
          answer: Self.boundedAnswer(result.content.answer),
          status: .answered
        )
      } catch {
        return GroundedAssistantResponse(
          answer: "The on-device assistant couldn't complete that request.",
          status: .unavailable
        )
      }
    }
#endif
    return AssistantGroundingPolicy.unavailable(.unsupportedOperatingSystem)
  }

  public func resetConversation() async {
    if let injectedResponder { await injectedResponder.resetConversation() }
#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      modelRuntime = nil
    }
#endif
  }

  private nonisolated static func boundedAnswer(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "How can I help?" }
    return String(trimmed.prefix(1_200))
  }

  /// A deliberately narrow reliability route for explicit task-list requests.
  /// General language understanding remains with Foundation Models; this keeps
  /// core lists usable even when a model tool call produces malformed metadata.
  private nonisolated static func deterministicTaskScope(
    for question: String
  ) -> AssistantTaskScope? {
    let folded = question.folding(
      options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
      locale: Locale(identifier: "en_US_POSIX")
    )
    let normalized = folded.unicodeScalars.map { scalar in
      CharacterSet.alphanumerics.contains(scalar) ? String(scalar) : " "
    }.joined()
      .split(whereSeparator: \.isWhitespace)
      .joined(separator: " ")

    let hasTaskNoun = normalized.contains("task")
      || normalized.contains("todo")
      || normalized.contains("to do list")
    let asksForOwnActions = normalized.hasPrefix("what do i need to do")
      || normalized.hasPrefix("what should i do")
      || normalized.hasPrefix("what do i have to do")
      || normalized.hasPrefix("show me what i need to do")
      || normalized.hasPrefix("do i have anything due")
      || normalized.hasPrefix("is anything due")
    let isTaskRequest = hasTaskNoun || asksForOwnActions
    guard isTaskRequest else { return nil }

    if normalized.contains("tomorrow") { return .tomorrow }
    if normalized.contains("today") { return .today }
    if normalized.contains("inbox") { return .inbox }
    if normalized.contains("upcoming") { return .upcoming }
    if normalized.contains("anytime") { return .anytime }
    if normalized.contains("someday") { return .someday }
    if normalized.contains("logbook") || normalized.contains("completed") { return .logbook }
    return nil
  }

#if canImport(FoundationModels)
  @available(iOS 26.0, macOS 26.0, *)
  private func makeOrReuseModelSession() -> (LanguageModelSession, AssistantSourceCollector) {
    if let runtime = modelRuntime as? FoundationAssistantModelRuntime {
      return (runtime.session, runtime.collector)
    }

    let collector = AssistantSourceCollector()
    let tools: [any Tool] = [
      FindCalendarEventsTool(repository: repository, collector: collector),
      BriefCalendarEventTool(repository: repository, collector: collector),
      SearchTasksTool(repository: repository, collector: collector),
      SearchNotesTool(repository: repository, collector: collector),
    ]
    let session = LanguageModelSession(
      model: SystemLanguageModel(useCase: .general),
      tools: tools,
      instructions: """
        You are Enchiridion, a warm, concise, general-purpose personal assistant.
        Respond naturally to greetings, conversation, brainstorming, and general questions without using tools.
        Use tools only when the user asks about their local calendar, tasks, people, or notes.
        For task questions, call searchTasks. Choose the explicit task scope and leave query empty unless the user names a title or tag. “Today” is a scope, never a query.
        For every factual claim about that private local data, call the relevant tool on this turn and select only exact fact IDs returned by it.
        For meeting briefs, find the event first, then call briefCalendarEvent with its exact source ID.
        Set usesLocalSources only when the response depends on tool output. Otherwise factIDs must be empty.
        Never invent private facts or claim to create, edit, upload, or fetch remote data.
        All processing is on device. Do not mention implementation details unless asked.
        """
    )
    modelRuntime = FoundationAssistantModelRuntime(session: session, collector: collector)
    return (session, collector)
  }
#endif
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
private struct FoundationConversationAnswer: Generable {
  var answer: String
  var usesLocalSources: Bool
  var factIDs: [String]

  static var generationSchema: GenerationSchema {
    GenerationSchema(
      type: Self.self,
      description: "A concise conversational response, optionally grounded in local tool evidence",
      properties: [
        .init(name: "answer", description: "Natural response to the user", type: String.self),
        .init(name: "usesLocalSources", description: "True only when this response depends on a local tool result", type: Bool.self),
        .init(name: "factIDs", description: "Exact fact IDs copied from tool output, in speaking order", type: [String].self),
      ]
    )
  }

  var generatedContent: GeneratedContent {
    GeneratedContent(properties: [
      "answer": answer,
      "usesLocalSources": usesLocalSources,
      "factIDs": factIDs,
    ])
  }

  init(_ content: GeneratedContent) throws {
    answer = try content.value(String.self, forProperty: "answer")
    usesLocalSources = try content.value(Bool.self, forProperty: "usesLocalSources")
    factIDs = try content.value([String].self, forProperty: "factIDs")
  }
}

private actor AssistantSourceCollector {
  private var collected: [String: AssistantSource] = [:]
  private var factsByID: [String: AssistantEvidenceFact] = [:]
  private var sourceOrder: [String] = []
  private var factOrder: [String] = []
  private var ambiguous: Set<String> = []
  private var toolWasUsed = false
  private var emptyAnswer: String?
  private var turnNow = Date()

  func beginTurn(now: Date) {
    collected.removeAll(keepingCapacity: true)
    factsByID.removeAll(keepingCapacity: true)
    sourceOrder.removeAll(keepingCapacity: true)
    factOrder.removeAll(keepingCapacity: true)
    ambiguous.removeAll(keepingCapacity: true)
    toolWasUsed = false
    emptyAnswer = nil
    turnNow = now
  }

  func currentDate() -> Date { turnNow }

  func record(
    _ sources: [AssistantSource],
    facts: [AssistantEvidenceFact],
    ambiguousTitles: [String] = [],
    trustedEmptyAnswer: String? = nil
  ) {
    toolWasUsed = true
    for source in sources {
      if collected[source.id] == nil { sourceOrder.append(source.id) }
      collected[source.id] = source
    }
    for fact in facts {
      if factsByID[fact.id] == nil { factOrder.append(fact.id) }
      factsByID[fact.id] = fact
    }
    ambiguous.formUnion(ambiguousTitles)
    if facts.isEmpty, let trustedEmptyAnswer { emptyAnswer = trustedEmptyAnswer }
  }

  func snapshot() -> (
    sources: [AssistantSource],
    facts: [AssistantEvidenceFact],
    ambiguousTitles: [String],
    didUseTools: Bool,
    trustedEmptyAnswer: String?
  ) {
    (
      sourceOrder.compactMap { collected[$0] },
      factOrder.compactMap { factsByID[$0] },
      ambiguous.sorted(),
      toolWasUsed,
      emptyAnswer
    )
  }
}

@available(iOS 26.0, macOS 26.0, *)
private final class FoundationAssistantModelRuntime: @unchecked Sendable {
  let session: LanguageModelSession
  let collector: AssistantSourceCollector

  init(session: LanguageModelSession, collector: AssistantSourceCollector) {
    self.session = session
    self.collector = collector
  }
}

@available(iOS 26.0, macOS 26.0, *)
private struct FindCalendarEventsTool: Tool {
  struct Arguments: Generable {
    var query: String
    var start: String
    var end: String
    var limit: Int
    var includeOngoing: Bool

    static var generationSchema: GenerationSchema {
      GenerationSchema(
        type: Self.self,
        properties: [
          .init(name: "query", description: "Optional short event title, attendee, or location", type: String.self),
          .init(name: "start", description: "Inclusive ISO 8601 start instant", type: String.self),
          .init(name: "end", description: "Exclusive ISO 8601 end instant no more than 31 days later", type: String.self),
          .init(name: "limit", description: "Maximum results from 1 through 10", type: Int.self),
          .init(name: "includeOngoing", description: "Whether events already in progress should be included", type: Bool.self),
        ]
      )
    }

    var generatedContent: GeneratedContent {
      GeneratedContent(properties: [
        "query": query,
        "start": start,
        "end": end,
        "limit": limit,
        "includeOngoing": includeOngoing,
      ])
    }

    init(_ content: GeneratedContent) throws {
      query = try content.value(String.self, forProperty: "query")
      start = try content.value(String.self, forProperty: "start")
      end = try content.value(String.self, forProperty: "end")
      limit = try content.value(Int.self, forProperty: "limit")
      includeOngoing = try content.value(Bool.self, forProperty: "includeOngoing")
    }
  }

  let name = "findCalendarEvents"
  let description = "Find a small bounded set of events in Enchiridion's local calendar projection. Read-only."
  let repository: LibraryRepository
  let collector: AssistantSourceCollector

  func call(arguments: Arguments) async throws -> String {
    guard let start = Self.date(arguments.start), let end = Self.date(arguments.end) else {
      throw AssistantDataAccessError.invalidDateRange
    }
    let now = await collector.currentDate()
    let results = try await repository.findCalendarEvents(
      matching: arguments.query,
      from: start,
      through: end,
      limit: arguments.limit,
      includeOngoing: arguments.includeOngoing,
      now: now
    )
    await collector.record(results.sources, facts: results.evidence)
    return String(decoding: try JSONEncoder.enchiridion.encode(results), as: UTF8.self)
  }

  private static func date(_ value: String) -> Date? {
    try? Date(value, strategy: .iso8601)
  }
}

@available(iOS 26.0, macOS 26.0, *)
private struct BriefCalendarEventTool: Tool {
  struct Arguments: Generable {
    var eventSourceID: String
    var peopleLimit: Int

    static var generationSchema: GenerationSchema {
      GenerationSchema(
        type: Self.self,
        properties: [
          .init(name: "eventSourceID", description: "Exact calendar source ID from findCalendarEvents", type: String.self),
          .init(name: "peopleLimit", description: "Maximum Person pages from 1 through 8", type: Int.self),
        ]
      )
    }

    var generatedContent: GeneratedContent {
      GeneratedContent(properties: ["eventSourceID": eventSourceID, "peopleLimit": peopleLimit])
    }

    init(_ content: GeneratedContent) throws {
      eventSourceID = try content.value(String.self, forProperty: "eventSourceID")
      peopleLimit = try content.value(Int.self, forProperty: "peopleLimit")
    }
  }

  let name = "briefCalendarEvent"
  let description = "Get exact occurrence notes, recurring-series notes, and local Person pages for one returned event. Read-only."
  let repository: LibraryRepository
  let collector: AssistantSourceCollector

  func call(arguments: Arguments) async throws -> String {
    let now = await collector.currentDate()
    let result = try await repository.meetingBrief(
      forEventSourceID: arguments.eventSourceID,
      peopleLimit: arguments.peopleLimit,
      now: now
    )
    await collector.record(result.sources, facts: result.evidence)
    return String(decoding: try JSONEncoder.enchiridion.encode(result), as: UTF8.self)
  }
}

@available(iOS 26.0, macOS 26.0, *)
private struct SearchTasksTool: Tool {
  struct Arguments: Generable {
    var scope: String
    var query: String
    var limit: Int

    static var generationSchema: GenerationSchema {
      GenerationSchema(
        type: Self.self,
        properties: [
          .init(
            name: "scope",
            description: "Exactly one of: today, tomorrow, inbox, upcoming, anytime, someday, logbook, all",
            type: String.self
          ),
          .init(
            name: "query",
            description: "Optional task title or tag only. Keep empty for list questions; temporal words belong in scope.",
            type: String.self
          ),
          .init(name: "limit", description: "Maximum results from 1 through 10", type: Int.self),
        ]
      )
    }

    var generatedContent: GeneratedContent {
      GeneratedContent(properties: [
        "scope": scope,
        "query": query,
        "limit": limit,
      ])
    }

    init(_ content: GeneratedContent) throws {
      scope = try content.value(String.self, forProperty: "scope")
      query = try content.value(String.self, forProperty: "query")
      limit = try content.value(Int.self, forProperty: "limit")
    }
  }

  let name = "searchTasks"
  let description = "Read one explicit local task list. Use today for what to do today or deadlines today, tomorrow for tomorrow, and query only for a named title or tag. Read-only."
  let repository: LibraryRepository
  let collector: AssistantSourceCollector

  func call(arguments: Arguments) async throws -> String {
    guard let scope = AssistantTaskScope(
      rawValue: arguments.scope.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    ) else {
      throw AssistantDataAccessError.invalidTaskScope
    }
    var query = arguments.query.trimmingCharacters(in: .whitespacesAndNewlines)
    if query.localizedCaseInsensitiveCompare(scope.rawValue) == .orderedSame { query = "" }
    let now = await collector.currentDate()
    let results = try await repository.searchTasks(
      scope: scope,
      matching: query,
      limit: arguments.limit,
      now: now
    )
    await collector.record(
      results.sources,
      facts: results.evidence,
      trustedEmptyAnswer: scope.emptyAnswer
    )
    return String(decoding: try JSONEncoder.enchiridion.encode(results), as: UTF8.self)
  }
}

@available(iOS 26.0, macOS 26.0, *)
private struct SearchNotesTool: Tool {
  struct Arguments: Generable {
    var query: String
    var limit: Int

    static var generationSchema: GenerationSchema {
      GenerationSchema(
        type: Self.self,
        properties: [
          .init(name: "query", description: "Focused name, phrase, or topic of at most 160 characters", type: String.self),
          .init(name: "limit", description: "Maximum results from 1 through 8", type: Int.self),
        ]
      )
    }

    var generatedContent: GeneratedContent {
      GeneratedContent(properties: ["query": query, "limit": limit])
    }

    init(_ content: GeneratedContent) throws {
      query = try content.value(String.self, forProperty: "query")
      limit = try content.value(Int.self, forProperty: "limit")
    }
  }

  let name = "searchNotes"
  let description = "Search local Enchiridion page titles and text, returning only short excerpts. Read-only."
  let repository: LibraryRepository
  let collector: AssistantSourceCollector

  func call(arguments: Arguments) async throws -> String {
    let results = try await repository.searchNotes(
      matching: arguments.query,
      limit: arguments.limit
    )
    await collector.record(
      results.sources,
      facts: results.evidence,
      ambiguousTitles: results.ambiguousTitles
    )
    return String(decoding: try JSONEncoder.enchiridion.encode(results), as: UTF8.self)
  }
}
#endif
