import Foundation
import SwiftUI
import AthenaeumRPC

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

    public init(detail: NativeAppRunDetailIdentity, generation: Int) {
        self.detail = detail
        self.generation = generation
    }
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

    public init(client: WorkspaceRPCClient, workspaceId: String) {
        self.client = client
        self.workspaceId = workspaceId
    }

    public func launch(app: RPCApp, hasClientCode: Bool) {
        generation += 1
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
        generation += 1
        acceptedIdentity = nil
        app = nil
        hasClientCode = false
        state = .idle
    }

    private func mint(identity: NativeAppRunLaunchIdentity, appId: String) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let credential = try await client.mintAppRunCredential(appId: appId)
                guard NativeAppRunPresentation.canPublish(candidate: identity, accepted: acceptedIdentity) else { return }
                state = .ready(identity, credential)
            } catch {
                guard NativeAppRunPresentation.canPublish(candidate: identity, accepted: acceptedIdentity) else { return }
                state = .failed(identity)
            }
        }
    }

    deinit {
        // No credential is persisted; teardown is intentionally terminal for this model instance.
    }
}
