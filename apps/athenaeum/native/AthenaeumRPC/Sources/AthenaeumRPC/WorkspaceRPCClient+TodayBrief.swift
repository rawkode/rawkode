import AthenaeumDomain
import Foundation

// This deliberately narrow read model never exposes provider ids, attendee addresses,
// recurrence metadata, linked-node ids, or synchronization details.

/// A field-neutral error for an invalid Today Brief wire response. It intentionally never embeds
/// server values: those can contain calendar-provider identifiers or other private data.
public enum TodayBriefRPCError: Error, Sendable, Equatable, LocalizedError {
    case malformedResponse

    public var errorDescription: String? { "Unable to load today’s brief. Please try again." }
}

public struct RPCTodayBriefPerson: Sendable, Equatable {
    public let displayName: String?

    public init(displayName: String? = nil) {
        precondition(displayName?.isEmpty != true, "Today Brief display names must be nonempty when present")
        self.displayName = displayName
    }

    init(_ value: CapnWebValue) throws {
        do {
            // `field(_:)` intentionally maps absent keys to `.null` for most optional legacy
            // fields. This contract distinguishes the two, so inspect the parent object first.
            guard case .object(let fields) = value else { throw TodayBriefRPCError.malformedResponse }
            guard let field = fields["displayName"] else {
                displayName = nil
                return
            }
            guard case .string(let name) = field, !name.isEmpty else { throw TodayBriefRPCError.malformedResponse }
            displayName = name
        } catch {
            throw TodayBriefRPCError.malformedResponse
        }
    }
}

public struct RPCTodayBriefEvent: Sendable, Equatable {
    public let id: EntityId
    public let title: String
    public let start: IsoDateTimeString
    public let end: IsoDateTimeString
    public let people: [RPCTodayBriefPerson]

    public init(id: EntityId, title: String, start: IsoDateTimeString, end: IsoDateTimeString, people: [RPCTodayBriefPerson]) {
        self.id = id
        self.title = title
        self.start = start
        self.end = end
        self.people = people
    }

    init(_ value: CapnWebValue) throws {
        do {
            guard let id = try value.field("id").stringValue,
                  let title = try value.field("title").stringValue,
                  let start = try value.field("start").stringValue,
                  let end = try value.field("end").stringValue,
                  let people = try value.field("people").arrayValue
            else { throw TodayBriefRPCError.malformedResponse }
            self.init(
                id: try EntityId(validating: id),
                title: title,
                start: try IsoDateTimeString(validating: start),
                end: try IsoDateTimeString(validating: end),
                people: try people.map(RPCTodayBriefPerson.init)
            )
        } catch {
            throw TodayBriefRPCError.malformedResponse
        }
    }
}

public enum RPCTodayBriefHistoryStatus: String, Sendable, Equatable {
    case found
    case noneInRetainedData
    case unavailable
}

public struct RPCTodayBriefCalendarHistory: Sendable, Equatable {
    public let status: RPCTodayBriefHistoryStatus

    init(_ value: CapnWebValue) throws {
        do {
            guard let rawStatus = try value.field("status").stringValue,
                  let status = RPCTodayBriefHistoryStatus(rawValue: rawStatus)
            else { throw TodayBriefRPCError.malformedResponse }
            self.status = status
        } catch {
            throw TodayBriefRPCError.malformedResponse
        }
    }
}

/// The resolved, privacy-safe local-day projection returned by `getTodayBrief`.
public struct RPCTodayBrief: Sendable, Equatable {
    public let localDate: LocalDate
    public let timeZone: IanaTimeZone
    public let from: IsoDateTimeString
    public let to: IsoDateTimeString
    public let calendarHistory: RPCTodayBriefCalendarHistory
    public let events: [RPCTodayBriefEvent]

    init(_ value: CapnWebValue) throws {
        do {
            guard let localDate = try value.field("localDate").stringValue,
                  let timeZone = try value.field("timeZone").stringValue,
                  let from = try value.field("from").stringValue,
                  let to = try value.field("to").stringValue,
                  let events = try value.field("events").arrayValue
            else { throw TodayBriefRPCError.malformedResponse }
            self.localDate = try LocalDate(validating: localDate)
            self.timeZone = try IanaTimeZone(validating: timeZone)
            self.from = try IsoDateTimeString(validating: from)
            self.to = try IsoDateTimeString(validating: to)
            self.calendarHistory = try RPCTodayBriefCalendarHistory(value.field("calendarHistory"))
            self.events = try events.map(RPCTodayBriefEvent.init)
        } catch {
            throw TodayBriefRPCError.malformedResponse
        }
    }
}

extension WorkspaceRPCClient {
    /// Fetches the server-resolved local-day projection. String inputs are validated before the
    /// wire call so callers cannot transmit malformed local dates or time-zone identifiers.
    public func getTodayBrief(localDate: String, timeZone: String) async throws -> RPCTodayBrief {
        try await getTodayBrief(
            localDate: LocalDate(validating: localDate),
            timeZone: IanaTimeZone(validating: timeZone)
        )
    }

    public func getTodayBrief(localDate: LocalDate, timeZone: IanaTimeZone) async throws -> RPCTodayBrief {
        do {
            let result = try await rpc("getTodayBrief", [
                "localDate": .string(localDate.rawValue),
                "timeZone": .string(timeZone.rawValue)
            ])
            return try RPCTodayBrief(result)
        } catch is TodayBriefRPCError {
            throw TodayBriefRPCError.malformedResponse
        }
    }
}
