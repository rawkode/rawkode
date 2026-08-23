import Foundation

// Mirrors `packages/domain/src/node.ts`'s `EntityId` brand: "a stable entity identifier: either a
// ULID (26-char Crockford base32) or a UUID." On the wire this is a plain JSON string (Effect's
// `Schema.brand` is a decode-time-only refinement — its `Encoded` type is `string`, per
// `view-spec.ts`'s own doc comment about `ViewPredicateEncoded`), so `EntityId` here is a thin
// validating wrapper around `String`, not a distinct storage representation: `Codable` encodes to
// a bare JSON string and decodes from one, validating the same two patterns the TS schema checks.

/// A stable entity identifier: either a ULID (26-char Crockford base32) or a UUID.
public struct EntityId: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    /// Matches `node.ts`'s `ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/` — Crockford base32,
    /// excluding I/L/O/U, first character restricted to 0-7 (so a 26-char ULID never exceeds the
    /// maximum representable timestamp).
    private static let ulidPattern = #"^[0-7][0-9A-HJKMNP-TV-Z]{25}$"#
    /// Matches `node.ts`'s `uuidPattern` — standard 8-4-4-4-12 hex UUID, case-insensitive.
    private static let uuidPattern =
        #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#

    private static func matches(_ pattern: String, _ value: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.firstMatch(in: value, range: range) != nil
    }

    public static func isValid(_ value: String) -> Bool {
        matches(ulidPattern, value) || matches(uuidPattern, value)
    }

    /// Validating initializer — mirrors `Schema.decodeUnknown(EntityId)` failing on a malformed
    /// string rather than silently accepting it.
    ///
    /// Deliberately labeled `validating:`, not `init(_:)`: an unlabeled `init(_ rawValue: String)
    /// throws` sitting alongside `ExpressibleByStringLiteral`'s `init(stringLiteral:)` is a real
    /// Swift overload-resolution trap — `EntityId("literal-string")` at a call site is ambiguous
    /// between the two, and Swift's resolver *silently prefers the non-throwing literal
    /// initializer*, meaning `try EntityId("garbage")` would compile (with only an "unused try"
    /// warning) but never actually validate, run the trapping `stringLiteral` path instead, and
    /// crash rather than throw on bad input. Explicit labels make the two calls unambiguous:
    /// `try EntityId(validating: someString)` for untrusted runtime input,
    /// `EntityId("known-good-literal")` for trusted compile-time constants (`BaseTagIds` below).
    public init(validating rawValue: String) throws {
        guard EntityId.isValid(rawValue) else {
            throw AthenaeumDomainDecodingError.invalidEntityId(rawValue)
        }
        self.rawValue = rawValue
    }

    /// Non-validating construction for literal, known-valid values (mirrors `EntityId.make(...)`
    /// on the TS side, e.g. `tag.ts`'s `BaseTagIds` — a trusted compile-time constant, not
    /// untrusted input). Traps on a malformed literal, exactly like `Schema.decodeSync` would
    /// throw synchronously on one — a programmer error, not a runtime data error.
    public init(stringLiteral value: String) {
        precondition(EntityId.isValid(value), "EntityId literal is not a valid ULID or UUID: \(value)")
        self.rawValue = value
    }

    public var description: String { rawValue }
}

extension EntityId: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard EntityId.isValid(value) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "EntityId must be a ULID or a UUID, got: \(value)"
            )
        }
        self.rawValue = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Mirrors `packages/domain/src/node.ts`'s `IsoDateTimeString` brand: "an ISO-8601 timestamp,
/// represented on the wire and in storage as a plain string." Validated the same way the TS
/// schema validates it (`!Number.isNaN(Date.parse(value))` — permissive: any string `Date.parse`
/// can make sense of, not strictly RFC 3339 alone), via `ISO8601DateFormatter` with a fallback to
/// `DateFormatter` for the fractional-seconds and space-separated forms `Date.parse` also accepts.
public struct IsoDateTimeString: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    private static let iso8601Fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601Plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Fallback for date-only / space-separated forms `Date.parse` accepts but `ISO8601DateFormatter`
    /// (which requires a `T`/timezone) does not — kept intentionally small (this brand's own job is
    /// "a valid-looking timestamp string", not full RFC 3339/`Date.parse` parity).
    private static let fallbackFormats = ["yyyy-MM-dd", "yyyy-MM-dd HH:mm:ss"]

    public static func isValid(_ value: String) -> Bool {
        if iso8601Fractional.date(from: value) != nil { return true }
        if iso8601Plain.date(from: value) != nil { return true }
        for format in fallbackFormats {
            let formatter = DateFormatter()
            formatter.dateFormat = format
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(identifier: "UTC")
            if formatter.date(from: value) != nil { return true }
        }
        return false
    }

    /// See `EntityId.init(validating:)`'s doc comment for why this is labeled, not `init(_:)`.
    public init(validating rawValue: String) throws {
        guard IsoDateTimeString.isValid(rawValue) else {
            throw AthenaeumDomainDecodingError.invalidIsoDateTimeString(rawValue)
        }
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        precondition(
            IsoDateTimeString.isValid(value),
            "IsoDateTimeString literal is not a valid ISO-8601 date-time string: \(value)"
        )
        self.rawValue = value
    }

    public var description: String { rawValue }
}

extension IsoDateTimeString: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard IsoDateTimeString.isValid(value) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "IsoDateTimeString must be a valid ISO-8601 date-time string, got: \(value)"
            )
        }
        self.rawValue = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Errors this package's hand-validated branded scalars (`EntityId`, `IsoDateTimeString`) throw
/// from their validating (non-literal) initializers — the Swift-side analog of a `ParseError` from
/// `Schema.decodeUnknown(EntityId)`/`Schema.decodeUnknown(IsoDateTimeString)` failing.
public enum AthenaeumDomainDecodingError: Error, Sendable, Equatable {
    case invalidEntityId(String)
    case invalidIsoDateTimeString(String)
    case invalidWorkspaceEpoch(String)
    /// Phase 4 addition — see `Auth.swift`'s `Email.init(validating:)`.
    case invalidEmail(String)
    /// Phase 4 addition — see `Sharing.swift`'s `ShareKeyHash.init(validating:)`.
    case invalidShareKeyHash(String)
    /// Phase 5 addition — see `Bookmark.swift`'s `BookmarkUrl.init(validating:)`.
    case invalidBookmarkUrl(String)
}
