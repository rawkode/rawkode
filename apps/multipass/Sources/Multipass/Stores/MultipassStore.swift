import AppKit
import Combine
import ServiceManagement

@MainActor
final class MultipassStore: ObservableObject {
    @Published private(set) var keyboardPresent: Bool?
    @Published private(set) var mousePresent: Bool?
    @Published private(set) var networkStatus = "Starting Multipass engine…"
    @Published private(set) var peerCount = 0
    @Published private(set) var paired = false
    @Published private(set) var pairingCode = ""
    @Published var enteredCode = ""
    @Published private(set) var message = ""
    @Published private(set) var events: [String] = []
    @Published private(set) var enabled = false
    @Published private(set) var available = false
    @Published private(set) var launchAtLogin = false
    @Published private(set) var localSlot = 1
    @Published private(set) var computerName = "This Mac"
    private let engine = EngineClient()
    private var observers: [NSObjectProtocol] = []

    init() {
        engine.onState = { [weak self] state in self?.apply(state) }
        engine.onResult = { [weak self] ok, message, code in
            guard let self else { return }
            self.message = message
            if let code { self.pairingCode = code }
            if ok { self.enteredCode = "" }
        }
        engine.onFailure = { [weak self] message in
            self?.available = false
            self?.enabled = false
            self?.networkStatus = "Engine unavailable"
            self?.message = message
        }
        engine.start()
        launchAtLogin = SMAppService.mainApp.status == .enabled
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.engine.send("suspend") }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.engine.send("resume") }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.engine.stop() }
        })
    }

    func createPairing() { engine.send("create_pairing") }
    func joinPairing() { pairingCode = ""; engine.send("join_pairing", values: ["code": enteredCode]) }
    func setLocalSlot(_ slot: Int) { engine.send("set_slot", values: ["slot": slot]) }
    func setEnabled(_ value: Bool) { engine.send("set_enabled", values: ["enabled": value]) }
    func copyPairingCode() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairingCode, forType: .string)
        message = "Pairing code copied. Paste it into Multipass on your other computer."
    }
    func setLaunchAtLogin(_ value: Bool) {
        do {
            if value { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            if value && !launchAtLogin { message = "Allow Multipass in System Settings → General → Login Items." }
        } catch { message = error.localizedDescription }
    }
    func openInputMonitoring() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent") { NSWorkspace.shared.open(url) }
    }
    private func apply(_ state: EngineState) {
        available = true
        keyboardPresent = state.keyboardPresent
        mousePresent = state.mousePresent
        networkStatus = state.networkStatus
        peerCount = state.peers
        paired = state.paired
        enabled = state.enabled
        localSlot = state.localSlot
        computerName = state.nodeName
        if !state.lastEvent.isEmpty, events.first != state.lastEvent {
            events.insert(state.lastEvent, at: 0)
            events = Array(events.prefix(12))
        }
    }
}
