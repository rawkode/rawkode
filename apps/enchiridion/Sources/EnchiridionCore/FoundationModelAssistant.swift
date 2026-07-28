import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

public actor FoundationModelAssistant {
  private let repository: LibraryRepository

  public init(repository: LibraryRepository) {
    self.repository = repository
  }

  public nonisolated static func availability(for locale: Locale = .current) -> AssistantAvailability {
#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      let model = SystemLanguageModel.default
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
    locale: Locale = .current,
    now: Date = Date()
  ) async -> GroundedAssistantResponse {
    let availability = Self.availability(for: locale)
    guard availability == .available else {
      return AssistantGroundingPolicy.unavailable(availability)
    }

#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      do {
        let collector = AssistantSourceCollector()
        let tools: [any Tool] = [
          FindCalendarEventsTool(repository: repository, collector: collector, now: now),
          SearchNotesTool(repository: repository, collector: collector),
        ]
        let session = LanguageModelSession(
          model: SystemLanguageModel.default,
          tools: tools,
          instructions: """
            You are Enchiridion's read-only driving assistant. Use a tool before making any factual claim.
            Calendar and note data exists only behind the tools; never infer missing details.
            Keep the spoken answer under 70 words. Treat stale data, duplicate names, and conflicts explicitly.
            Return only source IDs that appeared in tool output. Never claim to create, edit, or upload data.
            """
        )
        let prompt = """
          Current local time: \(now.enchiridionISO8601)
          User locale: \(locale.identifier)
          Question: \(question.prefix(500))
          """
        let result = try await session.respond(
          to: prompt,
          generating: FoundationGroundedAnswer.self,
          options: GenerationOptions(temperature: 0, maximumResponseTokens: 220)
        )
        let sources = await collector.sources()
        guard !sources.isEmpty else { return AssistantGroundingPolicy.noResults() }
        do {
          return try AssistantGroundingPolicy.groundedResponse(
            answer: result.content.answer,
            citedSourceIDs: result.content.sourceIDs,
            availableSources: sources
          )
        } catch {
          return GroundedAssistantResponse(
            answer: "I couldn't verify that answer against your local sources.",
            status: .ungrounded
          )
        }
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
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
private struct FoundationGroundedAnswer: Generable {
  var answer: String
  var sourceIDs: [String]

  static var generationSchema: GenerationSchema {
    GenerationSchema(
      type: Self.self,
      description: "A concise spoken answer and exact supporting local source IDs",
      properties: [
        .init(name: "answer", description: "Spoken answer supported only by cited sources", type: String.self),
        .init(name: "sourceIDs", description: "Exact source IDs copied from tool output", type: [String].self),
      ]
    )
  }

  var generatedContent: GeneratedContent {
    GeneratedContent(properties: ["answer": answer, "sourceIDs": sourceIDs])
  }

  init(_ content: GeneratedContent) throws {
    answer = try content.value(String.self, forProperty: "answer")
    sourceIDs = try content.value([String].self, forProperty: "sourceIDs")
  }
}

private actor AssistantSourceCollector {
  private var collected: [String: AssistantSource] = [:]

  func record(_ sources: [AssistantSource]) {
    for source in sources { collected[source.id] = source }
  }

  func sources() -> [AssistantSource] {
    collected.values.sorted { $0.id < $1.id }
  }
}

@available(iOS 26.0, macOS 26.0, *)
private struct FindCalendarEventsTool: Tool {
  struct Arguments: Generable {
    var query: String
    var start: String
    var end: String
    var limit: Int

    static var generationSchema: GenerationSchema {
      GenerationSchema(
        type: Self.self,
        properties: [
          .init(name: "query", description: "Optional short event title, attendee, or location", type: String.self),
          .init(name: "start", description: "Inclusive ISO 8601 start instant", type: String.self),
          .init(name: "end", description: "Exclusive ISO 8601 end instant no more than 31 days later", type: String.self),
          .init(name: "limit", description: "Maximum results from 1 through 10", type: Int.self),
        ]
      )
    }

    var generatedContent: GeneratedContent {
      GeneratedContent(properties: ["query": query, "start": start, "end": end, "limit": limit])
    }

    init(_ content: GeneratedContent) throws {
      query = try content.value(String.self, forProperty: "query")
      start = try content.value(String.self, forProperty: "start")
      end = try content.value(String.self, forProperty: "end")
      limit = try content.value(Int.self, forProperty: "limit")
    }
  }

  let name = "findCalendarEvents"
  let description = "Find a small bounded set of events in Enchiridion's local calendar projection. Read-only."
  let repository: LibraryRepository
  let collector: AssistantSourceCollector
  let now: Date

  func call(arguments: Arguments) async throws -> String {
    guard let start = Self.date(arguments.start), let end = Self.date(arguments.end) else {
      throw AssistantDataAccessError.invalidDateRange
    }
    let results = try await repository.findCalendarEvents(
      matching: arguments.query,
      from: start,
      through: end,
      limit: arguments.limit,
      now: now
    )
    await collector.record(results.sources)
    return String(decoding: try JSONEncoder.enchiridion.encode(results), as: UTF8.self)
  }

  private static func date(_ value: String) -> Date? {
    try? Date(value, strategy: .iso8601)
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
    await collector.record(results.sources)
    return String(decoding: try JSONEncoder.enchiridion.encode(results), as: UTF8.self)
  }
}
#endif
