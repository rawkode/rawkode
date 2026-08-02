import Foundation

public enum RealtimeProtocolCodecError: Error, Equatable, Sendable {
  case eventTooLarge
  case malformedEnvelope
  case malformedKnownEvent(String)
  case invalidClientCommand
}

/// A bounded codec for the small subset of Realtime events consumed by the
/// reducer. Unknown event types are ignored so additive server changes cannot
/// make an otherwise healthy voice session fail; malformed recognised events
/// are rejected before they reach the reducer.
public struct RealtimeProtocolCodec: Sendable {
  public static let maximumEventBytes = 64 * 1024
  public static let maximumClientCommandBytes = 4 * 1024

  public init() {}

  public func decode(_ json: String) throws -> RealtimeServerEvent? {
    guard json.utf8.count <= Self.maximumEventBytes,
      let data = json.data(using: .utf8)
    else { throw RealtimeProtocolCodecError.eventTooLarge }
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = string(root["type"], maximum: 128), !type.isEmpty
    else { throw RealtimeProtocolCodecError.malformedEnvelope }
    let eventID = optionalString(root["event_id"], maximum: 256)

    switch type {
    case "session.created":
      let session = try object(root["session"], event: type)
      let audio = try object(session["audio"], event: type)
      let output = try object(audio["output"], event: type)
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .sessionCreated(
          RealtimeSessionCreated(
            sessionID: try requiredString(session["id"], event: type),
            modelID: try requiredString(session["model"], event: type),
            voiceID: try requiredString(output["voice"], event: type)
          )
        )
      )

    case "input_audio_buffer.speech_started":
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .inputAudioSpeechStarted(
          RealtimeSpeechBoundary(
            itemID: optionalString(root["item_id"], maximum: 256),
            audioOffsetMilliseconds: try optionalInteger(root["audio_start_ms"], event: type)
          )
        )
      )

