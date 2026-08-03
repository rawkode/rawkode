import Foundation
import GRDB
import EnchiridionWorkoutTransport

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

/// A first-observation routing decision for an external capture. It lives in the
/// catalog rather than a vault database so a retry can never silently move data
/// to whichever vault happens to be selected later.
public struct WorkoutCaptureRoute: Codable, Hashable, Sendable {
  public let moduleID: String
  public let eventID: String
  public let payloadHash: String
  public let vaultID: VaultID
  public let createdAt: Date
}

public enum WorkoutCaptureRouteResult: Hashable, Sendable {
  case claimed(WorkoutCaptureRoute)
  case existing(WorkoutCaptureRoute)
}

public enum WorkoutCaptureRouteError: Error, LocalizedError, Equatable {
  case invalidEventID
  case invalidPayloadHash
  case conflictingPayload
  case routedVaultUnavailable

  public var errorDescription: String? {
    switch self {
    case .invalidEventID: "The workout event identifier is invalid."
    case .invalidPayloadHash: "The workout payload hash is invalid."
    case .conflictingPayload: "A different workout payload was received for this event."
    case .routedVaultUnavailable: "The vault originally chosen for this workout is unavailable."
    }
  }
}

/// A durable response that can be retried through WatchConnectivity after a
/// process restart. The acknowledgement itself is stored before it is queued.
public struct WorkoutAcknowledgementOutboxRecord: Codable, Hashable, Sendable, Identifiable {
  public let response: WorkoutDeliveryResponse
  public let createdAt: Date
  public var id: String { "\(response.moduleID):\(response.eventID):\(response.payloadHash)" }
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

  /// Claims an immutable destination before a vault import begins. An exact
  /// replay returns the original route; a different hash is quarantinable by
  /// the caller and never changes that route.
  public func claimWorkoutCaptureRoute(
    moduleID: String,
    eventID: String,
    payloadHash: String,
    now: Date = Date()
  ) throws -> WorkoutCaptureRouteResult {
    guard UUID(uuidString: eventID) != nil else { throw WorkoutCaptureRouteError.invalidEventID }
    guard Self.isSHA256(payloadHash) else { throw WorkoutCaptureRouteError.invalidPayloadHash }
    return try database.write { db in
      if let route = try Self.workoutRoute(moduleID: moduleID, eventID: eventID, db: db) {
        guard route.payloadHash == payloadHash else { throw WorkoutCaptureRouteError.conflictingPayload }
        guard try Self.isAvailable(route.vaultID, db: db) else {
          throw WorkoutCaptureRouteError.routedVaultUnavailable
        }
        return .existing(route)
      }

      guard let captureID = try Self.preference(db, key: "default-capture-vault-id").map(VaultID.init(rawValue:)),
        try Self.isAvailable(captureID, db: db)
      else { throw WorkoutCaptureRouteError.routedVaultUnavailable }
      let route = WorkoutCaptureRoute(
        moduleID: moduleID,
        eventID: eventID,
        payloadHash: payloadHash,
        vaultID: captureID,
        createdAt: now
      )
      try db.execute(
        sql: """
          INSERT INTO workout_capture_routes
            (module_id,event_id,payload_hash,vault_id,created_at)
          VALUES (?,?,?,?,?)
          """,
        arguments: [moduleID, eventID, payloadHash, captureID.rawValue, now.timeIntervalSince1970]
      )
      return .claimed(route)
    }
  }

  public func existingWorkoutCaptureRoute(
    moduleID: String,
    eventID: String
  ) throws -> WorkoutCaptureRoute? {
    guard UUID(uuidString: eventID) != nil else { throw WorkoutCaptureRouteError.invalidEventID }
    return try database.read { db in try Self.workoutRoute(moduleID: moduleID, eventID: eventID, db: db) }
  }

