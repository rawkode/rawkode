import Foundation

public enum RealtimeVoiceContractError: Error, Equatable, Sendable {
  case unauthorizedRoute(OpenAIVoiceAuthorizationFailure?)
  case modelNotAllowed(String?)
  case voiceNotAllowed(String?)
  case modelMismatch(expected: String, actual: String)
  case voiceMismatch(expected: String, actual: String)
}

public struct RealtimeSemanticVADConfiguration: Codable, Equatable, Sendable {
  public let type: String
  public let eagerness: String
  public let createResponse: Bool
  public let interruptResponse: Bool

  public init(
    type: String = "semantic_vad",
    eagerness: String = "auto",
    createResponse: Bool = true,
    interruptResponse: Bool = true
  ) {
    self.type = type
    self.eagerness = eagerness
    self.createResponse = createResponse
    self.interruptResponse = interruptResponse
  }
}

/// The only Realtime session configuration Loop 12 may send. It deliberately
/// has no tools, tracing, local context, or write capability.
public struct RealtimeVoiceConfiguration: Codable, Equatable, Sendable {
  public static let transcriptionModelID = "gpt-4o-mini-transcribe"
  public static let maximumOutputTokens = 1_024
  public static let instructions = """
    Be a concise, warm voice conversation partner. Greet the user briefly when the session begins. You cannot access notes, tasks, calendars, or any other local library content. If the user asks for local content, explain that OpenAI Voice cannot access it and offer Apple On Device voice or typed chat. Never claim that local content was searched or disclosed.
    """

  public let modelID: String
  public let voiceID: String
  public let outputModalities: [String]
  public let inputAudioTranscriptionModelID: String
  public let turnDetection: RealtimeSemanticVADConfiguration
  public let instructions: String
  public let maxOutputTokens: Int
  public let tracing: String?
  public let tools: [String]
  public let toolChoice: String

  public init(route: RealtimeVoiceRouteSnapshot) throws {
    guard route.isAuthorizedOpenAIRealtime else {
      throw RealtimeVoiceContractError.unauthorizedRoute(route.authorizationFailure)
    }
    guard let modelID = route.modelID,
      OpenAIModelCatalog.realtimeOptions.contains(where: { $0.id == modelID })
    else {
      throw RealtimeVoiceContractError.modelNotAllowed(route.modelID)
    }
    guard let voiceID = route.voiceID, OpenAIRealtimeVoiceCatalog.contains(voiceID) else {
      throw RealtimeVoiceContractError.voiceNotAllowed(route.voiceID)
    }
    self.modelID = modelID
    self.voiceID = voiceID
    outputModalities = ["audio"]
    inputAudioTranscriptionModelID = Self.transcriptionModelID
    turnDetection = RealtimeSemanticVADConfiguration()
    instructions = Self.instructions
    maxOutputTokens = Self.maximumOutputTokens
    tracing = nil
    tools = []
    toolChoice = "none"
  }

  public func validateActual(modelID actualModelID: String, voiceID actualVoiceID: String) throws {
    guard actualModelID == modelID else {
      throw RealtimeVoiceContractError.modelMismatch(expected: modelID, actual: actualModelID)
    }
    guard actualVoiceID == voiceID else {
      throw RealtimeVoiceContractError.voiceMismatch(expected: voiceID, actual: actualVoiceID)
    }
  }
}

/// Holds a standard BYOK credential only inside EnchiridionCore. It has no
/// public secret accessor and must be consumed by the native `/v1/realtime/calls`
/// transport, never serialized or passed into WebKit.
public struct RealtimeCredentialLease: @unchecked Sendable {
  let credential: String
  public let binding: OpenAICredentialBinding
  public var generation: String { binding.revision }

  init(credential: String, binding: OpenAICredentialBinding) {
    self.credential = credential
    self.binding = binding
  }

  /// Gives a native transport temporary access while constructing its exact
  /// Authorization header. The lease never exposes a stored public String and
  /// must not be retained, logged, serialized, or forwarded to web content.
  public func withSecret<Result>(
    _ body: (String) throws -> Result
  ) rethrows -> Result {
    try body(credential)
  }
}

public protocol RealtimeCredentialReading: Sendable {
  func realtimeCredential(
    matching binding: OpenAICredentialBinding
  ) async throws -> RealtimeCredentialLease
}

extension OpenAICredentialStore: RealtimeCredentialReading {
  public func realtimeCredential(
    matching binding: OpenAICredentialBinding
  ) async throws -> RealtimeCredentialLease {
    RealtimeCredentialLease(
      credential: try runtimeCredential(matching: binding),
      binding: binding
    )
  }
}

public enum RealtimeMicrophonePermission: Equatable, Sendable {
  case authorized
  case denied
  case restricted
}

