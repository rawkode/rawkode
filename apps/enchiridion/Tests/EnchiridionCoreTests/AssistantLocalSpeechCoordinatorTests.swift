import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class AssistantLocalSpeechCoordinatorTests: XCTestCase {
  func testPreviewDeclinesWhileAssistantOrCarPlayOwnsSpeech() throws {
    for owner in [AssistantLocalSpeechOwner.assistant, .carPlay] {
      let coordinator = AssistantLocalSpeechCoordinator()
      let conversation = try XCTUnwrap(coordinator.acquire(owner: owner, stop: {}))

      XCTAssertNil(coordinator.acquire(owner: .preview, stop: {}))
      XCTAssertEqual(coordinator.activeOwner, owner)
      XCTAssertTrue(coordinator.release(conversation))
    }
  }

  func testConversationPreemptsPreviewBeforeTakingItsLease() throws {
    let coordinator = AssistantLocalSpeechCoordinator()
    var stoppedOwners: [AssistantLocalSpeechOwner] = []
    let preview = try XCTUnwrap(
      coordinator.acquire(owner: .preview) {
        stoppedOwners.append(.preview)
      }
    )

    let assistant = try XCTUnwrap(
      coordinator.acquire(owner: .assistant) {
        stoppedOwners.append(.assistant)
      }
    )

    XCTAssertEqual(stoppedOwners, [.preview])
    XCTAssertFalse(coordinator.release(preview))
    XCTAssertEqual(coordinator.activeOwner, .assistant)
    XCTAssertTrue(coordinator.release(assistant))
  }

  func testStaleCallbacksCannotReleaseNewGenerationForSameOwner() throws {
    let coordinator = AssistantLocalSpeechCoordinator()
    let first = try XCTUnwrap(coordinator.acquire(owner: .assistant, stop: {}))
    let second = try XCTUnwrap(coordinator.acquire(owner: .assistant, stop: {}))

    XCTAssertNotEqual(first.generation, second.generation)
    XCTAssertFalse(coordinator.release(first))
    XCTAssertEqual(coordinator.activeOwner, .assistant)
    XCTAssertTrue(coordinator.release(second))
  }

  func testRapidPreviewStopIsIdempotent() throws {
    let coordinator = AssistantLocalSpeechCoordinator()
    var stopCount = 0
    let preview = try XCTUnwrap(
      coordinator.acquire(owner: .preview) {
        stopCount += 1
      }
    )

    XCTAssertTrue(coordinator.stop(preview))
    XCTAssertFalse(coordinator.stop(preview))
    XCTAssertFalse(coordinator.release(preview))
    XCTAssertEqual(stopCount, 1)
    XCTAssertNil(coordinator.activeOwner)
  }

  func testCatalogNotificationPostedOffMainArrivesOnMainActor() async {
    let center = NotificationCenter()
    let name = Notification.Name("AssistantLocalSpeechCoordinatorTests.catalog")
    let received = expectation(description: "Catalog change delivered")
    var callbackRanOnMainThread = false
    let observation = AssistantVoiceCatalogChangeObservation(
      notificationCenter: center,
      name: name
    ) {
      callbackRanOnMainThread = Thread.isMainThread
      received.fulfill()
    }

    await Task.detached {
      center.post(name: name, object: nil)
    }.value
    await fulfillment(of: [received], timeout: 1)

    XCTAssertTrue(callbackRanOnMainThread)
    observation.cancel()
  }

  func testCatalogObservationCancellationAndTeardownFenceFutureNotifications() async {
    let center = NotificationCenter()
    let name = Notification.Name("AssistantLocalSpeechCoordinatorTests.cancelledCatalog")
    let unexpected = expectation(description: "Cancelled observer stayed silent")
    unexpected.isInverted = true
    var observation: AssistantVoiceCatalogChangeObservation? =
      AssistantVoiceCatalogChangeObservation(
        notificationCenter: center,
        name: name
      ) {
        unexpected.fulfill()
      }

    observation?.cancel()
    observation = nil
    center.post(name: name, object: nil)
    await fulfillment(of: [unexpected], timeout: 0.1)
  }
}
