import Foundation
import Observation

/// A single, in-memory exchange with the assistant. This type is deliberately not
/// `Codable`: conversation history is short-lived context, not library data.
public struct AssistantConversationTurn: Equatable, Sendable {
  public var utterance: String
  public var answer: String
  public var status: AssistantResponseStatus

  public init(utterance: String, answer: String, status: AssistantResponseStatus) {
    self.utterance = utterance
    self.answer = answer
    self.status = status
  }
}

public struct AssistantConversationRequest: Equatable, Sendable {
  public var utterance: String
  public var priorTurns: [AssistantConversationTurn]
  public var locale: Locale
  public var now: Date

  public init(
    utterance: String,
    priorTurns: [AssistantConversationTurn],
    locale: Locale,
    now: Date
  ) {
    self.utterance = utterance
    self.priorTurns = priorTurns
    self.locale = locale
    self.now = now
  }
}

public protocol AssistantConversationTranscribing: Sendable {
  func transcribe() async throws -> String
}

public protocol AssistantConversationAnswering: Sendable {
  func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse
}

public protocol AssistantConversationSpeaking: Sendable {
  func speak(_ text: String) async throws
  func stop() async
}

public enum AssistantConversationFailureKind: String, Equatable, Sendable {
  case transcription
  case speaking
  case unavailable
  case ungrounded
}

public struct AssistantConversationFailure: Equatable, Sendable {
  public var kind: AssistantConversationFailureKind
  public var message: String

  public init(kind: AssistantConversationFailureKind, message: String) {
    self.kind = kind
    self.message = message
  }
}

public enum AssistantConversationState: Equatable, Sendable {
  case idle
  case listening
  case thinking
  case speaking
  case stopped
  case error(AssistantConversationFailure)
}

public enum AssistantSpokenResponseFormatter {
  public static func spokenText(for response: GroundedAssistantResponse) -> String {
    let caveat: String
    switch response.status {
    case .ambiguous:
      caveat = "I found more than one possible match. "
    case .stale:
      caveat = "Your local calendar information may be out of date. "
    case .conflicting:
      caveat = "Your local notes contain conflicting information. "
    default:
      caveat = ""
    }

    let titles = response.sources.reduce(into: [String]()) { result, source in
      if !result.contains(source.title) { result.append(source.title) }
    }
    guard !titles.isEmpty else { return caveat + response.answer }
    return "\(caveat)\(response.answer) Sources: \(titles.joined(separator: ", "))."
  }
}

/// Owns the serial listen -> answer -> speak loop shared by iOS, macOS, and
/// CarPlay. It intentionally has no persistence or logging dependency.
@MainActor
@Observable
public final class AssistantConversationSession {
  public nonisolated static let defaultMaximumContextTurns = 4

  public private(set) var state: AssistantConversationState = .idle
  public private(set) var turns: [AssistantConversationTurn] = []

  public var isRunning: Bool {
    switch state {
    case .listening, .thinking, .speaking:
      true
    case .idle, .stopped, .error:
      false
    }
  }

  @ObservationIgnored private let transcriber: any AssistantConversationTranscribing
  @ObservationIgnored private let answerer: any AssistantConversationAnswering
  @ObservationIgnored private let speaker: any AssistantConversationSpeaking
  @ObservationIgnored private let maximumContextTurns: Int
  @ObservationIgnored private let interTurnDelay: Duration
  @ObservationIgnored private let locale: Locale
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var surfaceOwnerID: UUID?

  public init(
    transcriber: any AssistantConversationTranscribing,
    answerer: any AssistantConversationAnswering,
    speaker: any AssistantConversationSpeaking,
    maximumContextTurns: Int = AssistantConversationSession.defaultMaximumContextTurns,
    interTurnDelay: Duration = .milliseconds(500),
    locale: Locale = .current,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    precondition(maximumContextTurns > 0, "Conversation context must retain at least one turn")
    self.transcriber = transcriber
    self.answerer = answerer
    self.speaker = speaker
    self.maximumContextTurns = maximumContextTurns
    self.interTurnDelay = interTurnDelay
    self.locale = locale
    self.now = now
  }

  deinit {
    operation?.cancel()
  }

