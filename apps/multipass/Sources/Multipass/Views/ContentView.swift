import SwiftUI

struct ContentView: View {
    @ObservedObject var store: MultipassStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
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

            GroupBox("This Mac") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(store.computerName).fontWeight(.medium)
                        Spacer()
                        Picker("Mouse slot", selection: Binding(get: { store.localSlot }, set: store.setLocalSlot)) {
                            ForEach(1...3, id: \.self) { Text("\($0)").tag($0) }
                        }.frame(width: 165)
                    }
                    deviceRow("EVO80", icon: "keyboard", present: store.keyboardPresent)
                    deviceRow("MX Master 4", icon: "computermouse", present: store.mousePresent)
                    Text("Choose the mouse’s Bluetooth slot paired with this Mac.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(8)
            }

            PairingView(store: store)

            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle("Automatic switching", isOn: Binding(get: { store.enabled }, set: store.setEnabled))
                        .toggleStyle(.switch).disabled(!store.paired || !store.available)
                    Label(store.networkStatus, systemImage: store.enabled ? "network" : "pause.circle")
                        .font(.callout).foregroundStyle(.secondary)
                    if store.peerCount > 0 {
                        Text("Only the computer you paired with can move the mouse; other Multipass services on this network are ignored.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Toggle("Launch at login", isOn: Binding(get: { store.launchAtLogin }, set: store.setLaunchAtLogin))
                    Button("Input Monitoring settings…", action: store.openInputMonitoring)
                        .buttonStyle(.link)
                }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
            }

            if !store.message.isEmpty {
                Text(store.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            DisclosureGroup("Recent activity") {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(store.events.enumerated()), id: \.offset) { _, event in
                            Text(event).font(.caption).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }.frame(height: 95)
            }
            Text("Run Multipass on both computers on the same local network. Wait three seconds after enabling, then switch the keyboard away and back to test.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(width: 580)
        .onAppear {
            store.presentWindow = {
                openWindow(id: "multipass")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
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

    var body: some View {
        GroupBox("Connect your computers") {
            VStack(alignment: .leading, spacing: 10) {
                if let pairing = store.pairing {
                    PairingPrompt(pairing: pairing, store: store)
                } else {
                    if store.paired {
                        HStack {
                            Label("Paired", systemImage: "lock.shield")
                            Spacer()
                            Button("Forget pairing", action: store.unpair).buttonStyle(.link)
                        }
                    }
                    if store.nearby.isEmpty {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(store.available
                                 ? "Looking for other computers running Multipass on this network…"
                                 : "Discovery is unavailable while the engine is stopped.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    } else {
                        Text(store.paired ? "Pair with a different computer:" : "Choose the computer to pair with:")
                            .font(.callout).foregroundStyle(.secondary)
                        ForEach(store.nearby) { peer in
                            HStack {
                                Label(peer.name, systemImage: "desktopcomputer")
                                Spacer()
                                Button("Pair…") { store.pair(peer) }.disabled(!store.available)
                            }
                        }
                    }
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
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
                Text("Confirm only if \(pairing.peerName) shows the same code. Both computers must confirm.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button(pairing.incoming ? "Decline" : "Cancel") { store.confirmPairing(false) }
                    Button(pairing.incoming ? "Accept" : "Confirm") { store.confirmPairing(true) }
                        .keyboardShortcut(.defaultAction)
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
