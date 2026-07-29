import EnchiridionCore
import SwiftUI

struct MacSettingsView: View {
  let store: LibraryStore
  let contactsResolver: DeviceContactsResolver
  let vaultSession: VaultSession?
  let selectVault: @MainActor (VaultID) throws -> Void
  let workspaceDidChange: @MainActor () -> Void
  @State private var showsVaultManager = false

  init(
    store: LibraryStore,
    contactsResolver: DeviceContactsResolver,
    vaultSession: VaultSession? = nil,
    selectVault: @escaping @MainActor (VaultID) throws -> Void = { _ in },
    workspaceDidChange: @escaping @MainActor () -> Void = {}
  ) {
    self.store = store
    self.contactsResolver = contactsResolver
    self.vaultSession = vaultSession
    self.selectVault = selectVault
    self.workspaceDidChange = workspaceDidChange
  }

  var body: some View {
    NavigationStack {
      Form {
        if let vaultSession {
          Section("Vault") {
            VaultSwitcherMenu(session: vaultSession, selectVault: selectVault)
            Button("Manage Vaults") { showsVaultManager = true }
            Text("Each vault is an independent graph. External capture can use a separate default vault.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
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
      .sheet(isPresented: $showsVaultManager) {
        if let vaultSession {
          VaultManagementView(
            session: vaultSession,
            selectVault: selectVault,
            workspaceDidChange: workspaceDidChange
          )
          .frame(minWidth: 480, minHeight: 420)
        }
      }
    }
    .frame(width: 520, height: 620)
  }
}
