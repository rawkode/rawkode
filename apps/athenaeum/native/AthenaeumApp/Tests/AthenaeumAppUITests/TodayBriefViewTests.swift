import XCTest
@testable import AthenaeumAppUI

@MainActor
final class TodayBriefViewTests: XCTestCase {
    func testLocalDateUsesCalendarComponentsWithoutClientSortingOrJoining() {
        XCTAssertEqual(
            TodayBriefViewModel.localDate(from: DateComponents(year: 2026, month: 8, day: 24)),
            "2026-08-24"
        )
    }

    func testLocalDateRejectsIncompleteComponents() {
        XCTAssertNil(TodayBriefViewModel.localDate(from: DateComponents(year: 2026, month: 8)))
    }

    func testLoadFailureMessageCannotEchoProviderData() {
        let privateWireValue = "alice@example.test/provider-private-id"
        XCTAssertEqual(TodayBriefViewModel.safeErrorMessage, "Unable to load today’s brief. Please try again.")
        XCTAssertFalse(TodayBriefViewModel.safeErrorMessage.contains(privateWireValue))
    }
}
