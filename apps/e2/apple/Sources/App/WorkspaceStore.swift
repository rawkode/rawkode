import ApsidesCore
import Combine
import Foundation
import WidgetKit

/// Framework-owned observable boundary. Pure reducers and Codable values own the data contract.
@MainActor
final class WorkspaceStore: ObservableObject {
    @Published private(set) var vault = Vault()
    @Published var storageError: String?
    @Published private(set) var isReadOnly = false
    @Published private(set) var context: ConnectedContext?
    @Published private(set) var calendarContext: ConnectedContext?
    @Published private(set) var refreshing = false
    @Published var connectionError: String?
    @Published var capturePresented = false
    @Published var settingsPresented = false
    @Published var selectedDay = Date()
    @Published private(set) var sending: Set<UUID> = []
    let disk: VaultPersistence
    let session: NativeSession
    let demo: Bool
    let isUITesting: Bool
    private var connectionGeneration = 0
    #if os(iOS)
    var watchBridge: WatchBridge?
    #endif

    init() {
        demo = ProcessInfo.processInfo.arguments.contains("--demo")
        isUITesting = ProcessInfo.processInfo.arguments.contains("--ui-testing")
        let arguments = ProcessInfo.processInfo.arguments
        let override = arguments.firstIndex(of: "--storage").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
        let testURL = FileManager.default.temporaryDirectory.appendingPathComponent("apsides-ui-tests/notebook.json")
        if arguments.contains("--ui-testing") && arguments.contains("--reset-test-data") {
            UserDefaults(suiteName: "dev.rawkode.apsides.ui-tests")?.removePersistentDomain(forName: "dev.rawkode.apsides.ui-tests")
            try? FileManager.default.removeItem(at: testURL.deletingLastPathComponent())
        }
        disk = VaultPersistence(url: arguments.contains("--ui-testing") ? testURL : override.map { URL(fileURLWithPath: $0) } ?? VaultPersistence.defaultURL())
        session = try! NativeSession(origin: URL(string: "https://apsides.rawkode.academy")!)
        do {
            vault = try disk.load()
            // Remote cache stays hidden until this launch verifies the account.
            vault.context = nil
            vault.captures.removeAll { $0.source == .workspace }
        } catch {
            storageError = "Your notebook could not be opened. The original file is preserved. \(error.localizedDescription)"
            isReadOnly = true
        }
        importSpool()
        if demo { context = DemoContent.context; vault.context = context?.snapshot }
        #if os(iOS)
        if !isUITesting && !demo {
        watchBridge = WatchBridge(onCapture: { [weak self] capture in
            guard let self else { throw CocoaError(.fileWriteUnknown) }
            let next = try CaptureLedger.inserting(capture, into: self.vault)
            try self.commit(next)
        }, onContext: { _ in }, onReceipt: { _ in })
        watchBridge?.start()
        if let snapshot = vault.context { watchBridge?.sendContext(snapshot) }
        }
        #endif
    }

    var dayKey: String { DayIdentity.key(selectedDay) }
    var dayText: String { vault.drafts.first { $0.id == dayKey }?.text ?? "" }
    var captures: [Capture] { vault.captures.filter { !vault.archived.contains($0.id) }.sorted { $0.createdAt > $1.createdAt } }
    var snapshot: ContextSnapshot? { context?.snapshot ?? vault.context }

