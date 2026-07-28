import EnchiridionCore
import SwiftUI

struct MacSettingsView: View {
  let store: LibraryStore
  let contactsResolver: DeviceContactsResolver

  var body: some View {
    NavigationStack {
      Form {
        Section("Storage") {
          LabeledContent("Persistence", value: "Local SQLite + Automerge")
          Text("Calendar event filters and contact matches stay on this Mac. Promoted pages can sync through iCloud.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        CalendarEventFilterSettingsSection(store: store)
        DeviceContactsSettingsSection(store: store, resolver: contactsResolver)
      }
      .formStyle(.grouped)
      .navigationTitle("Settings")
    }
    .frame(width: 520, height: 620)
  }
}
