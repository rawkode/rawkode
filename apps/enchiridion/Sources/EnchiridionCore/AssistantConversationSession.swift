import Foundation
import NaturalLanguage
import Observation

/// A single, in-memory exchange with the assistant. This type is deliberately not
/// `Codable`: conversation history is short-lived context, not library data.
public enum AssistantConversationTurnProvenance: String, Equatable, Sendable {
  case nonLocal
  case localDataDerived
}

public enum AssistantConversationTurnPhase: String, Equatable, Sendable {
  case pending
  case completed
  case failed
  case cancelled
}

public struct AssistantConversationTurn: Equatable, Identifiable, Sendable {
  public let id: UUID
  public let contextEpoch: UInt64
  public let requestedRoute: AssistantConversationRoute
  public let requestedRouteLabel: String
  public let requestedRouteSnapshot: AssistantTextRouteSnapshot
  public var utterance: String
  public var answer: String
  public var status: AssistantResponseStatus
  public var provenance: AssistantConversationTurnProvenance
  public var sources: [AssistantSource]
  public var metadata: AssistantResponseMetadata?
  public var modality: AssistantRequestModality
  public var phase: AssistantConversationTurnPhase

  public init(
    id: UUID = UUID(),
    contextEpoch: UInt64 = 0,
    utterance: String,
    answer: String,
    status: AssistantResponseStatus,
    provenance: AssistantConversationTurnProvenance,
    sources: [AssistantSource] = [],
    metadata: AssistantResponseMetadata? = nil,
    modality: AssistantRequestModality = .text,
    phase: AssistantConversationTurnPhase = .completed,
    requestedRoute: AssistantConversationRoute? = nil,
    requestedRouteLabel: String? = nil,
    requestedRouteSnapshot: AssistantTextRouteSnapshot? = nil
  ) {
    let route = requestedRoute ?? metadata?.routeContextIdentity ?? .appleOnDevice
    let routeSnapshot =
      requestedRouteSnapshot
      ?? AssistantTextRouteSnapshot(
        provider: route.provider == .openAI ? .openAI : .appleOnDevice,
        modelID: route.modelID,
        authorizationFailure: route.provider == .openAI ? .credentialVerificationRequired : nil
      )
    self.id = id
    self.contextEpoch = contextEpoch
    self.requestedRoute = route
    self.requestedRouteLabel =
      requestedRouteLabel ?? metadata?.routeLabel
      ?? (route.provider == .appleOnDevice ? "Apple On Device" : route.modelID ?? "OpenAI")
    self.requestedRouteSnapshot = routeSnapshot
    self.utterance = utterance
    self.answer = answer
    self.status = status
    self.provenance = provenance
    self.sources = sources
    self.metadata = metadata
    self.modality = modality
    self.phase = phase
  }
}

public struct AssistantConversationRequest: Equatable, Sendable {
  public var utterance: String
  public var priorTurns: [AssistantConversationTurn]
  public var contextEpoch: UInt64?
  public var locale: Locale
  public var now: Date
  public var modality: AssistantRequestModality
  public var routeOverride: AssistantConversationRoute?
  public var textRouteSnapshot: AssistantTextRouteSnapshot?
  /// A frozen, user-approved local retrieval allowance for this one submitted
  /// text turn. `nil` means OpenAI receives no local tools or library results.
  public var retrievalAuthorization: AssistantTurnRetrievalAuthorization?

  public init(
    utterance: String,
    priorTurns: [AssistantConversationTurn],
    contextEpoch: UInt64? = nil,
    locale: Locale,
    now: Date,
    modality: AssistantRequestModality = .text,
    routeOverride: AssistantConversationRoute? = nil,
    textRouteSnapshot: AssistantTextRouteSnapshot? = nil,
    retrievalAuthorization: AssistantTurnRetrievalAuthorization? = nil
  ) {
    self.utterance = utterance
    self.priorTurns = priorTurns
    self.contextEpoch = contextEpoch
    self.locale = locale
    self.now = now
    self.modality = modality
    self.routeOverride = routeOverride
    self.textRouteSnapshot = textRouteSnapshot
    self.retrievalAuthorization = retrievalAuthorization
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
  func resetAfterMediaServicesReset() async
  /// Newest-only microphone amplitudes for presentation. This never affects
  /// transcription or endpointing.
  func voiceActivity() async -> AsyncStream<Double>
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
  public func resetAfterMediaServicesReset() async {}
  public func voiceActivity() async -> AsyncStream<Double> { AsyncStream { $0.finish() } }
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
  func resetAfterMediaServicesReset() async
}

extension AssistantConversationSpeaking {
  public func resetAfterMediaServicesReset() async {}
}

/// Owns the process audio session for one complete voice conversation.
/// Capture and speech adapters deliberately do not configure audio routing.
public protocol AssistantConversationAudioSessionControlling: Sendable {
  func activate() async throws
  func deactivate() async
  func resetAfterMediaServicesReset() async
}

extension AssistantConversationAudioSessionControlling {
  public func resetAfterMediaServicesReset() async {}
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
  private struct MarkdownFence {
    var marker: Character
    var length: Int
    var hasTrailingContent: Bool
  }

  private static let continuationCue = "You can ask me to keep going."
  private static let emptyAnswerFallback = "I don't have an answer to read aloud."
  private static let longAnswerFallback = "I have a longer answer ready."
  private static let maximumSentenceCount = 2
  private static let maximumWordCount = 55

