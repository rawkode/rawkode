import ApsidesCore
import Combine
import Foundation

@MainActor
final class WatchStore: ObservableObject {
    @Published private(set) var vault = Vault()
    @Published private(set) var error: String?
    @Published private(set) var ready = false
    @Published private(set) var lastSavedID: UUID?
    private let persistence = VaultPersistence(url: VaultPersistence.defaultURL())
    private lazy var bridge = WatchBridge(
        onCapture: { [weak self] capture in
            guard let self else { throw CocoaError(.fileWriteUnknown) }
            let next = try CaptureLedger.inserting(capture, into: self.vault)
            try self.commit(next)
        },
        onContext: { [weak self] snapshot in
            guard let self else { return }
            guard self.vault.context == nil || snapshot.fetchedAt >= self.vault.context!.fetchedAt else { return }
            var next = self.vault
            next.context = snapshot
            do { try self.commit(next) } catch { self.error = "Could not save the latest agenda." }
        },
        onReceipt: { [weak self] id in
            guard let self, self.vault.captures.contains(where: { $0.id == id }) else { return }
            var next = self.vault
            next.phoneReceipts.insert(id)
            do { try self.commit(next) } catch { self.error = "Could not save the iPhone receipt. Your capture is safe here." }
        }
    )

    func start() {
        if !ready {
            do { vault = try persistence.load(); ready = true; error = nil }
            catch { self.error = "Could not open saved captures. Retry before adding a new one."; return }
        }
        bridge.start()
        for capture in CaptureLedger.pendingPhoneDelivery(in: vault) { bridge.sendCapture(capture) }
    }

    func updateDraft(_ text: String) {
        guard ready else { return }
        var next = vault
        next.captureDraft = text
        do { try commit(next) } catch {
            vault.captureDraft = text
            self.error = "Could not save your draft. Keep the app open and retry."
        }
    }

    func capture(_ text: String) -> Bool {
        guard ready else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let capture = Capture(text: trimmed, source: .watch)
        do {
            var next = try CaptureLedger.inserting(capture, into: vault)
            next.captureDraft = ""
            try commit(next)
            lastSavedID = capture.id
            bridge.sendCapture(capture)
            return true
        } catch { self.error = "Could not save this capture. Your text remains here to retry."; return false }
    }

    private func commit(_ next: Vault) throws {
        try persistence.save(next)
        vault = next
        error = nil
    }
}
