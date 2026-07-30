import Foundation
import NaturalLanguage
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
