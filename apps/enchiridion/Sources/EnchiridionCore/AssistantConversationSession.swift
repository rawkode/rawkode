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

public enum AssistantVoiceAvailability: Equatable, Sendable {
  case checking
  case available
  case permissionRequired
  case permissionDenied
  case installationRequired
  case installing
  case unavailable(String)
}

public enum AssistantTranscriptionOutcome: Equatable, Sendable {
  case utterance(String)
  case noSpeech
}

public typealias AssistantTranscriptionProgressHandler = @Sendable (String) async -> Void

public protocol AssistantConversationTranscribing: Sendable {
  func availability() async -> AssistantVoiceAvailability
  func requestPermission() async -> AssistantVoiceAvailability
  func installAssets() async throws
  func transcribe() async throws -> String
  func transcribe(
    reportingProgress: @escaping AssistantTranscriptionProgressHandler
  ) async throws -> AssistantTranscriptionOutcome
  func stop() async
}

extension AssistantConversationTranscribing {
  public func availability() async -> AssistantVoiceAvailability { .available }
  public func requestPermission() async -> AssistantVoiceAvailability { await availability() }
  public func installAssets() async throws {}
  public func transcribe(
    reportingProgress: @escaping AssistantTranscriptionProgressHandler
  ) async throws -> AssistantTranscriptionOutcome {
    let utterance = try await transcribe().trimmingCharacters(in: .whitespacesAndNewlines)
    return utterance.isEmpty ? .noSpeech : .utterance(utterance)
  }
  public func stop() async {}
}

/// Pure transcript-stability policy used to stop a live transcription turn.
/// This observes text hypotheses, not acoustic voice activity.
public struct AssistantTranscriptStabilityTracker: Sendable {
  public enum Decision: Equatable, Sendable {
    case continueListening
    case finalize(String)
    case noSpeech
  }

  public let firstHypothesisTimeout: Duration
  public let stabilityDuration: Duration
  public let hardLimit: Duration

  private var latestText = ""
  private var stableSince: Duration?

  public init(
    firstHypothesisTimeout: Duration = .seconds(5),
    stabilityDuration: Duration = .milliseconds(1_200),
    hardLimit: Duration = .seconds(15)
  ) {
    precondition(firstHypothesisTimeout > .zero)
    precondition(stabilityDuration > .zero)
    precondition(hardLimit >= firstHypothesisTimeout)
    self.firstHypothesisTimeout = firstHypothesisTimeout
    self.stabilityDuration = stabilityDuration
    self.hardLimit = hardLimit
  }

  /// Returns a displayable hypothesis when a nonempty normalized value is new.
  @discardableResult
  public mutating func record(_ text: String, at elapsed: Duration) -> String? {
    let normalized = Self.normalize(text)
    guard !normalized.isEmpty, normalized != latestText else { return nil }
    latestText = normalized
    stableSince = elapsed
    return normalized
  }

  public func decision(at elapsed: Duration) -> Decision {
    if elapsed >= hardLimit {
      return latestText.isEmpty ? .noSpeech : .finalize(latestText)
    }
    if latestText.isEmpty, elapsed >= firstHypothesisTimeout {
      return .noSpeech
    }
    if let stableSince, elapsed >= stableSince + stabilityDuration {
      return .finalize(latestText)
    }
    return .continueListening
  }

  /// Keeps a terminal no-speech decision, while allowing SpeechAnalyzer's
  /// post-finalization hypothesis to refine an accepted utterance.
  public func finalizedOutcome(
    preserving endpointOutcome: AssistantTranscriptionOutcome
  ) -> AssistantTranscriptionOutcome {
    switch endpointOutcome {
    case .noSpeech:
      return .noSpeech
    case .utterance(let endpointText):
      return .utterance(latestText.isEmpty ? endpointText : latestText)
    }
  }

  private static func normalize(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  }
}

public protocol AssistantConversationAnswering: Sendable {
  func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse
  func resetConversation() async
}

