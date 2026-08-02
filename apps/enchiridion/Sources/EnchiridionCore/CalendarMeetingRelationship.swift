import Foundation

/// A read-only calendar projection shown on a Person's relationship surface.
///
/// Calendar events remain provider-owned. This value deliberately contains the
/// event snapshot rather than a PageID so merely listing meetings cannot create
/// an occurrence page or a graph edge.
public struct CalendarMeetingRelationship: Identifiable, Hashable, Sendable {
  public enum Timing: String, Codable, Hashable, Sendable {
    case upcoming
    case past
  }

  /// Provider-normalized attendee information suitable for presentation.
  ///
  /// Calendar providers persist their own role and response representations.
  /// This deliberately keeps only the small, useful semantic subset so UI
  /// surfaces never need to render provider implementation details.
  public struct AttendeeContext: Hashable, Sendable {
    public enum Role: Hashable, Sendable {
      case organizer
      case chair
      case optional
    }

    public enum Response: Hashable, Sendable {
      case awaitingResponse
      case tentative
      case declined
      case delegated
      case inProgress
    }

    public let role: Role?
    public let response: Response?

    public init?(role: Role?, response: Response?) {
      guard role != nil || response != nil else { return nil }
      self.role = role
      self.response = response
    }
  }

  public var id: String
  public var event: CalendarEventSnapshot
  public var attendeeRole: String
  public var attendeeResponseStatus: String
  public var timing: Timing

  public init(
    id: String,
    event: CalendarEventSnapshot,
    attendeeRole: String,
    attendeeResponseStatus: String,
    timing: Timing
  ) {
    self.id = id
    self.event = event
    self.attendeeRole = attendeeRole
    self.attendeeResponseStatus = attendeeResponseStatus
    self.timing = timing
  }

  /// Strictly normalizes known provider values without exposing raw snapshots.
  ///
  /// EventKit data includes historical `String(describing:)` enum wrappers;
  /// those wrappers are accepted only for the EventKit provider. Other values,
  /// including malformed or future provider values, are intentionally omitted.
  public var attendeeContext: AttendeeContext? {
    AttendeeContext(
      role: Self.normalizedRole(provider: event.identity.provider, value: attendeeRole),
      response: Self.normalizedResponse(provider: event.identity.provider, value: attendeeResponseStatus)
    )
  }

  private static func normalizedRole(provider: String, value: String) -> AttendeeContext.Role? {
    switch (provider, value) {
    case ("eventkit", "EKParticipantRole(rawValue: 2)"):
      .optional
    case ("eventkit", "EKParticipantRole(rawValue: 3)"):
      .chair
    case ("google", "organizer"):
      .organizer
    default:
      nil
    }
  }

  private static func normalizedResponse(
    provider: String,
    value: String
  ) -> AttendeeContext.Response? {
    switch (provider, value) {
    case ("eventkit", "EKParticipantStatus(rawValue: 1)"), ("google", "needsAction"):
      .awaitingResponse
    case ("eventkit", "EKParticipantStatus(rawValue: 4)"), ("google", "tentative"):
      .tentative
    case ("eventkit", "EKParticipantStatus(rawValue: 3)"), ("google", "declined"):
      .declined
    case ("eventkit", "EKParticipantStatus(rawValue: 5)"):
      .delegated
    case ("eventkit", "EKParticipantStatus(rawValue: 7)"):
      .inProgress
    default:
      nil
    }
  }
}
