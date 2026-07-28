import EnchiridionCore
import SwiftUI

struct MobileSettingsView: View {
  let store: LibraryStore

  var body: some View {
    NavigationStack {
      Form {
        Section("Calendar") {
          Button("Enable Local Calendars") { Task { await store.enableCalendar() } }
          Button("Connect Google Calendar") { Task { await store.enableGoogleCalendar() } }
          if let error = store.calendarError { Text(error).foregroundStyle(.red) }
          Text("Calendar access is read-only. Local events stay in EventKit; Google connects directly from this device with OAuth and no Enchiridion server.")
            .font(.caption).foregroundStyle(.secondary)
        }
        Section("Sync") {
          LabeledContent("Status", value: store.syncStatus.title)
          Button("Sync Now") { Task { await store.syncNow() } }
          Text("Pages are durable locally first. Private iCloud sync runs when your account is available.")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Settings")
    }
  }
}
