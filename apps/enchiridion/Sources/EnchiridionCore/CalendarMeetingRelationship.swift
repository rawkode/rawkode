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
}
