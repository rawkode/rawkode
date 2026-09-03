import Foundation

// Phase 5 native stage ("Extend AthenaeumDomain... per the plan's calendar/bookmarks/gatekeeper-
// binding design") — mirrors `packages/domain/src/calendar-event.ts`. See that file's own header
// comment for the full field-by-field rationale (provider-managed vs. user-owned split,
// recurring-event identity via `seriesId`/`occurrenceId`/`masterRecordId`); this Swift mirror only
// needs to round-trip the shape, not reimplement the sync/merge logic that produces it
// (`calendar-service-live.ts`, `packages/backend`, out of this package's scope).

/// Mirrors `calendar-event.ts`'s `CalendarEventTime = Schema.Union(...)` — a discriminated union
/// on `kind`, hand-`Codable` like `Sharing.swift`'s `PermissionEdge` (unions are out of
/// `schema-diff.ts`'s automated scope by design — see `KNOWN_LIMITATIONS`; verified by hand here).
public enum CalendarEventTime: Hashable, Sendable {
    case date(date: String)
    case dateTime(dateTime: String, timeZone: String?)
}

extension CalendarEventTime: Codable {
    private enum CodingKeys: String, CodingKey { case kind, date, dateTime, timeZone }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "date":
            self = .date(date: try container.decode(String.self, forKey: .date))
        case "dateTime":
            self = .dateTime(
                dateTime: try container.decode(String.self, forKey: .dateTime),
                timeZone: try container.decodeIfPresent(String.self, forKey: .timeZone)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: container, debugDescription: "Unknown CalendarEventTime kind: \(kind)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .date(let date):
            try container.encode("date", forKey: .kind)
            try container.encode(date, forKey: .date)
        case .dateTime(let dateTime, let timeZone):
            try container.encode("dateTime", forKey: .kind)
            try container.encode(dateTime, forKey: .dateTime)
            try container.encodeIfPresent(timeZone, forKey: .timeZone)
        }
    }

    /// Convenience for `CalendarDayView`-style sorting/rendering — the wall-clock instant this
    /// time value represents, best-effort (a bare `"date"` value is midnight UTC on that date).
    public var isoString: String {
        switch self {
        case .date(let date): return date
        case .dateTime(let dateTime, _): return dateTime
        }
    }
}

/// Mirrors `calendar-event.ts`'s `CalendarEventAttendee` — `Schema.Class`, diffed by
/// `schema-diff.ts` (see `MIRRORED_CLASSES`).
public struct CalendarEventAttendee: Codable, Hashable, Sendable {
    public let email: Email
    public let displayName: String?
    public let personNodeId: EntityId?
    public init(email: Email, displayName: String? = nil, personNodeId: EntityId? = nil) {
        self.email = email
        self.displayName = displayName
        self.personNodeId = personNodeId
    }
}

/// Mirrors `calendar-event.ts`'s `CalendarEventStatus = Schema.Literal("confirmed", "tentative",
/// "cancelled")`.
public enum CalendarEventStatus: String, Codable, Hashable, Sendable {
    case confirmed
    case tentative
    case cancelled
}

/// Mirrors `calendar-event.ts`'s `CalendarEvent` — one provider-sourced calendar-event row. See
/// that file's header comment for the full recurring-event identity rationale; this struct only
/// needs to round-trip every field, not reimplement the semantics.
public struct CalendarEvent: Codable, Hashable, Sendable {
    public let id: EntityId
    public let workspaceId: EntityId
    public let providerEventId: String
    public let seriesId: String?
    public let occurrenceId: String?
    public let masterRecordId: EntityId?
    public let title: String
    public let start: CalendarEventTime
    public let end: CalendarEventTime
    public let attendees: [CalendarEventAttendee]
    public let status: CalendarEventStatus
    public let linkedNodeId: EntityId?
    public let syncedAt: IsoDateTimeString

    public init(
        id: EntityId,
        workspaceId: EntityId,
        providerEventId: String,
        seriesId: String? = nil,
        occurrenceId: String? = nil,
        masterRecordId: EntityId? = nil,
        title: String,
        start: CalendarEventTime,
        end: CalendarEventTime,
        attendees: [CalendarEventAttendee],
        status: CalendarEventStatus,
        linkedNodeId: EntityId? = nil,
        syncedAt: IsoDateTimeString
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.providerEventId = providerEventId
        self.seriesId = seriesId
        self.occurrenceId = occurrenceId
        self.masterRecordId = masterRecordId
        self.title = title
        self.start = start
        self.end = end
        self.attendees = attendees
        self.status = status
        self.linkedNodeId = linkedNodeId
        self.syncedAt = syncedAt
    }
}