extension AssistantConversationAnswering {
  public func resetConversation() async {}
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

/// Owns an ephemeral, text-first assistant conversation. Voice is an optional
/// input/output surface layered on top of the same grounded response path.
@MainActor
@Observable
public final class AssistantConversationSession {
  public nonisolated static let defaultMaximumContextTurns = 4

  public private(set) var state: AssistantConversationState = .idle
  public private(set) var turns: [AssistantConversationTurn] = []
  public private(set) var voiceAvailability: AssistantVoiceAvailability
  public private(set) var liveTranscript = ""
  public private(set) var voiceInputNotice: String?
  public var speaksResponses: Bool

  public var isRunning: Bool {
    switch state {
    case .listening, .thinking, .speaking:
      true
    case .idle, .stopped, .error:
      false
    }
  }

  public private(set) var isVoiceRunning = false
  public private(set) var voiceOperationCompletionGeneration: UInt64 = 0

  @ObservationIgnored private let transcriber: (any AssistantConversationTranscribing)?
  @ObservationIgnored private let answerer: any AssistantConversationAnswering
  @ObservationIgnored private let speaker: (any AssistantConversationSpeaking)?
  @ObservationIgnored private let maximumContextTurns: Int
  @ObservationIgnored private let interTurnDelay: Duration
  @ObservationIgnored private let locale: Locale
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var surfaceOwnerID: UUID?
  @ObservationIgnored private var isStopping = false
  @ObservationIgnored private var voiceStartAttemptID: UUID?
  @ObservationIgnored private var voiceInputGeneration: UInt64 = 0

  public init(
    transcriber: (any AssistantConversationTranscribing)? = nil,
    answerer: any AssistantConversationAnswering,
    speaker: (any AssistantConversationSpeaking)? = nil,
    speaksResponses: Bool = false,
    maximumContextTurns: Int = AssistantConversationSession.defaultMaximumContextTurns,
    interTurnDelay: Duration = .milliseconds(500),
    locale: Locale = .current,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    precondition(maximumContextTurns > 0, "Conversation context must retain at least one turn")
    self.transcriber = transcriber
    self.answerer = answerer
    self.speaker = speaker
    self.speaksResponses = speaksResponses
    self.maximumContextTurns = maximumContextTurns
    self.interTurnDelay = interTurnDelay
    self.locale = locale
    self.now = now
    voiceAvailability =
      transcriber == nil
      ? .unavailable("Voice input is unavailable on this device.")
      : .checking
  }

  deinit {
    operation?.cancel()
  }

  /// Sends typed text through the grounded assistant regardless of voice state.
  public func submit(_ text: String) async {
    let utterance = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !utterance.isEmpty, operation == nil, !isStopping else { return }

    resetVoiceInput()
    generation &+= 1
    let currentGeneration = generation
    finishVoiceOperationIfNeeded()
    state = .thinking
    let task = Task { [weak self] in
      await self?.answer(utterance, generation: currentGeneration)
      self?.finishOperation(generation: currentGeneration)
    }
    operation = task
    await task.value
  }

  /// Starts voice only after an explicit user action. It never clears typed history.
  public func startVoice(greeting: String? = nil) async {
    guard operation == nil, !isStopping, voiceStartAttemptID == nil, let transcriber else {
      return
    }
    let startAttemptID = UUID()
    voiceStartAttemptID = startAttemptID
    defer {
      if voiceStartAttemptID == startAttemptID { voiceStartAttemptID = nil }
    }
    let preflightGeneration = generation

    var availability = await transcriber.availability()
    guard !Task.isCancelled, voiceStartAttemptID == startAttemptID,
      generation == preflightGeneration
    else { return }
    if availability == .permissionRequired {
      availability = await transcriber.requestPermission()
      guard !Task.isCancelled, voiceStartAttemptID == startAttemptID,
        generation == preflightGeneration
      else { return }
    }
    voiceAvailability = availability
    guard !Task.isCancelled, availability == .available else { return }

    // Availability and permission checks are suspension points. A second tap
    // can arrive while the first one is waiting, so commit at most one voice
    // operation after those checks complete.
    guard voiceStartAttemptID == startAttemptID, generation == preflightGeneration,
      operation == nil, !isStopping
    else { return }

    generation &+= 1
    let currentGeneration = generation
    resetVoiceInput()
    isVoiceRunning = true
    let spokenGreeting = greeting?.trimmingCharacters(in: .whitespacesAndNewlines)
    state =
      spokenGreeting?.isEmpty == false && speaksResponses && speaker != nil
      ? .speaking
      : .listening
    operation = Task { [weak self] in
      await self?.runVoice(generation: currentGeneration, greeting: spokenGreeting)
      self?.finishOperation(generation: currentGeneration)
    }
  }