    func commit(_ next: Vault) throws {
        guard !isReadOnly else { throw CocoaError(.fileReadCorruptFile) }
        try disk.save(next)
        vault = next
        storageError = nil
    }
    func mutate(_ transform: (inout Vault) -> Void) {
        var next = vault; transform(&next)
        // Keep unsaved text visible on failure; don't claim persistence.
        vault = next
        do { try commit(next) } catch { storageError = error.localizedDescription }
    }
    func retrySave() { do { try commit(vault) } catch { storageError = error.localizedDescription } }
    func setDayText(_ value: String) {
        guard value.count <= 100_000 else { storageError = VaultError.tooLarge.localizedDescription; return }
        let key = dayKey
        mutate { next in
            next.drafts.removeAll { $0.id == key }
            if !value.isEmpty { next.drafts.append(DayDraft(id: key, text: value)) }
        }
    }
    func saveCapture() -> Bool {
        do {
            #if os(macOS)
            let source: CaptureSource = .mac
            #else
            let source: CaptureSource = .phone
            #endif
            var next = try CaptureLedger.inserting(Capture(text: vault.captureDraft, source: source), into: vault)
            next.captureDraft = ""
            try commit(next)
            return true
        } catch { storageError = error.localizedDescription; return false }
    }
    func addToToday(_ capture: Capture) {
        let key = DayIdentity.key(Date())
        let text = vault.drafts.first { $0.id == key }?.text ?? ""
        let combined = text.isEmpty ? capture.text : text + "\n\n" + capture.text
        guard combined.count <= 100_000 else { storageError = "This daybook is full. Your capture is still in the inbox."; return }
        var next = vault
        next.drafts.removeAll { $0.id == key }
        next.drafts.append(DayDraft(id: key, text: combined))
        next.archived.insert(capture.id)
        do { try commit(next) } catch { storageError = error.localizedDescription }
    }
    func refresh(for date: Date = .now) async {
        guard !refreshing, !demo, !isUITesting else { return }
        let generation = connectionGeneration
        refreshing = true; connectionError = nil
        defer { refreshing = false }
        do {
            try await session.verifyConnection()
            guard generation == connectionGeneration, let account = session.accountID else { return }
            if vault.accountID != account { try bindAccount(account) }
            let key = DayIdentity.key(date), bounds = DayIdentity.bounds(date)
            let data = try await session.today(date: key, from: bounds.0, to: bounds.1)
            guard generation == connectionGeneration, session.accountID == account else { return }
            let next = try ConnectedContext.decode(data, day: key)
            calendarContext = next
            if Calendar.current.isDateInToday(date) {
                var updated = vault; updated.context = next.snapshot
                try commit(updated)
                context = next
                publishWidget(next.snapshot)
                #if os(iOS)
                watchBridge?.sendContext(next.snapshot)
                #endif
            }
            try await receiveCaptures(account: account, generation: generation)
        } catch { connectionError = error.localizedDescription }
    }
    func send(_ capture: Capture) async {
        guard !sending.contains(capture.id), capture.source != .workspace, !isUITesting, !demo else { return }
        sending.insert(capture.id); defer { sending.remove(capture.id) }
        do {
            try await session.verifyConnection()
            guard let account = session.accountID else { return }
            if vault.accountID != account { try bindAccount(account) }
            let generation = connectionGeneration
            try await session.createCapture(id: capture.id, text: capture.text, date: capture.createdAt)
            guard connectionGeneration == generation, account == session.accountID else { return }
            var next = vault; next.uploaded.insert(capture.id); next.accountID = account; try commit(next)
        } catch { connectionError = error.localizedDescription }
    }
    func signOut() async {
        connectionGeneration += 1
        await session.signOut(); context = nil
        do { try bindAccount(nil) } catch { storageError = "Sign-out cleared the visible account data, but its cache could not be removed from disk. \(error.localizedDescription)" }
        #if os(iOS)
        watchBridge?.sendContext(ContextSnapshot(day: DayIdentity.key(.now)))
        #endif
        publishWidget(nil)
    }
    func importSpool() {
        guard !isUITesting && !demo else { return }
        guard !isReadOnly else { return }
        let spool = CaptureSpool(directory: CaptureSpool.defaultDirectory())
        do {
            for capture in try spool.pending() {
                let next = try CaptureLedger.inserting(capture, into: vault)
                try commit(next)
                try spool.acknowledge(capture.id)
            }
        } catch { storageError = error.localizedDescription }
    }
    private func receiveCaptures(account: String, generation: Int) async throws {
        let data = try await session.captureFeed()
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = envelope["data"] as? [String: Any], let me = payload["me"] as? [String: Any],
              let summaries = me["documentFeed"] as? [[String: Any]] else { throw CocoaError(.coderReadCorrupt) }
        for summary in summaries {
            guard connectionGeneration == generation, session.accountID == account else { return }
            guard let id = summary["id"] as? String, id.hasPrefix("capture:"), let uuid = UUID(uuidString: String(id.dropFirst(8))) else { continue }
            if vault.captures.contains(where: { $0.id == uuid }) { continue }
            let bytes = try await session.document(id: id)
            guard connectionGeneration == generation, session.accountID == account else { return }
            // Decode only our exact immutable wire format; never flatten a rich document.
            let capture: Capture
            do { capture = try RemoteCaptureDocument.decode(bytes, expectedID: id) }
            catch RemoteCaptureDocument.FormatError.invalid {
                connectionError = "Some captures contain formatting this app cannot open yet. They remain available in your web workspace."
                continue
            }
            var next = try CaptureLedger.inserting(capture, into: vault); next.uploaded.insert(uuid)
            try commit(next)
        }
    }
    private func bindAccount(_ account: String?) throws {
        context = nil; calendarContext = nil
        var next = vault
        next.context = nil; next.accountID = account; next.uploaded = []
        let remoteIDs = Set(next.captures.filter { $0.source == .workspace }.map(\.id))
        next.captures.removeAll { $0.source == .workspace }
        next.archived.subtract(remoteIDs)
        vault = next
        publishWidget(nil)
        #if os(iOS)
        watchBridge?.sendContext(ContextSnapshot(day: DayIdentity.key(.now)))
        #endif
        try commit(next)
    }
    private func publishWidget(_ snapshot: ContextSnapshot?) {
        guard !isUITesting && !demo else { return }
        #if os(iOS)
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.dev.rawkode.apsides")?.appendingPathComponent("context.json") {
            do {
                if let snapshot { try JSONEncoder().encode(snapshot).write(to: url, options: .atomic) }
                else if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                WidgetCenter.shared.reloadAllTimelines()
            } catch { connectionError = "The app is up to date, but the widget could not refresh." }
        }
        #endif
    }
}
