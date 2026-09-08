import Foundation

// Phase 4 ("port SharingManager (docs/sharing.md) as-designed onto workspaces") — the native client
// for `workspace-durable-object.ts`'s 9 sharing Cap'n Web methods (`addCollaborator`,
// `previewRemoveCollaborator`, `removeCollaborator`, `createShareLink`, `redeemShareLink`,
// `previewRevokeShareLink`, `revokeShareLink`, `listCollaborators`, `listShareLinks`). Same
// `rpc(_:_:)` dispatch / hand-rolled "RPC*"-prefixed decode-struct convention as
// `WorkspaceRPCClient+Graph.swift`/`WorkspaceRPCClient+AgentEdit.swift` — every method here REQUIRES a
// real caller (`init(bearerCredential:)` must be non-nil), matching `sharing-rpc.ts`'s own header
// comment: "sharing has no meaningful anonymous case."

/// Mirrors `AthenaeumDomain`'s `PermissionEdge` union (`UserEdge`/`ShareLinkEdge`), hand-decoded
/// from `CapnWebValue` on the shared `type` discriminant — same tagged-union convention as
/// `RpcError.swift`'s `AthenaeumDomainError`.
public enum RPCPermissionEdge: Sendable, Equatable {
    case user(sharerId: String, role: String, timestamp: String, note: String?)
    case shareLink(linkId: String, timestamp: String)

    init(_ value: CapnWebValue) throws {
        guard let type = try value.field("type").stringValue else {
            throw CapnWebError.malformedMessage("malformed PermissionEdge (missing type): \(value)")
        }
        switch type {
        case "user":
            guard let sharerId = try value.field("sharerId").stringValue,
                  let role = try value.field("role").stringValue,
                  let timestamp = try value.field("timestamp").stringValue
            else { throw CapnWebError.malformedMessage("malformed UserEdge: \(value)") }
            self = .user(sharerId: sharerId, role: role, timestamp: timestamp, note: try value.field("note").stringValue)
        case "shareLink":
            guard let linkId = try value.field("linkId").stringValue,
                  let timestamp = try value.field("timestamp").stringValue
            else { throw CapnWebError.malformedMessage("malformed ShareLinkEdge: \(value)") }
            self = .shareLink(linkId: linkId, timestamp: timestamp)
        default:
            throw CapnWebError.malformedMessage("unknown PermissionEdge type: \(type)")
        }
    }
}

/// Mirrors `AthenaeumDomain`'s `CollaboratorInfo`.
public struct RPCCollaboratorInfo: Sendable, Equatable {
    public let profileId: String
    public let workspaceId: String
    public let edges: [RPCPermissionEdge]
    public let role: String

    init(_ value: CapnWebValue) throws {
        guard let profileId = try value.field("profileId").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let role = try value.field("role").stringValue
        else { throw CapnWebError.malformedMessage("malformed CollaboratorInfo: \(value)") }
        self.profileId = profileId
        self.workspaceId = workspaceId
        self.role = role
        self.edges = try (value.field("edges").arrayValue ?? []).map(RPCPermissionEdge.init)
    }
}

/// Mirrors `AthenaeumDomain`'s `AffectedCollaborator`. `newRole == nil` means full removal
/// (`newRole === null` on the wire), matching `sharing.ts`'s own `Schema.NullOr` convention.
public struct RPCAffectedCollaborator: Sendable, Equatable {
    public let profileId: String
    public let workspaceId: String
    public let oldRole: String
    public let newRole: String?

    init(_ value: CapnWebValue) throws {
        guard let profileId = try value.field("profileId").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let oldRole = try value.field("oldRole").stringValue
        else { throw CapnWebError.malformedMessage("malformed AffectedCollaborator: \(value)") }
        self.profileId = profileId
        self.workspaceId = workspaceId
        self.oldRole = oldRole
        self.newRole = try value.field("newRole").stringValue
    }
}

