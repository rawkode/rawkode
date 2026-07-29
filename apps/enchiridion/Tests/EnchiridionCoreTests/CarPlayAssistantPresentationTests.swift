import XCTest

@testable import EnchiridionCore

final class CarPlayAssistantPresentationTests: XCTestCase {
  func testVoiceTemplateContractFitsCarPlayStateLimit() {
    XCTAssertEqual(CarPlayAssistantPhase.allCases.count, 5)
    XCTAssertEqual(Set(CarPlayAssistantPhase.allCases.map(\.rawValue)).count, 5)
  }

  func testReadyStateExplicitlyExplainsHowListeningStarts() {
    let ready = CarPlayAssistantPhase.ready

    XCTAssertEqual(ready.actionTitle, "Start")
    XCTAssertTrue(ready.titleVariants.first?.contains("Tap Start") == true)
  }

  func testRespondingStateIsNotPresentedAsAnAmbiguousSpeakerControl() {
    let responding = CarPlayAssistantPhase.responding

    XCTAssertFalse(responding.systemImageName.contains("speaker"))
    XCTAssertEqual(responding.actionTitle, "Stop")
  }

  func testSetupStateCannotRetryWhileDriving() {
    XCTAssertTrue(CarPlayAssistantPhase.setup.actionTitle.isEmpty)
  }
}
