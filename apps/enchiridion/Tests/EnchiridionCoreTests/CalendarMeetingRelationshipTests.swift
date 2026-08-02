import Foundation
import XCTest

@testable import EnchiridionCore

final class CalendarMeetingRelationshipTests: XCTestCase {
  func testEventKitLegacyValuesNormalizeKnownSemanticsAndOmitDefaults() {
    let roles: [(String, CalendarMeetingRelationship.AttendeeContext.Role?)] = [
      ("EKParticipantRole(rawValue: 0)", nil),
      ("EKParticipantRole(rawValue: 1)", nil),
      ("EKParticipantRole(rawValue: 2)", .optional),
      ("EKParticipantRole(rawValue: 3)", .chair),
      ("EKParticipantRole(rawValue: 4)", nil),
    ]
    let responses: [(String, CalendarMeetingRelationship.AttendeeContext.Response?)] = [
      ("EKParticipantStatus(rawValue: 0)", nil),
      ("EKParticipantStatus(rawValue: 1)", .awaitingResponse),
      ("EKParticipantStatus(rawValue: 2)", nil),
      ("EKParticipantStatus(rawValue: 3)", .declined),
      ("EKParticipantStatus(rawValue: 4)", .tentative),
      ("EKParticipantStatus(rawValue: 5)", .delegated),
      ("EKParticipantStatus(rawValue: 6)", nil),
      ("EKParticipantStatus(rawValue: 7)", .inProgress),
    ]

    for (raw, expected) in roles {
      XCTAssertEqual(relationship(provider: "eventkit", role: raw).attendeeContext?.role, expected, raw)
    }
    for (raw, expected) in responses {
      XCTAssertEqual(
        relationship(provider: "eventkit", response: raw).attendeeContext?.response,
        expected,
        raw
      )
    }
  }

  func testGoogleValuesNormalizeKnownSemanticsAndOmitDefaults() {
    let cases: [(String, String, CalendarMeetingRelationship.AttendeeContext?)] = [
      ("organizer", "accepted", .init(role: .organizer, response: nil)),
      ("attendee", "needsAction", .init(role: nil, response: .awaitingResponse)),
      ("attendee", "tentative", .init(role: nil, response: .tentative)),
      ("attendee", "declined", .init(role: nil, response: .declined)),
      ("attendee", "accepted", nil),
    ]

    for (role, response, expected) in cases {
      XCTAssertEqual(
        relationship(provider: "google", role: role, response: response).attendeeContext,
        expected,
        "\(role), \(response)"
      )
    }
  }

  func testMalformedWrongProviderAndNonCanonicalValuesAreRejected() {
    let rejected: [(String, String, String)] = [
      ("eventkit", "2", "1"),
      ("eventkit", "EKParticipantRole(rawValue: 99)", "EKParticipantStatus(rawValue: 99)"),
      ("eventkit", "ekparticipantrole(rawvalue: 2)", "EKParticipantStatus(rawValue: 1) "),
      ("google", "Organizer", "needsaction"),
      ("google", "EKParticipantRole(rawValue: 2)", "EKParticipantStatus(rawValue: 4)"),
      ("other", "organizer", "needsAction"),
    ]

    for (provider, role, response) in rejected {
      XCTAssertNil(relationship(provider: provider, role: role, response: response).attendeeContext)
    }
  }

  private func relationship(
    provider: String,
    role: String = "EKParticipantRole(rawValue: 0)",
    response: String = "EKParticipantStatus(rawValue: 0)"
  ) -> CalendarMeetingRelationship {
    let start = Date(timeIntervalSince1970: 0)
    return CalendarMeetingRelationship(
      id: "event",
      event: CalendarEventSnapshot(
        identity: .init(provider: provider, externalIdentifier: "event", occurrenceStart: start),
        title: "Event",
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