    case "input_audio_buffer.speech_stopped":
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .inputAudioSpeechStopped(
          RealtimeSpeechBoundary(
            itemID: optionalString(root["item_id"], maximum: 256),
            audioOffsetMilliseconds: try optionalInteger(root["audio_end_ms"], event: type)
          )
        )
      )

    case "conversation.item.input_audio_transcription.delta":
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .inputAudioTranscriptionDelta(
          RealtimeTranscriptDelta(
            itemID: try requiredString(root["item_id"], event: type),
            delta: try requiredString(root["delta"], event: type, maximum: 16 * 1024)
          )
        )
      )

    case "conversation.item.input_audio_transcription.completed":
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .inputAudioTranscriptionCompleted(
          RealtimeTranscriptCompleted(
            itemID: try requiredString(root["item_id"], event: type),
            transcript: try requiredString(root["transcript"], event: type, maximum: 16 * 1024),
            usage: try transcriptionUsage(root["usage"], event: type)
          )
        )
      )

    case "conversation.item.input_audio_transcription.failed":
      let error = try object(root["error"], event: type)
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .inputAudioTranscriptionFailed(
          RealtimeTranscriptFailure(
            itemID: try requiredString(root["item_id"], event: type),
            code: optionalCode(error["code"] ?? error["type"]),
            message: "OpenAI Voice could not transcribe that audio."
          )
        )
      )

    case "response.created":
      let response = try object(root["response"], event: type)
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .responseCreated(
          RealtimeResponseCreated(responseID: try requiredString(response["id"], event: type))
        )
      )

    case "response.output_audio_transcript.delta":
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .outputAudioTranscriptDelta(
          RealtimeOutputTranscriptDelta(
            responseID: try requiredString(root["response_id"], event: type),
            itemID: try requiredString(root["item_id"], event: type),
            contentIndex: try requiredInteger(root["content_index"], event: type),
            delta: try requiredString(root["delta"], event: type, maximum: 16 * 1024)
          )
        )
      )

    case "response.output_audio_transcript.done":
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .outputAudioTranscriptDone(
          RealtimeOutputTranscriptDone(
            responseID: try requiredString(root["response_id"], event: type),
            itemID: try requiredString(root["item_id"], event: type),
            contentIndex: try requiredInteger(root["content_index"], event: type),
            transcript: try requiredString(root["transcript"], event: type, maximum: 16 * 1024)
          )
        )
      )

    case "response.done":
      let response = try object(root["response"], event: type)
      guard let statusValue = string(response["status"], maximum: 32),
        let status = RealtimeResponseStatus(rawValue: statusValue)
      else { throw malformed(type) }
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .responseDone(
          RealtimeResponseDone(
            responseID: try requiredString(response["id"], event: type),
            status: status,
            statusDetails: try responseStatusDetails(response["status_details"], event: type),
            usage: try tokenUsage(response["usage"], event: type)
          )
        )
      )

    case "rate_limits.updated":
      guard let values = root["rate_limits"] as? [Any], values.count <= 32 else { throw malformed(type) }
      let limits = try values.map { value -> RealtimeRateLimit in
        let limit = try object(value, event: type)
        return RealtimeRateLimit(
          name: try requiredString(limit["name"], event: type),
          limit: try requiredInteger(limit["limit"], event: type),
          remaining: try requiredInteger(limit["remaining"], event: type),
          resetSeconds: try requiredNumber(limit["reset_seconds"], event: type)
        )
      }
      return RealtimeServerEvent(eventID: eventID, payload: .rateLimitsUpdated(limits))

    case "error":
      let error = try object(root["error"], event: type)
      return RealtimeServerEvent(
        eventID: eventID,
        payload: .error(
          RealtimeCorrelatedError(
            eventID: eventID,
            responseID: optionalString(error["response_id"], maximum: 256),
            code: optionalCode(error["code"] ?? error["type"]),
            message: "OpenAI Voice reported a connection error."
          )
        )
      )

    case "output_audio_buffer.cleared":
      return RealtimeServerEvent(eventID: eventID, payload: .outputAudioBufferCleared)

    default:
      return nil
    }
  }

  public func encode(_ command: RealtimeClientCommand) throws -> String {
    let object: [String: String]
    switch command {
    case .responseCancel:
      // The wire protocol cancels the active response. The reducer's optional
      // ID remains local correlation only and is never used as remote input.
      object = ["type": "response.cancel"]
    case .outputAudioBufferClear:
      object = ["type": "output_audio_buffer.clear"]
    case .inputAudioBufferClear:
      object = ["type": "input_audio_buffer.clear"]
    }
    guard JSONSerialization.isValidJSONObject(object),
      let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
      data.count <= Self.maximumClientCommandBytes,
      let encoded = String(data: data, encoding: .utf8)
    else { throw RealtimeProtocolCodecError.invalidClientCommand }
    return encoded
  }

  private func object(_ value: Any?, event: String) throws -> [String: Any] {
    guard let value = value as? [String: Any], value.count <= 64 else { throw malformed(event) }
    return value
  }

  private func requiredString(_ value: Any?, event: String, maximum: Int = 512) throws -> String {
    guard let value = string(value, maximum: maximum), !value.isEmpty else { throw malformed(event) }
    return value
  }

  private func optionalString(_ value: Any?, maximum: Int) -> String? {
    guard let value else { return nil }
    return string(value, maximum: maximum)
  }

  private func string(_ value: Any?, maximum: Int) -> String? {
    guard let value = value as? String, value.utf8.count <= maximum else { return nil }
    return value
  }

  private func requiredInteger(_ value: Any?, event: String) throws -> Int {
    guard let value = integer(value), value >= 0 else { throw malformed(event) }
    return value
  }

  private func optionalInteger(_ value: Any?, event: String) throws -> Int? {
    guard let value else { return nil }
    return try requiredInteger(value, event: event)
  }

  private func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded(.towardZero) == double,
      double >= 0, double <= Double(Int.max)
    else { return nil }
    return Int(double)
  }

  private func requiredNumber(_ value: Any?, event: String) throws -> Double {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite, number.doubleValue >= 0
    else { throw malformed(event) }
    return number.doubleValue
  }

  private func optionalCode(_ value: Any?) -> String? {
    guard let value = string(value, maximum: 128), !value.isEmpty,
      value.unicodeScalars.allSatisfy({ scalar in
        CharacterSet.alphanumerics.contains(scalar) || "-_.".unicodeScalars.contains(scalar)
      })
    else { return nil }
    return value
  }

  private func transcriptionUsage(_ value: Any?, event: String) throws -> RealtimeTranscriptionUsage? {
    guard let value else { return nil }
    let usage = try object(value, event: event)
    return RealtimeTranscriptionUsage(
      inputTokens: try requiredInteger(usage["input_tokens"] ?? 0, event: event),
      audioTokens: try requiredInteger(usage["audio_tokens"] ?? 0, event: event),
      textTokens: try requiredInteger(usage["text_tokens"] ?? 0, event: event),
      totalTokens: try requiredInteger(usage["total_tokens"] ?? 0, event: event)
    )
  }

  private func responseStatusDetails(
    _ value: Any?,
    event: String
  ) throws -> RealtimeResponseStatusDetails? {
    guard let value else { return nil }
    let details = try object(value, event: event)
    let nestedError = details["error"] as? [String: Any]
    return RealtimeResponseStatusDetails(
      type: optionalString(details["type"], maximum: 128),
      reason: optionalString(details["reason"], maximum: 256),
      errorCode: optionalCode(
        nestedError?["code"] ?? nestedError?["type"] ?? details["error_code"]
      ),
      errorMessage: nil
    )
  }

  private func tokenUsage(_ value: Any?, event: String) throws -> RealtimeTokenUsage? {
    guard let value else { return nil }
    let usage = try object(value, event: event)
    let inputDetails = try tokenUsageDetails(usage["input_token_details"], event: event)
    let outputDetails = try tokenUsageDetails(usage["output_token_details"], event: event)
    return RealtimeTokenUsage(
      inputTokens: try requiredInteger(usage["input_tokens"] ?? 0, event: event),
      outputTokens: try requiredInteger(usage["output_tokens"] ?? 0, event: event),
      totalTokens: try requiredInteger(usage["total_tokens"] ?? 0, event: event),
      inputDetails: inputDetails,
      outputDetails: outputDetails
    )
  }

  private func tokenUsageDetails(_ value: Any?, event: String) throws -> RealtimeTokenUsageDetails {
    guard let value else { return RealtimeTokenUsageDetails() }
    let details = try object(value, event: event)
    return RealtimeTokenUsageDetails(
      textTokens: try requiredInteger(details["text_tokens"] ?? 0, event: event),
      audioTokens: try requiredInteger(details["audio_tokens"] ?? 0, event: event),
      cachedTokens: try requiredInteger(details["cached_tokens"] ?? 0, event: event)
    )
  }

  private func malformed(_ event: String) -> RealtimeProtocolCodecError {
    .malformedKnownEvent(event)
  }
}
