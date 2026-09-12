import AppKit
import Combine
import Foundation
import MultipassCore
import MultipassHardware
import MultipassNetwork
import ServiceManagement

@MainActor
final class MultipassStore: ObservableObject {
    @Published private(set) var keyboardPresent = false
    @Published private(set) var mousePresent = false
    @Published private(set) var networkStatus = "Pair your Macs to begin"
    @Published private(set) var peers: [String] = []
    @Published private(set) var paired = false
    @Published private(set) var pairingCode = ""
    @Published var enteredCode = ""
    @Published private(set) var message = ""
    @Published private(set) var events: [String] = []
    @Published private(set) var enabled = false
    @Published private(set) var launchAtLogin = false
    @Published var localSlot: Int {
        didSet {
            UserDefaults.standard.set(localSlot, forKey: "localSlot")
            resetObservation()
        }
    }

    let computerName = Host.current().localizedName ?? "This Mac"
    private let pairing = PairingStore()
    private let monitor = DeviceMonitor()
    private let mouse = MouseController()
    private let transport: PeerTransport
    private var secret: Data?
    private var policy = AttachmentPolicy()
    private var attachmentTask: Task<Void, Never>?
    private var switchTask: Task<Void, Never>?
    private var permit: SwitchPermit?
    private var observers: [NSObjectProtocol] = []
    private var sleeping = false
    private var claimsAllowedAfter = ProcessInfo.processInfo.systemUptime + 3

    init() {
        let defaults = UserDefaults.standard
        let slot = defaults.integer(forKey: "localSlot")
        localSlot = (1...3).contains(slot) ? slot : 1
        let node = defaults.string(forKey: "nodeID").flatMap(UUID.init(uuidString:)) ?? UUID()
        defaults.set(node.uuidString, forKey: "nodeID")
        transport = PeerTransport(nodeID: node, name: computerName)
        transport.onStatus = { [weak self] in self?.networkStatus = $0 }
        transport.onPeers = { [weak self] in self?.peers = $0 }
        transport.onRequest = { [weak self] peer, slot, lease in self?.receiveClaim(from: peer, slot: slot, lease: lease) }
        monitor.onChange = { [weak self] in self?.observe($0) }
        monitor.start()
        observe(monitor.snapshot())
        do {
            secret = try pairing.load()
            paired = secret != nil
            if paired && defaults.bool(forKey: "enabled") { setEnabled(true) }
        } catch { message = error.localizedDescription }
        launchAtLogin = SMAppService.mainApp.status == .enabled
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.willSleep() }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.didWake() }
        })
    }

    func createPairing() {
        do {
            let data = try pairing.generate()
            try installSecret(data)
            pairingCode = data.base64EncodedString()
            message = "Enter this code on your other Mac. Keep the code private."
        } catch { message = error.localizedDescription }
    }

    func joinPairing() {
        do {
            try installSecret(pairing.parse(enteredCode))
            enteredCode = ""
            pairingCode = ""
            message = "Pairing key saved. Enable automatic switching on both Macs."
        } catch { message = error.localizedDescription }
    }

    func copyPairingCode() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairingCode, forType: .string)
        message = "Pairing code copied. Paste it into Multipass on your other Mac."
    }

    func setEnabled(_ value: Bool) {
        guard !value || secret != nil else { return }
        enabled = value
        UserDefaults.standard.set(value, forKey: "enabled")
        resetObservation()
        transport.stop()
        if value, let secret, !sleeping {
            transport.start(secret: secret)
            record("Watching for the next keyboard connection")
        } else {
            networkStatus = paired ? "Automatic switching paused" : "Pair your Macs to begin"
            record("Automatic switching paused")
        }
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
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent") {
            NSWorkspace.shared.open(url)
        }
    }

    private func installSecret(_ data: Data) throws {
        try pairing.save(data)
        setEnabled(false)
        secret = data
        paired = true
        networkStatus = "Pairing key saved; switching paused"
    }

    private func resetObservation() {
        claimsAllowedAfter = ProcessInfo.processInfo.systemUptime + 3
        attachmentTask?.cancel()
        permit?.cancel()
        policy.reset()
        _ = policy.observe(keyboardPresent: monitor.snapshot().keyboardPresent)
    }

    private func observe(_ state: DeviceSnapshot) {
        keyboardPresent = state.keyboardPresent
        mousePresent = state.mousePresent
        if state.keyboardPresent { permit?.cancel() }
        guard !sleeping else { return }
        if ProcessInfo.processInfo.systemUptime < claimsAllowedAfter {
            policy.reset()
            _ = policy.observe(keyboardPresent: state.keyboardPresent)
            return
        }
        guard let generation = policy.observe(keyboardPresent: state.keyboardPresent), enabled else { return }
        attachmentTask?.cancel()
        attachmentTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled, let self, self.enabled, !self.sleeping,
                  self.policy.isCurrent(generation), self.monitor.snapshot().keyboardPresent else { return }
            guard !self.peers.isEmpty else {
                self.record("Keyboard connected; no peer discovered, mouse unchanged")
                return
            }
            self.record("Keyboard connected; requesting mouse slot \(self.localSlot)")
            self.transport.announceAttachment(slot: self.localSlot) { [weak self] in
                guard let self else { return false }
                return self.enabled && !self.sleeping && self.policy.isCurrent(generation)
                    && self.monitor.snapshot().keyboardPresent
            }
        }
    }

    private func receiveClaim(from peer: UUID, slot: Int, lease: RequestLease) {
        guard switchTask == nil, !sleeping else { return }
        let state = monitor.snapshot()
        guard AttachmentPolicy.permitsSwitch(enabled: enabled, localSlot: localSlot, targetSlot: slot,
                                              keyboardPresent: state.keyboardPresent, mousePresent: state.mousePresent) else {
            record("Peer request ignored: local devices or slots do not permit a switch")
            return
        }
        let permission = SwitchPermit()
        permit = permission
        record("Authenticated keyboard connection on peer; sending mouse to slot \(slot)")
        switchTask = Task { [weak self] in
            guard let self else { return }
            let result = await self.mouse.switchTo(slot: slot, shouldProceed: { permission.isValid && lease.isValid })
            switch result {
            case .switched: self.record("Mouse switch to slot \(slot) acknowledged or departure observed")
            case .alreadyOnTarget: self.record("Mouse already uses slot \(slot)")
            case .unavailable(let reason), .failed(let reason):
                self.message = reason
                self.record(reason)
            }
            self.switchTask = nil
            self.permit = nil
        }
    }

    private func willSleep() {
        sleeping = true
        resetObservation()
        transport.stop()
        networkStatus = "Paused while this Mac sleeps"
    }

    private func didWake() {
        sleeping = false
        resetObservation()
        if enabled, let secret { transport.start(secret: secret) }
        record("Awake; waiting for a fresh keyboard connection")
    }

    private func record(_ event: String) {
        let time = Date().formatted(date: .omitted, time: .standard)
        events.insert("\(time)  \(event)", at: 0)
        events = Array(events.prefix(12))
    }
}

/// The HID worker reads this immediately before its irreversible report write.
private final class SwitchPermit: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    var isValid: Bool { lock.lock(); defer { lock.unlock() }; return valid }
    func cancel() { lock.lock(); valid = false; lock.unlock() }
}