  public static func spokenText(for response: GroundedAssistantResponse) -> String {
    let caveat = safetyCaveat(for: response.status)
    var answer = plainSpeech(from: response.answer)
    if let caveat {
      answer = removingRepeatedCaveat(caveat, from: answer)
    }

    let answerSentences = sentences(in: answer)
    var candidates = caveat.map { [$0] } ?? []
    candidates.append(contentsOf: answerSentences)
    guard !candidates.isEmpty else { return emptyAnswerFallback }

    var selected: [String] = []
    var selectedWordCount = 0
    for sentence in candidates {
      let sentenceWordCount = wordCount(in: sentence)
      guard selected.count < maximumSentenceCount,
        selectedWordCount + sentenceWordCount <= maximumWordCount
      else {
        let prefix = selected.isEmpty ? longAnswerFallback : selected.joined(separator: " ")
        return "\(prefix) \(continuationCue)"
      }
      selected.append(sentence)
      selectedWordCount += sentenceWordCount
    }

    return selected.joined(separator: " ")
  }

  private static func safetyCaveat(for status: AssistantResponseStatus) -> String? {
    switch status {
    case .ambiguous:
      "I found more than one possible match."
    case .stale:
      "Your local calendar information may be out of date."
    case .conflicting:
      "Your local notes contain conflicting information."
    default:
      nil
    }
  }

  private static func plainSpeech(from markdown: String) -> String {
    let lines = markdownWithoutSources(markdown)
      .split(omittingEmptySubsequences: false, whereSeparator: \Character.isNewline)
      .compactMap { speechContent(from: String($0)) }
    let inlineMarkdown = lines.joined(separator: " ")
    let options = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace
    )
    let rendered = renderInlineMarkdown(inlineMarkdown, options: options)
    let withoutURLs = removingURILikeTokens(from: rendered)
    return normalizeWhitespace(withoutURLs)
  }

  private static func markdownWithoutSources(_ markdown: String) -> String {
    var keptLines: [String] = []
    var omittingSourceBlock = false
    var activeFence: MarkdownFence?

    for originalLine in markdown.split(
      omittingEmptySubsequences: false,
      whereSeparator: \Character.isNewline
    ) {
      let line = String(originalLine)
      let structuralLine = markdownStructureContent(from: line)
      if let fence = markdownFence(in: structuralLine) {
        if let openingFence = activeFence {
          if fence.marker == openingFence.marker, fence.length >= openingFence.length,
            !fence.hasTrailingContent
          {
            activeFence = nil
          }
        } else {
          activeFence = fence
        }
        continue
      }
      if activeFence != nil { continue }

      if let heading = markdownHeading(in: structuralLine) {
        if isSourceHeading(heading) {
          omittingSourceBlock = true
          continue
        }
        if omittingSourceBlock { omittingSourceBlock = false }
      }
      if omittingSourceBlock { continue }

      let renderedLine = renderInlineMarkdown(structuralLine)
      if let sourceRange = sourceLabelRange(in: renderedLine) {
        let answerPrefix = String(renderedLine[..<sourceRange.lowerBound])
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if !answerPrefix.isEmpty { keptLines.append(answerPrefix) }
        omittingSourceBlock = true
        continue
      }
      keptLines.append(line)
    }

    return keptLines.joined(separator: "\n")
  }

