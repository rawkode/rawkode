import Foundation
import GRDB

public struct VaultDescriptor: Codable, Hashable, Sendable, Identifiable {
  public var id: VaultID
  public var name: String
  public var createdAt: Date
  public var modifiedAt: Date
  public var sortOrder: Int
  public var isDownloaded: Bool
  public var deletedAt: Date?

  public init(
    id: VaultID = .random(),
    name: String,
    createdAt: Date = Date(),
    modifiedAt: Date? = nil,
    sortOrder: Int = 0,
    isDownloaded: Bool = true,
    deletedAt: Date? = nil
  ) {
    self.id = id
    self.name = name
    self.createdAt = createdAt
    self.modifiedAt = modifiedAt ?? createdAt
    self.sortOrder = sortOrder
    self.isDownloaded = isDownloaded
    self.deletedAt = deletedAt
  }

  public var cloudZoneName: String { id.cloudZoneName }
}

public struct VaultRegistrySnapshot: Equatable, Sendable {
  public var vaults: [VaultDescriptor]
  public var selectedVaultID: VaultID
  public var defaultCaptureVaultID: VaultID

  public init(
    vaults: [VaultDescriptor],
    selectedVaultID: VaultID,
    defaultCaptureVaultID: VaultID
  ) {
    self.vaults = vaults
    self.selectedVaultID = selectedVaultID
    self.defaultCaptureVaultID = defaultCaptureVaultID
  }
}

public enum VaultSelection: Sendable {
  case selected
  case defaultCapture
  case vault(VaultID)
}

public enum VaultRegistryError: Error, LocalizedError, Equatable {
  case invalidName
  case invalidIdentifier
  case vaultNotFound
  case cannotDeleteOnlyVault

  public var errorDescription: String? {
    switch self {
    case .invalidName: "Enter a vault name."
    case .invalidIdentifier: "The vault identifier is invalid."
    case .vaultNotFound: "The vault is no longer available."
    case .cannotDeleteOnlyVault: "Create another vault before deleting this one."
    }
  }
}

/// The small app-group catalog is the only process-wide authority for locating vault databases.
/// Graph data never crosses this boundary: each descriptor maps to one independent SQLite file.
public final class VaultRegistry: @unchecked Sendable {
  public static let catalogZoneName = "EnchiridionGraphCatalog"
  public static let personalVaultName = "Personal"

  public let path: String
  private let database: DatabasePool

  public init(path: String) throws {
    self.path = path
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    var configuration = Configuration()
    configuration.busyMode = .timeout(5)
    configuration.journalMode = .wal
    configuration.prepareDatabase { db in
      try db.execute(sql: "PRAGMA foreign_keys = ON")
      try db.execute(sql: "PRAGMA synchronous = FULL")
    }
    database = try DatabasePool(path: path, configuration: configuration)
    try Self.migrator.migrate(database)
    try bootstrapIfNeeded()
  }

  public static func defaultCatalogPath() throws -> String {
    let manager = FileManager.default
    let catalogURL: URL
    #if os(iOS) || os(macOS)
    if let container = manager.containerURL(
      forSecurityApplicationGroupIdentifier: LibraryRepository.applicationGroupIdentifier
    ) {
      let directory = container.appendingPathComponent("vaults", isDirectory: true)
      try manager.createDirectory(at: directory, withIntermediateDirectories: true)
      catalogURL = directory.appendingPathComponent("catalog.sqlite")
      try migrateLegacyPersonalVaultIfNeeded(
        catalogPath: catalogURL.path,
        legacyDatabaseURLs: LibraryRepository.legacyDefaultDatabaseURLs(manager: manager),
        manager: manager
      )
      return catalogURL.path
    }
    #endif
    let base = try manager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = base
      .appendingPathComponent("dev.rawkode.enchiridion", isDirectory: true)
      .appendingPathComponent("vaults", isDirectory: true)
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
    catalogURL = directory.appendingPathComponent("catalog.sqlite")
    try migrateLegacyPersonalVaultIfNeeded(
      catalogPath: catalogURL.path,
      legacyDatabaseURLs: LibraryRepository.legacyDefaultDatabaseURLs(manager: manager),
      manager: manager
    )
    return catalogURL.path
  }

  static func migrateLegacyPersonalVaultIfNeeded(
    catalogPath: String,
    legacyDatabaseURLs: [URL],
    manager: FileManager = .default
  ) throws {
    let destinationDirectory = URL(fileURLWithPath: catalogPath)
      .deletingLastPathComponent()
      .appendingPathComponent(VaultID.personal.rawValue, isDirectory: true)
    try manager.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)
    let destinationDatabase = destinationDirectory.appendingPathComponent("graph.sqlite")

