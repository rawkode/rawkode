import CryptoKit
import Darwin
import Foundation
import GRDB

/// The payload deliberately excludes a vault. The queue owns the immutable route.
public struct BookmarkCaptureInboxPayload: Codable, Hashable, Sendable {
  public static let version = 1
  public let submittedURL: String
  public let note: String?
  public let capturedAt: Date
  public let dayKey: DayKey
  public let timeZoneIdentifier: String
  public let source: String
  public let platform: String

  public init(request: BookmarkCaptureRequest) {
    submittedURL = request.submittedURL; note = request.note
    capturedAt = Self.normalizedCapturedAt(request.capturedAt)
    dayKey = request.dayKey; timeZoneIdentifier = request.timeZoneIdentifier
    source = request.source; platform = request.platform
  }

  public func request(captureID: UUID, vaultID: VaultID) -> BookmarkCaptureRequest {
    .init(captureID: captureID, submittedURL: submittedURL, note: note, capturedAt: capturedAt,
      dayKey: dayKey, timeZoneIdentifier: timeZoneIdentifier, source: source, platform: platform, vaultID: vaultID)
  }

  private enum CodingKeys: String, CodingKey {
    case submittedURL, note, capturedAt, capturedAtMilliseconds, dayKey, timeZoneIdentifier, source, platform
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    submittedURL = try container.decode(String.self, forKey: .submittedURL)
    note = try container.decodeIfPresent(String.self, forKey: .note)
    if let milliseconds = try container.decodeIfPresent(Int64.self, forKey: .capturedAtMilliseconds) {
      capturedAt = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
    } else {
      // v1 originally used JSONEncoder's ISO-8601 Date representation under `capturedAt`.
      // Keep those already-enqueued rows readable while all new payloads use exact milliseconds.
      capturedAt = Self.normalizedCapturedAt(try container.decode(Date.self, forKey: .capturedAt))
    }
    dayKey = try container.decode(DayKey.self, forKey: .dayKey)
    timeZoneIdentifier = try container.decode(String.self, forKey: .timeZoneIdentifier)
    source = try container.decode(String.self, forKey: .source)
    platform = try container.decode(String.self, forKey: .platform)
  }

  public func encode(to encoder: Encoder) throws {
    let seconds = capturedAt.timeIntervalSince1970
    let milliseconds = seconds * 1_000
    guard seconds.isFinite, milliseconds >= Double(Int64.min), milliseconds <= Double(Int64.max) else {
      throw EncodingError.invalidValue(
        capturedAt,
        .init(codingPath: encoder.codingPath, debugDescription: "Capture timestamp cannot be represented as integer milliseconds.")
      )
    }
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(submittedURL, forKey: .submittedURL)
    try container.encodeIfPresent(note, forKey: .note)
    try container.encode(Int64(milliseconds.rounded()), forKey: .capturedAtMilliseconds)
    try container.encode(dayKey, forKey: .dayKey)
    try container.encode(timeZoneIdentifier, forKey: .timeZoneIdentifier)
    try container.encode(source, forKey: .source)
    try container.encode(platform, forKey: .platform)
  }

  private static func normalizedCapturedAt(_ value: Date) -> Date {
    let milliseconds = value.timeIntervalSince1970 * 1_000
    guard milliseconds.isFinite,
      milliseconds >= Double(Int64.min), milliseconds <= Double(Int64.max)
    else { return value }
    return Date(timeIntervalSince1970: TimeInterval(Int64(milliseconds.rounded())) / 1_000)
  }
}

public enum CaptureInboxState: String, Codable, Sendable { case pending, leased, imported, quarantined }

public struct CaptureInboxRecord: Sendable, Hashable, Identifiable {
  public let captureID: UUID; public let payload: BookmarkCaptureInboxPayload; public let payloadHash: String
  public let vaultID: VaultID; public let createdAt: Date; public let state: CaptureInboxState
  public let leaseID: UUID?; public let leaseExpiresAt: Date?; public let attempts: Int; public let lastError: String?; public let importedAt: Date?
  public var id: UUID { captureID }
}

public enum CaptureInboxStoreError: Error, Equatable, LocalizedError {
  case invalidURL, conflictingPayload, invalidState, databaseUnavailable(String)
  public var errorDescription: String? {
    switch self { case .invalidURL: "The bookmark URL is invalid."; case .conflictingPayload: "A different payload already uses this capture identifier."; case .invalidState: "The capture queue state is no longer current."; case .databaseUnavailable(let reason): reason }
  }
}

public enum CaptureInboxEnqueueResult: Sendable, Equatable { case enqueued(CaptureInboxRecord), existing(CaptureInboxRecord) }

