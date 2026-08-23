import Foundation

// Mirrors `packages/domain/src/sharing.ts` — direct port of docs/sharing.md's
// collaborator/permission-graph/share-link *shape* onto workspaces (plan §"Sharing/observers on
// workspaces"). `gadget` -> `workspace`, `Overseer` -> `WorkspaceDurableObject`, `profile.id` -> `Email`. See
// `sharing.ts`'s own header comment for the full section-by-section citation of docs/sharing.md
// this ports; not repeated here beyond a one-line pointer per type.

/// Collaborator access level. Totally ordered: `.build` > `.use` (docs/sharing.md
/// §Collaborators). Mirrors `sharing.ts`'s `Role = Schema.Literal("build", "use")` — a Swift
/// `String`-backed enum round-trips to/from the identical wire string, so no custom `Codable` is
/// needed (unlike `PermissionEdge`'s tagged union below).
public enum Role: String, Codable, Hashable, Sendable {
    case build
    case use
}

/// A 64-character lowercase hex SHA-256 digest — mirrors `sharing.ts`'s `ShareKeyHash` brand (the
/// storage id/hash shape `hashShareKey` produces). Deliberately a distinct validating wrapper from
/// `EntityId`, same rationale as the TS side: a share key hash can never be mistaken for an
/// ordinary entity id.
public struct ShareKeyHash: Hashable, Sendable, CustomStringConvertible, ExpressibleByStringLiteral {
    public let rawValue: String

    private static let pattern = #"^[0-9a-f]{64}$"#

    public static func isValid(_ value: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.firstMatch(in: value, range: range) != nil
    }

    public init(validating rawValue: String) throws {
        guard ShareKeyHash.isValid(rawValue) else {
            throw AthenaeumDomainDecodingError.invalidShareKeyHash(rawValue)
        }
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        precondition(ShareKeyHash.isValid(value), "ShareKeyHash literal is not a 64-char hex digest: \(value)")
        self.rawValue = value
    }

    public var description: String { rawValue }
}

extension ShareKeyHash: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        guard ShareKeyHash.isValid(value) else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "ShareKeyHash must be a 64-char hex digest, got: \(value)"
            )
        }
        self.rawValue = value
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// Records that `sharerId` directly added this collaborator (docs/sharing.md §Permission graph /
/// Edges: "User edge"). Mirrors `sharing.ts`'s `UserEdge` exactly, including the discriminant
/// `type` field (`PermissionEdge`'s tag) as a plain stored property, matching the TS
/// `Schema.Union`'s flat-object-with-discriminant wire shape.
public struct UserEdge: Codable, Hashable, Sendable {
    public let type: String
    public let sharerId: Email
    public let role: Role
    public let timestamp: IsoDateTimeString
    public let note: String?
    public init(sharerId: Email, role: Role, timestamp: IsoDateTimeString, note: String? = nil) {
        self.type = "user"
        self.sharerId = sharerId
        self.role = role
        self.timestamp = timestamp
        self.note = note
    }
}

/// Records that this collaborator redeemed a key for share link `linkId` (docs/sharing.md
/// §Permission graph / Edges: "Share-link edge"). Mirrors `sharing.ts`'s `ShareLinkEdge`.
public struct ShareLinkEdge: Codable, Hashable, Sendable {
    public let type: String
    public let linkId: ShareKeyHash
    public let timestamp: IsoDateTimeString
    public init(linkId: ShareKeyHash, timestamp: IsoDateTimeString) {
        self.type = "shareLink"
        self.linkId = linkId
        self.timestamp = timestamp
    }
}

/// One edge in a workspace's permission graph (docs/sharing.md §Permission graph). Mirrors `sharing.ts`'s
/// `PermissionEdge = Schema.Union(UserEdge, ShareLinkEdge)` — hand-written tagged-union `Codable`
/// dispatching on the shared `type` discriminant, the same "hand-verified against the TS union's
/// discriminant+payload shape" convention `ViewSpec.swift`/`RpcError.swift` already use for their
/// own `Schema.Union`s (see `schema-diff.ts`'s `KNOWN_LIMITATIONS` — unions are out of that tool's
/// automated scope by design, verified by hand here instead).
public enum PermissionEdge: Hashable, Sendable {
    case user(UserEdge)
    case shareLink(ShareLinkEdge)

    public var role: Role? {
        switch self {
        case .user(let edge): return edge.role
        case .shareLink: return nil // taken from the link itself, not the edge (sharing.ts's own note)
        }
    }
}

