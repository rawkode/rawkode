import EnchiridionCore
import SwiftUI

struct VaultSwitcherMenu: View {
  let session: VaultSession
  let selectVault: @MainActor (VaultID) throws -> Void
  @State private var errorMessage: String?

  var body: some View {
    Menu {
      ForEach(session.snapshot.vaults) { vault in
        Button {
          do {
            try selectVault(vault.id)
            errorMessage = nil
          } catch {
            errorMessage = error.localizedDescription
          }
        } label: {
          if vault.id == session.selectedVault.id {
            Label(vault.name, systemImage: "checkmark")
          } else {
            Text(vault.name)
          }
        }
      }
    } label: {
      Label(session.selectedVault.name, systemImage: "archivebox")
    }
    .help("Switch vault")
    .accessibilityHint("Chooses which independent knowledge graph is open.")
    .alert("Vault Unavailable", isPresented: errorBinding) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "The vault could not be opened.")
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}

struct VaultManagementView: View {
  let session: VaultSession
  let selectVault: @MainActor (VaultID) throws -> Void
  let workspaceDidChange: @MainActor () -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var showsNewVaultPrompt = false
  @State private var newVaultName = ""
  @State private var vaultToRename: VaultDescriptor?
  @State private var renamedVaultName = ""
  @State private var vaultToDelete: VaultDescriptor?
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(session.snapshot.vaults) { vault in
            vaultRow(vault)
          }
          .onMove(perform: moveVaults)
        } header: {
          Text("Vaults")
        } footer: {
          Text("Each vault is an independent knowledge graph. Links and assistant queries stay inside the open vault.")
        }
      }
      .navigationTitle("Vaults")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItem(placement: .primaryAction) {
          Button {
            newVaultName = ""
            showsNewVaultPrompt = true
          } label: {
            Label("New Vault", systemImage: "plus")
          }
        }
      }
      .alert("New Vault", isPresented: $showsNewVaultPrompt) {
        TextField("Name", text: $newVaultName)
        Button("Cancel", role: .cancel) {}
        Button("Create") { createVault() }
          .disabled(newVaultName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      } message: {
        Text("A new local graph is created and opened immediately.")
      }
      .alert("Rename Vault", isPresented: renameBinding) {
        TextField("Name", text: $renamedVaultName)
        Button("Cancel", role: .cancel) { vaultToRename = nil }
        Button("Rename") { renameVault() }
          .disabled(renamedVaultName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      .confirmationDialog(
        "Delete \(vaultToDelete?.name ?? "Vault")?",
        isPresented: deleteBinding,
        titleVisibility: .visible
      ) {
        Button("Delete Vault and Local Data", role: .destructive) { deleteVault() }
        Button("Cancel", role: .cancel) { vaultToDelete = nil }
      } message: {
        Text("This permanently removes this vault's local graph. Other vaults are not affected.")
      }
      .alert("Vault Error", isPresented: errorBinding) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(errorMessage ?? "The vault operation could not be completed.")
      }
    }
  }

  private func vaultRow(_ vault: VaultDescriptor) -> some View {
    Button {
      perform { try selectVault(vault.id) }
    } label: {
      HStack(spacing: 12) {
        Image(systemName: vault.id == session.selectedVault.id ? "archivebox.fill" : "archivebox")
          .foregroundStyle(vault.id == session.selectedVault.id ? Color.accentColor : .secondary)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(vault.name)
            .foregroundStyle(.primary)
          if vault.id == session.snapshot.defaultCaptureVaultID {
            Text("Default capture")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        Spacer()
        if vault.id == session.selectedVault.id {
          Image(systemName: "checkmark")
            .foregroundStyle(.tint)
            .accessibilityLabel("Open vault")
        }
      }
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button("Open", systemImage: "arrow.right.circle") {
        perform { try selectVault(vault.id) }
      }
      Button("Use for Capture", systemImage: "square.and.arrow.down") {
        perform { try session.setDefaultCaptureVault(vault.id) }
      }
      Button("Rename", systemImage: "pencil") {
        renamedVaultName = vault.name
        vaultToRename = vault
      }
      Divider()
      Button("Delete", systemImage: "trash", role: .destructive) {
        vaultToDelete = vault
      }
      .disabled(session.snapshot.vaults.count == 1)
    }
    .accessibilityLabel(vault.name)
    .accessibilityValue(vault.id == session.selectedVault.id ? "Open" : "")
  }

  private func createVault() {
    perform {
      _ = try session.createVault(name: newVaultName)
      workspaceDidChange()
    }
  }

  private func renameVault() {
    guard let vault = vaultToRename else { return }
    perform { try session.renameVault(vault.id, name: renamedVaultName) }
    vaultToRename = nil
  }

  private func deleteVault() {
    guard let vault = vaultToDelete else { return }
    let changedWorkspace = vault.id == session.selectedVault.id
    perform {
      try session.deleteVault(vault.id)
      if changedWorkspace { workspaceDidChange() }
    }
    vaultToDelete = nil
  }

  private func moveVaults(from offsets: IndexSet, to destination: Int) {
    var vaults = session.snapshot.vaults
    vaults.move(fromOffsets: offsets, toOffset: destination)
    perform { try session.reorderVaults(vaults.map(\.id)) }
  }

  private func perform(_ operation: () throws -> Void) {
    do {
      try operation()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var renameBinding: Binding<Bool> {
    Binding(
      get: { vaultToRename != nil },
      set: { if !$0 { vaultToRename = nil } }
    )
  }

  private var deleteBinding: Binding<Bool> {
    Binding(
      get: { vaultToDelete != nil },
      set: { if !$0 { vaultToDelete = nil } }
    )
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}
