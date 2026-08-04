import Foundation
import OSLog

/// Deliberately small, allowlisted voice diagnostics.  This is not telemetry:
/// it has no credential, SDP, server event, transcript, audio, or route data.
public enum OpenAIRealtimeVoiceDiagnosticStage: String, Codable, Sendable {
  case sessionStart, microphone, credential, transportStart, bootstrapRequest
  case bootstrapResponse, bridgeReady, offer, answerApplied, dataChannel, ice, audioSession
  case input, safety, webProcess, listening, terminal
}

/// A closed vocabulary for diagnostic causes. It never carries provider text,
/// NSError descriptions, bridge payloads, routes, or server content.
public enum OpenAIRealtimeVoiceDiagnosticReason: String, Codable, Sendable {
  case cancelled, controlTimedOut, bridgeClosed, bridgeFailure, unavailable
  case microphoneDenied, microphoneRestricted, credentialUnavailable
  case audioActivationFailed, inputEnableFailed, inputDisableFailed
  case providerErrorOther
  case safetyInterruption, mediaServicesRestarted, webContentProcessTerminated
  case routeMismatch, other
}

public enum OpenAIRealtimeVoiceDiagnosticInputDirection: String, Codable, Sendable {
  case enable, disable
}

public enum OpenAIRealtimeVoiceDiagnosticOutcome: String, Codable, Sendable {
  case started, succeeded, failed, cancelled, closed, timedOut, stale
}

public struct OpenAIRealtimeVoiceAttemptToken: Equatable, Sendable {
  fileprivate let rawValue: String
  public static func make() -> Self {
    Self(rawValue: String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16)).lowercased())
  }
}

/// Minted once by `RealtimeVoiceSession` and passed through every OpenAI
/// transport/bridge diagnostic emission for that attempt.
public struct OpenAIRealtimeVoiceDiagnosticContext: Equatable, Sendable {
  public let attemptToken: OpenAIRealtimeVoiceAttemptToken
  public let generation: UInt64
  public init(attemptToken: OpenAIRealtimeVoiceAttemptToken, generation: UInt64) {
    self.attemptToken = attemptToken
    self.generation = generation
  }
}

public struct OpenAIRealtimeVoiceDiagnosticEvent: Equatable, Sendable {
  public let stage: OpenAIRealtimeVoiceDiagnosticStage
  public let outcome: OpenAIRealtimeVoiceDiagnosticOutcome
  public let generation: UInt64?
  public let attemptToken: OpenAIRealtimeVoiceAttemptToken?
  public let httpStatus: Int?
  public let modelID: String?
  public let voiceID: String?
  public let requestID: String?
  public let reason: OpenAIRealtimeVoiceDiagnosticReason?
  public let inputDirection: OpenAIRealtimeVoiceDiagnosticInputDirection?

  public init(stage: OpenAIRealtimeVoiceDiagnosticStage, outcome: OpenAIRealtimeVoiceDiagnosticOutcome,
              generation: UInt64? = nil, attemptToken: OpenAIRealtimeVoiceAttemptToken? = nil, httpStatus: Int? = nil,
              modelID: String? = nil, voiceID: String? = nil, requestID: String? = nil,
              reason: OpenAIRealtimeVoiceDiagnosticReason? = nil,
              inputDirection: OpenAIRealtimeVoiceDiagnosticInputDirection? = nil) {
    self.stage = stage; self.outcome = outcome; self.generation = generation
    self.attemptToken = attemptToken
    self.httpStatus = httpStatus.map { min(max($0, 0), 999) }
    self.modelID = OpenAIModelCatalog.realtimeOptions.contains(where: { $0.id == modelID }) ? modelID : nil
    self.voiceID = OpenAIRealtimeVoiceCatalog.contains(voiceID ?? "") ? voiceID : nil
    self.requestID = Self.sanitizedRequestID(requestID)
    self.reason = reason
    self.inputDirection = inputDirection
  }

  private static func sanitizedRequestID(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value.utf8.count <= 128,
      value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    else { return nil }
    return value
  }
}

public protocol OpenAIRealtimeVoiceDiagnosticSinking: Sendable {
  func record(_ event: OpenAIRealtimeVoiceDiagnosticEvent)
}

public struct OpenAIRealtimeVoiceNoopDiagnosticSink: OpenAIRealtimeVoiceDiagnosticSinking {
  public init() {}
  public func record(_: OpenAIRealtimeVoiceDiagnosticEvent) {}
}

public struct OpenAIRealtimeVoiceOSLogDiagnosticSink: OpenAIRealtimeVoiceDiagnosticSinking {
  private let logger = Logger(subsystem: "dev.rawkode.enchiridion", category: "OpenAIRealtimeVoice")
  public init() {}
  public func record(_ event: OpenAIRealtimeVoiceDiagnosticEvent) {
    // All interpolation is from the typed allowlist above.
    logger.notice("voice stage=\(event.stage.rawValue, privacy: .public) outcome=\(event.outcome.rawValue, privacy: .public) reason=\(event.reason?.rawValue ?? "", privacy: .public) generation=\(event.generation ?? 0, privacy: .public) attempt=\(event.attemptToken?.rawValue ?? "", privacy: .public) status=\(event.httpStatus ?? 0, privacy: .public) model=\(event.modelID ?? "", privacy: .public) voice=\(event.voiceID ?? "", privacy: .public) request=\(event.requestID ?? "", privacy: .public)")
  }
}