extension PermissionEdge: Codable {
    private enum DiscriminantKey: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DiscriminantKey.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "user": self = .user(try UserEdge(from: decoder))
        case "shareLink": self = .shareLink(try ShareLinkEdge(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown PermissionEdge type: \(type)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .user(let edge): try edge.encode(to: encoder)
        case .shareLink(let edge): try edge.encode(to: encoder)
        }
    }
}

/// A workspace's stored collaborator record (docs/sharing.md §Collaborators / §Permission graph).
/// Mirrors `sharing.ts`'s `Collaborator` — deliberately carries no `role` field, see
/// `CollaboratorInfo` for the listing-facing shape that does.
public struct Collaborator: Codable, Hashable, Sendable {
    public let profileId: Email
    public let workspaceId: EntityId
    public let edges: [PermissionEdge]
    public init(profileId: Email, workspaceId: EntityId, edges: [PermissionEdge]) {
        self.profileId = profileId
        self.workspaceId = workspaceId
        self.edges = edges
    }
}

/// A `Collaborator` plus their current live-computed effective role — mirrors `sharing.ts`'s
/// `CollaboratorInfo`, the shape `listCollaborators`/the preview RPCs actually return.
public struct CollaboratorInfo: Codable, Hashable, Sendable {
    public let profileId: Email
    public let workspaceId: EntityId
    public let edges: [PermissionEdge]
    public let role: Role
    public init(profileId: Email, workspaceId: EntityId, edges: [PermissionEdge], role: Role) {
        self.profileId = profileId
        self.workspaceId = workspaceId
        self.edges = edges
        self.role = role
    }
}

/// A share link: a durable handle that owns one or more keys (docs/sharing.md §Adding
/// collaborators / Share link). Mirrors `sharing.ts`'s `ShareLink`.
public struct ShareLink: Codable, Hashable, Sendable {
    public let id: ShareKeyHash
    public let workspaceId: EntityId
    public let creatorId: Email
    public let role: Role
    public let revoked: Bool
    public let createdAt: IsoDateTimeString
    public init(
        id: ShareKeyHash, workspaceId: EntityId, creatorId: Email, role: Role, revoked: Bool, createdAt: IsoDateTimeString
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.creatorId = creatorId
        self.role = role
        self.revoked = revoked
        self.createdAt = createdAt
    }
}

/// One row of the `shareKeys` collection (docs/sharing.md §Adding collaborators / Share link:
/// "Storage shape: a link is its first key"). Mirrors `sharing.ts`'s `ShareKeyRecord`.
public struct ShareKeyRecord: Codable, Hashable, Sendable {
    public let hash: ShareKeyHash
    public let linkId: ShareKeyHash
    public let alias: Bool
    public init(hash: ShareKeyHash, linkId: ShareKeyHash, alias: Bool) {
        self.hash = hash
        self.linkId = linkId
        self.alias = alias
    }
}

/// A collaborator whose effective role changed (or would change) as the result of a removal/
/// revocation (docs/sharing.md §Removals and downgrades / §Preview and confirm). Mirrors
/// `sharing.ts`'s `AffectedCollaborator` — `newRole == nil` means full removal, matching the TS
/// side's `newRole === null` convention (`Schema.NullOr`, not `Schema.optional`).
public struct AffectedCollaborator: Codable, Hashable, Sendable {
    public let profileId: Email
    public let workspaceId: EntityId
    public let edges: [PermissionEdge]
    public let oldRole: Role
    public let newRole: Role?
    public init(profileId: Email, workspaceId: EntityId, edges: [PermissionEdge], oldRole: Role, newRole: Role?) {
        self.profileId = profileId
        self.workspaceId = workspaceId
        self.edges = edges
        self.oldRole = oldRole
        self.newRole = newRole
    }
}

/// One row of a user's multi-workspace catalog listing (plan §Phased delivery, Phase 4: "multi-workspace
/// in the User DO with the fixed-identity default 'Personal' workspace"). Mirrors `sharing.ts`'s
/// `WorkspaceCatalogEntry`.
public struct WorkspaceCatalogEntry: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let title: String
    public let ownerId: Email
    public let role: Role
    public let isDefault: Bool
    public init(workspaceId: EntityId, title: String, ownerId: Email, role: Role, isDefault: Bool) {
        self.workspaceId = workspaceId
        self.title = title
        self.ownerId = ownerId
        self.role = role
        self.isDefault = isDefault
    }
}
