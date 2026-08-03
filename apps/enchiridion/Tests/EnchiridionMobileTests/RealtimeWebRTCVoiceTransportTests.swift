import XCTest
import EnchiridionCore

@testable import Enchiridion

@MainActor
final class RealtimeWebRTCVoiceTransportTests: XCTestCase {
  func testOpenAIVoiceRetryEligibilityRequiresTerminalFailedSession() {
    let failedReceipt = RealtimeVoiceReceipt(
      requestedModelID: "gpt-realtime-2.1-mini",
      requestedVoiceID: "marin",
      startedAt: .distantPast,
      endedAt: .distantPast,
      completion: .failed
    )
    let cancelledReceipt = RealtimeVoiceReceipt(
      requestedModelID: "gpt-realtime-2.1-mini",
      requestedVoiceID: "marin",
      startedAt: .distantPast,
      endedAt: .distantPast,
      completion: .cancelled
    )

    XCTAssertFalse(RealtimeVoiceCoordinator.canRetry(phase: .listening, receipt: nil))
    XCTAssertFalse(RealtimeVoiceCoordinator.canRetry(phase: .ended, receipt: cancelledReceipt))
    XCTAssertFalse(RealtimeVoiceCoordinator.canRetry(phase: .failed, receipt: cancelledReceipt))
    XCTAssertTrue(RealtimeVoiceCoordinator.canRetry(phase: .failed, receipt: failedReceipt))
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
}
