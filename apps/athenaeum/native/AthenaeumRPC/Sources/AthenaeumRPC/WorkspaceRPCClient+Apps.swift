import Foundation

// Read-only native App Library client. App creation, code editing, and deletion remain on the
// web surface until those writes are routed through the workspace ledger; native can safely inspect
// the same typed App rows and immutable code snapshots without widening the mutation surface.

public enum RPCAppCodeKind: String, Sendable, Equatable {
    case client
    case server
}

/// Mirrors `packages/domain/src/app.ts`'s `App`.
public struct RPCApp: Sendable, Equatable, Identifiable {
    public let id: String
    public let workspaceId: String
    public let title: String
    public let icon: String
    public let clientCodeVersion: Int
    public let serverCodeVersion: Int
    public let createdAt: String
    public let updatedAt: String
    public let pending: RPCPendingMarker?

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let title = try value.field("title").stringValue,
              let icon = try value.field("icon").stringValue,
              let clientCodeVersion = try value.field("clientCodeVersion").intValue,
              let serverCodeVersion = try value.field("serverCodeVersion").intValue,
              let createdAt = try value.field("createdAt").stringValue,
              let updatedAt = try value.field("updatedAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed App: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.icon = icon
        self.clientCodeVersion = clientCodeVersion
        self.serverCodeVersion = serverCodeVersion
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pending = try RPCPendingMarker.decodeOptional(value.field("pending"))
    }
}

/// Mirrors `packages/domain/src/app.ts`'s immutable `AppCodeVersion`.
public struct RPCAppCodeVersion: Sendable, Equatable {
    public let id: String
    public let appId: String
    public let kind: RPCAppCodeKind
    public let version: Int
    public let code: String
    public let createdAt: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let appId = try value.field("appId").stringValue,
              let kindValue = try value.field("kind").stringValue,
              let kind = RPCAppCodeKind(rawValue: kindValue),
              let version = try value.field("version").intValue,
              let code = try value.field("code").stringValue,
              let createdAt = try value.field("createdAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed AppCodeVersion: \(value)") }
        self.id = id
        self.appId = appId
        self.kind = kind
        self.version = version
        self.code = code
        self.createdAt = createdAt
    }
}

extension WorkspaceRPCClient {
    // MARK: - Apps / gadgets (read-only native surface)

    /// `role` gate: `"use"`. Lists mainline Apps, excluding chat-local pending creations.
    public func listApps() async throws -> [RPCApp] {
        let result = try await rpc("listApps", [:])
        return try (result.field("apps").arrayValue ?? []).map(RPCApp.init)
    }

    /// `role` gate: `"use"`. Fetches one mainline App by id.
    public func getApp(appId: String) async throws -> RPCApp {
        let result = try await rpc("getApp", ["appId": .string(appId)])
        return try RPCApp(result.field("app"))
    }

    /// `role` gate: `"use"`. Fetches an immutable client/server code snapshot. `version` defaults
    /// server-side to the App's current mainline pointer when omitted.
    public func getAppCode(appId: String, kind: RPCAppCodeKind, version: Int? = nil) async throws -> RPCAppCodeVersion {
        var args: [String: CapnWebValue] = [
            "appId": .string(appId),
            "kind": .string(kind.rawValue)
        ]
        args["version"] = version.map(CapnWebValue.int) ?? .undefined
        let result = try await rpc("getAppCode", args)
        return try RPCAppCodeVersion(result.field("codeVersion"))
    }
}
