import Foundation
import XCTest

@testable import EnchiridionCore

final class PageDocumentReferenceTests: XCTestCase {
  func testPageReferenceMarkResolvesToDestination() throws {
    let targetID = PageID(rawValue: "page_target")
    let mark = try PageDocument.pageReferenceMark(to: targetID, label: "Project Atlas")

    XCTAssertEqual(
      PageDocument.pageReferenceDestination(from: mark),
      PageReferenceDestination(pageID: targetID, label: "Project Atlas")
    )
  }

  func testInvalidJSONDoesNotResolve() {
    let mark = PageRichTextMark(
      name: PageDocument.pageReferenceMark,
      value: .string("not-json")
    )

    XCTAssertNil(PageDocument.pageReferenceDestination(from: mark))
  }

  func testWrongMarkNameDoesNotLeakReferencePayload() throws {
    let encodedReference = try PageDocument.pageReferenceMark(
      to: PageID(rawValue: "page_target"),
      label: "Project Atlas"
    ).value
    let mark = PageRichTextMark(name: "untrusted-mark", value: encodedReference)

    XCTAssertNil(PageDocument.pageReferenceDestination(from: mark))
  }

  func testNonStringMarkValueDoesNotResolve() {
    let mark = PageRichTextMark(
      name: PageDocument.pageReferenceMark,
      value: .bytes(Data("{\"pageID\":\"page_target\",\"label\":\"Target\"}".utf8))
    )

    XCTAssertNil(PageDocument.pageReferenceDestination(from: mark))
  }

  func testMissingPayloadFieldsDoNotResolve() {
    let mark = PageRichTextMark(
      name: PageDocument.pageReferenceMark,
      value: .string("{\"pageID\":\"page_target\"}")
    )

    XCTAssertNil(PageDocument.pageReferenceDestination(from: mark))
  }
}
