import EnchiridionCore
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
final class CalendarEventRelationshipPresentationTests: XCTestCase {
  func testEventVocabularyIsExact() {
    XCTAssertEqual(
      CalendarEventRelationshipPresentation.sectionTitle(for: .upcoming),
      "Upcoming events"
    )
    XCTAssertEqual(CalendarEventRelationshipPresentation.sectionTitle(for: .past), "Past events")
    XCTAssertEqual(
      CalendarEventRelationshipPresentation.emptyState(for: .upcoming),
      "No upcoming events"
    )
    XCTAssertEqual(CalendarEventRelationshipPresentation.emptyState(for: .past), "No past events")
    XCTAssertEqual(
      CalendarEventRelationshipPresentation.calendarFooter,
      "Imported from Calendar. Opening an event creates or opens its occurrence note."
    )
  }

  func testNoContextOmitsSubtitleAndRawPersistenceFromVoiceOver() {
    let presentation = CalendarEventRelationshipPresentation(
      relationship: relationship(
        role: "EKParticipantRole(rawValue: 0)",
        response: "EKParticipantStatus(rawValue: 2)"
      ),
      dateText: "3 Apr 2026 at 16:30"
    )

    XCTAssertNil(presentation.attendeeContextText)
    XCTAssertEqual(presentation.accessibilityLabel, "Private lesson, 3 Apr 2026 at 16:30")
    XCTAssertEqual(presentation.accessibilityHint, "Imported calendar event. Opens its occurrence note.")
    XCTAssertFalse(presentation.accessibilityLabel.contains("EKParticipant"))
    XCTAssertFalse(presentation.accessibilityLabel.contains("rawValue"))
    XCTAssertFalse(presentation.accessibilityLabel.contains(" · "))
  }

  func testOptionalTentativeContextMatchesSubtitleAndVoiceOver() {
    let presentation = CalendarEventRelationshipPresentation(
      relationship: relationship(
        role: "EKParticipantRole(rawValue: 2)",
        response: "EKParticipantStatus(rawValue: 4)"
      ),
      dateText: "3 Apr 2026 at 16:30"
    )

    XCTAssertEqual(presentation.attendeeContextText, "Optional attendee · Tentative")
    XCTAssertEqual(
      presentation.accessibilityLabel,
      "Private lesson, 3 Apr 2026 at 16:30, Optional attendee · Tentative"
    )
    XCTAssertFalse(presentation.accessibilityLabel.contains("EKParticipant"))
    XCTAssertFalse(presentation.accessibilityLabel.contains("rawValue"))
  }

  private func relationship(role: String, response: String) -> CalendarMeetingRelationship {
    let start = Date(timeIntervalSince1970: 0)
    return CalendarMeetingRelationship(
      id: "event",
      event: CalendarEventSnapshot(
        identity: .init(provider: "eventkit", externalIdentifier: "event", occurrenceStart: start),
        title: "Private lesson",
        startDate: start,
        endDate: start,
        isAllDay: false,
        location: nil,
        notes: nil,
        url: nil,
        calendarTitle: "Calendar"
      ),
      attendeeRole: role,
      attendeeResponseStatus: response,
      timing: .upcoming
    )
  }
}
