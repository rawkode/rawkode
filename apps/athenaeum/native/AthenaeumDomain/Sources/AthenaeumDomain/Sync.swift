import Foundation

/// Mirrors `packages/domain/src/sync.ts`'s `SyncFeedEntry.operation` literal (`"put"|"delete"`).
public enum SyncOperation: String, Codable, Hashable, Sendable {
    case put, delete
}

/// Mirrors `sync.ts`'s `SyncFeedEntry` — one entry in a workspace's append-only structured-record
/// sync feed. `payload` is `JSONValue` here, not `Schema.Unknown` verbatim: this package's own
/// `JsonValue`/`JSONValue` reasoning (json-value.ts) applies — a feed entry's payload is always a
/// full encoded entity or tombstone/conflict marker, which is itself JSON-safe once it has
/// crossed the wire, even though the *TS* schema leaves it unvalidated at this layer (see that
/// file's doc comment for why `Schema.Unknown` was chosen there: re-validating a JsonValue-shaped
/// union here would just duplicate the entity-specific validation the apply-logic already does
/// after dispatching on `entityKind`). Modeling it as `JSONValue` rather than `AnyCodable`/
/// `Data` keeps this struct's `Codable` conformance simple and still round-trips every payload
/// shape any current entity produces, at the cost of accepting *only* JSON-safe payloads — a
/// strictly narrower acceptance than `Schema.Unknown`'s "anything", which is the same direction
/// `Fact.value`/`ViewPredicate` already narrow in, not a new inconsistency.
public struct SyncFeedEntry: Codable, Hashable, Sendable {
    public let replicaEpoch: Int
    public let monotonicCounter: Int
    public let entityKind: String
    public let entityId: EntityId
    public let operation: SyncOperation
    public let payload: JSONValue
    public let hash: String

    public init(
        replicaEpoch: Int,
        monotonicCounter: Int,
        entityKind: String,
        entityId: EntityId,
        operation: SyncOperation,
        payload: JSONValue,
        hash: String
    ) {
        self.replicaEpoch = replicaEpoch
        self.monotonicCounter = monotonicCounter
        self.entityKind = entityKind
        self.entityId = entityId
        self.operation = operation
        self.payload = payload
        self.hash = hash
    }
}

/// Mirrors `sync.ts`'s `WorkspaceEpoch` — a random opaque token a client only ever compares for
/// equality, branded as an opaque string (not a number) on both sides for the same reason: it is
/// not orderable/incrementable.
public struct WorkspaceEpoch: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    /// See `EntityId.init(validating:)`'s doc comment for why this is labeled, not `init(_:)`.
    public init(validating rawValue: String) throws {
        guard !rawValue.isEmpty else {
            throw AthenaeumDomainDecodingError.invalidWorkspaceEpoch(rawValue)
        }
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        precondition(!value.isEmpty, "WorkspaceEpoch literal must not be empty")
        self.rawValue = value
    }

    public var description: String { rawValue }
}

extension WorkspaceEpoch: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard !value.isEmpty else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "WorkspaceEpoch must be a non-empty string"
            )
        }
        self.rawValue = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Mirrors `sync.ts`'s `AutomergeSyncSession` — the Automerge prose-sync side's minimal session
/// envelope: opaque `sessionId` stable across reconnects, per-session `ordinal`, `reset` signaling
/// the "reclaim on ambiguous timeout" path.
public struct AutomergeSyncSession: Codable, Hashable, Sendable {
    public let sessionId: String
    public let ordinal: Int
    public let reset: Bool

    public init(sessionId: String, ordinal: Int, reset: Bool) {
        self.sessionId = sessionId
        self.ordinal = ordinal
        self.reset = reset
    }
}