  /// Reconstructs a missing catalog claim from one already-materialized vault.
  /// This deliberately requires the caller to have proved a unique provenance
  /// match; it must never fall back to today's default capture vault.
  public func claimRecoveredWorkoutCaptureRoute(
    moduleID: String,
    eventID: String,
    payloadHash: String,
    recoveredVaultID: VaultID,
    now: Date = Date()
  ) throws -> WorkoutCaptureRouteResult {
    guard UUID(uuidString: eventID) != nil else { throw WorkoutCaptureRouteError.invalidEventID }
    guard Self.isSHA256(payloadHash) else { throw WorkoutCaptureRouteError.invalidPayloadHash }
    return try database.write { db in
      if let route = try Self.workoutRoute(moduleID: moduleID, eventID: eventID, db: db) {
        guard route.payloadHash == payloadHash else { throw WorkoutCaptureRouteError.conflictingPayload }
        guard try Self.isAvailable(route.vaultID, db: db) else {
          throw WorkoutCaptureRouteError.routedVaultUnavailable
        }
        return .existing(route)
      }
      guard try Self.isAvailable(recoveredVaultID, db: db) else {
        throw WorkoutCaptureRouteError.routedVaultUnavailable
      }
      let route = WorkoutCaptureRoute(
        moduleID: moduleID, eventID: eventID, payloadHash: payloadHash,
        vaultID: recoveredVaultID, createdAt: now
      )
      try db.execute(
        sql: """
          INSERT INTO workout_capture_routes
            (module_id,event_id,payload_hash,vault_id,created_at)
          VALUES (?,?,?,?,?)
          """,
        arguments: [moduleID, eventID, payloadHash, recoveredVaultID.rawValue, now.timeIntervalSince1970]
      )
      return .claimed(route)
    }
  }