/// Mirrors `AthenaeumDomain`'s `ShareLink`.
public struct RPCShareLink: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let creatorId: String
    public let role: String
    public let revoked: Bool
    public let createdAt: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let creatorId = try value.field("creatorId").stringValue,
              let role = try value.field("role").stringValue,
              let revoked = try value.field("revoked").boolValue,
              let createdAt = try value.field("createdAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed ShareLink: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.creatorId = creatorId
        self.role = role
        self.revoked = revoked
        self.createdAt = createdAt
    }
}

extension WorkspaceRPCClient {
    // MARK: - Collaborators

    /// `role` is `"build"` or `"use"` (`Role`'s two wire literals — see `Sharing.swift`'s `Role`
    /// enum; kept as a plain `String` here, same "no speculative Swift enum for a two-case
    /// literal union this stage doesn't otherwise need" choice `runView`'s `viewName` makes).
    public func addCollaborator(profileId: String, role: String, note: String? = nil) async throws -> RPCCollaboratorInfo {
        var args: [String: CapnWebValue] = ["profileId": .string(profileId), "role": .string(role)]
        args["note"] = note.map(CapnWebValue.string) ?? .undefined
        let result = try await rpc("addCollaborator", args)
        return try RPCCollaboratorInfo(result.field("collaborator"))
    }

    public func previewRemoveCollaborator(profileId: String) async throws -> [RPCAffectedCollaborator] {
        let result = try await rpc("previewRemoveCollaborator", ["profileId": .string(profileId)])
        return try (result.field("affected").arrayValue ?? []).map(RPCAffectedCollaborator.init)
    }

    public func removeCollaborator(profileId: String, keepUsers: [String] = []) async throws -> [RPCAffectedCollaborator] {
        var args: [String: CapnWebValue] = ["profileId": .string(profileId)]
        if !keepUsers.isEmpty { args["keepUsers"] = .array(keepUsers.map(CapnWebValue.string)) }
        let result = try await rpc("removeCollaborator", args)
        return try (result.field("affected").arrayValue ?? []).map(RPCAffectedCollaborator.init)
    }

    public func listCollaborators() async throws -> [RPCCollaboratorInfo] {
        let result = try await rpc("listCollaborators", [:])
        return try (result.field("collaborators").arrayValue ?? []).map(RPCCollaboratorInfo.init)
    }

    // MARK: - Share links

    public func createShareLink(role: String, note: String? = nil) async throws -> (key: String, link: RPCShareLink) {
        var args: [String: CapnWebValue] = ["role": .string(role)]
        args["note"] = note.map(CapnWebValue.string) ?? .undefined
        let result = try await rpc("createShareLink", args)
        guard let key = try result.field("key").stringValue else {
            throw CapnWebError.malformedMessage("createShareLink response missing key")
        }
        return (key: key, link: try RPCShareLink(result.field("link")))
    }

    public func redeemShareLink(key: String) async throws -> RPCCollaboratorInfo {
        let result = try await rpc("redeemShareLink", ["key": .string(key)])
        return try RPCCollaboratorInfo(result.field("collaborator"))
    }

    public func previewRevokeShareLink(linkId: String) async throws -> [RPCAffectedCollaborator] {
        let result = try await rpc("previewRevokeShareLink", ["linkId": .string(linkId)])
        return try (result.field("affected").arrayValue ?? []).map(RPCAffectedCollaborator.init)
    }

    public func revokeShareLink(linkId: String, keepUsers: [String] = []) async throws -> [RPCAffectedCollaborator] {
        var args: [String: CapnWebValue] = ["linkId": .string(linkId)]
        if !keepUsers.isEmpty { args["keepUsers"] = .array(keepUsers.map(CapnWebValue.string)) }
        let result = try await rpc("revokeShareLink", args)
        return try (result.field("affected").arrayValue ?? []).map(RPCAffectedCollaborator.init)
    }

    public func listShareLinks() async throws -> [RPCShareLink] {
        let result = try await rpc("listShareLinks", [:])
        return try (result.field("shareLinks").arrayValue ?? []).map(RPCShareLink.init)
    }
}
