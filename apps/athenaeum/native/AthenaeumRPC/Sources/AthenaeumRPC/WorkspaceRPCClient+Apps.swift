import Foundation

// Read-only native App Library client. App creation, code editing, and deletion remain on the
// web surface until those writes are routed through the workspace ledger; native can safely inspect
// the same typed App rows and immutable code snapshots without widening the mutation surface.

public enum RPCAppCodeKind: String, Sendable, Equatable {
    case client
    case server
}

/// The short-lived, app-scoped capability returned by `mintAppRunCredential`.
///
/// This is deliberately distinct from the user's bearer credential. It is only suitable for
/// the app's client bundle and `/run` endpoint, and is never stored by the native client.
public struct RPCAppRunCredential: Sendable, Equatable {
    public let credential: String
    public let expiresAt: String

    init(_ value: CapnWebValue, now: Date = Date()) throws {
        guard let credential = try value.field("credential").stringValue,
              !credential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let expiresAt = try value.field("expiresAt").stringValue,
              let expiresDate = Self.parseDate(expiresAt),
              expiresDate > now
        else {
            throw CapnWebError.malformedMessage("malformed or expired AppRunCredential")
        }
        self.credential = credential
        self.expiresAt = expiresAt
    }

    static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }()
    }
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

    public init(
        id: String,
        workspaceId: String,
        title: String,
        icon: String,
        clientCodeVersion: Int,
        serverCodeVersion: Int,
        createdAt: String,
        updatedAt: String,
        pending: RPCPendingMarker? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.icon = icon
        self.clientCodeVersion = clientCodeVersion
        self.serverCodeVersion = serverCodeVersion
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.pending = pending
    }

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

    /// Mints a short-lived, app-scoped run capability. The user's bearer remains inside the RPC
    /// transport and is never returned to, or embedded by, the App Run document.
    public func mintAppRunCredential(appId: String, now: Date = Date()) async throws -> RPCAppRunCredential {
        let result = try await rpc("mintAppRunCredential", ["appId": .string(appId)])
        return try RPCAppRunCredential(result, now: now)
    }
}
