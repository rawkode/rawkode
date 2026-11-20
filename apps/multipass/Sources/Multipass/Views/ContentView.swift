import SwiftUI

struct ContentView: View {
    @ObservedObject var store: MultipassStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ScrollView {
            content.padding(24)
        }
        .frame(minWidth: 580, idealWidth: 580, minHeight: 460)
        .onAppear {
            store.presentWindow = {
                openWindow(id: "multipass")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: "keyboard.badge.ellipsis")
                    .font(.system(size: 32)).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Multipass").font(.largeTitle.weight(.semibold))
                    Text("Switch your keyboard. Your mouse follows.").foregroundStyle(.secondary)
                }
                Spacer()
            }

            MouseSlotView(store: store)

            PairingView(store: store)

            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle("Automatic switching", isOn: Binding(get: { store.enabled }, set: store.setEnabled))
                        .toggleStyle(.switch)
                        .disabled(!store.available || (!store.enabled && !store.canEnableSwitching))
                    if store.available && !store.canEnableSwitching {
                        Text(switchingSetupHint).font(.caption).foregroundStyle(.secondary)
                    }
                    Label(store.networkStatus, systemImage: store.enabled ? "network" : "pause.circle")
                        .font(.callout).foregroundStyle(.secondary)
                    Toggle("Launch at login", isOn: Binding(get: { store.launchAtLogin }, set: store.setLaunchAtLogin))
                    inputMonitoringRow
                }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
            }

            if store.pairing?.locallyConfirmed != true && !store.message.isEmpty {
                Text(store.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if store.pairing == nil && !store.latestActivity.isEmpty && store.latestActivity != store.message {
                Text(store.latestActivity).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let handoff = store.handoff {
                GroupBox("Latest handoff") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(Date(timeIntervalSince1970: handoff.occurredAt), style: .time)
                            .font(.caption).foregroundStyle(.secondary)
                        Text(handoff.message).font(.callout).textSelection(.enabled)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            let priorEvents = store.events.dropFirst(store.events.first == store.latestActivity ? 1 : 0)
            if !priorEvents.isEmpty {
                DisclosureGroup("Recent activity") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(priorEvents.enumerated()), id: \.offset) { _, event in
                            Text(event).font(.caption).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var switchingSetupHint: String {
        if !store.paired && !store.slotConfirmed {
            return "Confirm the mouse slot and pair another computer to turn on switching."
        }
        return store.paired
            ? "Confirm the mouse slot to turn on switching."
            : "Pair another computer to turn on switching."
    }

    private var inputMonitoringRow: some View {
        HStack(spacing: 8) {
            switch store.inputMonitoring {
            case .granted:
                Label("Input Monitoring allowed", systemImage: "checkmark.shield")
                    .font(.callout).foregroundStyle(.secondary)
            case .denied:
                Label("Allow Multipass under Input Monitoring, then reopen Multipass.", systemImage: "exclamationmark.shield")
                    .font(.callout).foregroundStyle(.orange)
            case .notDetermined:
                Label("Multipass needs Input Monitoring to reach the mouse.", systemImage: "shield")
                    .font(.callout).foregroundStyle(.secondary)
                Button("Allow…") { store.requestInputMonitoring(force: true) }
            }
            Spacer()
            Button("Input Monitoring settings…", action: store.openInputMonitoring).buttonStyle(.link)
        }
    }
}

private struct MouseSlotView: View {
    @ObservedObject var store: MultipassStore
    @State private var chosenSlot: Int?

    private var slot: Int { chosenSlot ?? store.localSlot }

    var body: some View {
        GroupBox("This Mac") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(store.computerName).fontWeight(.medium)
                    Spacer()
                    Picker("Mouse slot", selection: Binding(get: { slot }, set: { chosenSlot = $0 })) {
                        ForEach(1...3, id: \.self) { Text("\($0)").tag($0) }
                    }.frame(width: 165).disabled(!store.available)
                    if !store.slotConfirmed || slot != store.localSlot {
                        Button(store.slotConfirmed ? "Save slot" : "Confirm slot") { store.setLocalSlot(slot) }
                            .disabled(!store.available)
                    }
                }
                deviceRow("Bluetooth keyboard", icon: "keyboard", present: store.keyboardPresent)
                deviceRow("MX Master 4", icon: "computermouse", present: store.mousePresent)
                Text("Choose the Easy-Switch number on the bottom of the mouse that connects to this Mac.")
                    .font(.caption).foregroundStyle(.secondary)
                if !store.slotConfirmed, let suggested = store.suggestedSlot {
                    Button("Use detected slot \(suggested)") {
                        chosenSlot = suggested
                        store.setLocalSlot(suggested)
                    }.disabled(!store.available)
                }
            }.padding(8)
        }.onChange(of: store.localSlot) { _, _ in chosenSlot = nil }
    }

    private func deviceRow(_ name: String, icon: String, present: Bool?) -> some View {
        HStack {
            Label(name, systemImage: icon)
            Spacer()
            Text(present.map { $0 ? "Connected here" : "Not connected here" } ?? "Unknown")
                .foregroundStyle(present == true ? Color.green : Color.secondary)
        }
    }
}

private struct PairingView: View {
    @ObservedObject var store: MultipassStore
    @State private var replacing = false
    @State private var confirmingForget = false

    private var candidates: [PeerSummary] { store.nearby.filter { $0.id != store.pairedPeer?.id } }

    var body: some View {
        GroupBox("Connect your computers") {
            VStack(alignment: .leading, spacing: 10) {
                if let error = store.credentialError {
                    Label(error, systemImage: "exclamationmark.lock")
                        .font(.callout).foregroundStyle(.orange)
                }
                if let pairing = store.pairing {
                    PairingPrompt(pairing: pairing, store: store)
                } else {
                    if store.paired {
                        Label(store.pairedPeer.map { "Paired with \($0.name)" } ?? "Paired computer unknown",
                              systemImage: "lock.shield")
                        if let peer = store.pairedPeer, !store.nearby.contains(where: { $0.id == peer.id }) {
                            Text("Open Multipass on \(peer.name) and connect both computers to the same local network.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        HStack {
                            Button(replacing ? "Cancel" : "Pair with a different computer…") {
                                replacing.toggle()
                            }.disabled(!store.available || store.credentialError != nil)
                            Button("Forget pairing…") { confirmingForget = true }
                                .buttonStyle(.link).disabled(!store.available || store.credentialError != nil)
                        }
                    }
                    if store.credentialError == nil && (!store.paired || replacing) {
                        nearbyComputers
                    }
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
        .onChange(of: store.pairedPeer) { _, _ in replacing = false }
        .onChange(of: store.paired) { _, _ in replacing = false }
        .confirmationDialog("Forget this pairing?", isPresented: $confirmingForget, titleVisibility: .visible) {
            Button("Forget pairing", role: .destructive, action: store.unpair)
        } message: {
            Text("You’ll need to pair these computers again before they can switch the mouse.")
        }
    }

    @ViewBuilder private var nearbyComputers: some View {
        if replacing {
            Text("Completing a new pairing replaces the current pairing.")
                .font(.callout).foregroundStyle(.secondary)
        }
        if candidates.isEmpty {
            Text(store.available
                 ? "Open Multipass on the other computer and connect both computers to the same local network. If it still doesn’t appear, check firewall and Local Network settings."
                 : "Discovery is unavailable. Quit and reopen Multipass.")
                .font(.callout).foregroundStyle(.secondary)
        } else {
            ForEach(candidates) { peer in
                HStack {
                    Label(peer.name, systemImage: "desktopcomputer")
                    Spacer()
                    Button(replacing ? "Replace pairing…" : "Pair…") { store.pair(peer, replacing: replacing) }
                        .disabled(!store.available)
                }
            }
        }
    }
}

/// Both computers show the same six digits; each person confirms they match.
private struct PairingPrompt: View {
    let pairing: PairingStatus
    @ObservedObject var store: MultipassStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let code = pairing.code {
                Text(pairing.incoming
                     ? "“\(pairing.peerName)” wants to pair with this Mac."
                     : "Pairing with “\(pairing.peerName)”.")
                    .fontWeight(.medium)
                Text(Self.spaced(code))
                    .font(.system(size: 34, weight: .semibold, design: .monospaced))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                if pairing.locallyConfirmed {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Waiting for \(pairing.peerName) to confirm…")
                    }
                } else {
                    Text("Confirm only if \(pairing.peerName) shows the same code. Both computers must confirm.")
                        .font(.callout).foregroundStyle(.secondary)
                    if pairing.incoming && store.paired {
                        Text("Accepting this request replaces the current pairing once both computers confirm.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    HStack {
                        Spacer()
                        Button(pairing.incoming ? "Decline" : "Cancel") { store.confirmPairing(false) }
                        Button(pairing.incoming ? "Accept" : "Confirm") { store.confirmPairing(true) }
                            .keyboardShortcut(.defaultAction)
                            .disabled(store.credentialError != nil)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Connecting to “\(pairing.peerName)”…")
                    Spacer()
                    Button("Cancel") { store.confirmPairing(false) }
                }
            }
        }
    }

    private static func spaced(_ code: String) -> String {
        guard code.count == 6 else { return code }
        return code.prefix(3) + " " + code.suffix(3)
    }
}