public protocol RealtimeMicrophoneAuthorizing: Sendable {
  func requestPermission() async -> RealtimeMicrophonePermission
}

public protocol RealtimeAudioSessionControlling: Sendable {
  func activate() async throws
  func deactivate() async
}

public enum RealtimeClientCommand: Equatable, Sendable {
  case responseCancel(responseID: String?)
  case outputAudioBufferClear
  case inputAudioBufferClear
}

public protocol RealtimeVoiceTransport: Sendable {
  /// Starts with its input media track disabled. The session enables input only
  /// after consent, microphone permission, native key read, SDP exchange, and
  /// successful system-audio activation.
  func start(
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    credential: RealtimeCredentialLease
  ) async throws
  func events() -> AsyncStream<RealtimeServerEvent>
  func send(_ command: RealtimeClientCommand) async throws
  func setInputEnabled(_ enabled: Bool) async
  func close() async
}

public struct RealtimeSessionCreated: Equatable, Sendable {
  public let sessionID: String
  public let modelID: String
  public let voiceID: String
  public let requestID: String?

  public init(
    sessionID: String,
    modelID: String,
    voiceID: String,
    requestID: String? = nil
  ) {
    self.sessionID = sessionID
    self.modelID = modelID
    self.voiceID = voiceID
    self.requestID = requestID
  }
}

public struct RealtimeSpeechBoundary: Equatable, Sendable {
  public let itemID: String?
  public let audioOffsetMilliseconds: Int?

  public init(itemID: String? = nil, audioOffsetMilliseconds: Int? = nil) {
    self.itemID = itemID
    self.audioOffsetMilliseconds = audioOffsetMilliseconds
  }
}

public struct RealtimeTranscriptionUsage: Codable, Equatable, Sendable {
  public let inputTokens: Int
  public let audioTokens: Int
  public let textTokens: Int
  public let totalTokens: Int

  public init(
    inputTokens: Int = 0,
    audioTokens: Int = 0,
    textTokens: Int = 0,
    totalTokens: Int = 0
  ) {
    self.inputTokens = max(0, inputTokens)
    self.audioTokens = max(0, audioTokens)
    self.textTokens = max(0, textTokens)
    self.totalTokens = max(0, totalTokens)
  }
}

public struct RealtimeTranscriptDelta: Equatable, Sendable {
  public let itemID: String
  public let delta: String

  public init(itemID: String, delta: String) {
    self.itemID = itemID
    self.delta = delta
  }
}

public struct RealtimeTranscriptCompleted: Equatable, Sendable {
  public let itemID: String
  public let transcript: String
  public let usage: RealtimeTranscriptionUsage?

  public init(
    itemID: String,
    transcript: String,
    usage: RealtimeTranscriptionUsage? = nil
  ) {
    self.itemID = itemID
    self.transcript = transcript
    self.usage = usage
  }
}

public struct RealtimeTranscriptFailure: Equatable, Sendable {
  public let itemID: String
  public let code: String?
  public let message: String

  public init(itemID: String, code: String? = nil, message: String) {
    self.itemID = itemID
    self.code = code
    self.message = message
  }
}

public struct RealtimeResponseCreated: Equatable, Sendable {
  public let responseID: String

  public init(responseID: String) {
    self.responseID = responseID
  }
}

public struct RealtimeOutputTranscriptDelta: Equatable, Sendable {
  public let responseID: String
  public let itemID: String
  public let contentIndex: Int
  public let delta: String

  public init(responseID: String, itemID: String, contentIndex: Int, delta: String) {
    self.responseID = responseID
    self.itemID = itemID
    self.contentIndex = max(0, contentIndex)
    self.delta = delta
  }
}

public struct RealtimeOutputTranscriptDone: Equatable, Sendable {
  public let responseID: String
  public let itemID: String
  public let contentIndex: Int
  public let transcript: String

  public init(responseID: String, itemID: String, contentIndex: Int, transcript: String) {
    self.responseID = responseID
    self.itemID = itemID
    self.contentIndex = max(0, contentIndex)
    self.transcript = transcript
  }
}

public struct RealtimeTokenUsageDetails: Codable, Equatable, Sendable {
  public let textTokens: Int
  public let audioTokens: Int
  public let cachedTokens: Int

  public init(textTokens: Int = 0, audioTokens: Int = 0, cachedTokens: Int = 0) {
    self.textTokens = max(0, textTokens)
    self.audioTokens = max(0, audioTokens)
    self.cachedTokens = max(0, cachedTokens)
  }
}

public struct RealtimeTokenUsage: Codable, Equatable, Sendable {
  public let inputTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int
  public let inputDetails: RealtimeTokenUsageDetails
  public let outputDetails: RealtimeTokenUsageDetails

