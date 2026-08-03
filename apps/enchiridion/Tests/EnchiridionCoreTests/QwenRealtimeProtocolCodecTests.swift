import XCTest
@testable import EnchiridionCore

final class QwenRealtimeProtocolCodecTests: XCTestCase {
  func testHandshakeRequiresCreatedThenExactUpdatedPayloads() throws {
    let codec = QwenRealtimeProtocolCodec()
    XCTAssertEqual(
      try codec.decode(#"{"type":"session.created","session":{"id":"s1","model":"qwen-audio-3.0-realtime-flash"}}"#),
      .sessionCreated(.init(sessionID: "s1", modelID: "qwen-audio-3.0-realtime-flash"))
    )
    XCTAssertEqual(
      try codec.decode(#"{"type":"session.updated","session":{"id":"s1","model":"qwen-audio-3.0-realtime-flash","voice":"longanqian"}}"#),
      .sessionUpdated(.init(sessionID: "s1", modelID: "qwen-audio-3.0-realtime-flash", voiceID: "longanqian"))
    )
  }

  func testDecodesAudioTranscriptsAndMultipleFunctionCalls() throws {
    let codec = QwenRealtimeProtocolCodec()
    let audio = Data([1, 2, 3])
    XCTAssertEqual(
      try codec.decode(#"{"type":"response.audio.delta","delta":"AQID"}"#),
      .outputAudio(audio)
    )
    XCTAssertEqual(
      try codec.decode(#"{"type":"response.output_item.added","response_id":"r1","item":{"type":"function_call","call_id":"c1","name":"create_task"}}"#),
      .functionCallAdded(id: "c1", name: "create_task", responseID: "r1")
    )
    XCTAssertEqual(
      try codec.decode(#"{"type":"response.function_call_arguments.done","call_id":"c1","arguments":"{\"title\":\"Call\"}"}"#),
      .functionCallArgumentsDone(id: "c1", argumentsJSON: #"{"title":"Call"}"#)
    )
  }

  func testEncodesSmartTurnPcmConfigurationAndBoundedAudio() throws {
    let codec = QwenRealtimeProtocolCodec()
    let update = try codec.encode(
      .sessionUpdate(
        modelID: "qwen-audio-3.0-realtime-plus",
        voiceID: "longanqian",
        enablesTools: true
      )
    )
    XCTAssertTrue(update.contains(#""type":"smart_turn""#))
    XCTAssertTrue(update.contains(#""input_audio_format":"pcm""#))
    XCTAssertTrue(update.contains(#""create_task""#))
    XCTAssertTrue(update.contains(#""tool_choice":"auto""#))
    XCTAssertTrue(update.contains(#""output_audio_format":"pcm""#))
    XCTAssertThrowsError(try codec.encode(.appendInputAudio(Data(repeating: 1, count: QwenRealtimeProtocolCodec.maximumAudioBytes + 1))))
  }

  func testRejectsMalformedArgumentsAndOversizedEvents() {
    let codec = QwenRealtimeProtocolCodec()
    XCTAssertThrowsError(try codec.decode(#"{"type":"response.function_call_arguments.done","call_id":"c1","arguments":"nope"}"#))
    XCTAssertThrowsError(try codec.decode(String(repeating: "x", count: QwenRealtimeProtocolCodec.maximumEventBytes + 1)))
  }
}
