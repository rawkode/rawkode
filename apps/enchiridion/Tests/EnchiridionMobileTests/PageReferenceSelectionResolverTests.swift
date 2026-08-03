import EnchiridionCore
import XCTest
@testable import Enchiridion

@available(iOS 26.0, macOS 26.0, *)
final class PageReferenceSelectionResolverTests: XCTestCase {
  private let vaultID = VaultID(rawValue: "vault")
  private let sourceID = PageID(rawValue: "source")
  private let targetID = PageID(rawValue: "target")

  func testCaretUsesHalfOpenReferenceRangeAndSelectionMustBeContained() throws {
    var body = AttributedString("Atlas next")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    body[range][PageRichTextAttributes.AutomergeMarks.self] = [
      try PageDocument.pageReferenceMark(to: targetID, label: "Atlas")
    ]

    XCTAssertNotNil(resolve(body, selection: .caret(range.lowerBound)))
    XCTAssertNil(resolve(body, selection: .caret(range.upperBound)))
    XCTAssertNotNil(resolve(body, selection: .range(range)))
    XCTAssertNil(resolve(body, selection: .range(range.lowerBound..<body.endIndex)))
  }

  func testResolverRejectsSelfDeletedMissingAndCrossVaultTargets() throws {
    var body = AttributedString("Atlas")
    let range = try XCTUnwrap(body.range(of: "Atlas"))
    body[range][PageRichTextAttributes.AutomergeMarks.self] = [
      try PageDocument.pageReferenceMark(to: targetID, label: "Atlas")
    ]

    XCTAssertNil(resolve(body, selection: .range(range), sourceID: targetID))
    XCTAssertNil(resolve(body, selection: .range(range), missingDestination: true))
    XCTAssertNil(resolve(
      body,
      selection: .range(range),
      destination: .init(vaultID: vaultID, pageID: targetID, isDeleted: true)
    ))
    XCTAssertNil(resolve(
      body,
      selection: .range(range),
      destination: .init(vaultID: VaultID(rawValue: "other"), pageID: targetID)
    ))
  }

  func testOpenActionRequiresSamePostFlushDestination() async {
    let captured = PageReferenceSelectionResolver.ResolvedReference(
      sourceVaultID: vaultID,
      sourcePageID: sourceID,
      destination: .init(vaultID: vaultID, pageID: targetID),
      label: "Atlas"
    )
    let recorder = OpenRecorder()

    let opened = await PageReferenceOpenAction.perform(
      captured: captured,
      flushAndRevalidate: { _ in captured },
      open: { value in await recorder.record(value) }
    )
    XCTAssertTrue(opened)
    let changed = PageReferenceSelectionResolver.ResolvedReference(
      sourceVaultID: vaultID,
      sourcePageID: sourceID,
      destination: .init(vaultID: vaultID, pageID: PageID(rawValue: "other")),
      label: "Other"
    )
    let refused = await PageReferenceOpenAction.perform(
      captured: captured,
      flushAndRevalidate: { _ in changed },
      open: { value in await recorder.record(value) }
    )
    XCTAssertFalse(refused)
    let count = await recorder.count
    XCTAssertEqual(count, 1)
  }

  private func resolve(
    _ body: AttributedString,
    selection: PageReferenceSelectionResolver.Selection,
    sourceID: PageID? = nil,
    destination: PageReferenceSelectionResolver.LiveDestination? = nil,
    missingDestination: Bool = false
  ) -> PageReferenceSelectionResolver.ResolvedReference? {
    PageReferenceSelectionResolver.resolve(
      in: body,
      selection: selection,
      sourceVaultID: vaultID,
      sourcePageID: sourceID ?? self.sourceID
    ) { _ in
      if missingDestination { return nil }
      return destination ?? .init(vaultID: self.vaultID, pageID: self.targetID)
    }
  }
}

private actor OpenRecorder {
  private(set) var count = 0
  func record(_: PageReferenceSelectionResolver.ResolvedReference) { count += 1 }
}
