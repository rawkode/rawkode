import Foundation
import AthenaeumDomain

/// Loro sync bookkeeping is deliberately an FFI-free value. The sync client owns its lifecycle;
/// this type only makes the boundary explicit so a Loro document or version-vector cannot leak
/// into session state.
enum LoroSyncSessionError: Error, Sendable, Equatable { case emptySessionId, emptyKnownServerVersion, negativeOrdinal, sessionNotStarted }

struct LoroSyncSession: Sendable, Equatable {
    let workspaceId: EntityId
    let nodeId: EntityId
    let sessionId: String
    let started: Bool
    let nextOrdinal: Int
    let knownServerVersion: Data

    init(workspaceId: EntityId, nodeId: EntityId, sessionId: String, started: Bool, nextOrdinal: Int, knownServerVersion: Data) throws {
        guard !sessionId.isEmpty else { throw LoroSyncSessionError.emptySessionId }
        guard !knownServerVersion.isEmpty else { throw LoroSyncSessionError.emptyKnownServerVersion }
        guard nextOrdinal >= 0 else { throw LoroSyncSessionError.negativeOrdinal }
        guard started else { throw LoroSyncSessionError.sessionNotStarted }
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.sessionId = sessionId
        self.started = started
        self.nextOrdinal = nextOrdinal
        self.knownServerVersion = knownServerVersion
    }
}
