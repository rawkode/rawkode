import AthenaeumRPC
import Foundation
import SwiftUI

/// Immutable identity accepted by the Run surface. Pending is represented by its stable wire
/// fields rather than the mutable RPC object so this value remains Hashable and Sendable.
public struct NativeAppRunDetailIdentity: Equatable, Hashable, Sendable {
    public struct Pending: Equatable, Hashable, Sendable {
        public let chatId: String
        public let sequence: Int?

        init(_ value: RPCPendingMarker) {
            chatId = value.chatId
            sequence = value.sequence
        }
    }

    public let workspaceId: String
    public let appId: String
    public let pending: Pending?
    public let clientCodeVersion: Int
    public let serverCodeVersion: Int
    public let updatedAt: String

    public init(workspaceId: String, app: RPCApp) {
        self.workspaceId = workspaceId
        self.appId = app.id
        self.pending = app.pending.map(Pending.init)
        self.clientCodeVersion = app.clientCodeVersion
        self.serverCodeVersion = app.serverCodeVersion
        self.updatedAt = app.updatedAt
    }
}

public struct NativeAppRunLaunchIdentity: Equatable, Hashable, Sendable {
    public let detail: NativeAppRunDetailIdentity
    public let generation: Int
    public let launchID: String

    public init(
        detail: NativeAppRunDetailIdentity, generation: Int, launchID: String = UUID().uuidString
    ) {
        self.detail = detail
        self.generation = generation
        self.launchID = launchID
    }
}

extension NativeAppRunLaunchIdentity: Identifiable {
    public var id: String { "\(detail.workspaceId):\(detail.appId):\(generation):\(launchID)" }
}

public enum NativeAppRunState: Equatable, Sendable {
    case idle
    case noCode(NativeAppRunLaunchIdentity)
    case loading(NativeAppRunLaunchIdentity)
    case ready(NativeAppRunLaunchIdentity, RPCAppRunCredential)
    case failed(NativeAppRunLaunchIdentity)
}

public enum NativeAppRunPresentation {
    public static func identity(workspaceId: String, app: RPCApp) -> NativeAppRunDetailIdentity {
        NativeAppRunDetailIdentity(workspaceId: workspaceId, app: app)
    }

    public static func canLaunch(workspaceId: String, app: RPCApp) -> Bool {
        app.workspaceId == workspaceId && app.pending == nil && app.clientCodeVersion > 0
    }

    public static func canPublish(
        candidate: NativeAppRunLaunchIdentity,
        accepted: NativeAppRunLaunchIdentity?
    ) -> Bool {
        candidate == accepted
    }
}

/// Owns the asynchronous capability request and fences every result to the accepted detail plus
/// launch generation. The model never persists the capability and dismissal invalidates it.
@MainActor
public final class NativeAppRunModel: ObservableObject {
    @Published public private(set) var state: NativeAppRunState = .idle
    @Published public private(set) var acceptedIdentity: NativeAppRunLaunchIdentity?

    private let client: WorkspaceRPCClient
    private let workspaceId: String
    private var app: RPCApp?
    private var hasClientCode = false
    private var generation = 0
    private var expiryTask: Task<Void, Never>?

    public init(client: WorkspaceRPCClient, workspaceId: String) {
        self.client = client
        self.workspaceId = workspaceId
    }

    public func launch(app: RPCApp, hasClientCode: Bool) {
        generation += 1
        expiryTask?.cancel()
        expiryTask = nil
        let identity = NativeAppRunLaunchIdentity(
            detail: NativeAppRunPresentation.identity(workspaceId: workspaceId, app: app),
            generation: generation
        )
        acceptedIdentity = identity
        self.app = app
        self.hasClientCode = hasClientCode
        guard hasClientCode, app.clientCodeVersion > 0 else {
            state = .noCode(identity)
            return
        }
        state = .loading(identity)
        mint(identity: identity, appId: app.id)
    }

    public func retry() {
        guard let app else { return }
        launch(app: app, hasClientCode: hasClientCode)
    }

    public func dismiss() {
        expiryTask?.cancel()
        expiryTask = nil
        generation += 1
        acceptedIdentity = nil
        app = nil
        hasClientCode = false
        state = .idle
    }

    /// A capability is never silently reused after expiry. The current run is torn down and the
    /// user can explicitly retry the same accepted detail, which mints a fresh capability.
    public func expire(identity: NativeAppRunLaunchIdentity) {
        guard case .ready(let active, _) = state,
            active == identity,
            acceptedIdentity == identity
        else { return }
        expiryTask?.cancel()
        expiryTask = nil
        acceptedIdentity = nil
        state = .failed(identity)
    }

    /// Records a WebKit-side failure against the exact accepted launch. The App remains available
    /// for an explicit retry, but a failed load can never leave a live capability-backed view.
    public func fail(identity: NativeAppRunLaunchIdentity) {
        guard NativeAppRunPresentation.canPublish(candidate: identity, accepted: acceptedIdentity)
        else { return }
        expiryTask?.cancel()
        expiryTask = nil
        acceptedIdentity = nil
        state = .failed(identity)
    }

    private func scheduleExpiry(
        for identity: NativeAppRunLaunchIdentity, credential: RPCAppRunCredential
    ) {
        expiryTask?.cancel()
        guard let date = RPCAppRunCredential.parseDate(credential.expiresAt) else { return }
        let interval = max(date.timeIntervalSinceNow, 0)
        guard interval.isFinite else { return }
        let maxInterval = Double(UInt64.max) / 1_000_000_000
        let nanoseconds = UInt64(min(interval, maxInterval) * 1_000_000_000)
        expiryTask = Task { [weak self] in
            guard interval > 0 else {
                self?.expire(identity: identity)
                return
            }
            do {
                try await Task.sleep(nanoseconds: nanoseconds)
                guard !Task.isCancelled else { return }
                self?.expire(identity: identity)
            } catch {
                // Cancellation is the normal path when the run is dismissed or replaced.
            }
        }
    }

    private func mint(identity: NativeAppRunLaunchIdentity, appId: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let credential = try await client.mintAppRunCredential(appId: appId)
                guard NativeAppRunPresentation.canPublish(candidate: identity, accepted: acceptedIdentity)
                else { return }
                state = .ready(identity, credential)
                scheduleExpiry(for: identity, credential: credential)
            } catch {
                guard NativeAppRunPresentation.canPublish(candidate: identity, accepted: acceptedIdentity)
                else { return }
                state = .failed(identity)
            }
        }
    }

    deinit {
        expiryTask?.cancel()
        // No credential is persisted; teardown is intentionally terminal for this model instance.
    }
}
