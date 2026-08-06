import XCTest
import EnchiridionCore
import Foundation

@testable import Enchiridion

@MainActor
final class RealtimeWebRTCVoiceTransportTests: XCTestCase {
  func testInputLeaseFenceRejectsDelayedEnableAfterNewerDisable() {
    var fence = RealtimeWebRTCInputLeaseFence()
    let delayedEnable = RealtimeVoiceInputLease(transportGeneration: 7, inputEpoch: 11)
    let newerDisable = RealtimeVoiceInputLease(transportGeneration: 7, inputEpoch: 12)

    XCTAssertTrue(fence.install(delayedEnable, activeGeneration: 7, maximumEpoch: 9_007_199_254_740_991))
    XCTAssertTrue(fence.install(newerDisable, activeGeneration: 7, maximumEpoch: 9_007_199_254_740_991))
    XCTAssertFalse(fence.install(delayedEnable, activeGeneration: 7, maximumEpoch: 9_007_199_254_740_991))
    XCTAssertEqual(fence.newestLease, newerDisable)
  }

  func testInputLeaseFenceRejectsDelayedEnableAfterTerminalClose() {
    var fence = RealtimeWebRTCInputLeaseFence()
    let delayedEnable = RealtimeVoiceInputLease(transportGeneration: 7, inputEpoch: 11)
    XCTAssertTrue(fence.install(delayedEnable, activeGeneration: 7, maximumEpoch: 9_007_199_254_740_991))

    let terminal = fence.installTerminal(generation: 7, epoch: 9_007_199_254_740_991)
    XCTAssertFalse(fence.install(delayedEnable, activeGeneration: 7, maximumEpoch: 9_007_199_254_740_991))
    XCTAssertEqual(fence.newestLease, terminal)
  }

  func testOpenAIVoiceRetryEligibilityRequiresTerminalFailedSession() {
    let failedReceipt = RealtimeVoiceReceipt(
      requestedModelID: "gpt-realtime-mini",
      requestedVoiceID: "marin",
      startedAt: .distantPast,
      endedAt: .distantPast,
      completion: .failed
    )
    let cancelledReceipt = RealtimeVoiceReceipt(
      requestedModelID: "gpt-realtime-mini",
      requestedVoiceID: "marin",
      startedAt: .distantPast,
      endedAt: .distantPast,
      completion: .cancelled
    )

    XCTAssertFalse(RealtimeVoiceCoordinator.canRetry(phase: .listening, receipt: nil))
    XCTAssertFalse(RealtimeVoiceCoordinator.canRetry(phase: .ended, receipt: cancelledReceipt))
    XCTAssertFalse(RealtimeVoiceCoordinator.canRetry(phase: .failed, receipt: cancelledReceipt))
    XCTAssertTrue(RealtimeVoiceCoordinator.canRetry(phase: .failed, receipt: failedReceipt))
    XCTAssertTrue(
      RealtimeVoiceCoordinator.canRetry(
        phase: .paused(.interruption),
        receipt: nil,
        failure: RealtimeVoiceFailure(code: "server_error", message: "failed")
      )
    )
    XCTAssertFalse(
      RealtimeVoiceCoordinator.canRetry(
        phase: .paused(.interruption),
        receipt: nil,
        failure: nil
      )
    )
  }

  func testClosingCoordinatorInvalidatesQueuedRetryAndPreventsRestart() {
    var lifecycle = RealtimeVoiceCoordinatorLifecycleState()
    let queuedRetryGeneration = lifecycle.generation

    XCTAssertTrue(lifecycle.allowsRetry(requestGeneration: queuedRetryGeneration))
    lifecycle.close()

    XCTAssertTrue(lifecycle.isClosed)
    XCTAssertFalse(lifecycle.allowsRetry(requestGeneration: queuedRetryGeneration))
    XCTAssertFalse(lifecycle.allowsRetry(requestGeneration: lifecycle.generation))
  }

  func testOrbDescribesConcurrentActivityWithoutHiddenReasoningLanguage() {
    let description = VoiceActivityOrb.semanticDescription(
      VoiceActivitySnapshot(
        isListening: true,
        isPreparingResponse: true,
        isResponding: true,
        inputLevel: 0.4,
        outputLevel: 0.7
      )
    )

    XCTAssertEqual(description, "Listening · Preparing response · Responding")
    XCTAssertFalse(description.localizedCaseInsensitiveContains("thinking"))
  }

