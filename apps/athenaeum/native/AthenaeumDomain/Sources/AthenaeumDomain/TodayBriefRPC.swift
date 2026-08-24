import Foundation

// Mirrors `packages/domain/src/today-brief-rpc.ts`: a deliberately privacy-safe, read-only
// calendar projection. These DTOs intentionally omit provider identifiers, attendee addresses,
// recurrence metadata, linked nodes, and sync timestamps.

/// A real `YYYY-MM-DD` calendar date, without a time or offset. Mirrors the `LocalDate` brand.
public struct LocalDate: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    public static func isValid(_ value: String) -> Bool {
        guard value.count == 10 else { return false }
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4,
              parts[1].count == 2,
              parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isNumber) }),
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2])
        else { return false }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = DateComponents(year: year, month: month, day: day)
        guard let date = calendar.date(from: components) else { return false }
        let resolved = calendar.dateComponents([.year, .month, .day], from: date)
        return resolved.year == year && resolved.month == month && resolved.day == day
    }

    public init(validating rawValue: String) throws {
        guard LocalDate.isValid(rawValue) else { throw AthenaeumDomainDecodingError.invalidLocalDate(rawValue) }
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        precondition(LocalDate.isValid(value), "LocalDate literal must be a real YYYY-MM-DD date: \(value)")
        self.rawValue = value
    }

    public var description: String { rawValue }
}

extension LocalDate: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard LocalDate.isValid(value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "LocalDate must be a real YYYY-MM-DD date, got: \(value)")
        }
        rawValue = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// An IANA time-zone identifier validated by Foundation's time-zone database. The server remains
/// authoritative for canonicalization and returns the resolved identifier in `GetTodayBriefOutput`.
public struct IanaTimeZone: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    public static func isValid(_ value: String) -> Bool { TimeZone(identifier: value) != nil }

    public init(validating rawValue: String) throws {
        guard IanaTimeZone.isValid(rawValue) else { throw AthenaeumDomainDecodingError.invalidIanaTimeZone(rawValue) }
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        precondition(IanaTimeZone.isValid(value), "IanaTimeZone literal must be a valid IANA zone: \(value)")
        self.rawValue = value
    }

    public var description: String { rawValue }
}

extension IanaTimeZone: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard IanaTimeZone.isValid(value) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "IanaTimeZone must be valid, got: \(value)")
        }
        rawValue = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Safe attendee projection: display names only, never addresses or person-node internals.
public struct TodayBriefPerson: Codable, Hashable, Sendable {
    public let displayName: String?
    public init(displayName: String? = nil) {
        precondition(displayName?.isEmpty != true, "TodayBriefPerson displayName must be nonempty when present")
        self.displayName = displayName
    }

    private enum CodingKeys: String, CodingKey { case displayName }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.displayName) else {
            displayName = nil
            return
        }
        do {
            guard try !container.decodeNil(forKey: .displayName) else {
                throw TodayBriefPersonDecodingError.malformed
            }
            let decoded = try container.decode(String.self, forKey: .displayName)
            guard !decoded.isEmpty else {
                throw TodayBriefPersonDecodingError.malformed
            }
            displayName = decoded
        } catch {
            // Keep the error independent of the malformed field and its value: this model is a
            // privacy-safe projection and must not echo data received from a calendar provider.
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Malformed Today Brief person")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // `Schema.optional` is represented by an omitted key, never an explicit `null`.
        if let displayName {
            try container.encode(displayName, forKey: .displayName)
        }
    }
}

private enum TodayBriefPersonDecodingError: Error {
    case malformed
}

/// One standalone event or resolved occurrence in the server-resolved local-day window.
public struct TodayBriefEvent: Codable, Hashable, Sendable {
    public let id: EntityId
    public let title: String
    public let start: IsoDateTimeString
    public let end: IsoDateTimeString
    public let people: [TodayBriefPerson]

    public init(id: EntityId, title: String, start: IsoDateTimeString, end: IsoDateTimeString, people: [TodayBriefPerson]) {
        self.id = id
        self.title = title
        self.start = start
        self.end = end
        self.people = people
    }
}

/// Describes only Athenaeum's retained projection, never the user's real-world calendar.
public enum TodayBriefHistoryStatus: String, Codable, Hashable, Sendable {
    case found
    case noneInRetainedData
    case unavailable
}

public struct TodayBriefCalendarHistory: Codable, Hashable, Sendable {
    public let status: TodayBriefHistoryStatus
    public init(status: TodayBriefHistoryStatus) { self.status = status }
}

public struct GetTodayBriefInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let localDate: LocalDate
    public let timeZone: IanaTimeZone

    public init(workspaceId: EntityId, localDate: LocalDate, timeZone: IanaTimeZone) {
        self.workspaceId = workspaceId
        self.localDate = localDate
        self.timeZone = timeZone
    }
}

public struct GetTodayBriefOutput: Codable, Hashable, Sendable {
    public let localDate: LocalDate
    public let timeZone: IanaTimeZone
    /// Inclusive local-day boundary, encoded as an instant.
    public let from: IsoDateTimeString
    /// Exclusive local-day boundary, encoded as an instant.
    public let to: IsoDateTimeString
    public let calendarHistory: TodayBriefCalendarHistory
    public let events: [TodayBriefEvent]

    public init(
        localDate: LocalDate,
        timeZone: IanaTimeZone,
        from: IsoDateTimeString,
        to: IsoDateTimeString,
        calendarHistory: TodayBriefCalendarHistory,
        events: [TodayBriefEvent]
    ) {
        self.localDate = localDate
        self.timeZone = timeZone
        self.from = from
        self.to = to
        self.calendarHistory = calendarHistory
        self.events = events
    }
}