  private static func markdownFence(in line: String) -> MarkdownFence? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard let marker = trimmed.first, marker == "`" || marker == "~" else { return nil }
    let length = trimmed.prefix(while: { $0 == marker }).count
    guard length >= 3 else { return nil }
    let contentStart = trimmed.index(trimmed.startIndex, offsetBy: length)
    let trailingContent = trimmed[contentStart...]
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return MarkdownFence(
      marker: marker,
      length: length,
      hasTrailingContent: !trailingContent.isEmpty
    )
  }

  private static func isSourceHeading(_ heading: String) -> Bool {
    let normalized = renderInlineMarkdown(heading)
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: ":"))
    return normalized.caseInsensitiveCompare("source") == .orderedSame
      || normalized.caseInsensitiveCompare("sources") == .orderedSame
  }

  private static func sourceLabelRange(in line: String) -> Range<String.Index>? {
    guard let expression = try? NSRegularExpression(pattern: #"(?i)\bsources?\s*:"#),
      let match = expression.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
      let range = Range(match.range, in: line)
    else { return nil }
    let prefix = line[..<range.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
    guard prefix.isEmpty || prefix.last.map(isSentenceTerminator) == true else { return nil }
    return range
  }

  private static func markdownHeading(in line: String) -> String? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let markerCount = trimmed.prefix(while: { $0 == "#" }).count
    guard (1...6).contains(markerCount) else { return nil }
    let contentStart = trimmed.index(trimmed.startIndex, offsetBy: markerCount)
    guard contentStart == trimmed.endIndex || trimmed[contentStart].isWhitespace else { return nil }
    return trimmed[contentStart...]
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: ":"))
  }

  private static func speechContent(from line: String) -> String? {
    var content = markdownStructureContent(from: line)
    guard !content.isEmpty else { return nil }
    if content.hasPrefix("```") || content.hasPrefix("~~~") { return nil }
    if content.allSatisfy({ "-*_".contains($0) }) { return nil }

    if let heading = markdownHeading(in: content) {
      content = heading
      if !content.isEmpty, content.last.map(isSentenceTerminator) != true,
        !content.hasSuffix(":")
      {
        content.append(":")
      }
    }
    if content.first == "[", let definitionEnd = content.range(of: "]:")?.upperBound,
      content[definitionEnd...].trimmingCharacters(in: .whitespaces).hasPrefix("http")
    {
      return nil
    }
    return content.isEmpty ? nil : content
  }

  private static func markdownStructureContent(from line: String) -> String {
    var content = line.trimmingCharacters(in: .whitespacesAndNewlines)
    var previous = ""
    while content != previous {
      previous = content
      while content.hasPrefix(">") {
        content.removeFirst()
        content = content.trimmingCharacters(in: .whitespaces)
      }
      if content.hasPrefix("- ") || content.hasPrefix("* ") || content.hasPrefix("+ ") {
        content.removeFirst(2)
        content = content.trimmingCharacters(in: .whitespaces)
      } else if let orderedContent = removingOrderedListMarker(from: content) {
        content = orderedContent.trimmingCharacters(in: .whitespaces)
      }
      if content.hasPrefix("[ ] ") || content.hasPrefix("[x] ") || content.hasPrefix("[X] ") {
        content.removeFirst(4)
        content = content.trimmingCharacters(in: .whitespaces)
      }
    }
    return content
  }

  private static func removingOrderedListMarker(from content: String) -> String? {
    let numberEnd = content.prefix(while: \Character.isNumber).endIndex
    guard numberEnd != content.startIndex, numberEnd != content.endIndex,
      content[numberEnd] == "." || content[numberEnd] == ")"
    else { return nil }
    let space = content.index(after: numberEnd)
    guard space != content.endIndex, content[space].isWhitespace else { return nil }
    return String(content[content.index(after: space)...])
  }

  private static func removingRepeatedCaveat(_ caveat: String, from answer: String) -> String {
    var result = answer
    while let range = result.range(of: caveat, options: .caseInsensitive) {
      result.removeSubrange(range)
    }
    return normalizeWhitespace(result)
  }

  private static func sentences(in text: String) -> [String] {
    guard !text.isEmpty else { return [] }
    let tokenizer = NLTokenizer(unit: .sentence)
    tokenizer.string = text
    var result: [String] = []
    tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
      let sentence = text[range]
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if !sentence.isEmpty { result.append(sentence) }
      return true
    }
    return result
  }

  private static func isSentenceTerminator(_ character: Character) -> Bool {
    ".!?…。！？".contains(character)
  }

  private static func wordCount(in text: String) -> Int {
    let tokenizer = NLTokenizer(unit: .word)
    tokenizer.string = text
    var count = 0
    tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { _, _ in
      count += 1
      return true
    }
    return count
  }

  private static func normalizeWhitespace(_ text: String) -> String {
    text.split(whereSeparator: \Character.isWhitespace).joined(separator: " ")
  }

  private static func removingURILikeTokens(from text: String) -> String {
    let pattern =
      #"(?i)(?<![\p{L}\p{N}_])(?:[a-z][a-z0-9+.-]*://|(?:mailto|tel|calendar|event|page|task):|www\.)[^\s<>\"\[\]{}]+"#
    guard let expression = try? NSRegularExpression(pattern: pattern) else { return text }

    let source = text as NSString
    let result = NSMutableString(string: text)
    let terminalPunctuation = CharacterSet(charactersIn: ".,;!?…。！？，；")
    let matches = expression.matches(in: text, range: NSRange(text.startIndex..., in: text))
    for match in matches.reversed() {
      var removalRange = match.range
      while removalRange.length > 0 {
        let trailingRange = NSRange(
          location: removalRange.location + removalRange.length - 1,
          length: 1
        )
        let trailing = source.substring(with: trailingRange)
        guard trailing.rangeOfCharacter(from: terminalPunctuation) != nil else { break }
        removalRange.length -= 1
      }

      guard removalRange.length > 0 else { continue }
      let token = source.substring(with: removalRange)
      if removalRange.location > 0,
        source.substring(with: NSRange(location: removalRange.location - 1, length: 1)) == "(",
        token.filter({ $0 == ")" }).count > token.filter({ $0 == "(" }).count
      {
        removalRange.location -= 1
        removalRange.length += 1
      }
      result.replaceCharacters(in: removalRange, with: "")
    }
    return result as String
  }

  private static func renderInlineMarkdown(
    _ markdown: String,
    options: AttributedString.MarkdownParsingOptions = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace
    )
  ) -> String {
    (try? AttributedString(markdown: markdown, options: options))
      .map { String($0.characters) } ?? markdown
  }
}

/// Owns an ephemeral, text-first assistant conversation. Voice is an optional
/// input/output surface layered on top of the same grounded response path.
@MainActor
@Observable
public final class AssistantConversationSession {
  private struct AudioSessionActivation {
    var id: UUID
    var task: Task<Void, any Error>
  }

  public nonisolated static let defaultMaximumContextTurns = 4