  func testActivityFloodNeverWakesOrClosesControlMailbox() async {
    let mailbox = RealtimeWebRTCVoiceTransport.BridgeEventQueue()
    let waitingControl = Task { await mailbox.next() }
    await Task.yield()

    for _ in 0 ..< 5_000 {
      let accepted = await mailbox.feedForTesting(
        .audioActivity(generation: 1, inputLevel: 0.5, outputLevel: 0)
      )
      XCTAssertTrue(accepted)
    }

    let acceptedOffer = await mailbox.feedForTesting(.offer(generation: 1, sdp: "offer"))
    XCTAssertTrue(acceptedOffer)
    let deliveredOffer = await waitingControl.value
    XCTAssertEqual(deliveredOffer, .offer(generation: 1, sdp: "offer"))

    let acceptedAnswer = await mailbox.feedForTesting(.answerApplied(generation: 1))
    let acceptedServerEvent = await mailbox.feedForTesting(.serverEvent(generation: 1, json: "{}"))
    let acceptedFailure = await mailbox.feedForTesting(.failure(generation: 1, code: "failed"))
    XCTAssertTrue(acceptedAnswer)
    XCTAssertTrue(acceptedServerEvent)
    XCTAssertTrue(acceptedFailure)
    let deliveredAnswer = await mailbox.next()
    let deliveredServerEvent = await mailbox.next()
    let deliveredFailure = await mailbox.next()
    XCTAssertEqual(deliveredAnswer, .answerApplied(generation: 1))
    XCTAssertEqual(deliveredServerEvent, .serverEvent(generation: 1, json: "{}"))
    XCTAssertEqual(deliveredFailure, .failure(generation: 1, code: "failed"))
  }

  @available(iOS 26.0, *)
  func testStaleOnDeviceCaptureCannotPublishIntoReplacementSubscription() async {
    let transcriber = OnDeviceSpeechTranscriber()
    _ = await transcriber.voiceActivity()
    let staleSubscriptionID = await transcriber.activitySubscriptionIDForTesting()

    let currentActivity = await transcriber.voiceActivity()
    let currentSubscriptionID = await transcriber.activitySubscriptionIDForTesting()
    await transcriber.publishActivityForTesting(0.9, subscriptionID: staleSubscriptionID)
    await transcriber.publishActivityForTesting(0.3, subscriptionID: currentSubscriptionID)

    var iterator = currentActivity.makeAsyncIterator()
    let deliveredLevel = await iterator.next()
    XCTAssertEqual(deliveredLevel, 0.3)
  }

  func testNativeAudioPreflightAcceptsEnvelopeSlightlyAboveCoreLimit() throws {
    let pcm = Data(repeating: 0, count: NativeRealtimeOutputAudioDeltaPreflight.maximumPCMBytes)
    let json = try nativeAudioEnvelope(delta: pcm.base64EncodedString())

    XCTAssertEqual(pcm.base64EncodedString().utf8.count, 64 * 1024)
    XCTAssertGreaterThan(json.utf8.count, RealtimeProtocolCodec.maximumEventBytes)
    XCTAssertLessThanOrEqual(json.utf8.count, NativeRealtimeOutputAudioDeltaPreflight.maximumEnvelopeBytes)
    guard case let .valid(delta) = NativeRealtimeOutputAudioDeltaPreflight.parse(json) else {
      return XCTFail("expected bounded native audio delta")
    }
    XCTAssertEqual(delta.pcm, pcm)
  }

  func testNativeAudioPreflightRejectsOversizedEnvelopeAndBase64() throws {
    let oversizedEnvelope = try nativeAudioEnvelope(
      delta: Data([0, 0]).base64EncodedString(),
      padding: String(repeating: "x", count: NativeRealtimeOutputAudioDeltaPreflight.maximumEnvelopeBytes)
    )
    XCTAssertEqual(NativeRealtimeOutputAudioDeltaPreflight.parse(oversizedEnvelope), .invalid)

    let oversizedBase64 = try nativeAudioEnvelope(
      delta: String(repeating: "A", count: NativeRealtimeOutputAudioDeltaPreflight.maximumBase64Bytes + 1)
    )
    XCTAssertEqual(NativeRealtimeOutputAudioDeltaPreflight.parse(oversizedBase64), .invalid)

    let whitespaceDelimitedOversizedAudio = """
    {
      "padding": "\(String(repeating: "x", count: NativeRealtimeOutputAudioDeltaPreflight.maximumEnvelopeBytes))",
      "type" : "response.output_audio.delta"
    }
    """
    XCTAssertEqual(NativeRealtimeOutputAudioDeltaPreflight.parse(whitespaceDelimitedOversizedAudio), .invalid)
  }

