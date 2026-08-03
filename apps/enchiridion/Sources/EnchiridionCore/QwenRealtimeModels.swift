import Foundation

/// The Qwen websocket boundary is deliberately separate from OpenAI Realtime.
/// A Qwen key is only ever consumed by this native transport.
public enum QwenRealtimeError: Error, Equatable, Sendable {
  case invalidEndpoint
  case redirectBlocked
  case credentialMismatch
  case handshakeFailed
  case malformedEvent
  case eventTooLarge
  case closed
  case unsupportedCommand
}

public enum QwenRealtimePhase: Equatable, Sendable {
  case idle
  case connecting
  case listening
  case userSpeaking
  case responding
  case muted
  case ending
  case ended
  case failed(String)
}

public struct QwenRealtimeCaption: Equatable, Identifiable, Sendable {
  public enum Role: String, Equatable, Sendable { case user, assistant }
  public enum Status: Equatable, Sendable { case streaming, completed, interrupted, failed }
  public let id: String
  public let role: Role
  public var text: String
  public var status: Status

  public init(id: String, role: Role, text: String = "", status: Status = .streaming) {
    self.id = id
    self.role = role
    self.text = text
    self.status = status
  }
}

/// A model-supplied mutation is only a proposal. The application must render a
/// native confirmation before an executor may consume it.
public struct QwenPendingMutation: Equatable, Sendable, Identifiable {
  public let id: String
  public let name: String
  public let argumentsJSON: String
  public init(id: String, name: String, argumentsJSON: String) {
    self.id = id
    self.name = name
    self.argumentsJSON = argumentsJSON
  }
}

public protocol QwenVoiceMutationHandling: Sendable {
  func receive(_ mutation: QwenPendingMutation) async
}

/// The small presentation contract shared by voice surfaces without coupling
/// them to a vendor transport or tool executor.
@MainActor
public protocol QwenRealtimeVoicePresenting: AnyObject {
  var phase: QwenRealtimePhase { get }
  var captions: [QwenRealtimeCaption] { get }
  var voiceActivity: VoiceActivitySnapshot { get }
  var pendingMutations: [QwenPendingMutation] { get }
  func start() async
  func stop() async
  func setMuted(_ muted: Bool) async
  func confirmMutation(id: String) async
  func rejectMutation(id: String) async
}

public struct QwenRealtimeSessionCreated: Equatable, Sendable {
  public let sessionID: String
  public let modelID: String
  public let voiceID: String?
  public init(sessionID: String, modelID: String, voiceID: String? = nil) {
    self.sessionID = sessionID
    self.modelID = modelID
    self.voiceID = voiceID
  }
}

public enum QwenRealtimeServerEvent: Equatable, Sendable {
  case sessionCreated(QwenRealtimeSessionCreated)
  case sessionUpdated(QwenRealtimeSessionCreated)
  case speechStarted
  case speechStopped
  case inputTranscriptDelta(id: String, text: String)
  case inputTranscriptDone(id: String, text: String)
  case outputTranscriptDelta(id: String, text: String)
  case outputTranscriptDone(id: String, text: String)
  case outputAudio(Data)
  case responseCreated(id: String, inputItemID: String?)
  case functionCallAdded(id: String, name: String, responseID: String?)
  case functionCallArgumentsDone(id: String, argumentsJSON: String)
  case responseDone(id: String?, cancelled: Bool)
  case error(code: String?, message: String)
}

public enum QwenRealtimeClientEvent: Equatable, Sendable {
  case sessionUpdate(modelID: String, voiceID: String, enablesTools: Bool)
  case appendInputAudio(Data)
  case responseCreate
  case responseCancel
  case inputAudioBufferClear
  case outputAudioBufferClear
  case functionOutput(callID: String, outputJSON: String)
}

@MainActor
public protocol QwenRealtimeTransport: Sendable {
  func start(
    generation: UInt64,
    route: QwenVoiceRouteSnapshot,
    configuration: QwenRealtimeConfiguration,
    credential: QwenRealtimeCredentialLease
  ) async throws -> QwenRealtimeSessionCreated
  func events() -> AsyncStream<QwenRealtimeServerEvent>
  func activity() -> AsyncStream<RealtimeAudioActivitySample>
  func send(_ event: QwenRealtimeClientEvent) async throws
  func setMuted(_ muted: Bool) async throws
  func close() async
}
