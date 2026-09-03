import Foundation

// Mirrors `packages/domain/src/sync-rpc.ts` — two surfaces: (1) the Automerge prose-sync session
// envelope (`startPageSync`/`pageSyncMessage`), (2) the structured-record append-only feed
// (`syncFeed`/`rotateEpoch`).
//
// Binary fields (`Schema.Uint8ArrayFromSelf` on the TS side — raw Automerge sync-message bytes)
// are modeled as Swift `Data`. This is a **deliberate, documented divergence** from a literal
// `Schema.encodeSync` JSON mirror: `Schema.Uint8ArrayFromSelf` is an identity schema over a real
// JS `Uint8Array`, which has no native JSON representation (`JSON.stringify` of a `Uint8Array`
// serializes it as an index-keyed object, e.g. `{"0":1,"1":2}`, not a JSON array or string) — it
// is never meant to cross a plain-JSON wire directly; the real transport
// (`AthenaeumRPC`/capnweb's own `["bytes", ...]`-tagged encoding, see that package's
// `CapnWebValue.swift`) carries these bytes structurally, not through this package's JSON Codable
// path. For this package's own fixture-based round-trip tests, byte fields are represented as
// base64 strings (`Data`'s default `Codable` behavior) — see
// `scripts/generate-fixtures.ts`'s header comment for how those specific fixtures are produced
// (hand-adapted, not a raw `Schema.encodeSync` dump, precisely because of this gap).

public struct StartPageSyncInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let sessionId: String

    public init(workspaceId: EntityId, nodeId: EntityId, sessionId: String) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.sessionId = sessionId
    }
}

public struct StartPageSyncOutput: Codable, Hashable, Sendable {
    public let sessionId: String
    public let message: Data?

    public init(sessionId: String, message: Data?) {
        self.sessionId = sessionId
        self.message = message
    }
}

public struct PageSyncMessageInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let sessionId: String
    public let ordinal: Int
    public let message: Data

    public init(workspaceId: EntityId, nodeId: EntityId, sessionId: String, ordinal: Int, message: Data) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.sessionId = sessionId
        self.ordinal = ordinal
        self.message = message
    }
}

public struct PageSyncMessageOutput: Codable, Hashable, Sendable {
    public let sessionId: String
    public let ordinal: Int
    public let message: Data?
    public let converged: Bool
    public let reset: Bool

    public init(sessionId: String, ordinal: Int, message: Data?, converged: Bool, reset: Bool) {
        self.sessionId = sessionId
        self.ordinal = ordinal
        self.message = message
        self.converged = converged
        self.reset = reset
    }
}

public struct SyncFeedInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let knownEpoch: WorkspaceEpoch?
    public let afterCounter: Int?
    public let limit: Int

    public init(workspaceId: EntityId, knownEpoch: WorkspaceEpoch? = nil, afterCounter: Int? = nil, limit: Int) {
        self.workspaceId = workspaceId
        self.knownEpoch = knownEpoch
        self.afterCounter = afterCounter
        self.limit = limit
    }
}

public struct SyncFeedOutput: Codable, Hashable, Sendable {
    public let epoch: WorkspaceEpoch
    public let epochMismatch: Bool
    public let entries: [SyncFeedEntry]
    public let nextAfterCounter: Int?

    public init(epoch: WorkspaceEpoch, epochMismatch: Bool, entries: [SyncFeedEntry], nextAfterCounter: Int? = nil) {
        self.epoch = epoch
        self.epochMismatch = epochMismatch
        self.entries = entries
        self.nextAfterCounter = nextAfterCounter
    }
}

/// Admin/test-only, per `sync-rpc.ts`'s `RotateEpochInput` doc comment.
public struct RotateEpochInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public init(workspaceId: EntityId) { self.workspaceId = workspaceId }
}

public struct RotateEpochOutput: Codable, Hashable, Sendable {
    public let epoch: WorkspaceEpoch
    public init(epoch: WorkspaceEpoch) { self.epoch = epoch }
}
