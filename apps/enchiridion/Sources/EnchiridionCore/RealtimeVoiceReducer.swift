import Foundation

public struct RealtimeVoiceFailure: Error, Equatable, Sendable {
  public let code: String?
  public let message: String
  public let responseID: String?

  public init(code: String? = nil, message: String, responseID: String? = nil) {
    self.code = code
    self.message = message
    self.responseID = responseID
  }
}

public enum RealtimeVoiceReducerEffect: Equatable, Sendable {
  case send(RealtimeClientCommand)
  case terminate(RealtimeVoiceFailure)
}

public struct RealtimeVoiceReducerState: Equatable, Sendable {
  public internal(set) var phase: RealtimeVoicePhase = .idle
  public internal(set) var sessionID: String?
  public internal(set) var actualModelID: String?
  public internal(set) var actualVoiceID: String?
  public internal(set) var activeResponseID: String?
  public internal(set) var captions: [RealtimeCaption] = []
  public internal(set) var rateLimits: [RealtimeRateLimit] = []
  public internal(set) var requestIDs: [String] = []
  public internal(set) var turnReceipts: [RealtimeVoiceTurnReceipt] = []
  public internal(set) var failure: RealtimeVoiceFailure?
  public internal(set) var lastTranscriptionFailure: RealtimeTranscriptFailure?
  public internal(set) var didClearOutputBuffer = false

  public init() {}
}

/// A deterministic event reducer. Event IDs and terminal response IDs are
/// deduplicated so replayed or reordered WebRTC data-channel events cannot
/// duplicate captions, usage, or billing receipts.
public struct RealtimeVoiceReducer: Sendable {
  private struct InputTranscript: Sendable {
    var text = ""
    var usage: RealtimeTranscriptionUsage?
  }

  private struct ResponseAccumulator: Sendable {
    var inputItemID: String?
    var outputText = ""
  }

  public private(set) var state = RealtimeVoiceReducerState()

  private let configuration: RealtimeVoiceConfiguration
  private var seenEventIDs: Set<String> = []
  private var finalizedResponseIDs: Set<String> = []
  private var bargeInResponseIDs: Set<String> = []
  private var inputTranscripts: [String: InputTranscript] = [:]
  private var responses: [String: ResponseAccumulator] = [:]
  private var latestInputItemID: String?

  public init(configuration: RealtimeVoiceConfiguration) {
    self.configuration = configuration
  }

  public mutating func setLocalPhase(_ phase: RealtimeVoicePhase) {
    state.phase = phase
  }

  public mutating func markLocalFailure(_ failure: RealtimeVoiceFailure) {
    state.failure = failure
    state.phase = .failed
  }

  public mutating func finishActiveResponse(
    as completion: RealtimeVoiceTurnCompletion
  ) {
    guard let responseID = state.activeResponseID,
      !finalizedResponseIDs.contains(responseID)
    else { return }
    appendReceipt(
      responseID: responseID,
      completion: completion,
      status: nil,
      statusDetails: nil,
      usage: nil
    )
  }