  public func pendingWorkoutAcknowledgements(
    limit: Int = 100
  ) throws -> [WorkoutAcknowledgementOutboxRecord] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT module_id,event_id,payload_hash,disposition,created_at
          FROM workout_acknowledgement_outbox
          ORDER BY created_at, module_id, event_id
          LIMIT ?
          """,
        arguments: [max(1, min(limit, 100))]
      ).compactMap(Self.decodeAcknowledgementOutbox)
    }
  }

  /// Safe to call repeatedly. The primary key is the exact acknowledgement
  /// tuple, so a retry cannot produce a response for a different payload.
  public func enqueueWorkoutAcknowledgement(
    _ acknowledgement: WorkoutImportAcknowledgement,
    now: Date = Date()
  ) throws {
    try enqueueWorkoutResponse(.init(
      moduleID: acknowledgement.moduleID, eventID: acknowledgement.eventID,
      payloadHash: acknowledgement.payloadHash, disposition: .imported
    ), now: now)
  }

  /// Persists a terminal response before any queued WatchConnectivity call.
  /// Delivery confirmation is a separate Watch-to-phone transfer; enqueuing is
  /// deliberately not treated as observation.
  public func enqueueWorkoutResponse(
    _ response: WorkoutDeliveryResponse,
    now: Date = Date()
  ) throws {
    try database.write { db in
      try db.execute(
        sql: """
          INSERT OR IGNORE INTO workout_acknowledgement_outbox
            (module_id,event_id,payload_hash,disposition,created_at)
          VALUES (?,?,?,?,?)
          """,
        arguments: [
          response.moduleID, response.eventID, response.payloadHash, response.disposition.rawValue,
          now.timeIntervalSince1970,
        ]
      )
      // Bounded retention is a guard against a permanently unreachable watch.
      try db.execute(
        sql: """
          DELETE FROM workout_acknowledgement_outbox
          WHERE created_at < ? OR rowid NOT IN (
            SELECT rowid FROM workout_acknowledgement_outbox
            ORDER BY created_at DESC, module_id DESC, event_id DESC
            LIMIT 500
          )
          """,
        arguments: [now.addingTimeInterval(-60 * 60 * 24 * 30).timeIntervalSince1970]
      )
    }
  }

  public func acknowledgeWorkoutAcknowledgementDelivery(
    _ acknowledgement: WorkoutImportAcknowledgement
  ) throws {
    try database.write { db in
      try db.execute(
        sql: """
          DELETE FROM workout_acknowledgement_outbox
          WHERE module_id = ? AND event_id = ? AND payload_hash = ?
          """,
        arguments: [acknowledgement.moduleID, acknowledgement.eventID, acknowledgement.payloadHash]
      )
    }
  }

  public func acknowledgeWorkoutResponseDelivery(_ response: WorkoutDeliveryResponse) throws {
    try acknowledgeWorkoutAcknowledgementDelivery(response.acknowledgement)
  }

  /// Keeps rejected transport attempts out of the normal retry path without
  /// discarding the forensic identity tuple needed for support export.
  public func quarantineWorkoutCapture(
    moduleID: String,
    eventID: String,
    payloadHash: String,
    reason: String,
    now: Date = Date()
  ) throws {
    try database.write { db in
      try db.execute(
        sql: """
          INSERT OR IGNORE INTO workout_capture_quarantine
            (module_id,event_id,payload_hash,reason,received_at)
          VALUES (?,?,?,?,?)
          """,
        arguments: [moduleID, eventID, payloadHash, reason, now.timeIntervalSince1970]
      )
    }
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

  private static func isSHA256(_ value: String) -> Bool {
    value.count == 64 && value.unicodeScalars.allSatisfy {
      CharacterSet(charactersIn: "0123456789abcdef").contains($0)
    }
  }

  private static func isAvailable(_ id: VaultID, db: Database) throws -> Bool {
    try Bool.fetchOne(
      db,
      sql: "SELECT EXISTS(SELECT 1 FROM vaults WHERE id = ? AND deleted_at IS NULL AND is_downloaded = 1)",
      arguments: [id.rawValue]
    ) == true
  }

  private static func workoutRoute(
    moduleID: String,
    eventID: String,
    db: Database
  ) throws -> WorkoutCaptureRoute? {
    guard let row = try Row.fetchOne(
      db,
      sql: """
        SELECT module_id,event_id,payload_hash,vault_id,created_at
        FROM workout_capture_routes WHERE module_id = ? AND event_id = ?
        """,
      arguments: [moduleID, eventID]
    ), let moduleID: String = row["module_id"], let eventID: String = row["event_id"],
      let payloadHash: String = row["payload_hash"], let vaultID: String = row["vault_id"],
      let createdAt: Double = row["created_at"]
    else { return nil }
    return .init(moduleID: moduleID, eventID: eventID, payloadHash: payloadHash,
                 vaultID: .init(rawValue: vaultID), createdAt: .init(timeIntervalSince1970: createdAt))
  }

  private static func decodeAcknowledgementOutbox(_ row: Row) -> WorkoutAcknowledgementOutboxRecord? {
    guard let moduleID: String = row["module_id"], let eventID: String = row["event_id"],
      let payloadHash: String = row["payload_hash"], let disposition: String = row["disposition"],
      let createdAt: Double = row["created_at"],
      let parsedDisposition = WorkoutDeliveryDisposition(rawValue: disposition)
    else { return nil }
    return .init(
      response: .init(
        moduleID: moduleID, eventID: eventID, payloadHash: payloadHash,
        disposition: parsedDisposition
      ),
      createdAt: .init(timeIntervalSince1970: createdAt)
    )
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
    migrator.registerMigration("v2-workout-capture-routing") { db in
      try db.create(table: "workout_capture_routes") { table in
        table.column("module_id", .text).notNull()
        table.column("event_id", .text).notNull()
        table.column("payload_hash", .text).notNull()
        table.column("vault_id", .text).notNull().references("vaults", onDelete: .restrict)
        table.column("created_at", .double).notNull()
        table.primaryKey(["module_id", "event_id"])
      }
      try db.create(table: "workout_acknowledgement_outbox") { table in
        table.column("module_id", .text).notNull()
        table.column("event_id", .text).notNull()
        table.column("payload_hash", .text).notNull()
        table.column("disposition", .text).notNull()
        table.column("created_at", .double).notNull()
        table.primaryKey(["module_id", "event_id", "payload_hash"])
      }
      try db.create(table: "workout_capture_quarantine") { table in
        table.column("module_id", .text).notNull()
        table.column("event_id", .text).notNull()
        table.column("payload_hash", .text).notNull()
        table.column("reason", .text).notNull()
        table.column("received_at", .double).notNull()
        table.primaryKey(["module_id", "event_id", "payload_hash"])
      }
    }
    return migrator
  }()
}
