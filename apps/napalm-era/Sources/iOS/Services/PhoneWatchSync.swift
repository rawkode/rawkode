import Foundation
import Observation
import SwiftData
@preconcurrency import WatchConnectivity

@MainActor
@Observable
final class PhoneWatchSync: NSObject {
    private(set) var lastImportError: String?
    private let container: ModelContainer
    private let session: WCSession?

    init(container: ModelContainer) {
        self.container = container
        session = WCSession.isSupported() ? .default : nil
        super.init()
        session?.delegate = self
        session?.activate()
    }

    func sendCatalog(massUnit: MassUnitPreference) {
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<MachineProfile>(sortBy: [SortDescriptor(\.order)])
        guard let machines = try? context.fetch(descriptor) else { return }
        let payload = MachineCatalogPayload(massUnit: massUnit, machines: machines.map(\.snapshot))
        guard let data = try? JSONEncoder().encode(payload) else { return }
        do {
            try session?.updateApplicationContext([WatchTransferKey.catalog: data])
        } catch {
            lastImportError = error.localizedDescription
        }
    }

    private func importSession(_ payload: GymSessionPayload) {
        let context = ModelContext(container)
        let id = payload.id
        var descriptor = FetchDescriptor<GymSession>(predicate: #Predicate { $0.id == id })
        descriptor.fetchLimit = 1
        guard (try? context.fetch(descriptor))?.isEmpty != false else { return }

        context.insert(GymSession(payload: payload))
        let lastByMachine = Dictionary(grouping: payload.sets, by: \.machineID)
            .compactMapValues { $0.max(by: { $0.completedAt < $1.completedAt }) }
        let profiles = (try? context.fetch(FetchDescriptor<MachineProfile>())) ?? []
        for profile in profiles {
            if let last = lastByMachine[profile.id] {
                profile.defaultLoadKilograms = last.loadKilograms
            }
        }
        do { try context.save() }
        catch { lastImportError = error.localizedDescription }
    }
}

extension PhoneWatchSync: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?
    ) {
        if let error { Task { @MainActor in self.lastImportError = error.localizedDescription } }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let data = userInfo[WatchTransferKey.gymSession] as? Data,
              let payload = try? JSONDecoder().decode(GymSessionPayload.self, from: data) else { return }
        Task { @MainActor in self.importSession(payload) }
    }
}
