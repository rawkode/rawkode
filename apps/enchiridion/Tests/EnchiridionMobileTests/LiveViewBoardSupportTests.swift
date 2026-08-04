import XCTest

@testable import Enchiridion
import EnchiridionCore

@available(iOS 26.0, *)
final class LiveViewBoardSupportTests: XCTestCase {
  func testColumnSelectionInitializesToFirstOption() {
    XCTAssertEqual(
      LiveViewBoardColumnSelection.reconciled(
        currentSelection: nil,
        previousOptionIDs: [],
        optionIDs: ["inbox", "doing"]
      ),
      "inbox"
    )
  }

  func testColumnSelectionIsUnavailableForEmptyOptions() {
    XCTAssertNil(
      LiveViewBoardColumnSelection.reconciled(
        currentSelection: "doing",
        previousOptionIDs: ["inbox", "doing"],
        optionIDs: []
      )
    )
  }

  func testColumnSelectionPreservesStableOptionID() {
    XCTAssertEqual(
      LiveViewBoardColumnSelection.reconciled(
        currentSelection: "doing",
        previousOptionIDs: ["inbox", "doing", "done"],
        optionIDs: ["done", "doing", "inbox"]
      ),
      "doing"
    )
  }

  func testColumnSelectionUsesNearestSurvivingOptionWhenSelectedOptionIsRemoved() {
    XCTAssertEqual(
      LiveViewBoardColumnSelection.reconciled(
        currentSelection: "doing",
        previousOptionIDs: ["inbox", "todo", "doing", "done", "later"],
        optionIDs: ["inbox", "done"]
      ),
      "done"
    )
  }

  func testColumnSelectionFallsBackToFirstWhenNoPriorPositionExists() {
    XCTAssertEqual(
      LiveViewBoardColumnSelection.reconciled(
        currentSelection: "removed",
        previousOptionIDs: ["inbox", "doing"],
        optionIDs: ["todo", "done"]
      ),
      "todo"
    )
  }

  func testBoardMoveCreatesUnsetAndSelectMutations() {
    let item = pageItem
    let unset = mutation(item: item, destinationID: "__unset")
    let select = mutation(item: item, destinationID: "doing")

    XCTAssertEqual(unset?.pageID, pageID)
    XCTAssertEqual(unset?.supertagID, supertagID)
    XCTAssertEqual(unset?.fieldID, fieldID)
    XCTAssertEqual(unset?.values, [])
    XCTAssertEqual(select?.values, [.select("doing")])
  }

  func testBoardMoveRejectsEventsAndInvalidBoardDefinitions() {
    XCTAssertNil(mutation(item: eventItem, destinationID: "doing"))
    XCTAssertNil(mutation(item: pageItem, source: .pages, destinationID: "doing"))
    XCTAssertNil(
      LiveViewBoardMove.mutation(
        item: pageItem,
        source: .supertag(supertagID),
        groupFieldID: nil,
        destinationID: "doing",
        validDestinationIDs: ["__unset", "doing"]
      )
    )
    XCTAssertNil(mutation(item: pageItem, destinationID: "missing"))
  }

  private let pageID = PageID(rawValue: "page-1")
  private let supertagID = SupertagID(rawValue: "project")
  private let fieldID = SupertagFieldID(rawValue: "status")

  private var pageItem: LiveQueryItem {
    .page(
      PageSnapshot(
        id: pageID,
        kind: .free,
        title: "A page",
        plainText: "",
        document: Data(),
        heads: .empty,
        createdAt: .distantPast,
        modifiedAt: .distantPast
      )
    )
  }

  private var eventItem: LiveQueryItem {
    .event(
      CalendarEventSnapshot(
        identity: .init(externalIdentifier: "event-1", occurrenceStart: .distantPast),
        title: "An event",
        startDate: .distantPast,
        endDate: .distantFuture,
        isAllDay: false,
        location: nil,
        notes: nil,
        url: nil,
        calendarTitle: "Calendar"
      )
    )
  }

  private func mutation(
    item: LiveQueryItem,
    source: LiveQuerySource? = nil,
    destinationID: String
  ) -> LiveViewBoardPropertyMutation? {
    LiveViewBoardMove.mutation(
      item: item,
      source: source ?? .supertag(supertagID),
      groupFieldID: fieldID,
      destinationID: destinationID,
      validDestinationIDs: ["__unset", "doing"]
    )
  }
}