/// An app-group-only inbox. It never knows a graph path, which keeps extensions from opening graph.sqlite.
public actor CaptureInboxStore {
  public static let notificationName = "dev.rawkode.enchiridion.capture-inbox.changed"
  public let path: String
  private let database: DatabasePool

  public init(path: String) throws {
    self.path = path
    let url = URL(fileURLWithPath: path)
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    #if os(iOS)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
    #endif
    var configuration = Configuration()
    configuration.busyMode = .timeout(5)
    configuration.journalMode = .wal
    configuration.prepareDatabase { db in try db.execute(sql: "PRAGMA foreign_keys = ON"); try db.execute(sql: "PRAGMA synchronous = FULL") }
    do {
      database = try Self.withOpenLock(path: path) {
        let database = try DatabasePool(path: path, configuration: configuration)
        try database.writeWithoutTransaction { db in try db.execute(sql: "PRAGMA synchronous = FULL"); try db.execute(sql: "PRAGMA foreign_keys = ON") }
        try Self.migrator.migrate(database)
        return database
      }
      #if os(iOS)
      try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
      #endif
    } catch { throw CaptureInboxStoreError.databaseUnavailable(error.localizedDescription) }
  }

  public static func defaultPath() throws -> String {
    let manager = FileManager.default
    #if os(iOS) || os(macOS)
    if let container = manager.containerURL(forSecurityApplicationGroupIdentifier: LibraryRepository.applicationGroupIdentifier) {
      let directory = container.appendingPathComponent("captures", isDirectory: true)
      try manager.createDirectory(at: directory, withIntermediateDirectories: true)
      #if os(iOS)
      try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
      #endif
      return directory.appendingPathComponent("inbox.sqlite").path
    }
    throw CaptureInboxStoreError.databaseUnavailable(
      "The shared capture inbox is unavailable because the Enchiridion App Group container could not be opened."
    )
    #else
    let base = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let directory = base.appendingPathComponent("dev.rawkode.enchiridion/captures", isDirectory: true)
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("inbox.sqlite").path
    #endif
  }

  /// The caller obtains `vaultID` from the catalog at capture time. Once inserted, neither route nor payload can change.
  public func enqueue(captureID: UUID, payload: BookmarkCaptureInboxPayload, vaultID: VaultID, now: Date = Date()) throws -> CaptureInboxEnqueueResult {
    guard BookmarkURLKey(submittedURL: payload.submittedURL) != nil else { throw CaptureInboxStoreError.invalidURL }
    let encoded = try JSONEncoder.enchiridion.encode(payload)
    let hash = Self.hash(encoded)
    let result: CaptureInboxEnqueueResult = try database.write { db in
      if let existing = try Self.record(captureID, db: db) {
        // The original v1 ISO-8601 timestamp and the millisecond-stable v1 representation have
        // different byte hashes. Preserve idempotency for an already-enqueued semantic payload
        // while continuing to reject any actual capture mutation.
        guard existing.payloadHash == hash || existing.payload == payload else {
          throw CaptureInboxStoreError.conflictingPayload
        }
        return .existing(existing)
      }
      try db.execute(sql: "INSERT INTO capture_inbox (capture_id,payload_version,payload,payload_hash,vault_id,created_at,state,attempts) VALUES (?,?,?,?,?,?,?,0)", arguments: [captureID.uuidString.lowercased(), BookmarkCaptureInboxPayload.version, encoded, hash, vaultID.rawValue, now.timeIntervalSince1970, CaptureInboxState.pending.rawValue])
      guard let created = try Self.record(captureID, db: db) else { throw CaptureInboxStoreError.databaseUnavailable("The enqueue commit could not be confirmed.") }
      return .enqueued(created)
    }
    if case .enqueued = result { Self.postEnqueueNotification() }
    return result
  }

  public func enqueue(captureID: UUID, request: BookmarkCaptureRequest, vaultID: VaultID, now: Date = Date()) throws -> CaptureInboxEnqueueResult {
    try enqueue(captureID: captureID, payload: .init(request: request), vaultID: vaultID, now: now)
  }

  /// Convenience for capture producers: take the catalog's current default once, then persist it
  /// with the payload in the queue transaction. Retries never consult the catalog again.
  public func enqueue(captureID: UUID, request: BookmarkCaptureRequest, registry: VaultRegistry, now: Date = Date()) throws -> CaptureInboxEnqueueResult {
    let route = try registry.snapshot().defaultCaptureVaultID
    return try enqueue(captureID: captureID, request: request, vaultID: route, now: now)
  }

  public func record(_ captureID: UUID) throws -> CaptureInboxRecord? { try database.read { try Self.record(captureID, db: $0) } }
  public func records() throws -> [CaptureInboxRecord] { try database.read { db in try Row.fetchAll(db, sql: "SELECT * FROM capture_inbox ORDER BY created_at, capture_id").map(Self.decode) } }

  /// Removes URL-bearing queue payloads after the graph has durably completed permanent deletion.
  /// Digests are inputs only: this inbox never persists bookmark identity or suppression state.
  @discardableResult
  public func purgeURLKeyDigests<S: Sequence>(_ urlKeyDigests: S) throws -> Int where S.Element == String {
    let digests = Set(urlKeyDigests)
    guard !digests.isEmpty else { return 0 }
    return try database.write { db in
      let rows = try Row.fetchAll(db, sql: "SELECT capture_id,payload FROM capture_inbox")
      var captureIDs: [String] = []
      captureIDs.reserveCapacity(rows.count)
      for row in rows {
        guard let captureID: String = row["capture_id"],
          let bytes: Data = row["payload"],
          let payload = try? JSONDecoder.enchiridion.decode(BookmarkCaptureInboxPayload.self, from: bytes),
          let key = BookmarkURLKey(submittedURL: payload.submittedURL),
          digests.contains(key.digest)
        else { continue }
        captureIDs.append(captureID)
      }
      for captureID in captureIDs {
        try db.execute(sql: "DELETE FROM capture_inbox WHERE capture_id = ?", arguments: [captureID])
      }
      return captureIDs.count
    }
  }

  public func claim(ownerID: UUID, leaseID: UUID = UUID(), leaseDuration: TimeInterval = 60, limit: Int = 25, now: Date = Date()) throws -> [CaptureInboxRecord] {
    try database.write { db in
      try db.execute(sql: "UPDATE capture_inbox SET state = ?, lease_id = NULL, lease_expires_at = NULL WHERE state = ? AND lease_expires_at <= ?", arguments: [CaptureInboxState.pending.rawValue, CaptureInboxState.leased.rawValue, now.timeIntervalSince1970])
      let ids = try String.fetchAll(db, sql: "SELECT capture_id FROM capture_inbox WHERE state = ? ORDER BY created_at, capture_id LIMIT ?", arguments: [CaptureInboxState.pending.rawValue, max(0, limit)])
      let expiry = now.addingTimeInterval(leaseDuration).timeIntervalSince1970
      return try ids.compactMap { id in
        try db.execute(sql: "UPDATE capture_inbox SET state = ?, lease_owner_id = ?, lease_id = ?, lease_expires_at = ?, attempts = attempts + 1 WHERE capture_id = ? AND state = ?", arguments: [CaptureInboxState.leased.rawValue, ownerID.uuidString.lowercased(), leaseID.uuidString.lowercased(), expiry, id, CaptureInboxState.pending.rawValue])
        guard db.changesCount == 1, let uuid = UUID(uuidString: id) else { return nil }
        return try Self.record(uuid, db: db)
      }
    }
  }

  public func renew(captureID: UUID, ownerID: UUID, leaseID: UUID, leaseDuration: TimeInterval = 60, now: Date = Date()) throws -> Bool { try leaseUpdate(captureID: captureID, ownerID: ownerID, leaseID: leaseID, now: now, sql: "UPDATE capture_inbox SET lease_expires_at = ? WHERE capture_id = ? AND state = ? AND lease_owner_id = ? AND lease_id = ? AND lease_expires_at > ?", values: [now.addingTimeInterval(leaseDuration).timeIntervalSince1970]) }
  public func release(captureID: UUID, ownerID: UUID, leaseID: UUID, now: Date = Date()) throws -> Bool { try leaseUpdate(captureID: captureID, ownerID: ownerID, leaseID: leaseID, now: now, sql: "UPDATE capture_inbox SET state = ?, lease_owner_id = NULL, lease_id = NULL, lease_expires_at = NULL WHERE capture_id = ? AND state = ? AND lease_owner_id = ? AND lease_id = ?", values: [CaptureInboxState.pending.rawValue]) }
  public func finishImported(captureID: UUID, ownerID: UUID, leaseID: UUID, now: Date = Date()) throws -> Bool { try leaseUpdate(captureID: captureID, ownerID: ownerID, leaseID: leaseID, now: now, sql: "UPDATE capture_inbox SET state = ?, lease_owner_id = NULL, lease_id = NULL, lease_expires_at = NULL, imported_at = ?, last_error = NULL WHERE capture_id = ? AND state = ? AND lease_owner_id = ? AND lease_id = ? AND lease_expires_at > ?", values: [CaptureInboxState.imported.rawValue, now.timeIntervalSince1970], needsExpiry: true) }
  public func quarantine(captureID: UUID, ownerID: UUID, leaseID: UUID, reason: String, now: Date = Date()) throws -> Bool { try leaseUpdate(captureID: captureID, ownerID: ownerID, leaseID: leaseID, now: now, sql: "UPDATE capture_inbox SET state = ?, lease_owner_id = NULL, lease_id = NULL, lease_expires_at = NULL, last_error = ? WHERE capture_id = ? AND state = ? AND lease_owner_id = ? AND lease_id = ?", values: [CaptureInboxState.quarantined.rawValue, reason]) }

  private func leaseUpdate(captureID: UUID, ownerID: UUID, leaseID: UUID, now: Date, sql: String, values: [any DatabaseValueConvertible], needsExpiry: Bool = false) throws -> Bool {
    try database.write { db in
      guard var args = StatementArguments(values) else {
        throw CaptureInboxStoreError.databaseUnavailable("Could not encode the capture lease update.")
      }
      args += StatementArguments([captureID.uuidString.lowercased(), CaptureInboxState.leased.rawValue, ownerID.uuidString.lowercased(), leaseID.uuidString.lowercased()])
      if needsExpiry || sql.contains("lease_expires_at > ?") { args += StatementArguments([now.timeIntervalSince1970]) }
      try db.execute(sql: sql, arguments: args); return db.changesCount == 1
    }
  }

  private static func record(_ id: UUID, db: Database) throws -> CaptureInboxRecord? { try Row.fetchOne(db, sql: "SELECT * FROM capture_inbox WHERE capture_id = ?", arguments: [id.uuidString.lowercased()]).map(decode) }
  private static func decode(_ row: Row) throws -> CaptureInboxRecord {
    guard let id: String = row["capture_id"], let captureID = UUID(uuidString: id), let bytes: Data = row["payload"], let payload = try? JSONDecoder.enchiridion.decode(BookmarkCaptureInboxPayload.self, from: bytes), let rawState: String = row["state"], let state = CaptureInboxState(rawValue: rawState), let vault: String = row["vault_id"], let hash: String = row["payload_hash"] else { throw CaptureInboxStoreError.databaseUnavailable("Capture inbox contains an invalid record.") }
    return .init(captureID: captureID, payload: payload, payloadHash: hash, vaultID: .init(rawValue: vault), createdAt: Date(timeIntervalSince1970: (row["created_at"] as Double? ?? 0)), state: state, leaseID: (row["lease_id"] as String?).flatMap(UUID.init(uuidString:)), leaseExpiresAt: (row["lease_expires_at"] as Double?).map(Date.init(timeIntervalSince1970:)), attempts: row["attempts"] as Int? ?? 0, lastError: row["last_error"], importedAt: (row["imported_at"] as Double?).map(Date.init(timeIntervalSince1970:)))
  }
  private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
  private static func withOpenLock<T>(path: String, operation: () throws -> T) throws -> T {
    let lock = URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(".capture-inbox-open.lock")
    let descriptor = open(lock.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw CaptureInboxStoreError.databaseUnavailable("Could not open the capture inbox lock.") }
    defer { close(descriptor) }
    let deadline = Date().addingTimeInterval(5)
    while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
      guard errno == EWOULDBLOCK || errno == EAGAIN, Date() < deadline else { throw CaptureInboxStoreError.databaseUnavailable("Timed out waiting to open the capture inbox.") }
      usleep(50_000)
    }
    defer { _ = flock(descriptor, LOCK_UN) }
    return try operation()
  }
  private static func postEnqueueNotification() {
    #if os(iOS) || os(macOS)
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(notificationName as CFString), nil, nil, true)
    #endif
  }
  private static let migrator: DatabaseMigrator = {
    var migrator = DatabaseMigrator()
    migrator.registerMigration("v1-capture-inbox") { db in
      try db.create(table: "capture_inbox") { t in
        t.column("capture_id", .text).primaryKey(); t.column("payload_version", .integer).notNull(); t.column("payload", .blob).notNull(); t.column("payload_hash", .text).notNull(); t.column("vault_id", .text).notNull(); t.column("created_at", .double).notNull(); t.column("state", .text).notNull(); t.column("lease_owner_id", .text); t.column("lease_id", .text); t.column("lease_expires_at", .double); t.column("attempts", .integer).notNull().defaults(to: 0); t.column("last_error", .text); t.column("imported_at", .double)
      }
      try db.create(index: "capture_inbox_claim", on: "capture_inbox", columns: ["state", "created_at"])
    }; return migrator
  }()
}