  /// Convenience for clients that do not need to await permission preflight.
  public func start() {
    Task { await startVoice() }
  }

  public func refreshVoiceAvailability() async {
    guard let transcriber else {
      voiceAvailability = .unavailable("Voice input is unavailable on this device.")
      return
    }
    voiceAvailability = .checking
    voiceAvailability = await transcriber.availability()
  }

  public func installVoiceAssets() async {
    guard let transcriber, operation == nil else { return }
    voiceAvailability = .installing
    do {
      try await transcriber.installAssets()
      voiceAvailability = await transcriber.availability()
    } catch {
      voiceAvailability = .unavailable(error.localizedDescription)
    }
  }

  /// Stops active capture/generation/speech while retaining visible conversation.
  public func stop() async {
    await stop(preservingTurns: true)
  }

  public func reset() async {
    await stop(preservingTurns: false)
    guard !isStopping else { return }
    state = .idle
  }

  /// Gives a presentation surface ownership of lifecycle cleanup. If an older
  /// surface closes after a replacement opens, its delayed teardown is ignored.
  public func activateSurface(_ id: UUID) async {
    guard surfaceOwnerID != id else { return }
    surfaceOwnerID = id
    await stop(preservingTurns: false)
    guard surfaceOwnerID == id, !isStopping else { return }
    state = .idle
  }

  public func stopSurface(_ id: UUID) async {
    guard surfaceOwnerID == id else { return }
    surfaceOwnerID = nil
    await stop(preservingTurns: false)
  }

  private func stop(preservingTurns: Bool) async {
    voiceStartAttemptID = nil
    generation &+= 1
    resetVoiceInput()
    let stopGeneration = generation
    isStopping = true
    finishVoiceOperationIfNeeded()
    let activeOperation = operation
    operation = nil
    activeOperation?.cancel()

    // Force the adapters to release continuations and hardware before waiting
    // for the operation that may currently be suspended inside either adapter.
    await transcriber?.stop()
    await speaker?.stop()
    await activeOperation?.value
    if !preservingTurns { await answerer.resetConversation() }

    guard generation == stopGeneration else { return }
    if !preservingTurns { turns.removeAll(keepingCapacity: true) }
    state = .stopped
    isStopping = false
  }

