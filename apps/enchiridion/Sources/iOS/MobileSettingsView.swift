import EnchiridionCore
import SwiftUI

struct MobileSettingsView: View {
  let store: LibraryStore
  let contactsResolver: DeviceContactsResolver
  let vaultSession: VaultSession?
  let selectVault: @MainActor (VaultID) throws -> Void
  let workspaceDidChange: @MainActor () -> Void
  let assistantVoicePreferences: AssistantVoicePreferences
  @State private var showsVaultManager = false
  @AppStorage(CarPlayAssistantPrivacySettings.isEnabledKey)
  private var isCarPlayAssistantEnabled = true

  init(
    store: LibraryStore,
    contactsResolver: DeviceContactsResolver = DeviceContactsResolver(),
    vaultSession: VaultSession? = nil,
    selectVault: @escaping @MainActor (VaultID) throws -> Void = { _ in },
    workspaceDidChange: @escaping @MainActor () -> Void = {},
    assistantVoicePreferences: AssistantVoicePreferences
  ) {
    self.store = store
    self.contactsResolver = contactsResolver
    self.vaultSession = vaultSession
    self.selectVault = selectVault
    self.workspaceDidChange = workspaceDidChange
    self.assistantVoicePreferences = assistantVoicePreferences
  }

  var body: some View {
    Form {
      if let vaultSession {
        Section("Vault") {
          VaultSwitcherMenu(session: vaultSession, selectVault: selectVault)
          Button("Manage Vaults") { showsVaultManager = true }
          Text("Captures can use a different default vault. Relationships never cross vault boundaries.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Section("Calendar") {
        Button("Enable Local Calendars") { Task { await store.enableCalendar() } }
        Button("Connect Google Calendar") { Task { await store.enableGoogleCalendar() } }
        if let error = store.calendarError { Text(error).foregroundStyle(.red) }
        Text("Calendar access is read-only. Local events stay in EventKit; Google connects directly from this device with OAuth and no Enchiridion server.")
          .font(.caption).foregroundStyle(.secondary)
      }
      CalendarEventFilterSettingsSection(store: store)
      DeviceContactsSettingsSection(store: store, resolver: contactsResolver)
      AssistantVoiceSettingsSection(preferences: assistantVoicePreferences)
      Section("CarPlay") {
        Toggle("CarPlay Assistant", isOn: $isCarPlayAssistantEnabled)
        Text("When enabled, voice transcription, Apple Intelligence, calendar lookup, and note search run only on this iPhone. Diagnostics record operational state only—never transcripts or note content.")
          .font(.caption).foregroundStyle(.secondary)
      }
      Section("Sync") {
        LabeledContent("Status", value: store.syncStatus.title)
        Text(store.syncStatus.detail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel("Sync details: \(store.syncStatus.detail)")
        Button {
          Task { await store.syncNow() }
        } label: {
          if isSyncing {
            HStack(spacing: 8) {
              ProgressView()
              Text("Syncing")
            }
          } else {
            Label("Sync Now", systemImage: "arrow.triangle.2.circlepath")
          }
        }
        .disabled(!canRequestSync)
        .accessibilityHint(syncActionHint)
        Text("Pages are durable locally first. Private iCloud sync runs when your account is available.")
          .font(.caption).foregroundStyle(.secondary)
      }
    }
    .navigationTitle("Settings")
    .sheet(isPresented: $showsVaultManager) {
      if let vaultSession {
        VaultManagementView(
          session: vaultSession,
          selectVault: selectVault,
          workspaceDidChange: workspaceDidChange
        )
      }
    }
  }

  private var isSyncing: Bool {
    if case .syncing = store.syncStatus { return true }
    return false
  }

  private var canRequestSync: Bool {
    switch store.syncStatus {
    case .synced, .offline, .attentionRequired:
      true
    case .localOnly, .syncing, .iCloudUnavailable:
      false
    }
  }

  private var syncActionHint: String {
    if isSyncing { return "A sync is already in progress." }
    if canRequestSync { return "Checks iCloud now for updates and retries any pending work." }
    return store.syncStatus.detail
  }
}
