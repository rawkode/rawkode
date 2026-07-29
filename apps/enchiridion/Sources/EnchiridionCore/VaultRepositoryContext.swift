import Foundation

/// Opens a repository together with the vault identity that gives its node IDs meaning.
public struct VaultRepositoryContext: Sendable {
  public let vault: VaultDescriptor
  public let repository: LibraryRepository

  public init(vault: VaultDescriptor, repository: LibraryRepository) {
    self.vault = vault
    self.repository = repository
  }

  public static func open(_ selection: VaultSelection) throws -> Self {
    let registry = try VaultRegistry(path: VaultRegistry.defaultCatalogPath())
    let snapshot = try registry.snapshot()
    let vaultID = switch selection {
    case .selected: snapshot.selectedVaultID
    case .defaultCapture: snapshot.defaultCaptureVaultID
    case .vault(let id): id
    }
    guard let vault = snapshot.vaults.first(where: { $0.id == vaultID }) else {
      throw VaultRegistryError.vaultNotFound
    }
    return try .init(
      vault: vault,
      repository: LibraryRepository(path: registry.graphPath(for: vaultID))
    )
  }

  public static func openAll() throws -> [Self] {
    let registry = try VaultRegistry(path: VaultRegistry.defaultCatalogPath())
    return try registry.snapshot().vaults.map { vault in
      try .init(
        vault: vault,
        repository: LibraryRepository(path: registry.graphPath(for: vault.id))
      )
    }
  }
}
