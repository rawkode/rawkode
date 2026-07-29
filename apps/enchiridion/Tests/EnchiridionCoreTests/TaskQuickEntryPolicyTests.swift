import XCTest
@testable import EnchiridionCore

final class TaskQuickEntryPolicyTests: XCTestCase {
  func testSubmitCreatesImmediateLiteralInboxDraft() throws {
    let command = try XCTUnwrap(
      TaskQuickEntryPolicy.command(
        for: "  Review launch plan tomorrow at 9  ",
        trigger: .submit
      )
    )

    guard case .saveLiteral(let draft) = command else {
      return XCTFail("Submit must not request model interpretation")
    }
    XCTAssertEqual(draft.title, "Review launch plan tomorrow at 9")
    XCTAssertEqual(draft.data.placement, .inbox)
    XCTAssertNil(draft.data.scheduledAt)
    XCTAssertNil(draft.data.deadline)
    XCTAssertNil(draft.data.reminder)
    XCTAssertNil(draft.data.recurrence)
    XCTAssertTrue(draft.data.tags.isEmpty)
  }

  func testInterpretationRequiresExplicitTrigger() throws {
    let command = try XCTUnwrap(
      TaskQuickEntryPolicy.command(
        for: "  Review launch plan tomorrow at 9  ",
        trigger: .interpret
      )
    )

    guard case .reviewInterpretation(let input) = command else {
      return XCTFail("Interpret must open review instead of saving directly")
    }
    XCTAssertEqual(input, "Review launch plan tomorrow at 9")
  }

  func testBlankInputProducesNoCommand() {
    XCTAssertNil(TaskQuickEntryPolicy.command(for: " \n ", trigger: .submit))
    XCTAssertNil(TaskQuickEntryPolicy.command(for: " \n ", trigger: .interpret))
  }
}