  public mutating func reduce(_ event: RealtimeServerEvent) -> [RealtimeVoiceReducerEffect] {
    if let eventID = event.eventID {
      guard seenEventIDs.insert(eventID).inserted else { return [] }
    }

    switch event.payload {
    case .sessionCreated(let created):
      do {
        try configuration.validateActual(modelID: created.modelID, voiceID: created.voiceID)
      } catch {
        let failure = RealtimeVoiceFailure(
          code: "route_mismatch",
          message: String(describing: error)
        )
        markLocalFailure(failure)
        return [.terminate(failure)]
      }
      if let existingSessionID = state.sessionID, existingSessionID != created.sessionID {
        let failure = RealtimeVoiceFailure(
          code: "session_identity_changed",
          message: "OpenAI changed the Realtime session identity."
        )
        markLocalFailure(failure)
        return [.terminate(failure)]
      }
      state.sessionID = created.sessionID
      state.actualModelID = created.modelID
      state.actualVoiceID = created.voiceID
      appendRequestID(created.requestID)
      if state.phase == .connecting { state.phase = .listening }
      return []

    case .inputAudioSpeechStarted(let boundary):
      guard state.phase != .muted else {
        let failure = RealtimeVoiceFailure(
          code: "speech_received_while_muted",
          message: "OpenAI reported microphone speech while input was muted."
        )
        markLocalFailure(failure)
        return [.terminate(failure)]
      }
      latestInputItemID = boundary.itemID ?? latestInputItemID
      var effects: [RealtimeVoiceReducerEffect] = []
      if let responseID = state.activeResponseID,
        !finalizedResponseIDs.contains(responseID)
      {
        bargeInResponseIDs.insert(responseID)
        markAssistantCaption(responseID: responseID, status: .interrupted)
        effects = [
          .send(.responseCancel(responseID: responseID)),
          .send(.outputAudioBufferClear),
        ]
      }
      state.phase = .userSpeaking
      return effects

    case .inputAudioSpeechStopped(let boundary):
      latestInputItemID = boundary.itemID ?? latestInputItemID
      if state.phase != .muted { state.phase = .responding }
      return []

    case .inputAudioTranscriptionDelta(let delta):
      latestInputItemID = delta.itemID
      var transcript = inputTranscripts[delta.itemID] ?? InputTranscript()
      transcript.text += delta.delta
      inputTranscripts[delta.itemID] = transcript
      upsertCaption(
        id: "user:\(delta.itemID)",
        role: .user,
        text: transcript.text,
        status: .streaming
      )
      return []

    case .inputAudioTranscriptionCompleted(let completed):
      latestInputItemID = completed.itemID
      inputTranscripts[completed.itemID] = InputTranscript(
        text: completed.transcript,
        usage: completed.usage
      )
      if let responseID = state.activeResponseID,
        responses[responseID]?.inputItemID == nil
      {
        responses[responseID]?.inputItemID = completed.itemID
      }
      upsertCaption(
        id: "user:\(completed.itemID)",
        role: .user,
        text: completed.transcript,
        status: .completed
      )
      return []

    case .inputAudioTranscriptionFailed(let failure):
      latestInputItemID = failure.itemID
      state.lastTranscriptionFailure = failure
      let partial = inputTranscripts[failure.itemID]?.text ?? ""
      upsertCaption(
        id: "user:\(failure.itemID)",
        role: .user,
        text: partial.isEmpty ? "Transcription unavailable" : partial,
        status: .failed
      )
      if state.phase != .muted { state.phase = .listening }
      return []

    case .responseCreated(let created):
      guard !finalizedResponseIDs.contains(created.responseID) else { return [] }
      if responses[created.responseID] == nil {
        responses[created.responseID] = ResponseAccumulator(
          inputItemID: latestInputItemID,
          outputText: ""
        )
      }
      state.activeResponseID = created.responseID
      if state.phase != .muted { state.phase = .responding }
      return []

    case .outputAudioTranscriptDelta(let delta):
      guard !finalizedResponseIDs.contains(delta.responseID) else { return [] }
      var response = responses[delta.responseID]
        ?? ResponseAccumulator(inputItemID: latestInputItemID, outputText: "")
      response.outputText += delta.delta
      responses[delta.responseID] = response
      let wasInterrupted = bargeInResponseIDs.contains(delta.responseID)
      upsertCaption(
        id: "assistant:\(delta.responseID)",
        role: .assistant,
        text: response.outputText,
        status: wasInterrupted ? .interrupted : .streaming
      )
      if !wasInterrupted {
        state.activeResponseID = delta.responseID
        if state.phase != .muted { state.phase = .assistantSpeaking }
      }
      return []

    case .outputAudioTranscriptDone(let done):
      guard !finalizedResponseIDs.contains(done.responseID) else { return [] }
      var response = responses[done.responseID]
        ?? ResponseAccumulator(inputItemID: latestInputItemID, outputText: "")
      response.outputText = done.transcript
      responses[done.responseID] = response
      upsertCaption(
        id: "assistant:\(done.responseID)",
        role: .assistant,
        text: done.transcript,
        status: bargeInResponseIDs.contains(done.responseID) ? .interrupted : .completed
      )
      return []

    case .responseDone(let done):
      guard !finalizedResponseIDs.contains(done.responseID) else { return [] }
      let completedWasActive = state.activeResponseID == done.responseID
      let completion: RealtimeVoiceTurnCompletion
      if bargeInResponseIDs.contains(done.responseID) {
        completion = .bargeIn
      } else {
        completion = switch done.status {
        case .completed: .completed
        case .cancelled: .cancelled
        case .failed, .incomplete: .failed
        }
      }
      appendReceipt(
        responseID: done.responseID,
        completion: completion,
        status: done.status,
        statusDetails: done.statusDetails,
        usage: done.usage
      )
      if completedWasActive, state.phase != .muted { state.phase = .listening }
      return []

    case .rateLimitsUpdated(let rateLimits):
      state.rateLimits = rateLimits
      return []

    case .error(let error):
      appendRequestID(error.eventID)
      if let responseID = error.responseID,
        !finalizedResponseIDs.contains(responseID)
      {
        appendReceipt(
          responseID: responseID,
          completion: .failed,
          status: .failed,
          statusDetails: RealtimeResponseStatusDetails(
            type: "error",
            errorCode: error.code,
            errorMessage: error.message
          ),
          usage: nil
        )
      }
      let failure = RealtimeVoiceFailure(
        code: error.code,
        message: error.message,
        responseID: error.responseID
      )
      markLocalFailure(failure)
      return [.terminate(failure)]

    case .outputAudioBufferCleared:
      state.didClearOutputBuffer = true
      if let responseID = state.activeResponseID,
        bargeInResponseIDs.contains(responseID)
      {
        markAssistantCaption(responseID: responseID, status: .interrupted)
      }
      return []
    }
  }

