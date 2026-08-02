import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
@MainActor
final class EditorFlushControllerTests: XCTestCase {
  func testFlushAggregatesEveryRegisteredEditorAndReportsFailure() async {
    let controller = EditorFlushController()
    let firstID = UUID()
    let secondID = UUID()
    var flushed: [UUID] = []

    controller.register(firstID) {
      flushed.append(firstID)
      return false
    }
    controller.register(secondID) {
      flushed.append(secondID)
      return true
    }

    let didFlush = await controller.flush()

    XCTAssertFalse(didFlush)
    XCTAssertEqual(Set(flushed), [firstID, secondID])
  }

  func testLifecycleFlushInvokesRegisteredEditorsAcrossLiveSurfaces() async {
    let firstController = EditorFlushController()
    let secondController = EditorFlushController()
    let firstID = UUID()
    let secondID = UUID()
    var flushed: Set<UUID> = []

    firstController.register(firstID) {
      flushed.insert(firstID)
      return true
    }
    secondController.register(secondID) {
      flushed.insert(secondID)
      return true
    }

    let didFlush = await EditorFlushController.flushRegisteredEditors()

    XCTAssertTrue(didFlush)
    XCTAssertEqual(flushed, [firstID, secondID])
  }

  func testLifecycleTransitionStartsBestEffortFlush() async {
    let controller = EditorFlushController()
    let flushed = expectation(description: "registered editor is asked to flush")

    controller.register(UUID()) {
      flushed.fulfill()
      return false
    }

    EditorFlushController.flushForLifecycleTransition()

    await fulfillment(of: [flushed], timeout: 1)
  }

  func testSurfaceFlushDoesNotFlushEditorsRegisteredByAnotherSurface() async {
    let destinationController = EditorFlushController()
    let unrelatedController = EditorFlushController()
    let destinationID = UUID()
    let unrelatedID = UUID()
    var destinationFlushes = 0
    var unrelatedFlushes = 0

    destinationController.register(destinationID) {
      destinationFlushes += 1
      return true
    }
    unrelatedController.register(unrelatedID) {
      unrelatedFlushes += 1
      return true
    }

    let didFlush = await destinationController.flush()

    XCTAssertTrue(didFlush)
    XCTAssertEqual(destinationFlushes, 1)
    XCTAssertEqual(unrelatedFlushes, 0)
  }
}
