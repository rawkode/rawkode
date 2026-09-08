import XCTest
@testable import AthenaeumAppUI

@MainActor
final class BacklinksViewTests: XCTestCase {
    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    func testBacklinksLoadFailureSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = AthenaeumViewModel.backlinksLoadFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "Backlinks couldn’t be loaded right now. Reopen this note to check them again."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testBacklinkCreationFailureSuppressesUnderlyingTransportDetailsAndRetainsCustodyGuidance() {
        let error = PrivateTransportError()
        let message = AthenaeumViewModel.backlinkCreationFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "We couldn’t confirm that the backlink was created. Your title is still here. " +
                "Review backlinks before taking another action."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testBacklinkCreationPresentationRejectsRapidDuplicatesAndRetainsModelBusyState() {
        XCTAssertFalse(
            BacklinkCreationPresentation.isBusy(
                isModelLinking: false,
                isCreationInFlight: false
            )
        )
        XCTAssertTrue(
            BacklinkCreationPresentation.canStartCreation(
                isModelLinking: false,
                isCreationInFlight: false
            )
        )

        XCTAssertTrue(
            BacklinkCreationPresentation.isBusy(
                isModelLinking: false,
                isCreationInFlight: true
            )
        )
        XCTAssertFalse(
            BacklinkCreationPresentation.canStartCreation(
                isModelLinking: false,
                isCreationInFlight: true
            )
        )

        XCTAssertTrue(
            BacklinkCreationPresentation.isBusy(
                isModelLinking: true,
                isCreationInFlight: false
            )
        )
        XCTAssertFalse(
            BacklinkCreationPresentation.canStartCreation(
                isModelLinking: true,
                isCreationInFlight: false
            )
        )

        XCTAssertTrue(
            BacklinkCreationPresentation.canStartCreation(
                isModelLinking: false,
                isCreationInFlight: false
            )
        )
    }

    func testBacklinksEmptyStateRequiresASuccessfulEmptyRead() {
        XCTAssertTrue(
            AthenaeumViewModel.shouldShowEmptyBacklinks(
                isEmpty: true,
                hasLoadedBacklinks: true,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowEmptyBacklinks(
                isEmpty: true,
                hasLoadedBacklinks: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowEmptyBacklinks(
                isEmpty: true,
                hasLoadedBacklinks: true,
                errorMessage: "Backlinks couldn’t be loaded right now."
            )
        )
    }

    func testBacklinksLoadingStateIsLimitedToAnUnresolvedRead() {
        XCTAssertTrue(
            AthenaeumViewModel.shouldShowBacklinksLoading(
                hasLoadedBacklinks: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowBacklinksLoading(
                hasLoadedBacklinks: true,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            AthenaeumViewModel.shouldShowBacklinksLoading(
                hasLoadedBacklinks: false,
                errorMessage: "Backlinks couldn’t be loaded right now."
            )
        )
    }
}
