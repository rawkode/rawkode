import EnchiridionCore
import SwiftUI

struct VaultSettingsContext {
  let session: VaultSession
  let selectVault: @MainActor (VaultID) throws -> Void
  let workspaceDidChange: @MainActor () -> Void
}

struct MacSettingsView: View {
  let store: LibraryStore
  let contactsResolver: DeviceContactsResolver
  let vaultContext: VaultSettingsContext?
  @State private var showsVaultManager = false

  init(
    store: LibraryStore,
    contactsResolver: DeviceContactsResolver,
    vaultContext: VaultSettingsContext? = nil
  ) {
    self.store = store
    self.contactsResolver = contactsResolver
    self.vaultContext = vaultContext
  }

  var body: some View {
    NavigationStack {
      Form {
        if let vaultContext {
          Section("Vault") {
            VaultSwitcherMenu(
              session: vaultContext.session,
              selectVault: vaultContext.selectVault
            )
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
        if let vaultContext {
          VaultManagementView(
            session: vaultContext.session,
            selectVault: vaultContext.selectVault,
            workspaceDidChange: vaultContext.workspaceDidChange
          )
          .frame(minWidth: 480, minHeight: 420)
        }
      }
    }
    .frame(width: 520, height: 620)
  }
}
