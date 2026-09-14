#if os(iOS) || os(watchOS)
import ApsidesCore
import Combine
import Foundation
@preconcurrency import WatchConnectivity

/// Transport receipt acknowledges the receiver's durable local write only.
@MainActor
final class WatchBridge: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var error: String?
    private let onCapture: (Capture) throws -> Void
    private let onContext: (ContextSnapshot) -> Void
    private let onReceipt: (UUID) -> Void
    private var captures: [UUID: Capture] = [:]
    private var receipts: Set<UUID> = []
    private var context: ContextSnapshot?

    init(onCapture: @escaping (Capture) throws -> Void,
         onContext: @escaping (ContextSnapshot) -> Void,
         onReceipt: @escaping (UUID) -> Void) {
        self.onCapture = onCapture
        self.onContext = onContext
        self.onReceipt = onReceipt
        super.init()
    }

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        if WCSession.default.activationState == .activated { flush() }
        else { WCSession.default.activate() }
    }

    func sendCapture(_ capture: Capture) { captures[capture.id] = capture; flush() }
    func sendContext(_ snapshot: ContextSnapshot) { context = snapshot; flush() }
    func sendReceipt(_ id: UUID) { receipts.insert(id); flush() }

    private func flush() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        let session = WCSession.default
        let outstanding = Set(session.outstandingUserInfoTransfers.compactMap { $0.userInfo["key"] as? String })
        do {
            for capture in captures.values {
                let key = "capture:\(capture.id.uuidString)"
                if !outstanding.contains(key) {
                    session.transferUserInfo(["key": key, "capture": try JSONEncoder().encode(capture)])
                }
            }
            captures.removeAll()
            for id in receipts {
                let key = "receipt:\(id.uuidString)"
                if !outstanding.contains(key) { session.transferUserInfo(["key": key, "receipt": id.uuidString]) }
            }
            receipts.removeAll()
            if let context {
                try session.updateApplicationContext(["context": JSONEncoder().encode(context)])
                self.context = nil
            }
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let message = error?.localizedDescription
        let data = session.receivedApplicationContext["context"] as? Data
        Task { @MainActor in
            self.error = message
            if let data, let snapshot = try? JSONDecoder().decode(ContextSnapshot.self, from: data) { self.onContext(snapshot) }
            self.flush()
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let captureData = userInfo["capture"] as? Data
        let receipt = (userInfo["receipt"] as? String).flatMap(UUID.init(uuidString:))
        Task { @MainActor in
            do {
                if let captureData {
                    let capture = try JSONDecoder().decode(Capture.self, from: captureData)
                    try self.onCapture(capture)
                    self.sendReceipt(capture.id)
                }
                if let receipt { self.onReceipt(receipt) }
            } catch { self.error = "Could not save incoming capture. The sender will retry." }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        guard let data = applicationContext["context"] as? Data else { return }
        Task { @MainActor in
            if let snapshot = try? JSONDecoder().decode(ContextSnapshot.self, from: data) { self.onContext(snapshot) }
        }
    }

    #if os(iOS)
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    #endif
}
#endif