  public private(set) var state: AssistantConversationState = .idle
  public private(set) var turns: [AssistantConversationTurn] = []
  public private(set) var voiceAvailability: AssistantVoiceAvailability
  public private(set) var liveTranscript = ""
  public private(set) var voiceInputNotice: String?
  public private(set) var voicePauseReason: AssistantVoicePauseReason?
  public private(set) var transcriptRevision: UInt64 = 0
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
  public private(set) var voiceActivity = VoiceActivitySnapshot.inactive

  @ObservationIgnored private let transcriber: (any AssistantConversationTranscribing)?
  @ObservationIgnored private let answerer: any AssistantConversationAnswering
  @ObservationIgnored private let speaker: (any AssistantConversationSpeaking)?
  @ObservationIgnored private let audioSessionController:
    (any AssistantConversationAudioSessionControlling)?
  @ObservationIgnored private let voiceSafetyEventSource: (any AssistantVoiceSafetyEventSource)?
  @ObservationIgnored private let maximumContextTurns: Int
  @ObservationIgnored private let interTurnDelay: Duration
  @ObservationIgnored private let locale: Locale
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var activeAttemptID: UUID?
  @ObservationIgnored private var activeTurnID: UUID?
  @ObservationIgnored private var cancelledTurnByAttemptID: [UUID: UUID] = [:]
  @ObservationIgnored private var surfaceOwnerID: UUID?
  @ObservationIgnored private var isStopping = false
  @ObservationIgnored private var voiceStartAttemptID: UUID?
  @ObservationIgnored private var voiceInputGeneration: UInt64 = 0
  @ObservationIgnored private var audioSessionActivation: AudioSessionActivation?
  @ObservationIgnored private var ownsAudioSession = false
  @ObservationIgnored private var voiceSafetyEventTask: Task<Void, Never>?
  @ObservationIgnored private var voiceActivityTask: Task<Void, Never>?
  @ObservationIgnored private var lastVoiceSafetyEvent: AssistantVoiceSafetyEvent?
  @ObservationIgnored private var currentContextEpoch: UInt64 = 0

  public init(
    transcriber: (any AssistantConversationTranscribing)? = nil,
    answerer: any AssistantConversationAnswering,
    speaker: (any AssistantConversationSpeaking)? = nil,
    audioSessionController: (any AssistantConversationAudioSessionControlling)? = nil,
    voiceSafetyEventSource: (any AssistantVoiceSafetyEventSource)? = nil,
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
    self.audioSessionController = audioSessionController
    self.voiceSafetyEventSource = voiceSafetyEventSource
    self.speaksResponses = speaksResponses
    self.maximumContextTurns = maximumContextTurns
    self.interTurnDelay = interTurnDelay
    self.locale = locale
    self.now = now
    voiceAvailability =
      transcriber == nil
      ? .unavailable("Voice input is unavailable on this device.")
      : .checking
    if let voiceSafetyEventSource {
      voiceSafetyEventTask = Task { [weak self] in
        for await event in voiceSafetyEventSource.events() {
          guard !Task.isCancelled else { return }
          await self?.handleVoiceSafetyEvent(event)
        }
      }
    }
  }

  deinit {
    operation?.cancel()
    audioSessionActivation?.task.cancel()
    voiceSafetyEventTask?.cancel()
    voiceActivityTask?.cancel()
    guard let audioSessionController else { return }
    if let audioSessionActivation {
      Task {
        guard (try? await audioSessionActivation.task.value) != nil else { return }
        await audioSessionController.deactivate()
      }
    } else if ownsAudioSession {
      Task { await audioSessionController.deactivate() }
    }
  }

  /// Sends typed text through the grounded assistant regardless of voice state.
  public func submit(_ text: String) async {
    guard
      let started = beginTypedSubmission(
        text,
        routeOverride: nil,
        routeLabel: nil,
        routeSnapshot: nil,
        retrievalAuthorization: nil,
        contextEpoch: nil
      )
    else { return }
    await started.task.value
  }

  /// Accepts a typed message synchronously so its user and pending assistant
  /// bubbles are observable before any answerer suspension point.
  @discardableResult
  public func submitImmediately(
    _ text: String,
    routeOverride: AssistantConversationRoute,
    routeLabel: String,
    routeSnapshot: AssistantTextRouteSnapshot? = nil,
    retrievalAuthorization: AssistantTurnRetrievalAuthorization? = nil
  ) -> UUID? {
    beginTypedSubmission(
      text,
      routeOverride: routeOverride,
      routeLabel: routeLabel,
      routeSnapshot: routeSnapshot,
      retrievalAuthorization: retrievalAuthorization,
      contextEpoch: nil
    )?.turnID
  }

  private struct StartedTypedSubmission {
    var turnID: UUID
    var task: Task<Void, Never>
  }

