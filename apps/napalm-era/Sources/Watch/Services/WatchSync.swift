import Foundation
@preconcurrency import WatchConnectivity

@MainActor
final class WatchSync: NSObject, WCSessionDelegate {
    var onCatalog: ((MachineCatalogPayload) -> Void)?
    var onTransferError: ((String) -> Void)?
    private var session: WCSession? { WCSession.isSupported() ? .default : nil }

    func activate() {
        session?.delegate = self
        session?.activate()
        if let data = session?.receivedApplicationContext[WatchTransferKey.catalog] as? Data,
           let catalog = try? JSONDecoder().decode(MachineCatalogPayload.self, from: data) {
            onCatalog?(catalog)
        }
    }

    func transfer(_ payload: GymSessionPayload) {
        guard let data = try? JSONEncoder().encode(payload) else { return }
        session?.transferUserInfo([WatchTransferKey.gymSession: data])
    }

    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?
    ) {
        if let error { Task { @MainActor in onTransferError?(error.localizedDescription) } }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let data = applicationContext[WatchTransferKey.catalog] as? Data,
              let catalog = try? JSONDecoder().decode(MachineCatalogPayload.self, from: data) else { return }
        Task { @MainActor in onCatalog?(catalog) }
    }
}

