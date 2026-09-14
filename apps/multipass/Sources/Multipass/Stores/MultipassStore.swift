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
    @Published private(set) var nearby: [PeerSummary] = []
    @Published private(set) var pairing: PairingStatus?
    @Published private(set) var message = ""
    @Published private(set) var events: [String] = []
    @Published private(set) var enabled = false
    @Published private(set) var available = false
    @Published private(set) var launchAtLogin = false
    @Published private(set) var localSlot = 1
    @Published private(set) var computerName = "This Mac"
    /// Set by the main window so an incoming pairing request can bring it forward.
    var presentWindow: (() -> Void)?
    private let engine = EngineClient()
    private var observers: [NSObjectProtocol] = []

    init() {
        engine.onState = { [weak self] state in self?.apply(state) }
        engine.onResult = { [weak self] _, message in self?.message = message }
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
            Task { @MainActor [weak self] in self?.engine.send("suspend") }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.engine.send("resume") }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.engine.stop() }
        })
    }

    func pair(_ peer: PeerSummary) { message = ""; engine.send("pair", values: ["peer": peer.id.uuidString.lowercased()]) }
    func confirmPairing(_ accept: Bool) { engine.send("confirm_pairing", values: ["accept": accept]) }
    func unpair() { engine.send("unpair") }
    func setLocalSlot(_ slot: Int) { engine.send("set_slot", values: ["slot": slot]) }
    func setEnabled(_ value: Bool) { engine.send("set_enabled", values: ["enabled": value]) }
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
        nearby = state.nearby
        if state.pairing != pairing {
            // A request from another computer needs this person's eyes on the code.
            if let request = state.pairing, request.incoming, pairing?.incoming != true { presentWindow?() }
            pairing = state.pairing
        }
        enabled = state.enabled
        localSlot = state.localSlot
        computerName = state.nodeName
        if !state.lastEvent.isEmpty, events.first != state.lastEvent {
            events.insert(state.lastEvent, at: 0)
            events = Array(events.prefix(12))
        }
    }
}
