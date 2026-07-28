import SwiftUI

struct MacSettingsView: View {
  var body: some View {
    Form {
      Section("Storage") {
        LabeledContent("Persistence", value: "Local SQLite + Automerge")
        Text("Calendar permissions and iCloud status are available from the main window.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .formStyle(.grouped)
    .frame(width: 440, height: 180)
    .padding()
  }
}
