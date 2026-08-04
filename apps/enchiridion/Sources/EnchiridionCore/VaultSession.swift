import Foundation
import Observation

public enum VaultSessionError: Error, LocalizedError, Equatable {
  case unavailable(String)
  case couldNotRemoveLocalData(String)

  public var errorDescription: String? {
    switch self {
    case .unavailable(let message): message
    case .couldNotRemoveLocalData(let name):
      "The \(name) vault was removed from the catalog, but its local files could not be deleted."
    }
  }
}

/// Owns the currently selected vault workspace. A switch replaces the repository and store as one
/// unit so node identifiers, queries, assistant access, and sync never cross vault boundaries.
@MainActor
@Observable
public final class VaultSession {
  public private(set) var snapshot: VaultRegistrySnapshot
  public private(set) var selectedVault: VaultDescriptor
  public private(set) var repository: LibraryRepository
  public private(set) var store: LibraryStore
  public private(set) var errorMessage: String?

  @ObservationIgnored private let registry: VaultRegistry
  @ObservationIgnored private let calendar: Calendar
  @ObservationIgnored private let contactResolver: (any DeviceContactResolving)?
  @ObservationIgnored private let startsStoresImmediately: Bool
  @ObservationIgnored private var backgroundStores: [VaultID: LibraryStore] = [:]

  /// Process-wide catalog authority for non-UI background deliveries. Callers
  /// still use `backgroundStore(forVault:)` for vault graph access.
  public var catalog: VaultRegistry { registry }

  public convenience init(
    calendar: Calendar = .current,
    contactResolver: (any DeviceContactResolving)? = nil,
    startImmediately: Bool = true
  ) throws {
    try self.init(
      registry: VaultRegistry(path: VaultRegistry.defaultCatalogPath()),
      calendar: calendar,
      contactResolver: contactResolver,
      startImmediately: startImmediately
    )
  }

  public init(
    registry: VaultRegistry,
    calendar: Calendar = .current,
    contactResolver: (any DeviceContactResolving)? = nil,
    startImmediately: Bool = true
  ) throws {
    let snapshot = try registry.snapshot()
    guard let descriptor = snapshot.vaults.first(where: { $0.id == snapshot.selectedVaultID }) else {
      throw VaultRegistryError.vaultNotFound
    }
    let repository = try LibraryRepository(path: registry.graphPath(for: descriptor.id))
    self.registry = registry
    self.calendar = calendar
    self.contactResolver = contactResolver
    startsStoresImmediately = startImmediately
    self.snapshot = snapshot
    selectedVault = descriptor
    self.repository = repository
    store = LibraryStore(
      vaultID: descriptor.id,
      repository: repository,
      calendar: calendar,
      contactResolver: contactResolver,
      startImmediately: startImmediately
    )
  }

  public func refreshCatalog() throws {
    let refreshed = try registry.snapshot()
    snapshot = refreshed
    guard refreshed.vaults.contains(where: { $0.id == selectedVault.id }) else {
      try replaceWorkspace(with: refreshed.selectedVaultID, snapshot: refreshed)
      return
    }
    selectedVault = refreshed.vaults.first(where: { $0.id == selectedVault.id })!
  }

  public func selectVault(_ id: VaultID) throws {
    guard id != selectedVault.id else { return }
    try registry.setSelectedVault(id)
    let refreshed = try registry.snapshot()
    do {
      try replaceWorkspace(with: id, snapshot: refreshed)
      errorMessage = nil
    } catch {
      try? registry.setSelectedVault(selectedVault.id)
      throw error
    }
  }

  @discardableResult
  public func createVault(name: String, select: Bool = true) throws -> VaultDescriptor {
    let descriptor = try registry.createVault(name: name)
    if select {
      do {
        try selectVault(descriptor.id)
      } catch {
        _ = try? registry.deleteVault(descriptor.id)
        throw error
      }
    } else {
      snapshot = try registry.snapshot()
    }
    return descriptor
  }

  public func renameVault(_ id: VaultID, name: String) throws {
    try registry.renameVault(id, name: name)
    try refreshCatalog()
  }

  public func setDefaultCaptureVault(_ id: VaultID) throws {
    try registry.setDefaultCaptureVault(id)
    snapshot = try registry.snapshot()
  }

  public func reorderVaults(_ ids: [VaultID]) throws {
    try registry.reorderVaults(ids)
    snapshot = try registry.snapshot()
  }

  public func deleteVault(_ id: VaultID) async throws {
    let name = snapshot.vaults.first(where: { $0.id == id })?.name ?? "selected"
    let removedStore = id == selectedVault.id ? store : backgroundStores.removeValue(forKey: id)
    let removedRepository = removedStore?.repository
    let path = try registry.deleteVault(id)
    let refreshed = try registry.snapshot()
    if id == selectedVault.id {
      try replaceWorkspace(with: refreshed.selectedVaultID, snapshot: refreshed)
    } else {
      snapshot = refreshed
    }
    await removedStore?.stop()
    try await removedRepository?.closeDatabase()

    let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
    guard FileManager.default.fileExists(atPath: directory.path) else { return }
    do {
      try FileManager.default.removeItem(at: directory)
    } catch {
      let sessionError = VaultSessionError.couldNotRemoveLocalData(name)
      errorMessage = sessionError.localizedDescription
      throw sessionError
    }
  }

  public func clearError() {
    errorMessage = nil
  }

  public func store(
    forVault id: VaultID,
    selectingWith select: @MainActor (VaultID) throws -> Void
  ) throws -> LibraryStore {
    if selectedVault.id != id {
      try select(id)
    }
    return store
  }

  public func backgroundStore(forVault id: VaultID) async throws -> LibraryStore {
    if selectedVault.id == id { return store }
    if let existing = backgroundStores[id] { return existing }
    guard let descriptor = snapshot.vaults.first(where: {
      $0.id == id && $0.isDownloaded && $0.deletedAt == nil
    }) else {
      throw VaultRegistryError.vaultNotFound
    }
    let path = try registry.graphPath(for: id)
    let repository = try await Task.detached(priority: .userInitiated) {
      try LibraryRepository(path: path)
    }.value
    let store = LibraryStore(
      vaultID: descriptor.id,
      repository: repository,
      calendar: calendar,
      contactResolver: contactResolver,
      startImmediately: false
    )
    backgroundStores[id] = store
    return store
  }

  private func replaceWorkspace(
    with id: VaultID,
    snapshot: VaultRegistrySnapshot
  ) throws {
    guard let descriptor = snapshot.vaults.first(where: { $0.id == id }) else {
      throw VaultRegistryError.vaultNotFound
    }
    do {
      let repository: LibraryRepository
      let store: LibraryStore
      if let cachedStore = backgroundStores.removeValue(forKey: id),
        let cachedRepository = cachedStore.repository
      {
        repository = cachedRepository
        store = cachedStore
        if startsStoresImmediately { Task { await store.start() } }
      } else {
        repository = try LibraryRepository(path: registry.graphPath(for: id))
        store = LibraryStore(
          vaultID: descriptor.id,
          repository: repository,
          calendar: calendar,
          contactResolver: contactResolver,
          startImmediately: startsStoresImmediately
        )
      }
      self.snapshot = snapshot
      selectedVault = descriptor
      self.repository = repository
      self.store = store
    } catch {
      let wrapped = VaultSessionError.unavailable(
        "The \(descriptor.name) vault could not be opened: \(error.localizedDescription)"
      )
      errorMessage = wrapped.localizedDescription
      throw wrapped
    }
  }
}
