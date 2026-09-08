import AthenaeumDomain
import Foundation

// This deliberately narrow read model never exposes provider ids, attendee addresses,
// recurrence metadata, or synchronization details. A server-validated person node id is an
// opaque navigation handle and is retained only when the projection can prove the association.

/// A field-neutral error for an invalid Today Brief wire response. It intentionally never embeds
/// server values: those can contain calendar-provider identifiers or other private data.
public enum TodayBriefRPCError: Error, Sendable, Equatable, LocalizedError {
    case malformedResponse

    public var errorDescription: String? { "Unable to load today’s brief. Please try again." }
}

public enum TodayBriefPreparationRPCError: Error, Sendable, Equatable, LocalizedError {
    case malformedResponse

    public var errorDescription: String? { "Unable to prepare this meeting. Please try again." }
}

public struct RPCTodayBriefPerson: Sendable, Equatable {
    public let displayName: String?
    public let personNodeId: EntityId?

    public init(displayName: String? = nil, personNodeId: EntityId? = nil) {
        precondition(displayName?.isEmpty != true, "Today Brief display names must be nonempty when present")
        self.displayName = displayName
        self.personNodeId = personNodeId
    }

    init(_ value: CapnWebValue) throws {
        do {
            // `field(_:)` intentionally maps absent keys to `.null` for most optional legacy
            // fields. This contract distinguishes the two, so inspect the parent object first.
            guard case .object(let fields) = value else { throw TodayBriefRPCError.malformedResponse }
            guard let field = fields["displayName"] else {
                displayName = nil
                if let personField = fields["personNodeId"] {
                    guard case .string(let rawId) = personField else { throw TodayBriefRPCError.malformedResponse }
                    personNodeId = try EntityId(validating: rawId)
                } else {
                    personNodeId = nil
                }
                return
            }
            guard case .string(let name) = field, !name.isEmpty else { throw TodayBriefRPCError.malformedResponse }
            displayName = name
            if let personField = fields["personNodeId"] {
                guard case .string(let rawId) = personField else { throw TodayBriefRPCError.malformedResponse }
                personNodeId = try EntityId(validating: rawId)
            } else {
                personNodeId = nil
            }
        } catch {
            throw TodayBriefRPCError.malformedResponse
        }
    }
}

public struct RPCTodayBriefEvent: Sendable, Equatable {
    public let id: EntityId
    public let occurrenceKey: String
    public let title: String
    public let start: IsoDateTimeString
    public let end: IsoDateTimeString
    public let people: [RPCTodayBriefPerson]

    public init(id: EntityId, occurrenceKey: String, title: String, start: IsoDateTimeString, end: IsoDateTimeString, people: [RPCTodayBriefPerson]) {
        self.id = id
        self.occurrenceKey = occurrenceKey
        self.title = title
        self.start = start
        self.end = end
        self.people = people
    }

    init(_ value: CapnWebValue) throws {
        do {
            guard let id = try value.field("id").stringValue,
                  let occurrenceKey = try value.field("occurrenceKey").stringValue,
                  let title = try value.field("title").stringValue,
                  let start = try value.field("start").stringValue,
                  let end = try value.field("end").stringValue,
                  let people = try value.field("people").arrayValue
            else { throw TodayBriefRPCError.malformedResponse }
            self.init(
                id: try EntityId(validating: id),
                occurrenceKey: try Self.validatedOccurrenceKey(occurrenceKey),
                title: title,
                start: try IsoDateTimeString(validating: start),
                end: try IsoDateTimeString(validating: end),
                people: try people.map(RPCTodayBriefPerson.init)
            )
        } catch {
            throw TodayBriefRPCError.malformedResponse
        }
    }

    private static func validatedOccurrenceKey(_ value: String) throws -> String {
        guard value.count == 64, value.unicodeScalars.allSatisfy({ (48...57).contains($0.value) || (97...102).contains($0.value) }) else {
            throw TodayBriefRPCError.malformedResponse
        }
        return value
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

    /// Requests the server-owned meeting-preparation mutation. The client never supplies event
    /// content or Loro bytes: the Worker resolves the opaque occurrence and records the ledgered
    /// change against the deterministic daily note.
    public func prepareMeetingInDailyNote(_ input: PrepareMeetingInDailyNoteInput) async throws -> PrepareMeetingInDailyNoteOutput {
        guard input.workspaceId.rawValue == workspaceId else { throw LoroMutationWireError.workspaceMismatch }
        do {
            let result = try await rpc("prepareMeetingInDailyNote", [
                "dailyNoteId": .string(input.dailyNoteId.rawValue),
                "localDate": .string(input.localDate.rawValue),
                "timeZone": .string(input.timeZone.rawValue),
                "occurrenceKey": .string(input.occurrenceKey),
                "intent": .object([
                    "requestId": .string(input.intent.requestId),
                    "commitMessage": .string(input.intent.commitMessage),
                    "attribution": loroAttributionValue(input.intent.attribution)
                ])
            ])
            return try decodeMeetingPreparationOutput(result)
        } catch is TodayBriefPreparationRPCError {
            throw TodayBriefPreparationRPCError.malformedResponse
        } catch is TodayBriefPreparationError {
            throw TodayBriefPreparationRPCError.malformedResponse
        }
    }
}

private func decodeMeetingPreparationOutput(_ value: CapnWebValue) throws -> PrepareMeetingInDailyNoteOutput {
    do {
        guard let dailyNoteId = try value.field("dailyNoteId").stringValue,
              let localDate = try value.field("localDate").stringValue,
              let occurrenceKey = try value.field("occurrenceKey").stringValue,
              let rawStatus = try value.field("status").stringValue,
              let resultSnapshotSha256 = try value.field("resultSnapshotSha256").stringValue,
              let status = PrepareMeetingInDailyNoteOutput.Status(rawValue: rawStatus) else {
            throw TodayBriefPreparationRPCError.malformedResponse
        }
        return try PrepareMeetingInDailyNoteOutput(
            dailyNoteId: EntityId(validating: dailyNoteId),
            localDate: LocalDate(validating: localDate),
            occurrenceKey: occurrenceKey,
            status: status,
            resultSnapshotSha256: resultSnapshotSha256
        )
    } catch {
        throw TodayBriefPreparationRPCError.malformedResponse
    }
}