    for sourceDatabase in legacyDatabaseURLs {
      guard !manager.fileExists(atPath: destinationDatabase.path) else { return }
      try LibraryRepository.migrateSQLiteDatabaseIfNeeded(
        from: sourceDatabase,
        to: destinationDatabase,
        manager: manager
      )
    }
  }

  public static func defaultGraphPath(
    selection: VaultSelection = .selected
  ) throws -> String {
    let registry = try VaultRegistry(path: defaultCatalogPath())
    return try registry.graphPath(selection: selection)
  }

  public func snapshot() throws -> VaultRegistrySnapshot {
    try database.read { db in
      let vaults = try Self.fetchActiveVaults(db)
      guard let first = vaults.first else { throw VaultRegistryError.vaultNotFound }
      let selected = try Self.preference(db, key: "selected-vault-id")
        .map(VaultID.init(rawValue:))
        .flatMap { id in vaults.contains(where: { $0.id == id }) ? id : nil }
        ?? first.id
      let capture = try Self.preference(db, key: "default-capture-vault-id")
        .map(VaultID.init(rawValue:))
        .flatMap { id in vaults.contains(where: { $0.id == id }) ? id : nil }
        ?? selected
      return .init(
        vaults: vaults,
        selectedVaultID: selected,
        defaultCaptureVaultID: capture
      )
    }
  }

  @discardableResult
  public func createVault(name: String, now: Date = Date()) throws -> VaultDescriptor {
    let normalizedName = try Self.normalizedName(name)
    return try database.write { db in
      let sortOrder = try Int.fetchOne(
        db,
        sql: "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM vaults WHERE deleted_at IS NULL"
      ) ?? 0
      let descriptor = VaultDescriptor(
        name: normalizedName,
        createdAt: now,
        sortOrder: sortOrder
      )
      try Self.insert(descriptor, db: db)
      return descriptor
    }
  }

  public func renameVault(_ id: VaultID, name: String, now: Date = Date()) throws {
    let normalizedName = try Self.normalizedName(name)
    try database.write { db in
      try db.execute(
        sql: "UPDATE vaults SET name = ?, modified_at = ? WHERE id = ? AND deleted_at IS NULL",
        arguments: [normalizedName, now.timeIntervalSince1970, id.rawValue]
      )
      guard db.changesCount == 1 else { throw VaultRegistryError.vaultNotFound }
    }
  }

  public func setSelectedVault(_ id: VaultID) throws {
    try setPreference("selected-vault-id", id: id)
  }

  public func setDefaultCaptureVault(_ id: VaultID) throws {
    try setPreference("default-capture-vault-id", id: id)
  }

  public func reorderVaults(_ ids: [VaultID], now: Date = Date()) throws {
    try database.write { db in
      let active = try Self.fetchActiveVaults(db)
      guard Set(ids) == Set(active.map(\.id)), ids.count == active.count else {
        throw VaultRegistryError.vaultNotFound
      }
      for (index, id) in ids.enumerated() {
        try db.execute(
          sql: "UPDATE vaults SET sort_order = ?, modified_at = ? WHERE id = ?",
          arguments: [index, now.timeIntervalSince1970, id.rawValue]
        )
      }
    }
  }

  /// Marks the catalog entry deleted and returns the graph path. The caller must close every open
  /// repository before removing the returned SQLite files.
  @discardableResult
  public func deleteVault(_ id: VaultID, now: Date = Date()) throws -> String {
    let graphPath = try graphPathWithoutCreating(for: id)
    try database.write { db in
      let active = try Self.fetchActiveVaults(db)
      guard active.contains(where: { $0.id == id }) else {
        throw VaultRegistryError.vaultNotFound
      }
      guard active.count > 1 else { throw VaultRegistryError.cannotDeleteOnlyVault }
      try db.execute(
        sql: "UPDATE vaults SET deleted_at = ?, modified_at = ? WHERE id = ?",
        arguments: [now.timeIntervalSince1970, now.timeIntervalSince1970, id.rawValue]
      )
      let fallback = active.first(where: { $0.id != id })!.id
      for key in ["selected-vault-id", "default-capture-vault-id"] {
        if try Self.preference(db, key: key) == id.rawValue {
          try Self.setPreference(db, key: key, value: fallback.rawValue)
        }
      }
    }
    return graphPath
  }

  public func graphPath(selection: VaultSelection) throws -> String {
    let id: VaultID
    switch selection {
    case .selected: id = try snapshot().selectedVaultID
    case .defaultCapture: id = try snapshot().defaultCaptureVaultID
    case .vault(let requested):
      guard try snapshot().vaults.contains(where: { $0.id == requested }) else {
        throw VaultRegistryError.vaultNotFound
      }
      id = requested
    }
    return try graphPath(for: id)
  }

  public func graphPath(for id: VaultID) throws -> String {
    let graphPath = try graphPathWithoutCreating(for: id)
    let directory = URL(fileURLWithPath: graphPath).deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    #if os(iOS)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: directory.path
    )
    #endif
    return graphPath
  }

  func graphPathWithoutCreating(for id: VaultID) throws -> String {
    guard Self.isSafe(id) else { throw VaultRegistryError.invalidIdentifier }
    let catalogURL = URL(fileURLWithPath: path)
    let directory = catalogURL.deletingLastPathComponent()
      .appendingPathComponent(id.rawValue, isDirectory: true)
    return directory.appendingPathComponent("graph.sqlite").path
  }

  private func bootstrapIfNeeded() throws {
    try database.write { db in
      if try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM vaults WHERE deleted_at IS NULL") == 0 {
        let personal = VaultDescriptor(id: .personal, name: Self.personalVaultName)
        try Self.insert(personal, db: db)
        try Self.setPreference(db, key: "selected-vault-id", value: personal.id.rawValue)
        try Self.setPreference(db, key: "default-capture-vault-id", value: personal.id.rawValue)
      }
    }
  }

  private func setPreference(_ key: String, id: VaultID) throws {
    try database.write { db in
      guard try Bool.fetchOne(
        db,
        sql: "SELECT EXISTS(SELECT 1 FROM vaults WHERE id = ? AND deleted_at IS NULL)",
        arguments: [id.rawValue]
      ) == true else { throw VaultRegistryError.vaultNotFound }
      try Self.setPreference(db, key: key, value: id.rawValue)
    }
  }

  private static func normalizedName(_ value: String) throws -> String {
    let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !result.isEmpty, result.count <= 80 else { throw VaultRegistryError.invalidName }
    return result
  }

  private static func isSafe(_ id: VaultID) -> Bool {
    guard id.rawValue.hasPrefix("vault_"), id.rawValue.count <= 80 else { return false }
    return id.rawValue.unicodeScalars.allSatisfy {
      CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-"
    }
  }

  private static func fetchActiveVaults(_ db: Database) throws -> [VaultDescriptor] {
    try Row.fetchAll(
      db,
      sql: "SELECT * FROM vaults WHERE deleted_at IS NULL ORDER BY sort_order, name COLLATE NOCASE"
    ).compactMap(decode)
  }

  private static func decode(_ row: Row) -> VaultDescriptor? {
    guard let id: String = row["id"],
      let name: String = row["name"],
      let createdAt: Double = row["created_at"],
      let modifiedAt: Double = row["modified_at"],
      let sortOrder: Int = row["sort_order"]
    else { return nil }
    return .init(
      id: .init(rawValue: id),
      name: name,
      createdAt: Date(timeIntervalSince1970: createdAt),
      modifiedAt: Date(timeIntervalSince1970: modifiedAt),
      sortOrder: sortOrder,
      isDownloaded: row["is_downloaded"] ?? true,
      deletedAt: (row["deleted_at"] as Double?).map(Date.init(timeIntervalSince1970:))
    )
  }

  private static func insert(_ descriptor: VaultDescriptor, db: Database) throws {
    try db.execute(
      sql: """
        INSERT INTO vaults
          (id,name,created_at,modified_at,sort_order,is_downloaded,deleted_at)
        VALUES (?,?,?,?,?,?,?)
        """,
      arguments: [
        descriptor.id.rawValue,
        descriptor.name,
        descriptor.createdAt.timeIntervalSince1970,
        descriptor.modifiedAt.timeIntervalSince1970,
        descriptor.sortOrder,
        descriptor.isDownloaded,
        descriptor.deletedAt?.timeIntervalSince1970,
      ]
    )
  }

  private static func preference(_ db: Database, key: String) throws -> String? {
    try String.fetchOne(db, sql: "SELECT value FROM preferences WHERE key = ?", arguments: [key])
  }

  private static func setPreference(_ db: Database, key: String, value: String) throws {
    try db.execute(
      sql: "INSERT OR REPLACE INTO preferences (key,value) VALUES (?,?)",
      arguments: [key, value]
    )
  }

  private static let migrator: DatabaseMigrator = {
    var migrator = DatabaseMigrator()
    migrator.registerMigration("v1-vault-catalog") { db in
      try db.create(table: "vaults") { table in
        table.column("id", .text).primaryKey()
        table.column("name", .text).notNull()
        table.column("created_at", .double).notNull()
        table.column("modified_at", .double).notNull()
        table.column("sort_order", .integer).notNull()
        table.column("is_downloaded", .boolean).notNull().defaults(to: true)
        table.column("deleted_at", .double)
      }
      try db.create(index: "vaults_on_sort_order", on: "vaults", columns: ["sort_order"])
      try db.create(table: "preferences") { table in
        table.column("key", .text).primaryKey()
        table.column("value", .text).notNull()
      }
      try db.create(table: "cloud_catalog_state") { table in
        table.column("key", .text).primaryKey()
        table.column("value", .blob).notNull()
      }
    }
    return migrator
  }()
}