  /// Starts a fresh conversation. Calling this while a turn is already active
  /// is intentionally a no-op.
  public func start() {
    guard operation == nil else { return }
    generation &+= 1
    turns.removeAll(keepingCapacity: true)
    state = .listening
    let currentGeneration = generation
    operation = Task { [weak self] in
      await self?.run(generation: currentGeneration)
    }
  }

  /// Stops listening or speech immediately and forgets all ephemeral context.
  public func stop() async {
    generation &+= 1
    let activeOperation = operation
    operation = nil
    activeOperation?.cancel()
    await activeOperation?.value
    turns.removeAll(keepingCapacity: true)
    state = .stopped
    await speaker.stop()
  }

  /// Returns a disconnected surface to its initial presentation state.
  public func reset() async {
    await stop()
    state = .idle
  }

  /// Gives a presentation surface ownership of lifecycle cleanup. If an older
  /// surface closes after a replacement opens, its delayed teardown is ignored.
  public func activateSurface(_ id: UUID) async {
    guard surfaceOwnerID != id else { return }
    await stop()
    surfaceOwnerID = id
    state = .idle
  }

  public func stopSurface(_ id: UUID) async {
    guard surfaceOwnerID == id else { return }
    await stop()
    if surfaceOwnerID == id { surfaceOwnerID = nil }
  }

  private func run(generation currentGeneration: UInt64) async {
    while isCurrent(currentGeneration) {
      do {
        state = .listening
        let utterance = try await transcriber.transcribe()
          .trimmingCharacters(in: .whitespacesAndNewlines)
        try Task.checkCancellation()
        guard isCurrent(currentGeneration) else { return }
        guard !utterance.isEmpty else {
          fail(
            generation: currentGeneration,
            kind: .transcription,
            message: "I didn't hear a request."
          )
          return
        }

        state = .thinking
        let request = AssistantConversationRequest(
          utterance: utterance,
          priorTurns: turns,
          locale: locale,
          now: now()
        )
        let response = await answerer.respond(to: request)
        try Task.checkCancellation()
        guard isCurrent(currentGeneration) else { return }

        switch response.status {
        case .unavailable:
          fail(generation: currentGeneration, kind: .unavailable, message: response.answer)
          return
        case .ungrounded:
          fail(generation: currentGeneration, kind: .ungrounded, message: response.answer)
          return
        default:
          break
        }

        appendTurn(
          AssistantConversationTurn(
            utterance: utterance,
            answer: response.answer,
            status: response.status
          )
        )
        state = .speaking
        try await speaker.speak(AssistantSpokenResponseFormatter.spokenText(for: response))
        try Task.checkCancellation()
        guard isCurrent(currentGeneration) else { return }
        if interTurnDelay > .zero {
          try await Task.sleep(for: interTurnDelay)
        }
        await Task.yield()
      } catch is CancellationError {
        if currentGeneration == generation, operation != nil, !Task.isCancelled {
          fail(
            generation: currentGeneration,
            kind: .transcription,
            message: "Listening was interrupted."
          )
        }
        return
      } catch {
        guard isCurrent(currentGeneration) else { return }
        let kind: AssistantConversationFailureKind = state == .speaking ? .speaking : .transcription
        fail(generation: currentGeneration, kind: kind, message: error.localizedDescription)
        return
      }
    }
  }

  private func appendTurn(_ turn: AssistantConversationTurn) {
    turns.append(turn)
    if turns.count > maximumContextTurns {
      turns.removeFirst(turns.count - maximumContextTurns)
    }
  }

  private func isCurrent(_ candidate: UInt64) -> Bool {
    candidate == generation && operation != nil && !Task.isCancelled
  }

  private func fail(
    generation candidate: UInt64,
    kind: AssistantConversationFailureKind,
    message: String
  ) {
    guard candidate == generation else { return }
    operation = nil
    state = .error(AssistantConversationFailure(kind: kind, message: message))
  }
}

extension FoundationModelAssistant: AssistantConversationAnswering {
  public func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse {
    await respond(
      to: request.utterance,
      context: request.priorTurns,
      locale: request.locale,
      now: request.now
    )
  }
}
