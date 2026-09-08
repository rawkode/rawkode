import Foundation

// Mirrors `packages/domain/src/sharing-rpc.ts` — wire schemas for the Phase 4 sharing/multi-workspace
// RPC surface (plan §"Sharing/observers on workspaces"). One Swift struct per TS `Schema.Class`
// input/output pair, same convention as `GraphRPC.swift`/`NodeRPC.swift`. See `sharing-rpc.ts`'s
// own header comment for the full rationale (identity threaded via auth context, not an explicit
// `callerId` field; `createWorkspace`/`listWorkspaces` are User-DO-scoped, everything else workspace-scoped).

// --- Multi-workspace catalog (User DO-scoped) ------------------------------------------------------

public struct CreateWorkspaceInput: Codable, Hashable, Sendable {
    public let title: String
    public init(title: String) { self.title = title }
}

public struct CreateWorkspaceOutput: Codable, Hashable, Sendable {
    public let workspace: WorkspaceCatalogEntry
    public init(workspace: WorkspaceCatalogEntry) { self.workspace = workspace }
}

/// Zero-field input — mirrors `sharing-rpc.ts`'s `ListWorkspacesInput extends Schema.Class(...)({})`.
/// See the web stage's own note (`user-rpc-client.ts`) about `Schema.encodeSync` misbehaving on a
/// zero-field `Schema.Class`: this Swift side is unaffected (it never round-trips through
/// `Schema.encodeSync`), but `UserRPCClient.listWorkspaces()` still sends the wire literal `{}`
/// directly rather than constructing/encoding this type, for the identical reason.
public struct ListWorkspacesInput: Codable, Hashable, Sendable {
    public init() {}
}

public struct ListWorkspacesOutput: Codable, Hashable, Sendable {
    public let workspaces: [WorkspaceCatalogEntry]
    public init(workspaces: [WorkspaceCatalogEntry]) { self.workspaces = workspaces }
}

// --- Collaborator management --------------------------------------------------------------------

public struct AddCollaboratorInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let profileId: Email
    public let role: Role
    public let note: String?
    public init(workspaceId: EntityId, profileId: Email, role: Role, note: String? = nil) {
        self.workspaceId = workspaceId
        self.profileId = profileId
        self.role = role
        self.note = note
    }
}

public struct AddCollaboratorOutput: Codable, Hashable, Sendable {
    public let collaborator: CollaboratorInfo
    public init(collaborator: CollaboratorInfo) { self.collaborator = collaborator }
}

public struct RemoveCollaboratorInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let profileId: Email
    public let keepUsers: [Email]?
    public init(workspaceId: EntityId, profileId: Email, keepUsers: [Email]? = nil) {
        self.workspaceId = workspaceId
        self.profileId = profileId
        self.keepUsers = keepUsers
    }
}

public struct RemoveCollaboratorOutput: Codable, Hashable, Sendable {
    public let affected: [AffectedCollaborator]
    public init(affected: [AffectedCollaborator]) { self.affected = affected }
}

public struct PreviewRemoveCollaboratorInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let profileId: Email
    public init(workspaceId: EntityId, profileId: Email) {
        self.workspaceId = workspaceId
        self.profileId = profileId
    }
}

public struct PreviewRemoveCollaboratorOutput: Codable, Hashable, Sendable {
    public let affected: [AffectedCollaborator]
    public init(affected: [AffectedCollaborator]) { self.affected = affected }
}

public struct ListCollaboratorsInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListCollaboratorsOutput: Codable, Hashable, Sendable {
    public let collaborators: [CollaboratorInfo]
    public init(collaborators: [CollaboratorInfo]) { self.collaborators = collaborators }
}

// --- Share links -----------------------------------------------------------------------------

public struct CreateShareLinkInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let role: Role
    public let note: String?
    public init(workspaceId: EntityId, role: Role, note: String? = nil) {
        self.workspaceId = workspaceId
        self.role = role
        self.note = note
    }
}

public struct CreateShareLinkOutput: Codable, Hashable, Sendable {
    public let key: String
    public let link: ShareLink
    public init(key: String, link: ShareLink) {
        self.key = key
        self.link = link
    }
}

public struct RedeemShareLinkInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let key: String
    public init(workspaceId: EntityId, key: String) {
        self.workspaceId = workspaceId
        self.key = key
    }
}

public struct RedeemShareLinkOutput: Codable, Hashable, Sendable {
    public let collaborator: CollaboratorInfo
    public init(collaborator: CollaboratorInfo) { self.collaborator = collaborator }
}

public struct RevokeShareLinkInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let linkId: ShareKeyHash
    public let keepUsers: [Email]?
    public init(workspaceId: EntityId, linkId: ShareKeyHash, keepUsers: [Email]? = nil) {
        self.workspaceId = workspaceId
        self.linkId = linkId
        self.keepUsers = keepUsers
    }
}

public struct RevokeShareLinkOutput: Codable, Hashable, Sendable {
    public let affected: [AffectedCollaborator]
    public init(affected: [AffectedCollaborator]) { self.affected = affected }
}

public struct PreviewRevokeShareLinkInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let linkId: ShareKeyHash
    public init(workspaceId: EntityId, linkId: ShareKeyHash) {
        self.workspaceId = workspaceId
        self.linkId = linkId
    }
}

public struct PreviewRevokeShareLinkOutput: Codable, Hashable, Sendable {
    public let affected: [AffectedCollaborator]
    public init(affected: [AffectedCollaborator]) { self.affected = affected }
}

public struct ListShareLinksInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct ListShareLinksOutput: Codable, Hashable, Sendable {
    public let shareLinks: [ShareLink]
    public init(shareLinks: [ShareLink]) { self.shareLinks = shareLinks }
}
