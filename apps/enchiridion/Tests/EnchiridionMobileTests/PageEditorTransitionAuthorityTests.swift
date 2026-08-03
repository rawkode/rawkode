import EnchiridionCore
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
@MainActor
final class PageEditorTransitionAuthorityTests: XCTestCase {
  private let pageA = PageID(rawValue: "page-a")
  private let pageB = PageID(rawValue: "page-b")
  private let pageC = PageID(rawValue: "page-c")

  func testCancelAfterFailureRestoresAuthoritativePageAndInvalidatesRequest() {
    let authority = PageEditorTransitionAuthority(initialPageID: pageA)
    let generation = authority.beginRequest(to: pageB)

    XCTAssertTrue(authority.fail(generation, pageID: pageB, message: "Save failed"))
    XCTAssertEqual(authority.authoritativePageID, pageA)
    XCTAssertEqual(authority.pageIDForActions, pageA)
    XCTAssertEqual(authority.requestedPageID, pageB)
    XCTAssertFalse(authority.arePageActionsEnabled)
    XCTAssertEqual(authority.failureMessage, "Save failed")

    authority.cancelPendingRequest()

    XCTAssertEqual(authority.authoritativePageID, pageA)
    XCTAssertEqual(authority.requestedPageID, pageA)
    XCTAssertEqual(authority.pageIDForActions, pageA)
    XCTAssertTrue(authority.arePageActionsEnabled)
    XCTAssertNil(authority.failureMessage)
    XCTAssertNil(authority.authorizeLoad(pageB, generation: generation))
  }

  func testPageActionsRemainDisabledUntilInnerEditorAcknowledgesLoad() throws {
    let authority = PageEditorTransitionAuthority(initialPageID: pageA)
    let generation = authority.beginRequest(to: pageB)

    let loadRequest = try XCTUnwrap(authority.authorizeLoad(pageB, generation: generation))
    XCTAssertEqual(authority.authoritativePageID, pageA)
    XCTAssertEqual(authority.pageIDForActions, pageA)
    XCTAssertFalse(authority.arePageActionsEnabled)

    var loadedPageID = pageA
    XCTAssertTrue(
      authority.loadAndAcknowledge(loadRequest) {
        loadedPageID = pageB
      }
    )
    XCTAssertEqual(loadedPageID, pageB)
    XCTAssertEqual(authority.authoritativePageID, pageB)
    XCTAssertEqual(authority.pageIDForActions, pageB)
    XCTAssertTrue(authority.arePageActionsEnabled)
    XCTAssertNil(authority.failureMessage)
  }

  func testStaleInnerEditorAcknowledgementCannotSupersedeNewerRequest() throws {
    let authority = PageEditorTransitionAuthority(initialPageID: pageA)
    let generationB = authority.beginRequest(to: pageB)
    let loadRequestB = try XCTUnwrap(
      authority.authorizeLoad(pageB, generation: generationB)
    )
    let generationC = authority.beginRequest(to: pageC)
    let loadRequestC = try XCTUnwrap(
      authority.authorizeLoad(pageC, generation: generationC)
    )

    var loadedPageID = pageA
    XCTAssertFalse(
      authority.loadAndAcknowledge(loadRequestB) {
        loadedPageID = pageB
      }
    )
    XCTAssertEqual(loadedPageID, pageA)
    XCTAssertEqual(authority.pageIDForActions, pageA)
    XCTAssertFalse(authority.arePageActionsEnabled)
    XCTAssertTrue(
      authority.loadAndAcknowledge(loadRequestC) {
        loadedPageID = pageC
      }
    )
    XCTAssertEqual(loadedPageID, pageC)
    XCTAssertEqual(authority.authoritativePageID, pageC)
    XCTAssertEqual(authority.pageIDForActions, pageC)
    XCTAssertTrue(authority.arePageActionsEnabled)
  }

  func testRemovalDuringFlushIsRevalidatedBeforeLoadAuthorization() async {
    let authority = PageEditorTransitionAuthority(initialPageID: pageA)
    let generation = authority.beginRequest(to: pageB)
    var isPageAvailable = true

    let loadRequest = await authority.prepareLoad(
      pageB,
      generation: generation,
      isAvailable: { isPageAvailable },
      flush: {
        isPageAvailable = false
        return true
      }
    )

    XCTAssertNil(loadRequest)
    XCTAssertNil(authority.loadRequest)
    XCTAssertEqual(authority.authoritativePageID, pageA)
    XCTAssertEqual(authority.requestedPageID, pageB)
    XCTAssertFalse(authority.arePageActionsEnabled)
    XCTAssertEqual(authority.failureMessage, "The requested page is no longer available.")
  }

  func testMissingChildSnapshotFailsExactAuthorizedLoadAndCancelRestoresPage() throws {
    let authority = PageEditorTransitionAuthority(initialPageID: pageA)
    let generation = authority.beginRequest(to: pageB)
    let loadRequest = try XCTUnwrap(
      authority.authorizeLoad(pageB, generation: generation)
    )

    XCTAssertTrue(
      authority.failAuthorizedLoad(
        loadRequest,
        message: "The requested page is no longer available."
      )
    )
    XCTAssertEqual(authority.authoritativePageID, pageA)
    XCTAssertEqual(authority.requestedPageID, pageB)
    XCTAssertFalse(authority.arePageActionsEnabled)
    XCTAssertEqual(authority.failureMessage, "The requested page is no longer available.")

    authority.cancelPendingRequest()
    XCTAssertEqual(authority.authoritativePageID, pageA)
    XCTAssertEqual(authority.requestedPageID, pageA)
    XCTAssertTrue(authority.arePageActionsEnabled)
  }

  func testCancelledStaleChildCannotLoadBeforeRejectedAcknowledgement() throws {
    let authority = PageEditorTransitionAuthority(initialPageID: pageA)
    let generationB = authority.beginRequest(to: pageB)
    let loadRequestB = try XCTUnwrap(
      authority.authorizeLoad(pageB, generation: generationB)
    )
    let generationC = authority.beginRequest(to: pageC)
    XCTAssertTrue(authority.fail(generationC, pageID: pageC, message: "Save failed"))
    authority.cancelPendingRequest()

    var loadedPageID = pageA
    XCTAssertFalse(
      authority.loadAndAcknowledge(loadRequestB, isCancelled: true) {
        loadedPageID = pageB
      }
    )
    XCTAssertEqual(loadedPageID, pageA)
    XCTAssertEqual(authority.authoritativePageID, pageA)
    XCTAssertEqual(authority.requestedPageID, pageA)
    XCTAssertTrue(authority.arePageActionsEnabled)
  }
}