  func testNativeAudioPreflightRejectsInvalidBase64AndOddPCM() throws {
    XCTAssertEqual(
      NativeRealtimeOutputAudioDeltaPreflight.parse(try nativeAudioEnvelope(delta: "not base64!")),
      .invalid
    )
    XCTAssertEqual(
      NativeRealtimeOutputAudioDeltaPreflight.parse(
        try nativeAudioEnvelope(delta: Data([0, 0, 0]).base64EncodedString())
      ),
      .invalid
    )
  }

  func testNativeAudioPreflightRejectsBooleanAndNonIntegralContentIndex() throws {
    XCTAssertEqual(
      NativeRealtimeOutputAudioDeltaPreflight.parse(
        try nativeAudioEnvelope(delta: Data([0, 0]).base64EncodedString(), contentIndex: true)
      ),
      .invalid
    )
    XCTAssertEqual(
      NativeRealtimeOutputAudioDeltaPreflight.parse(
        try nativeAudioEnvelope(delta: Data([0, 0]).base64EncodedString(), contentIndex: 1.5)
      ),
      .invalid
    )
  }

  func testOversizedNonAudioStillUsesCoreCodecLimit() {
    let json = #"{\"type\":\"future.event\",\"value\":\""#
      + String(repeating: "x", count: RealtimeProtocolCodec.maximumEventBytes)
      + #"\"}"#
    XCTAssertEqual(NativeRealtimeOutputAudioDeltaPreflight.parse(json), .notAudio)
    XCTAssertThrowsError(try RealtimeProtocolCodec().decode(json)) { error in
      XCTAssertEqual(error as? RealtimeProtocolCodecError, .eventTooLarge)
    }
  }

  func testPlaybackLedgerIgnoresStaleGenerationAndCanceledResponseReuse() {
    var ledger = NativeRealtimePlaybackLedger()
    let oldPlaybackID = ledger.reserve(responseID: "response", itemID: "old", contentIndex: 0)
    let old = nativeRendered(playbackID: oldPlaybackID, itemID: "old")

    XCTAssertNil(ledger.complete(old, activeGeneration: 42))
    ledger.cancel(responseID: "response")
    let currentPlaybackID = ledger.reserve(responseID: "response", itemID: "new", contentIndex: 0)

    XCTAssertNil(ledger.complete(old, activeGeneration: 41))
    let current = nativeRendered(playbackID: currentPlaybackID, itemID: "new")
    XCTAssertNil(
      ledger.complete(
        nativeRendered(playbackID: currentPlaybackID, itemID: "mismatched"),
        activeGeneration: 41
      )
    )
    let completion = ledger.complete(current, activeGeneration: 41)
    XCTAssertEqual(completion?.responseID, "response")
    XCTAssertEqual(completion?.isDrained, true)

    let clearedPlaybackID = ledger.reserve(responseID: "other", itemID: "cleared", contentIndex: 0)
    ledger.cancelAll()
    XCTAssertNil(
      ledger.complete(
        nativeRendered(playbackID: clearedPlaybackID, responseID: "other", itemID: "cleared"),
        activeGeneration: 41
      )
    )
  }

  private func nativeAudioEnvelope(
    delta: String,
    padding: String? = nil,
    contentIndex: Any = 0
  ) throws -> String {
    var object: [String: Any] = [
      "type": "response.output_audio.delta",
      "response_id": "response",
      "item_id": "item",
      "content_index": contentIndex,
      "delta": delta,
    ]
    if let padding { object["padding"] = padding }
    return String(data: try JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
  }

  private func nativeRendered(
    playbackID: UInt64,
    responseID: String = "response",
    itemID: String
  ) -> NativeRealtimeRenderedBuffer {
    .init(
      generation: 41,
      playbackID: playbackID,
      responseID: responseID,
      itemID: itemID,
      contentIndex: 0,
      renderedFrames: 480
    )
  }
}
