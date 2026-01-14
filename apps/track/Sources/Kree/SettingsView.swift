import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @ObservedObject var appState: AppState
    
    @State private var launchAtLogin: Bool = SMAppService.mainApp.status == .enabled
    
    var body: some View {
        Form {
            Section {
                Toggle("Launch at Login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, newValue in
                        updateLaunchAtLogin(newValue)
                    }
            }
            
            Section(header: Text("Behavior")) {
                VStack(alignment: .leading) {
                    HStack {
                        Text("Poll Interval")
                        Spacer()
                        Text(String(format: "%.2fs", appState.pollInterval))
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: $appState.pollInterval, in: 0.02...0.5, step: 0.01) {
                        Text("Poll Interval")
                    } minimumValueLabel: {
                        Image(systemName: "hare")
                    } maximumValueLabel: {
                        Image(systemName: "tortoise")
                    }
                    Text("Lower values are more responsive but use more CPU.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                
                VStack(alignment: .leading) {
                    HStack {
                        Text("Focus Delay")
                        Spacer()
                        Text(String(format: "%.2fs", appState.focusDelay))
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: $appState.focusDelay, in: 0.0...1.0, step: 0.05) {
                        Text("Focus Delay")
                    } minimumValueLabel: {
                        Text("0s")
                    } maximumValueLabel: {
                        Text("1s")
                    }
                    Text("Time the mouse must be over a window before focusing.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                
                Picker("Disable with:", selection: $appState.disableModifier) {
                    ForEach(DisableModifier.allCases) { modifier in
                        Text(modifier.rawValue).tag(modifier)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .padding()
        .frame(width: 400)
    }
    
    private func updateLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                if SMAppService.mainApp.status == .enabled { return }
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            print("Failed to toggle Launch at Login: \(error)")
            // Revert state on failure
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}