  public init(
    inputTokens: Int = 0,
    outputTokens: Int = 0,
    totalTokens: Int = 0,
    inputDetails: RealtimeTokenUsageDetails = RealtimeTokenUsageDetails(),
    outputDetails: RealtimeTokenUsageDetails = RealtimeTokenUsageDetails()
  ) {
    self.inputTokens = max(0, inputTokens)
    self.outputTokens = max(0, outputTokens)
    self.totalTokens = max(0, totalTokens)
    self.inputDetails = inputDetails
    self.outputDetails = outputDetails
  }
}

public enum RealtimeResponseStatus: String, Codable, Equatable, Sendable {
  case completed
  case cancelled
  case failed
  case incomplete
}

public struct RealtimeResponseStatusDetails: Codable, Equatable, Sendable {
  public let type: String?
  public let reason: String?
  public let errorCode: String?
  public let errorMessage: String?

  public init(
    type: String? = nil,
    reason: String? = nil,
    errorCode: String? = nil,
    errorMessage: String? = nil
  ) {
    self.type = type
    self.reason = reason
    self.errorCode = errorCode
    self.errorMessage = errorMessage
  }
}

public struct RealtimeResponseDone: Equatable, Sendable {
  public let responseID: String
  public let status: RealtimeResponseStatus
  public let statusDetails: RealtimeResponseStatusDetails?
  public let usage: RealtimeTokenUsage?

  public init(
    responseID: String,
    status: RealtimeResponseStatus,
    statusDetails: RealtimeResponseStatusDetails? = nil,
    usage: RealtimeTokenUsage? = nil
  ) {
    self.responseID = responseID
    self.status = status
    self.statusDetails = statusDetails
    self.usage = usage
  }
}

public struct RealtimeRateLimit: Codable, Equatable, Sendable {
  public let name: String
  public let limit: Int
  public let remaining: Int
  public let resetSeconds: Double

  public init(name: String, limit: Int, remaining: Int, resetSeconds: Double) {
    self.name = name
    self.limit = max(0, limit)
    self.remaining = max(0, remaining)
    self.resetSeconds = max(0, resetSeconds)
  }
}

public struct RealtimeCorrelatedError: Equatable, Sendable {
  public let eventID: String?
  public let responseID: String?
  public let code: String?
  public let message: String

  public init(
    eventID: String? = nil,
    responseID: String? = nil,
    code: String? = nil,
    message: String
  ) {
    self.eventID = eventID
    self.responseID = responseID
    self.code = code
    self.message = message
  }
}

public enum RealtimeServerEventPayload: Equatable, Sendable {
  case sessionCreated(RealtimeSessionCreated)
  case inputAudioSpeechStarted(RealtimeSpeechBoundary)
  case inputAudioSpeechStopped(RealtimeSpeechBoundary)
  case inputAudioTranscriptionDelta(RealtimeTranscriptDelta)
  case inputAudioTranscriptionCompleted(RealtimeTranscriptCompleted)
  case inputAudioTranscriptionFailed(RealtimeTranscriptFailure)
  case responseCreated(RealtimeResponseCreated)
  case outputAudioTranscriptDelta(RealtimeOutputTranscriptDelta)
  case outputAudioTranscriptDone(RealtimeOutputTranscriptDone)
  case responseDone(RealtimeResponseDone)
  case rateLimitsUpdated([RealtimeRateLimit])
  case error(RealtimeCorrelatedError)
  case outputAudioBufferCleared
}

public struct RealtimeServerEvent: Equatable, Sendable {
  public let eventID: String?
  public let payload: RealtimeServerEventPayload

  public init(eventID: String? = nil, payload: RealtimeServerEventPayload) {
    self.eventID = eventID
    self.payload = payload
  }
}

public enum RealtimeVoicePhase: Equatable, Sendable {
  case idle
  case requestingMicrophone
  case readingCredential
  case connecting
  case listening
  case userSpeaking
  case responding
  case assistantSpeaking
  case muted
  case paused(AssistantVoicePauseReason)
  case ending
  case ended
  case failed
}

public enum RealtimeCaptionRole: String, Codable, Equatable, Sendable {
  case user
  case assistant
}

public enum RealtimeCaptionStatus: String, Codable, Equatable, Sendable {
  case streaming
  case completed
  case failed
  case interrupted
}

public struct RealtimeCaption: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let role: RealtimeCaptionRole
  public var text: String
  public var status: RealtimeCaptionStatus

  public init(
    id: String,
    role: RealtimeCaptionRole,
    text: String,
    status: RealtimeCaptionStatus
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.status = status
  }
}
