import Foundation

// Phase 4 ("multi-workspace in the User DO with the fixed-identity default 'Personal' workspace") — the
// native client for `packages/backend/src/index.ts`'s `GET/POST /api/user` route, i.e.
// `UserDurableObject`'s `UserRpcApi` (`createWorkspace`/`listWorkspaces`). Same `CapnWebBatchClient`
// transport `WorkspaceRPCClient` uses, pointed at a different endpoint, with a MANDATORY bearer
// credential — unlike `WorkspaceRPCClient`, there is no anonymous "whose catalog" case (see
// `user-durable-object.ts`'s own doc comment), so this client's initializer does not make
// `bearerCredential` optional.

/// Mirrors `AthenaeumDomain`'s `WorkspaceCatalogEntry` — hand-decoded from `CapnWebValue`, same
/// "RPC*"-prefixed, hand-rolled-decoder convention `WorkspaceRPCClient.swift`'s `RPCNode`/`RPCTag`/etc.
/// already establish (this package deliberately does not depend on `AthenaeumDomain` — see this
/// package's own `Package.swift` header comment on why it stays a hand-rolled minimal client, not
/// a generated one).
public struct RPCWorkspaceCatalogEntry: Sendable, Equatable {
    public let workspaceId: String
    public let title: String
    public let ownerId: String
    public let role: String
    public let isDefault: Bool

    init(_ value: CapnWebValue) throws {
        guard let workspaceId = try value.field("workspaceId").stringValue,
              let title = try value.field("title").stringValue,
              let ownerId = try value.field("ownerId").stringValue,
              let role = try value.field("role").stringValue,
              let isDefault = try value.field("isDefault").boolValue
        else { throw CapnWebError.malformedMessage("malformed WorkspaceCatalogEntry: \(value)") }
        self.workspaceId = workspaceId
        self.title = title
        self.ownerId = ownerId
        self.role = role
        self.isDefault = isDefault
    }
}

/// Typed convenience wrapper over `CapnWebBatchClient`, scoped to the two methods
/// `UserRpcApi` exposes today: `createWorkspace`, `listWorkspaces`. Same shape as `WorkspaceRPCClient`, minus
/// the automatic `workspaceId`-injection (this client's calls are user-scoped, not workspace-scoped).
public final class UserRPCClient: Sendable {
    private let client: CapnWebBatchClient

    /// `baseURL` is the backend Worker's root, e.g. `http://127.0.0.1:8787` for local dev —
    /// `/api/user` is appended here, mirroring `WorkspaceRPCClient`'s own "caller passes the workspace
    /// endpoint" convention one level up (caller passes the backend root, this type knows its own
    /// path suffix).
    public init(backendURL: URL, bearerCredential: String, urlSession: URLSession = .shared) {
        self.client = CapnWebBatchClient(
            baseURL: backendURL.appendingPathComponent("api/user"),
            urlSession: urlSession,
            bearerCredential: bearerCredential
        )
    }

    /// Same `CapnWebError -> AthenaeumDomainError` conversion `WorkspaceRPCClient.rpc(_:_:)` applies —
    /// kept as a private helper here rather than duplicated inline per method.
    private func call(_ method: String, _ args: [String: CapnWebValue]) async throws -> CapnWebValue {
        do {
            return try await client.call(method, args: .object(args))
        } catch let error as CapnWebError {
            throw error.asDomainError()
        }
    }

    public func createWorkspace(title: String) async throws -> RPCWorkspaceCatalogEntry {
        let result = try await call("createWorkspace", ["title": .string(title)])
        return try RPCWorkspaceCatalogEntry(result.field("workspace"))
    }

    /// `ListWorkspacesInput` is a zero-field wire object — sent as the literal `{}` directly, per the
    /// web stage's own documented `Schema.encodeSync`-on-a-zero-field-class gotcha
    /// (`AthenaeumDomain`'s `ListWorkspacesInput` doc comment); this client never round-trips through
    /// that codec at all (it builds `CapnWebValue` by hand, like every other RPC call here), so
    /// the gotcha doesn't actually apply here — noted anyway so the two call sites stay consistent
    /// in spirit.
    public func listWorkspaces() async throws -> [RPCWorkspaceCatalogEntry] {
        let result = try await call("listWorkspaces", [:])
        let workspaces = try result.field("workspaces").arrayValue ?? []
        return try workspaces.map(RPCWorkspaceCatalogEntry.init)
    }
}