  private mutating func appendReceipt(
    responseID: String,
    completion: RealtimeVoiceTurnCompletion,
    status: RealtimeResponseStatus?,
    statusDetails: RealtimeResponseStatusDetails?,
    usage: RealtimeTokenUsage?
  ) {
    guard finalizedResponseIDs.insert(responseID).inserted else { return }
    let response = responses[responseID]
      ?? ResponseAccumulator(inputItemID: latestInputItemID, outputText: "")
    let input = response.inputItemID.flatMap { inputTranscripts[$0] }
    state.turnReceipts.append(
      RealtimeVoiceTurnReceipt(
        responseID: responseID,
        inputItemID: response.inputItemID,
        inputTranscript: input?.text.nilIfEmpty,
        outputTranscript: response.outputText.nilIfEmpty,
        completion: completion,
        status: status,
        statusDetails: statusDetails,
        usage: usage,
        transcriptionUsage: input?.usage
      )
    )
    let captionStatus: RealtimeCaptionStatus = switch completion {
    case .completed: .completed
    case .failed: .failed
    case .cancelled, .bargeIn: .interrupted
    }
    markAssistantCaption(responseID: responseID, status: captionStatus)
    if state.activeResponseID == responseID { state.activeResponseID = nil }
  }

  private mutating func appendRequestID(_ requestID: String?) {
    guard let requestID, !requestID.isEmpty, !state.requestIDs.contains(requestID) else { return }
    state.requestIDs.append(requestID)
  }

  private mutating func upsertCaption(
    id: String,
    role: RealtimeCaptionRole,
    text: String,
    status: RealtimeCaptionStatus
  ) {
    if let index = state.captions.firstIndex(where: { $0.id == id }) {
      state.captions[index].text = text
      state.captions[index].status = status
    } else {
      state.captions.append(
        RealtimeCaption(id: id, role: role, text: text, status: status)
      )
    }
  }

  private mutating func markAssistantCaption(
    responseID: String,
    status: RealtimeCaptionStatus
  ) {
    guard let index = state.captions.firstIndex(where: { $0.id == "assistant:\(responseID)" })
    else { return }
    state.captions[index].status = status
  }
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
