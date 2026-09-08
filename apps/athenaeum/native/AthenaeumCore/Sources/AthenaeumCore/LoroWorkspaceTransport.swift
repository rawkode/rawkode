import AthenaeumDomain
import AthenaeumRPC
import Foundation

/// Narrow Loro-only transport seam.  The Automerge client deliberately remains concrete.
protocol LoroWorkspaceTransport: Sendable {
    func getPageDocumentDescriptor(nodeId: String) async throws -> PageDocumentDescriptor
    func createLoroPage(nodeId: String, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor
    func startLoroPageSync(nodeId: String, sessionId: String) async throws -> StartLoroPageSyncOutput
    /// The read path has no caller-supplied update. Its implementation must send `Data()` on
    /// the wire; semantic changes use the separately SPI-fenced checkpoint transport.
    func loroPageReadSyncMessage(nodeId: String, sessionId: String, ordinal: Int, clientVersion: Data) async throws -> LoroPageSyncMessageOutput
}

extension WorkspaceRPCClient: LoroWorkspaceTransport {}

/// A cancellation-safe FIFO lease for one `(workspace,node)` operation.  It is separate
/// from `WorkspaceSyncClient` because actors are re-entrant across awaits.
actor LoroNodeOperationGate {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Void, Error>
    }

    private var occupied = Set<String>()
    private var waiters: [String: [Waiter]] = [:]
    /// A waiter selected by `release` remains recorded until its task has observed the
    /// handoff.  That closes the cancellation-vs-resume race.
    private var grantedWaiters: [String: UUID] = [:]

    func acquire(_ key: String) async throws {
        try Task.checkCancellation()
        guard occupied.contains(key) else {
            occupied.insert(key)
            do {
                try Task.checkCancellation()
            } catch {
                release(key)
                throw error
            }
            return
        }

        let id = UUID()
        do {
            try await withTaskCancellationHandler(operation: {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    // A task may be cancelled between the fast-path check and registration.
                    // Do not enqueue it in that case, even if the key has just become free.
                    guard !Task.isCancelled else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    waiters[key, default: []].append(Waiter(id: id, continuation: continuation))
                }
            }, onCancel: {
                Task { await self.cancelWaiter(key, id: id) }
            })
            // `release` may have handed the lease to us immediately before cancellation.  If
            // so, compensate before returning so a cancelled waiter cannot strand the key.
            try Task.checkCancellation()
            acknowledgeGrantedWaiter(key, id: id)
        } catch {
            cancelGrantedWaiter(key, id: id)
            throw error
        }
    }

    /// Runs an operation while holding the lease.  Keeping the `defer` actor-isolated avoids
    /// the detached-release gap that would otherwise exist at every caller.
    func withLease<T: Sendable>(_ key: String, operation: @Sendable () async throws -> T) async throws -> T {
        try await acquire(key)
        defer { release(key) }
        try Task.checkCancellation()
        return try await operation()
    }

    func release(_ key: String) {
        if var queue = waiters[key], !queue.isEmpty {
            let next = queue.removeFirst()
            waiters[key] = queue.isEmpty ? nil : queue
            grantedWaiters[key] = next.id
            next.continuation.resume()
        } else {
            occupied.remove(key)
        }
    }

    private func cancelWaiter(_ key: String, id: UUID) {
        if var queue = waiters[key], let index = queue.firstIndex(where: { $0.id == id }) {
            let cancelled = queue.remove(at: index)
            waiters[key] = queue.isEmpty ? nil : queue
            cancelled.continuation.resume(throwing: CancellationError())
            return
        }
        cancelGrantedWaiter(key, id: id)
    }

    private func acknowledgeGrantedWaiter(_ key: String, id: UUID) {
        guard grantedWaiters[key] == id else { return }
        grantedWaiters[key] = nil
    }

    private func cancelGrantedWaiter(_ key: String, id: UUID) {
        guard grantedWaiters[key] == id else { return }
        grantedWaiters[key] = nil
        release(key)
    }
}

/// The exact read-only wire frame retained over an uncertain request outcome. No new session,
/// ordinal, or client version may be invented until this frame has a definitive response. The
/// local update is structurally absent: this transport seam cannot retain or replay one.
struct LoroInFlightFrame: Sendable, Equatable {
    let workspaceId: EntityId
    let nodeId: EntityId
    let sessionId: String
    let ordinal: Int
    let clientVersion: Data
}
