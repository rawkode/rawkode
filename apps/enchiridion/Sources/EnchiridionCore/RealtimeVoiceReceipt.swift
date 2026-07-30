import Foundation

public enum RealtimeVoiceTurnCompletion: String, Codable, Equatable, Sendable {
  case completed
  case failed
  case cancelled
  case bargeIn
}

public enum RealtimeVoiceSessionCompletion: String, Codable, Equatable, Sendable {
  case completed
  case failed
  case cancelled
  case safetyPause
  case hardLimit
}

public struct RealtimeVoiceTurnReceipt: Codable, Equatable, Sendable {
  public let responseID: String
  public let inputItemID: String?
  public let inputTranscript: String?
  public let outputTranscript: String?
  public let completion: RealtimeVoiceTurnCompletion
  public let status: RealtimeResponseStatus?
  public let statusDetails: RealtimeResponseStatusDetails?
  public let usage: RealtimeTokenUsage?
  public let transcriptionUsage: RealtimeTranscriptionUsage?

  public init(
    responseID: String,
    inputItemID: String? = nil,
    inputTranscript: String? = nil,
    outputTranscript: String? = nil,
    completion: RealtimeVoiceTurnCompletion,
    status: RealtimeResponseStatus? = nil,
    statusDetails: RealtimeResponseStatusDetails? = nil,
    usage: RealtimeTokenUsage? = nil,
    transcriptionUsage: RealtimeTranscriptionUsage? = nil
  ) {
    self.responseID = responseID
    self.inputItemID = inputItemID
    self.inputTranscript = inputTranscript
    self.outputTranscript = outputTranscript
    self.completion = completion
    self.status = status
    self.statusDetails = statusDetails
    self.usage = usage
    self.transcriptionUsage = transcriptionUsage
  }
}

/// Ephemeral, immutable evidence for one OpenAI Realtime session. The core does
/// not persist this value or any caption/audio content.
public struct RealtimeVoiceReceipt: Equatable, Sendable {
  public let requestedModelID: String
  public let requestedVoiceID: String
  public let actualModelID: String?
  public let actualVoiceID: String?
  public let sessionID: String?
  public let requestIDs: [String]
  public let startedAt: Date
  public let endedAt: Date
  public let completion: RealtimeVoiceSessionCompletion
  public let failureCode: String?
  public let failureMessage: String?
  public let turns: [RealtimeVoiceTurnReceipt]

  public init(
    requestedModelID: String,
    requestedVoiceID: String,
    actualModelID: String? = nil,
    actualVoiceID: String? = nil,
    sessionID: String? = nil,
    requestIDs: [String] = [],
    startedAt: Date,
    endedAt: Date,
    completion: RealtimeVoiceSessionCompletion,
    failureCode: String? = nil,
    failureMessage: String? = nil,
    turns: [RealtimeVoiceTurnReceipt] = []
  ) {
    self.requestedModelID = requestedModelID
    self.requestedVoiceID = requestedVoiceID
    self.actualModelID = actualModelID
    self.actualVoiceID = actualVoiceID
    self.sessionID = sessionID
    self.requestIDs = requestIDs.reduce(into: []) { result, requestID in
      if !result.contains(requestID) { result.append(requestID) }
    }
    self.startedAt = startedAt
    self.endedAt = max(startedAt, endedAt)
    self.completion = completion
    self.failureCode = failureCode
    self.failureMessage = failureMessage
    self.turns = turns
  }
}