  private func beginTypedSubmission(
    _ text: String,
    routeOverride: AssistantConversationRoute?,
    routeLabel: String?,
    routeSnapshot: AssistantTextRouteSnapshot?,
    retrievalAuthorization: AssistantTurnRetrievalAuthorization?,
    contextEpoch: UInt64?
  ) -> StartedTypedSubmission? {
    let utterance = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !utterance.isEmpty, operation == nil, !isStopping else { return nil }

    clearVoicePause()
    resetVoiceInput()
    generation &+= 1
    let currentGeneration = generation
    let attemptID = UUID()
    let turnID = UUID()
    let acceptedContextEpoch = contextEpoch ?? currentContextEpoch
    let requestedRoute = routeOverride ?? .appleOnDevice
    let requestedProvider: AssistantProvider =
      requestedRoute.provider == .openAI ? .openAI : .appleOnDevice
    if let routeSnapshot {
      guard routeSnapshot.provider == requestedProvider,
        routeSnapshot.modelID == requestedRoute.modelID
      else { return nil }
    }
    let requestedRouteSnapshot =
      routeSnapshot
      ?? AssistantTextRouteSnapshot(
        provider: requestedProvider,
        modelID: requestedRoute.modelID,
        authorizationFailure: requestedRoute.provider == .openAI
          ? .credentialVerificationRequired : nil
      )
    let requestedRouteLabel =
      routeLabel
      ?? (requestedRoute.provider == .appleOnDevice
        ? "Apple On Device" : requestedRoute.modelID ?? "OpenAI")
    finishVoiceOperationIfNeeded()
    activeAttemptID = attemptID
    activeTurnID = turnID
    appendTurn(
      AssistantConversationTurn(
        id: turnID,
        contextEpoch: acceptedContextEpoch,
        utterance: utterance,
        answer: "",
        status: .answered,
        provenance: .nonLocal,
        modality: .text,
        phase: .pending,
        requestedRoute: requestedRoute,
        requestedRouteLabel: requestedRouteLabel,
        requestedRouteSnapshot: requestedRouteSnapshot
      )
    )
    state = .thinking
    let task = Task { [weak self] in
      await self?.answer(
        utterance,
        generation: currentGeneration,
        attemptID: attemptID,
        turnID: turnID,
        routeOverride: requestedRoute,
        routeSnapshot: requestedRouteSnapshot,
        retrievalAuthorization: retrievalAuthorization,
        contextEpoch: acceptedContextEpoch
      )
      await self?.finishOperation(
        generation: currentGeneration,
        attemptID: attemptID,
        turnID: turnID
      )
    }
    operation = task
    return StartedTypedSubmission(turnID: turnID, task: task)
  }

  public func retryLastFailedTurn() async {
    guard let turnID = turns.last?.id else { return }
    await retryFailedTurn(id: turnID)
  }

  /// Appends a new attempt for the exact failed receipt selected by the user.
  public func retryFailedTurn(at index: Int) async {
    guard turns.indices.contains(index) else { return }
    await retryFailedTurn(id: turns[index].id)
  }

  /// Resolves retries by stable identity so trimming or an intervening update
  /// cannot redirect the action to a different receipt.
  @discardableResult
  public func retryFailedTurn(id: UUID) async -> UUID? {
    guard let started = beginRetryFailedTurn(id: id) else { return nil }
    await started.task.value
    return started.turnID
  }

  /// Accepts an exact historical retry synchronously so the new attempt can
  /// be revealed before the answerer reaches its first suspension point.
  @discardableResult
  public func retryFailedTurnImmediately(id: UUID) -> UUID? {
    beginRetryFailedTurn(id: id)?.turnID
  }

  private func beginRetryFailedTurn(id: UUID) -> StartedTypedSubmission? {
    guard operation == nil, !isStopping, let turn = turns.first(where: { $0.id == id }) else {
      return nil
    }
    guard
      turn.metadata?.recoveryAction == .retry,
      turn.metadata?.completion != .completed,
      turn.phase == .failed || turn.phase == .cancelled
    else { return nil }
    return beginTypedSubmission(
      turn.utterance,
      routeOverride: turn.requestedRoute,
      routeLabel: turn.requestedRouteLabel,
      routeSnapshot: turn.requestedRouteSnapshot,
      retrievalAuthorization: nil,
      contextEpoch: turn.contextEpoch
    )
  }

  /// Appends a distinct Apple attempt while preserving the failed OpenAI turn
  /// and its billing/disclosure receipt exactly as presented.
  public func retryLastFailedTurnOnApple() async {
    guard let turnID = turns.last?.id else { return }
    await retryFailedTurnOnApple(id: turnID)
  }

  /// Appends a distinct Apple attempt for the exact failed receipt selected
  /// by the user, without mutating any prior attempt.
  public func retryFailedTurnOnApple(at index: Int) async {
    guard turns.indices.contains(index) else { return }
    await retryFailedTurnOnApple(id: turns[index].id)
  }

  @discardableResult
  public func retryFailedTurnOnApple(id: UUID) async -> UUID? {
    guard let started = beginRetryFailedTurnOnApple(id: id) else { return nil }
    await started.task.value
    return started.turnID
  }

  @discardableResult
  public func retryFailedTurnOnAppleImmediately(id: UUID) -> UUID? {
    beginRetryFailedTurnOnApple(id: id)?.turnID
  }

  private func beginRetryFailedTurnOnApple(id: UUID) -> StartedTypedSubmission? {
    guard operation == nil, !isStopping, let turn = turns.first(where: { $0.id == id }) else {
      return nil
    }
    guard
      turn.metadata?.recoveryAction == .retry,
      turn.metadata?.completion != .completed,
      turn.phase == .failed || turn.phase == .cancelled
    else { return nil }
    return beginTypedSubmission(
      turn.utterance,
      routeOverride: .appleOnDevice,
      routeLabel: "Apple On Device",
      routeSnapshot: AssistantTextRouteSnapshot(provider: .appleOnDevice),
      retrievalAuthorization: nil,
      contextEpoch: nil
    )
  }