  private func runVoice(
    generation currentGeneration: UInt64,
    greeting: String? = nil
  ) async {
    guard let transcriber else { return }
    if let greeting, !greeting.isEmpty, speaksResponses, let speaker {
      do {
        try await speaker.speak(greeting)
        guard isCurrent(currentGeneration), !Task.isCancelled else { return }
      } catch is CancellationError {
        return
      } catch {
        fail(generation: currentGeneration, kind: .speaking, message: error.localizedDescription)
        return
      }
    }
    while isCurrent(currentGeneration) {
      do {
        state = .listening
        let inputGeneration = beginVoiceInputTurn()
        let outcome = try await transcriber.transcribe { [weak self] transcript in
          await self?.receiveTranscript(
            transcript,
            generation: currentGeneration,
            inputGeneration: inputGeneration
          )
        }
        try Task.checkCancellation()
        guard isCurrent(currentGeneration), inputGeneration == voiceInputGeneration else {
          return
        }
        finishVoiceInputTurn(inputGeneration)

        guard case .utterance(let value) = outcome else {
          voiceInputNotice = "No speech detected. Tap the microphone to try again."
          state = .idle
          return
        }
        let utterance = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !utterance.isEmpty else {
          voiceInputNotice = "No speech detected. Tap the microphone to try again."
          state = .idle
          return
        }

        let shouldContinue = await answer(utterance, generation: currentGeneration)
        guard shouldContinue, isCurrent(currentGeneration) else { return }
        if interTurnDelay > .zero { try await Task.sleep(for: interTurnDelay) }
        await Task.yield()
      } catch is CancellationError {
        return
      } catch {
        guard isCurrent(currentGeneration) else { return }
        let kind: AssistantConversationFailureKind = state == .speaking ? .speaking : .transcription
        fail(generation: currentGeneration, kind: kind, message: error.localizedDescription)
        return
      }
    }
  }

  @discardableResult
  private func answer(_ utterance: String, generation currentGeneration: UInt64) async -> Bool {
    guard isCurrent(currentGeneration) else { return false }
    state = .thinking
    let request = AssistantConversationRequest(
      utterance: utterance,
      priorTurns: turns,
      locale: locale,
      now: now()
    )
    let response = await answerer.respond(to: request)
    guard isCurrent(currentGeneration), !Task.isCancelled else { return false }

    let presentedResponse =
      response.status == .ungrounded
      ? GroundedAssistantResponse(
        answer: "I couldn't answer that confidently. Try asking more specifically.",
        status: .ungrounded
      )
      : response
    appendTurn(
      AssistantConversationTurn(
        utterance: utterance,
        answer: presentedResponse.answer,
        status: presentedResponse.status
      )
    )
    switch presentedResponse.status {
    case .unavailable:
      fail(generation: currentGeneration, kind: .unavailable, message: presentedResponse.answer)
      return false
    case .ungrounded:
      fail(generation: currentGeneration, kind: .ungrounded, message: presentedResponse.answer)
      return false
    default:
      break
    }

    // Typed chat is deliberately silent. Speech output belongs to an active
    // voice conversation, regardless of whether a speaker is configured for
    // another surface such as CarPlay.
    if isVoiceRunning, speaksResponses, let speaker {
      do {
        state = .speaking
        try await speaker.speak(AssistantSpokenResponseFormatter.spokenText(for: presentedResponse))
        guard isCurrent(currentGeneration), !Task.isCancelled else { return false }
      } catch is CancellationError {
        return false
      } catch {
        fail(generation: currentGeneration, kind: .speaking, message: error.localizedDescription)
        return false
      }
    }
    state = isVoiceRunning ? .listening : .idle
    return true
  }

  private func finishOperation(generation candidate: UInt64) {
    guard candidate == generation else { return }
    operation = nil
    finishVoiceOperationIfNeeded()
    if state == .thinking || state == .speaking || state == .listening { state = .idle }
  }

  private func finishVoiceOperationIfNeeded() {
    guard isVoiceRunning else { return }
    isVoiceRunning = false
    voiceOperationCompletionGeneration &+= 1
  }

  private func beginVoiceInputTurn() -> UInt64 {
    resetVoiceInput()
    return voiceInputGeneration
  }

  private func resetVoiceInput() {
    voiceInputGeneration &+= 1
    liveTranscript = ""
    voiceInputNotice = nil
  }

  private func finishVoiceInputTurn(_ inputGeneration: UInt64) {
    guard inputGeneration == voiceInputGeneration else { return }
    voiceInputGeneration &+= 1
    liveTranscript = ""
  }

  private func receiveTranscript(
    _ transcript: String,
    generation candidate: UInt64,
    inputGeneration: UInt64
  ) {
    guard isCurrent(candidate), inputGeneration == voiceInputGeneration else { return }
    let value = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return }
    liveTranscript = value
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
