import Foundation
import XCTest

@testable import EnchiridionCore

final class PageDestinationClassifierTests: XCTestCase {
  func testMissingPageIsUnavailable() {
    XCTAssertEqual(PageDestinationClassifier.classify(nil), .unavailable)
  }

  func testDeletedPageIsUnavailableEvenWhenTyped() {
    XCTAssertEqual(
      PageDestinationClassifier.classify(
        page(
          supertagIDs: [BuiltInSupertags.task, BuiltInSupertags.project],
          deletedAt: Date()
        )
      ),
      .unavailable
    )
  }

  func testTaskSupertagTakesPrecedenceOverOtherTypes() {
    XCTAssertEqual(
      PageDestinationClassifier.classify(
        page(supertagIDs: [BuiltInSupertags.project, BuiltInSupertags.task])
      ),
      .task
    )
  }

  func testAnyNonTaskSupertagProducesAnEntityDestination() {
    XCTAssertEqual(
      PageDestinationClassifier.classify(
        page(supertagIDs: [.init(rawValue: "custom-type")])
      ),
      .entity
    )
  }

  func testUntypedPageProducesANoteDestination() {
    XCTAssertEqual(PageDestinationClassifier.classify(page()), .note)
  }

  private func page(
    supertagIDs: [SupertagID] = [],
    deletedAt: Date? = nil
  ) -> PageSnapshot {
    PageSnapshot(
      id: .free(),
      kind: .free,
      title: "Example",
      plainText: "",
      document: Data(),
      heads: .empty,
      createdAt: Date(timeIntervalSince1970: 0),
      modifiedAt: Date(timeIntervalSince1970: 0),
      deletedAt: deletedAt,
      objectMetadata: .init(supertagIDs: supertagIDs)
    )
  }
}
