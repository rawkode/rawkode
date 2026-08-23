import Foundation

// Phase 5 native stage — mirrors `packages/domain/src/gatekeeper-binding.ts`. See that file's own
// header comment for the full rationale (extensible `gatekeeperKind` literal union, per-kind
// discriminated `config` payload, why `gatekeeperKind` duplicates `config.kind`).

/// Mirrors `gatekeeper-binding.ts`'s `GatekeeperKind = Schema.Literal("google-calendar")` —
/// extensible; today's one member.
public enum GatekeeperKind: String, Codable, Hashable, Sendable {
    case googleCalendar = "google-calendar"
}

/// Mirrors `gatekeeper-binding.ts`'s `GoogleCalendarBindingConfig` — `Schema.Class`, diffed by
/// `schema-diff.ts`.
public struct GoogleCalendarBindingConfig: Codable, Hashable, Sendable {
    public let kind: String
    public let calendarId: String
    public let mode: String

    public init(calendarId: String, mode: String) {
        self.kind = "google-calendar"
        self.calendarId = calendarId
        self.mode = mode
    }
}

/// Mirrors `gatekeeper-binding.ts`'s `GatekeeperBindingConfig = Schema.Union(GoogleCalendarBindingConfig)`
/// — one real member today, declared as a Swift enum (not a bare alias) for the same "a second
/// gatekeeper kind's config slots in later" reason the TS side gives. Hand-`Codable` (unions are
/// out of `schema-diff.ts`'s automated scope, see `KNOWN_LIMITATIONS`).
public enum GatekeeperBindingConfig: Hashable, Sendable {
    case googleCalendar(GoogleCalendarBindingConfig)
}

extension GatekeeperBindingConfig: Codable {
    private enum DiscriminantKey: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminantKey.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "google-calendar":
            self = .googleCalendar(try GoogleCalendarBindingConfig(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: container, debugDescription: "Unknown GatekeeperBindingConfig kind: \(kind)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .googleCalendar(let config): try config.encode(to: encoder)
        }
    }
}

/// Mirrors `gatekeeper-binding.ts`'s `GatekeeperBinding` — a workspace's connection to one external
/// gatekeeper-governed resource, `{id, workspaceId, gatekeeperKind, boundBy, config, createdAt}`.
/// `Schema.Class`, diffed by `schema-diff.ts`.
public struct GatekeeperBinding: Codable, Hashable, Sendable {
    public let id: EntityId
    public let workspaceId: EntityId
    public let gatekeeperKind: GatekeeperKind
    public let boundBy: Email
    public let config: GatekeeperBindingConfig
    public let createdAt: IsoDateTimeString

    public init(
        id: EntityId,
        workspaceId: EntityId,
        gatekeeperKind: GatekeeperKind,
        boundBy: Email,
        config: GatekeeperBindingConfig,
        createdAt: IsoDateTimeString
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.gatekeeperKind = gatekeeperKind
        self.boundBy = boundBy
        self.config = config
        self.createdAt = createdAt
    }
}
