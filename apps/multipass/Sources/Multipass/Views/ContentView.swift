import SwiftUI

struct ContentView: View {
    @ObservedObject var store: MultipassStore

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
                        Text("\(store.peerCount) nearby Multipass \(store.peerCount == 1 ? "service" : "services"). Requests must match your pairing code.")
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
    @State private var editing = false

    var body: some View {
        GroupBox("Connect your computers") {
            VStack(alignment: .leading, spacing: 10) {
                if store.paired && !editing && store.pairingCode.isEmpty {
                    Label("Pairing key saved securely", systemImage: "lock.shield")
                    Button("Replace pairing…") { editing = true }
                        .buttonStyle(.link)
                } else {
                    Text("Create a code on one computer, then paste it into the other.")
                        .font(.callout).foregroundStyle(.secondary)
                    HStack {
                        SecureField("Pairing code from your other Mac", text: $store.enteredCode)
                        Button("Join") { store.joinPairing(); editing = false }
                            .disabled(store.enteredCode.isEmpty)
                    }
                    Button("Create pairing code", action: store.createPairing)
                    if !store.pairingCode.isEmpty {
                        HStack {
                            Text(store.pairingCode).font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled).lineLimit(2)
                            Spacer()
                            Button("Copy", action: store.copyPairingCode)
                        }
                    }
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