  /// Starts a fresh provider context without cancelling an already-snapshotted
  /// request that may be billable. An in-flight attempt finishes into its old
  /// context; the new route begins after its immutable receipt.
  public func startNewRouteContext() async {
    startNewRouteContextImmediately()
  }

  public func startNewRouteContextImmediately() {
    currentContextEpoch &+= 1
    if operation == nil, !isStopping { state = .idle }
  }

  /// Starts voice only after an explicit user action. It never clears typed history.
  public func startVoice(greeting: String? = nil) async {
    guard operation == nil, !isStopping, voiceStartAttemptID == nil, let transcriber else {
      return
    }
    let startAttemptID = UUID()
    voiceStartAttemptID = startAttemptID
    clearVoicePause()
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

    if let audioSessionController {
      let activationID = UUID()
      let activationTask = Task { try await audioSessionController.activate() }
      audioSessionActivation = AudioSessionActivation(id: activationID, task: activationTask)
      do {
        try await activationTask.value
      } catch {
        guard audioSessionActivation?.id == activationID else { return }
        audioSessionActivation = nil
        guard !Task.isCancelled, voiceStartAttemptID == startAttemptID,
          generation == preflightGeneration, !isStopping
        else { return }
        voiceAvailability = .unavailable(error.localizedDescription)
        state = .error(
          AssistantConversationFailure(kind: .unavailable, message: error.localizedDescription)
        )
        return
      }

      guard audioSessionActivation?.id == activationID else { return }
      audioSessionActivation = nil
      guard !Task.isCancelled, voiceStartAttemptID == startAttemptID,
        generation == preflightGeneration, operation == nil, !isStopping
      else {
        await audioSessionController.deactivate()
        return
      }
      ownsAudioSession = true
    }

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
      await self?.finishOperation(generation: currentGeneration)
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

  /// Pauses only an in-flight voice preflight or operation. Typed chat is not
  /// cancelled, and no event can restart capture or speech.
  public func handleVoiceSafetyEvent(_ event: AssistantVoiceSafetyEvent) async {
    guard lastVoiceSafetyEvent != event else { return }
    lastVoiceSafetyEvent = event

    if hasActiveVoiceWork, let reason = pauseReason(for: event) {
      await pauseVoice(for: reason)
    }

    switch event {
    case .mediaServicesLost, .mediaServicesReset:
      await transcriber?.resetAfterMediaServicesReset()
      await speaker?.resetAfterMediaServicesReset()
      await audioSessionController?.resetAfterMediaServicesReset()
    case .interruptionBegan, .routeChanged, .appInactive:
      break
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
    guard !isStopping else { return }
    voiceStartAttemptID = nil
    generation &+= 1
    resetVoiceInput()
    clearVoiceActivity()
    let stopGeneration = generation
    isStopping = true
    finishVoiceOperationIfNeeded()
    var cancelledAttempt: (attemptID: UUID, turnID: UUID)?
    if preservingTurns, let activeTurnID {
      cancelPendingTurn(id: activeTurnID)
      if let activeAttemptID {
        cancelledAttempt = (activeAttemptID, activeTurnID)
        cancelledTurnByAttemptID[activeAttemptID] = activeTurnID
      }
    }
    activeAttemptID = nil
    activeTurnID = nil
    let pendingAudioSessionActivation = audioSessionActivation
    pendingAudioSessionActivation?.task.cancel()
    let activeOperation = operation
    operation = nil
    activeOperation?.cancel()

    // Force the adapters to release continuations and hardware before waiting
    // for the operation that may currently be suspended inside either adapter.
    await transcriber?.stop()
    await speaker?.stop()
    await activeOperation?.value
    if let cancelledAttempt,
      cancelledTurnByAttemptID[cancelledAttempt.attemptID] == cancelledAttempt.turnID
    {
      cancelledTurnByAttemptID[cancelledAttempt.attemptID] = nil
    }
    if let pendingAudioSessionActivation {
      let didActivate = (try? await pendingAudioSessionActivation.task.value) != nil
      if audioSessionActivation?.id == pendingAudioSessionActivation.id {
        audioSessionActivation = nil
        if didActivate { await audioSessionController?.deactivate() }
      }
    }
    await releaseAudioSessionIfNeeded()
    if !preservingTurns { await answerer.resetConversation() }

    guard generation == stopGeneration else { return }
    if !preservingTurns {
      let hadTurns = !turns.isEmpty
      turns.removeAll(keepingCapacity: true)
      currentContextEpoch &+= 1
      if hadTurns { transcriptRevision &+= 1 }
    }
    state = .stopped
    isStopping = false
  }

  private var hasActiveVoiceWork: Bool {
    isVoiceRunning || voiceStartAttemptID != nil || audioSessionActivation != nil
  }

  private func pauseReason(for event: AssistantVoiceSafetyEvent) -> AssistantVoicePauseReason? {
    switch event {
    case .interruptionBegan:
      return .interruption
    case .routeChanged(let reason, let previous, let current):
      return AssistantAudioRouteSafetyClassifier.pauseReason(
        reason: reason,
        previous: previous,
        current: current
      )
    case .mediaServicesLost, .mediaServicesReset:
      return .mediaServicesRestarted
    case .appInactive:
      return .appInactive
    }
  }

  private func pauseVoice(for reason: AssistantVoicePauseReason) async {
    voiceStartAttemptID = nil
    generation &+= 1
    resetVoiceInput()
    clearVoiceActivity()
    let pauseGeneration = generation
    isStopping = true
    finishVoiceOperationIfNeeded()
    let pendingAudioSessionActivation = audioSessionActivation
    pendingAudioSessionActivation?.task.cancel()
    let activeOperation = operation
    operation = nil
    activeOperation?.cancel()

    await transcriber?.stop()
    await speaker?.stop()
    await activeOperation?.value
    if let pendingAudioSessionActivation {
      let didActivate = (try? await pendingAudioSessionActivation.task.value) != nil
      if audioSessionActivation?.id == pendingAudioSessionActivation.id {
        audioSessionActivation = nil
        if didActivate { await audioSessionController?.deactivate() }
      }
    }
    await releaseAudioSessionIfNeeded()

    guard generation == pauseGeneration else { return }
    voicePauseReason = reason
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
    while currentGeneration == generation, !Task.isCancelled {
      do {
        state = .listening
        let inputGeneration = beginVoiceInputTurn()
        guard await beginVoiceActivity(
          generation: currentGeneration,
          inputGeneration: inputGeneration
        ) else { return }
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
        clearVoiceActivity()

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
  private func answer(
    _ utterance: String,
    generation currentGeneration: UInt64,
    attemptID: UUID? = nil,
    turnID: UUID? = nil,
    routeOverride: AssistantConversationRoute? = nil,
    routeSnapshot: AssistantTextRouteSnapshot? = nil,
    retrievalAuthorization: AssistantTurnRetrievalAuthorization? = nil,
    contextEpoch: UInt64? = nil
  ) async -> Bool {
    guard isCurrent(currentGeneration, attemptID: attemptID, turnID: turnID) else {
      return false
    }
    state = .thinking
    if isVoiceRunning {
      voiceActivity = VoiceActivitySnapshot(isPreparingResponse: true)
    }
    let acceptedContextEpoch = contextEpoch ?? currentContextEpoch
    let acceptedRouteSnapshot =
      routeSnapshot
      ?? (isVoiceRunning ? AssistantTextRouteSnapshot(provider: .appleOnDevice) : nil)
    let visibleHistory =
      turns
      .filter {
        $0.phase == .completed
          && $0.id != turnID
          && $0.contextEpoch == acceptedContextEpoch
          && (acceptedRouteSnapshot == nil || $0.requestedRouteSnapshot == acceptedRouteSnapshot)
      }
      .suffix(maximumContextTurns)
    let request = AssistantConversationRequest(
      utterance: utterance,
      priorTurns: Array(visibleHistory),
      contextEpoch: acceptedContextEpoch,
      locale: locale,
      now: now(),
      modality: isVoiceRunning ? .voice : .text,
      routeOverride: routeOverride,
      textRouteSnapshot: routeSnapshot,
      retrievalAuthorization: retrievalAuthorization
    )
    let response = await answerer.respond(to: request)
    if let attemptID, let turnID,
      cancelledTurnByAttemptID[attemptID] == turnID
    {
      mergeCancelledReceipt(response, into: turnID)
      return false
    }
    guard
      isCurrent(currentGeneration, attemptID: attemptID, turnID: turnID),
      !Task.isCancelled
    else { return false }

    let presentedResponse =
      response.status == .ungrounded
      ? GroundedAssistantResponse(
        answer: "I couldn't answer that confidently. Try asking more specifically.",
        status: .ungrounded,
        sources: response.sources,
        metadata: response.metadata
      )
      : response
    if let turnID {
      guard
        replacePendingTurn(
          id: turnID,
          with: presentedResponse,
          modality: request.modality
        )
      else { return false }
    } else {
      appendTurn(
        AssistantConversationTurn(
          contextEpoch: acceptedContextEpoch,
          utterance: utterance,
          answer: presentedResponse.answer,
          status: presentedResponse.status,
          provenance: Self.provenance(for: presentedResponse),
          sources: presentedResponse.sources,
          metadata: presentedResponse.metadata,
          modality: request.modality,
          phase: Self.phase(for: presentedResponse)
        )
      )
    }
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
        voiceActivity = VoiceActivitySnapshot(isResponding: true)
        try await speaker.speak(AssistantSpokenResponseFormatter.spokenText(for: presentedResponse))
        guard isCurrent(currentGeneration), !Task.isCancelled else { return false }
        clearVoiceActivity()
      } catch is CancellationError {
        clearVoiceActivity()
        return false
      } catch {
        clearVoiceActivity()
        fail(generation: currentGeneration, kind: .speaking, message: error.localizedDescription)
        return false
      }
    }
    state = isVoiceRunning ? .listening : .idle
    clearVoiceActivity()
    return true
  }

  private static func provenance(
    for response: GroundedAssistantResponse
  ) -> AssistantConversationTurnProvenance {
    if !response.sources.isEmpty { return .localDataDerived }
    switch response.status {
    case .noResults, .ambiguous, .stale, .conflicting:
      return .localDataDerived
    case .answered, .unavailable, .ungrounded:
      return .nonLocal
    }
  }

  private func finishOperation(
    generation candidate: UInt64,
    attemptID: UUID? = nil,
    turnID: UUID? = nil
  ) async {
    guard isCurrent(candidate, attemptID: attemptID, turnID: turnID) else { return }
    operation = nil
    activeAttemptID = nil
    activeTurnID = nil
    finishVoiceOperationIfNeeded()
    clearVoiceActivity()
    await releaseAudioSessionIfNeeded()
    if state == .thinking || state == .speaking || state == .listening { state = .idle }
  }

  private func releaseAudioSessionIfNeeded() async {
    guard ownsAudioSession else { return }
    ownsAudioSession = false
    await audioSessionController?.deactivate()
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

  private func beginVoiceActivity(generation: UInt64, inputGeneration: UInt64) async -> Bool {
    clearVoiceActivity()
    voiceActivity = VoiceActivitySnapshot(isListening: true)
    let transcriber = transcriber
    guard let transcriber else { return false }
    let stream = await transcriber.voiceActivity()
    guard !Task.isCancelled, isCurrent(generation), inputGeneration == voiceInputGeneration,
      state == .listening
    else {
      clearVoiceActivity()
      return false
    }
    voiceActivityTask = Task { [weak self] in
      for await level in stream {
        guard !Task.isCancelled else { return }
        self?.receiveVoiceActivity(
          level,
          generation: generation,
          inputGeneration: inputGeneration
        )
      }
    }
    return true
  }

  private func receiveVoiceActivity(
    _ level: Double,
    generation candidate: UInt64,
    inputGeneration: UInt64
  ) {
    guard isCurrent(candidate), inputGeneration == voiceInputGeneration, state == .listening else {
      return
    }
    voiceActivity = VoiceActivitySnapshot(isListening: true, inputLevel: level)
  }

  private func clearVoiceActivity() {
    voiceActivityTask?.cancel()
    voiceActivityTask = nil
    voiceActivity = .inactive
  }

  private func resetVoiceInput() {
    voiceInputGeneration &+= 1
    liveTranscript = ""
    voiceInputNotice = nil
  }

  private func clearVoicePause() {
    voicePauseReason = nil
    lastVoiceSafetyEvent = nil
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

  private static func phase(
    for response: GroundedAssistantResponse
  ) -> AssistantConversationTurnPhase {
    if response.status == .unavailable || response.status == .ungrounded {
      return .failed
    }
    if let metadata = response.metadata, metadata.completion != .completed {
      return .failed
    }
    return .completed
  }

  @discardableResult
  private func replacePendingTurn(
    id: UUID,
    with response: GroundedAssistantResponse,
    modality: AssistantRequestModality
  ) -> Bool {
    guard let index = turns.firstIndex(where: { $0.id == id }),
      turns[index].phase == .pending
    else { return false }
    turns[index].answer = response.answer
    turns[index].status = response.status
    turns[index].provenance = Self.provenance(for: response)
    turns[index].sources = response.sources
    turns[index].metadata = response.metadata
    turns[index].modality = modality
    turns[index].phase = Self.phase(for: response)
    transcriptRevision &+= 1
    return true
  }

  private func cancelPendingTurn(id: UUID) {
    guard let index = turns.firstIndex(where: { $0.id == id }),
      turns[index].phase == .pending
    else { return }
    let route = turns[index].requestedRoute
    turns[index].answer = "Response stopped"
    turns[index].status = .answered
    turns[index].provenance = .nonLocal
    turns[index].sources = []
    turns[index].metadata = AssistantResponseMetadata(
      requestedProvider: route.provider,
      requestedModelID: route.modelID,
      routeLabel: turns[index].requestedRouteLabel,
      completion: .incomplete,
      recoveryAction: .retry
    )
    turns[index].phase = .cancelled
    transcriptRevision &+= 1
  }

  private func mergeCancelledReceipt(
    _ response: GroundedAssistantResponse,
    into id: UUID
  ) {
    guard let index = turns.firstIndex(where: { $0.id == id }),
      turns[index].phase == .cancelled,
      let receipt = response.metadata
    else { return }
    let route = turns[index].requestedRoute
    turns[index].metadata = AssistantResponseMetadata(
      requestedProvider: route.provider,
      requestedModelID: route.modelID,
      actualModelID: receipt.actualModelID,
      routeLabel: turns[index].requestedRouteLabel,
      usage: receipt.usage,
      requestIDs: receipt.requestIDs,
      completion: .incomplete,
      priorOpenAITurnCount: receipt.priorOpenAITurnCount,
      localContextCount: receipt.localContextCount,
      recoveryAction: .retry
    )
    turns[index].sources = response.sources
    turns[index].provenance = response.sources.isEmpty ? .nonLocal : .localDataDerived
    transcriptRevision &+= 1
  }

  private func appendTurn(_ turn: AssistantConversationTurn) {
    turns.append(turn)
    transcriptRevision &+= 1
  }

  private func isCurrent(
    _ candidate: UInt64,
    attemptID: UUID? = nil,
    turnID: UUID? = nil
  ) -> Bool {
    guard candidate == generation, operation != nil, !Task.isCancelled else { return false }
    if let attemptID, activeAttemptID != attemptID { return false }
    if let turnID, activeTurnID != turnID { return false }
    return true
  }

  private func fail(
    generation candidate: UInt64,
    kind: AssistantConversationFailureKind,
    message: String
  ) {
    guard candidate == generation else { return }
    clearVoiceActivity()
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
