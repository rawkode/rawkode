import XCTest
@testable import EnchiridionCore

final class RealtimeProtocolCodecTests: XCTestCase {
  func testDecodesSessionCreatedWithModelAndVoice() throws {
    let json = #"""
      {
      "type":"session.created",
      "event_id":"evt_session",
      "session":{
        "id":"sess_123",
        "model":"gpt-realtime-mini",
        "audio":{
          "output":{"voice":"marin"}
        }
      }
      }
      """#

    let event = try RealtimeProtocolCodec().decode(json)

    XCTAssertEqual(
      event,
      RealtimeServerEvent(
        eventID: "evt_session",
        payload: .sessionCreated(
          RealtimeSessionCreated(
            sessionID: "sess_123",
            modelID: "gpt-realtime-mini",
            voiceID: "marin"
          )
        )
      )
    )
  }

  func testDecodesTranscriptAndResponseEvents() throws {
    let codec = RealtimeProtocolCodec()

    let transcript = try codec.decode(#"""
      {
      "type":"conversation.item.input_audio_transcription.completed",
      "event_id":"evt_transcript",
      "item_id":"item_1",
      "transcript":"The quick brown fox.",
      "usage":{"input_tokens":3,"audio_tokens":4,"text_tokens":5,"total_tokens":12}
      }
      """#)
    XCTAssertEqual(
      transcript,
      RealtimeServerEvent(
        eventID: "evt_transcript",
        payload: .inputAudioTranscriptionCompleted(
          RealtimeTranscriptCompleted(
            itemID: "item_1",
            transcript: "The quick brown fox.",
            usage: RealtimeTranscriptionUsage(
              inputTokens: 3,
              audioTokens: 4,
              textTokens: 5,
              totalTokens: 12
            )
          )
        )
      )
    )

    let response = try codec.decode(#"""
      {
      "type":"response.output_audio_transcript.delta",
      "response_id":"resp_1",
      "item_id":"item_2",
      "content_index":0,
      "delta":"Hello"
      }
      """#)
    XCTAssertEqual(
      response,
      RealtimeServerEvent(
        payload: .outputAudioTranscriptDelta(
          RealtimeOutputTranscriptDelta(
            responseID: "resp_1",
            itemID: "item_2",
            contentIndex: 0,
            delta: "Hello"
          )
        )
      )
    )
  }

  func testIgnoresUnknownEventTypes() throws {
    XCTAssertNil(try RealtimeProtocolCodec().decode(#"{"type":"future.event","value":42}"#))
  }

  func testPreservesSafeServerErrorCodeInVoiceFailureMessage() throws {
    let event = try RealtimeProtocolCodec().decode(#"""
      {"type":"error",
      "event_id":"evt_error",
      "error":{"type":"invalid_request_error","message":"private server detail"}
    }
    """#)

    guard case let .error(error) = event?.payload else {
      return XCTFail("Expected a decoded Realtime error")
    }
    XCTAssertEqual(error.code, "invalid_request_error")
    XCTAssertEqual(
      error.message,
      "OpenAI Voice reported a connection error (invalid_request_error)."
    )
    XCTAssertFalse(error.message.contains("private server detail"))
  }

  func testRejectsMalformedKnownEventAndOversizedInput() {
    XCTAssertThrowsError(
      try RealtimeProtocolCodec().decode(#"{"type":"session.created","session":{}}"#)
    ) { error in
      XCTAssertEqual(
        error as? RealtimeProtocolCodecError,
        .malformedKnownEvent("session.created")
      )
    }

    let oversized = String(repeating: "x", count: RealtimeProtocolCodec.maximumEventBytes + 1)
    XCTAssertThrowsError(try RealtimeProtocolCodec().decode(oversized)) { error in
      XCTAssertEqual(error as? RealtimeProtocolCodecError, .eventTooLarge)
    }
  }

  func testEncodesAllClientCommandsWithoutWireResponseID() throws {
    let codec = RealtimeProtocolCodec()
    let commands: [(RealtimeClientCommand, String)] = [
      (.responseCancel(responseID: "local-only-response-id"), #"{"type":"response.cancel"}"#),
      (.outputAudioBufferClear, #"{"type":"output_audio_buffer.clear"}"#),
      (.inputAudioBufferClear, #"{"type":"input_audio_buffer.clear"}"#),
    ]

    for (command, expected) in commands {
      let encoded = try codec.encode(command)
      XCTAssertEqual(encoded, expected)
      XCTAssertFalse(encoded.contains("local-only-response-id"))
      XCTAssertFalse(encoded.contains("response_id"))
    }
  }
}
