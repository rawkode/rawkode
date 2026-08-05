import Automerge
import CryptoKit
import Darwin
import Foundation
import GRDB

public enum LibraryRepositoryError: Error, Equatable, LocalizedError {
  case pageNotFound
  case pagePurged
  case invalidRecord
  case calendarMaterializationDisabled
  case bookmarkCaptureHistoryConflict
  case bookmarkIdentityFrozen
  case bookmarkSuppressed
  case bookmarkDeletionCarrier
  case projectHasActiveTasks(count: Int)
  case projectClosureUndoUnavailable
  case taskProjectClosed(projectID: PageID)
  case taskNotActive
  case taskNotClosed
  case taskCompletionUndoUnavailable
  case taskNotClarifiable
  case taskClarificationStale
  case taskClarificationUndoUnavailable
  case databaseUnavailable(String)

  public var errorDescription: String? {
    switch self {
    case .pageNotFound: "The page is no longer available."
    case .pagePurged: "This page was permanently removed."
    case .invalidRecord: "The local page record is invalid."
    case .calendarMaterializationDisabled:
      "Calendar Event page materialization is disabled."
    case .bookmarkCaptureHistoryConflict:
      "This capture identifier already belongs to different immutable bookmark history."
    case .bookmarkIdentityFrozen:
      "A bookmark with synced capture history cannot change its source identity."
    case .bookmarkSuppressed:
      "This bookmark was deleted and will not be recreated until it is explicitly restored."
    case .bookmarkDeletionCarrier:
      "Bookmark deletion records cannot be edited, restored, or removed."
    case .projectHasActiveTasks(let count):
      "Complete or move the project's \(count) active task\(count == 1 ? "" : "s") before closing it."
    case .projectClosureUndoUnavailable:
      "The project or one of its tasks changed after closure, so Undo was not applied."
    case .taskProjectClosed:
      "Active tasks cannot be assigned to a closed project. Reopen the project or choose another project."
    case .taskNotActive: "Only active tasks can be completed."
    case .taskNotClosed: "Only completed or canceled tasks can be reopened."
    case .taskCompletionUndoUnavailable:
      "The task or its recurring successor changed after completion, so the completion was not undone."
    case .taskNotClarifiable:
      "Only active Inbox tasks can be clarified."
    case .taskClarificationStale:
      "This Inbox task changed while it was being clarified. Review the latest copy and try again."
    case .taskClarificationUndoUnavailable:
      "The task changed after clarification, so Undo was not applied."
    case .databaseUnavailable(let message): "The local library could not be opened: \(message)"
    }
  }
}

/// A live Person entity found by its canonical email address.
///
/// This is intentionally a candidate list rather than a uniqueness assertion: callers must
/// let people resolve duplicates explicitly instead of merging records by email.
public struct PersonEmailCandidate: Codable, Hashable, Sendable, Identifiable {
  public var pageID: PageID
  public var displayName: String
  public var email: String

  public var id: PageID { pageID }

  public init(pageID: PageID, displayName: String, email: String) {
    self.pageID = pageID
    self.displayName = displayName
    self.email = PersonEmail.normalizedForComparison(email)
  }
}

/// A durable CloudKit intent created only when Person privacy crosses the local-only boundary.
/// Unlike `cloud_dirty`, this remains present while an older save/delete acknowledgement is in
/// flight, allowing the repository to compensate in the opposite direction.
public enum CloudPrivacyDesiredOperation: String, Codable, Hashable, Sendable {
  case save
  case delete
}

public struct CloudPrivacyRemoval: Hashable, Sendable {
  public var pageID: PageID
  public var generation: Int64

  public init(pageID: PageID, generation: Int64) {
    self.pageID = pageID
    self.generation = generation
  }
}

public struct CloudPrivacySave: Hashable, Sendable {
  public var pageID: PageID
  public var desiredGeneration: Int64
  public var pageDirtyGeneration: Int64

  public init(pageID: PageID, desiredGeneration: Int64, pageDirtyGeneration: Int64) {
    self.pageID = pageID
    self.desiredGeneration = desiredGeneration
    self.pageDirtyGeneration = pageDirtyGeneration
  }
}

public enum CloudPrivacyAcknowledgement: Hashable, Sendable {
  case none
  case save(PageID)
  case delete(CloudPrivacyRemoval)
}

public struct EditorCommit: Codable, Hashable, Sendable {
  public var pageID: PageID
  public var loadGeneration: Int
  public var journalID: String
  /// The durable Automerge heads from which `encodedChanges` were authored.
  public var baseHeads: AutomergeHeads
  public var encodedChanges: Data
  public var advertisedHeads: AutomergeHeads

  public init(
    pageID: PageID,
    loadGeneration: Int,
    journalID: String,
    baseHeads: AutomergeHeads,
    encodedChanges: Data,
    advertisedHeads: AutomergeHeads
  ) {
    self.pageID = pageID
    self.loadGeneration = loadGeneration
    self.journalID = journalID
    self.baseHeads = baseHeads
    self.encodedChanges = encodedChanges
    self.advertisedHeads = advertisedHeads
  }
}

public struct EditorCommitReceipt: Codable, Hashable, Sendable {
  public var pageID: PageID
  public var journalID: String
  public var heads: AutomergeHeads
  public var dirtyGeneration: Int64
  public var duplicate: Bool
}

/// Describes the durable pair created when an editor creates a tagged page and
/// inserts its reference into an existing page.
public struct TaggedPageReferenceInsertionRequest: Sendable {
  public var sourcePageID: PageID
  public var expectedSourceHeads: AutomergeHeads
  public var sourceTitle: String
  public var sourceBody: AttributedString
  public var targetPageID: PageID
  public var targetTitle: String
  public var supertagID: SupertagID
  /// Values seeded into the new target after its supertag is applied.
  /// Keys retain the schema owner so inherited fields remain unambiguous.
  public var initialProperties: [SupertagPropertyKey: [SupertagValue]]

  public init(
    sourcePageID: PageID,
    expectedSourceHeads: AutomergeHeads,
    sourceTitle: String,
    sourceBody: AttributedString,
    targetPageID: PageID,
    targetTitle: String,
    supertagID: SupertagID,
    initialProperties: [SupertagPropertyKey: [SupertagValue]] = [:]
  ) {
    self.sourcePageID = sourcePageID
    self.expectedSourceHeads = expectedSourceHeads
    self.sourceTitle = sourceTitle
    self.sourceBody = sourceBody
    self.targetPageID = targetPageID
    self.targetTitle = targetTitle
    self.supertagID = supertagID
    self.initialProperties = initialProperties
  }
}

public struct TaggedPageReferenceInsertionResult: Sendable {
  public var source: PageSnapshot
  public var target: PageSnapshot

  public init(source: PageSnapshot, target: PageSnapshot) {
    self.source = source
    self.target = target
  }
}

public enum TaggedPageReferenceInsertionError: Error, Equatable, LocalizedError {
  case sourceStale
  case sourceDeleted
  case invalidSupertag
  case targetOccupied
  case targetPurged
  case invalidTargetTitle
  case invalidInitialProperties
  case personEmailAlreadyExists
  case missingTargetReference
  case persistenceFailure(String)

  public var errorDescription: String? {
    switch self {
    case .sourceStale:
      "This page changed while the tagged page was being created. Try again."
    case .sourceDeleted:
      "This page is no longer available."
    case .invalidSupertag:
      "That supertag is no longer available."
    case .targetOccupied:
      "A page with this identifier already exists."
    case .targetPurged:
      "This page identifier was permanently removed."
    case .invalidTargetTitle:
      "The new page needs a name."
    case .invalidInitialProperties:
      "The new page contains an invalid property."
    case .personEmailAlreadyExists:
      "A Person with this email already exists. Select that Person instead of creating another."
    case .missingTargetReference:
      "The created page reference is missing from the editor content."
    case .persistenceFailure(let message):
      "The tagged page could not be saved: \(message)"
    }
  }
}

public struct PageSuggestion: Codable, Hashable, Sendable, Identifiable {
  public var id: PageID
  public var title: String
  public var kind: PageKind

  public init(id: PageID, title: String, kind: PageKind) {
    self.id = id
    self.title = title
    self.kind = kind
  }

  public var displaySubtitle: String? {
    switch kind {
    case .calendarEvent(let identity):
      return identity.occurrenceStart.formatted(date: .abbreviated, time: .shortened)
    case .calendarSeries:
      return "Series notes"
    case .calendarMaterializedEvent:
      return "Calendar event"
    case .daily, .free:
      return nil
    }
  }
}

public struct PurgeMarker: Codable, Hashable, Sendable {
  public var pageID: PageID
  public var generation: Int64
  public var purgedAt: Date
  public var cloudRecord: Data?
}

/// The durable, generation-fenced lifecycle for permanent bookmark deletion.
public enum BookmarkPermanentDeletionStage: String, Codable, Hashable, Sendable {
  case preparing
  case carrierPendingAck
  case carrierAcknowledged
  case purgingCandidates
  case stable
}

/// Privacy-minimal deletion state. URL text and user content never enter this projection.
public struct BookmarkSuppressionState: Codable, Hashable, Sendable, Identifiable {
  public var urlKeyDigest: String
  public var stage: BookmarkPermanentDeletionStage
  public var carrierPageID: PageID?
  public var requiredGeneration: Int64?
  public var acknowledgedGeneration: Int64?
  public var permanentRequested: Bool

  public var id: String { urlKeyDigest }
}

/// A sanitized history diagnostic. Raw Automerge values and URLs remain repository-internal.
public struct BookmarkCaptureHistoryIssue: Hashable, Sendable, Identifiable {
  public var reason: String
  public var pageIDs: [PageID]

  public var id: String {
    reason + ":" + pageIDs.map(\.rawValue).joined(separator: ",")
  }
}

/// Digest-only handoff emitted after app-queryable candidate data has been logically removed.
public struct BookmarkPermanentDeletionHandoff: Codable, Hashable, Sendable, Identifiable {
  public var urlKeyDigest: String
  public var completedAt: Date

  public var id: String { urlKeyDigest }
}

enum BookmarkPageWriteOrigin {
  case local
  case remote
  case system
}

public struct SavedViewCloudRecord: Sendable {
  public var id: LiveQueryID
  public var definition: LiveQueryDefinition
  public var whiteboardDocument: WhiteboardDocument
  public var isDeleted: Bool
  public var sortOrder: Int
  public var modifiedAt: Date
  public var dirtyGeneration: Int64
  public var cloudRecord: Data?
}

public struct SupertagCloudRecord: Sendable {
  public var id: SupertagID
  public var definition: SupertagDefinition
  public var isDeleted: Bool
  public var sortOrder: Int
  public var modifiedAt: Date
  public var dirtyGeneration: Int64
  public var cloudRecord: Data?
}

public struct CloudPageMergeResult: Sendable {
  public var page: PageSnapshot?
  public var needsUpload: Bool

  public init(page: PageSnapshot?, needsUpload: Bool) {
    self.page = page
    self.needsUpload = needsUpload
  }
}

public actor LibraryRepository {
  public static let applicationGroupIdentifier = "group.dev.rawkode.enchiridion"
  private static let databaseBusyTimeout: TimeInterval = 5
  private static let migrationLockTimeout: TimeInterval = 5

  public nonisolated let path: String
  let database: DatabasePool
  private var authoritativeCalendarRefreshTokens: [String: (id: UUID, eligibilityEpoch: Int64)] = [:]

  func assistantRead<T: Sendable>(
    _ access: @Sendable (Database) throws -> T
  ) throws -> T {
    try database.read(access)
  }

  public init(path: String) throws {
    self.path = path
    do {
      database = try Self.withDatabaseOpenLock(path: path) {
        var configuration = Configuration()
        configuration.busyMode = .timeout(Self.databaseBusyTimeout)
        configuration.journalMode = .wal
        configuration.prepareDatabase { db in
          try db.execute(sql: "PRAGMA foreign_keys = ON")
          try db.execute(sql: "PRAGMA synchronous = FULL")
        }
        let database = try DatabasePool(path: path, configuration: configuration)
        try database.writeWithoutTransaction { db in
          try db.execute(sql: "PRAGMA synchronous = FULL")
          try db.execute(sql: "PRAGMA foreign_keys = ON")
        }
        try Self.migrator.migrate(database)
        return database
      }
    } catch {
      throw LibraryRepositoryError.databaseUnavailable(error.localizedDescription)
    }
  }

  public func closeDatabase() throws {
    try database.close()
  }

  /// Materializes one capture receipt, its page (when no live local identity exists), and all
  /// bookmark projections atomically. The receipt is deliberately the allocation authority: a
  /// crash cannot cause a retry of the same UUID to allocate a second page.
  public func materializeBookmark(_ request: BookmarkCaptureRequest) throws -> BookmarkCaptureResult {
    guard let key = BookmarkURLKey(submittedURL: request.submittedURL) else {
      throw LibraryRepositoryError.invalidRecord
    }
    let syncedEvent: BookmarkSyncedCaptureEvent
    do {
      syncedEvent = try BookmarkSyncedCaptureEvent(
        captureID: request.captureID,
        urlKey: key,
        submittedURL: request.submittedURL,
        capturedAt: request.capturedAt,
        dayKey: request.dayKey,
        timeZoneIdentifier: request.timeZoneIdentifier
      )
    } catch {
      throw LibraryRepositoryError.invalidRecord
    }
    return try database.write { db in
      let capture = request.captureID.uuidString.lowercased()
      if try Self.isBookmarkIdentitySuppressed(db, digest: key.digest) {
        let retainedPageID = try String.fetchOne(
          db,
          sql: """
            SELECT page_id FROM bookmark_identity_candidates
            WHERE url_key_digest = ? ORDER BY page_id LIMIT 1
            """,
          arguments: [key.digest]
        ) ?? String.fetchOne(
          db,
          sql: "SELECT page_id FROM bookmark_capture_receipts WHERE canonical_url = ? ORDER BY page_id LIMIT 1",
          arguments: [key.canonicalURL]
        )
        if let retainedPageID {
          return .init(pageID: .init(rawValue: retainedPageID), urlKey: key, duplicate: true)
        }
        throw LibraryRepositoryError.bookmarkSuppressed
      }
      if let receipt = try Row.fetchOne(
        db,
        sql: "SELECT page_id,canonical_url FROM bookmark_capture_receipts WHERE capture_id = ?",
        arguments: [capture]
      ), let existing: String = receipt["page_id"] {
        let receiptCanonical: String? = receipt["canonical_url"]
        let candidateCanonical = try String.fetchOne(
          db,
          sql: "SELECT canonical_url FROM bookmark_identity_candidates WHERE page_id = ? ORDER BY url_key_digest LIMIT 1",
          arguments: [existing]
        )
        let canonical = receiptCanonical ?? candidateCanonical
        guard let canonical, let originalKey = BookmarkURLKey(submittedURL: canonical) else {
          throw LibraryRepositoryError.invalidRecord
        }
        guard originalKey == key else {
          throw LibraryRepositoryError.bookmarkCaptureHistoryConflict
        }
        if let originalEvent = try Self.localSyncedBookmarkCaptureEvent(db, captureID: capture),
          originalEvent != syncedEvent
        {
          throw LibraryRepositoryError.bookmarkCaptureHistoryConflict
        }
        let pageID = PageID(rawValue: existing)
        if let page = try Self.fetchPage(db, id: pageID) {
          let appended = try PageDocument.appendBookmarkCaptureEvent(syncedEvent, in: page.document)
          if appended.document != page.document {
            try Self.writePage(
              db,
              page: Self.updatedPage(page, with: appended, now: syncedEvent.capturedAt),
              cloudDirty: true
            )
          }
        }
        return .init(pageID: .init(rawValue: existing), urlKey: originalKey, duplicate: true)
      }
      let winner: String? = try String.fetchOne(db, sql: """
        SELECT c.page_id FROM bookmark_identity_candidates c
        JOIN pages p ON p.id = c.page_id
        WHERE c.url_key_digest = ? AND p.deleted_at IS NULL
        ORDER BY c.page_id LIMIT 1
        """, arguments: [key.digest])
      let pageID = winner.map(PageID.init(rawValue:)) ?? .free()
      let page: PageSnapshot
      let duplicate: Bool
      if let winner, let current = try Self.fetchPage(db, id: .init(rawValue: winner)) {
        let mutation = try PageDocument.appendBookmarkCaptureEvent(syncedEvent, in: current.document)
        if mutation.document == current.document {
          page = current
        } else {
          page = Self.updatedPage(current, with: mutation, now: syncedEvent.capturedAt)
          try Self.writePage(db, page: page, cloudDirty: true)
        }
        duplicate = true
      } else {
        let created = try PageDocument.create(
          id: pageID,
          kind: .free,
          title: request.submittedURL,
          createdAt: syncedEvent.capturedAt
        )
        var mutation = try PageDocument.addSupertag(
          BuiltInSupertags.bookmark,
          in: created.document
        )
        mutation = try PageDocument.setProperty(
          key: .init(supertagID: BuiltInSupertags.bookmark, fieldID: BuiltInSupertags.bookmarkSourceURLField),
          values: [.url(request.submittedURL)], in: mutation.document)
        mutation = try PageDocument.appendBookmarkCaptureEvent(syncedEvent, in: mutation.document)
        page = PageSnapshot(
          id: pageID,
          kind: .free,
          title: mutation.projection.title,
          plainText: mutation.projection.plainText,
          document: mutation.document,
          heads: mutation.heads,
          createdAt: syncedEvent.capturedAt,
          modifiedAt: syncedEvent.capturedAt,
          deletedAt: mutation.projection.deletedAt,
          isPinned: mutation.projection.isPinned,
          dirtyGeneration: 1,
          objectMetadata: mutation.projection.objectMetadata
        )
        try Self.writePage(db, page: page, cloudDirty: true)
        duplicate = false
      }
      try db.execute(sql: """
        INSERT INTO bookmark_capture_events
          (capture_id,url_key_digest,url_key_version,canonical_url,submitted_url,note,captured_at,day_key,time_zone,source,platform,vault_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, arguments: [capture, key.digest, BookmarkURLKey.version, key.canonicalURL, request.submittedURL, request.note, syncedEvent.capturedAt.timeIntervalSince1970, request.dayKey.rawValue, request.timeZoneIdentifier, request.source, request.platform, request.vaultID.rawValue])
      try db.execute(sql: "INSERT INTO bookmark_capture_receipts (capture_id,page_id,url_key_version,canonical_url) VALUES (?,?,?,?)", arguments: [capture, pageID.rawValue, BookmarkURLKey.version, key.canonicalURL])
      return .init(pageID: pageID, urlKey: key, duplicate: duplicate)
    }
  }

  public func bookmarkAliases() throws -> [BookmarkAliasSuggestion] {
    try database.read { db in
      try Row.fetchAll(db, sql: """
        SELECT c.url_key_digest,c.canonical_url,c.page_id,
               (SELECT c2.page_id FROM bookmark_identity_candidates c2 JOIN pages p2 ON p2.id=c2.page_id
                WHERE c2.url_key_digest=c.url_key_digest AND p2.deleted_at IS NULL ORDER BY c2.page_id LIMIT 1) AS winner
        FROM bookmark_identity_candidates c JOIN pages p ON p.id=c.page_id
        WHERE p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM bookmark_identity_suppressions d WHERE d.url_key_digest=c.url_key_digest)
        """).compactMap { row in
          guard let digest: String = row["url_key_digest"], let canonical: String = row["canonical_url"], let page: String = row["page_id"], let winner: String = row["winner"], page != winner,
            let key = BookmarkURLKey(submittedURL: canonical), key.digest == digest else { return nil }
          return .init(urlKey: key, winner: .init(rawValue: winner), alias: .init(rawValue: page))
        }
    }
  }

  /// Establishes a monotonic digest suppression, creates its distinct carrier, and tombstones
  /// every current candidate in one transaction. Candidate content remains available in Trash
  /// until permanent deletion is separately requested and carrier upload is acknowledged.
  public func deleteBookmarkIdentity(
    _ deletion: BookmarkIdentityDeletion,
    now: Date = Date()
  ) throws {
    try database.write { db in
      try Self.suppressBookmarkIdentity(db, deletion: deletion, now: now)
    }
  }

  public func bookmarkCaptureEvents(dayKey: DayKey? = nil, timeZoneIdentifier: String? = nil) throws -> [BookmarkCaptureEvent] {
    try database.read { db in
      var sql = "SELECT * FROM bookmark_capture_events WHERE NOT EXISTS (SELECT 1 FROM bookmark_identity_suppressions d WHERE d.url_key_digest = bookmark_capture_events.url_key_digest) AND NOT EXISTS (SELECT 1 FROM bookmark_identity_deletions d WHERE d.url_key_digest = bookmark_capture_events.url_key_digest)"
      var arguments: [DatabaseValueConvertible] = []
      if let dayKey { sql += " AND day_key = ?"; arguments.append(dayKey.rawValue) }
      if let timeZoneIdentifier { sql += " AND time_zone = ?"; arguments.append(timeZoneIdentifier) }
      sql += " ORDER BY captured_at,capture_id"
      return try Row.fetchAll(db, sql: sql, arguments: StatementArguments(arguments)).compactMap { row in
        guard let rawID: String = row["capture_id"], let id = UUID(uuidString: rawID), let submitted: String = row["submitted_url"], let canonical: String = row["canonical_url"], let key = BookmarkURLKey(submittedURL: canonical), let captured: Double = row["captured_at"], let day: String = row["day_key"], let zone: String = row["time_zone"], let source: String = row["source"], let platform: String = row["platform"], let vault: String = row["vault_id"] else { return nil }
        let dayKey = DayKey(rawValue: day)
        return .init(captureID: id, urlKey: key, submittedURL: submitted, note: row["note"], capturedAt: .init(timeIntervalSince1970: captured), dayKey: dayKey, timeZoneIdentifier: zone, source: source, platform: platform, vaultID: .init(rawValue: vault))
      }
    }
  }

  /// Returns the deterministic global union of valid privacy-minimal capture facts. Identical
  /// facts replicated by multiple candidate Pages collapse to one item; a divergent capture ID
  /// is excluded in full and reported through `bookmarkCaptureHistoryIssues()`.
  public func bookmarkSyncedCaptureEvents(
    dayKey: DayKey? = nil,
    timeZoneIdentifier: String? = nil
  ) throws -> [BookmarkSyncedCaptureEvent] {
    try database.read { db in
      let rows = try Row.fetchAll(db, sql: """
        SELECT s.capture_id,s.encoded_envelope,s.valid_identity,
               CASE WHEN d.url_key_digest IS NULL THEN 0 ELSE 1 END AS suppressed
        FROM bookmark_capture_event_sources s
        LEFT JOIN bookmark_identity_suppressions d ON d.url_key_digest=s.url_key_digest
        ORDER BY s.capture_id,s.encoded_envelope,s.page_id
        """)
      var grouped: [String: [(encoded: String, valid: Bool, suppressed: Bool)]] = [:]
      for row in rows {
        guard let captureID: String = row["capture_id"], let encoded: String = row["encoded_envelope"] else {
          continue
        }
        grouped[captureID, default: []].append((
          encoded,
          row["valid_identity"] ?? false,
          row["suppressed"] ?? false
        ))
      }
      return grouped.keys.sorted().compactMap { captureID in
        guard let sources = grouped[captureID],
          Set(sources.map(\.encoded)).count == 1,
          sources.contains(where: \.valid),
          !sources.contains(where: \.suppressed),
          let encoded = sources.first?.encoded,
          let data = encoded.data(using: .utf8),
          let event = try? JSONDecoder.enchiridion.decode(BookmarkSyncedCaptureEvent.self, from: data),
          dayKey.map({ event.dayKey == $0 }) ?? true,
          timeZoneIdentifier.map({ event.timeZoneIdentifier == $0 }) ?? true
        else { return nil }
        return event
      }.sorted {
        if $0.capturedAt != $1.capturedAt { return $0.capturedAt < $1.capturedAt }
        return $0.captureID.uuidString < $1.captureID.uuidString
      }
    }
  }

  public func bookmarkCaptureHistoryIssues() throws -> [BookmarkCaptureHistoryIssue] {
    try database.read { db in
      var issues: [BookmarkCaptureHistoryIssue] = []
      let localRows = try Row.fetchAll(db, sql: """
        SELECT kind,page_id FROM bookmark_capture_event_issues
        ORDER BY kind,page_id,issue_key
        """)
      var localGroups: [String: Set<PageID>] = [:]
      for row in localRows {
        guard let kind: String = row["kind"], let pageID: String = row["page_id"] else { continue }
        localGroups[Self.sanitizedBookmarkHistoryIssueReason(kind), default: []]
          .insert(.init(rawValue: pageID))
      }
      for reason in localGroups.keys.sorted() {
        issues.append(.init(
          reason: reason,
          pageIDs: Array(localGroups[reason] ?? []).sorted { $0.rawValue < $1.rawValue }
        ))
      }

      let sourceRows = try Row.fetchAll(db, sql: """
        SELECT capture_id,encoded_envelope,page_id
        FROM bookmark_capture_event_sources
        ORDER BY capture_id,encoded_envelope,page_id
        """)
      var captures: [String: [(String, PageID)]] = [:]
      for row in sourceRows {
        guard let captureID: String = row["capture_id"],
          let encoded: String = row["encoded_envelope"],
          let rawPageID: String = row["page_id"]
        else { continue }
        captures[captureID, default: []].append((encoded, .init(rawValue: rawPageID)))
      }
      for captureID in captures.keys.sorted() {
        guard let facts = captures[captureID], Set(facts.map(\.0)).count > 1 else { continue }
        issues.append(.init(
          reason: "Conflicting synced capture facts",
          pageIDs: Array(Set(facts.map(\.1))).sorted { $0.rawValue < $1.rawValue }
        ))
      }
      return issues.sorted {
        if $0.reason != $1.reason { return $0.reason < $1.reason }
        return $0.pageIDs.map(\.rawValue).lexicographicallyPrecedes($1.pageIDs.map(\.rawValue))
      }
    }
  }

  public func rebuildBookmarkCaptureEventProjection() throws {
    try database.write { db in
      try db.execute(sql: "DELETE FROM bookmark_capture_event_sources")
      try db.execute(sql: "DELETE FROM bookmark_capture_event_issues")
      try db.execute(sql: "DELETE FROM bookmark_frozen_identities")
      for row in try Row.fetchAll(db, sql: "SELECT * FROM pages ORDER BY id") {
        try Self.reconcileBookmarkCaptureEventProjection(db, page: Self.decodePage(row))
      }
      try db.execute(
        sql: "INSERT OR REPLACE INTO bookmark_projection_backfills (projection,completed_at) VALUES ('capture-events-v30',?)",
        arguments: [Date().timeIntervalSince1970]
      )
    }
  }

  public func bookmarkSuppressionState(for key: BookmarkURLKey) throws -> BookmarkSuppressionState? {
    try bookmarkSuppressionState(urlKeyDigest: key.digest)
  }

  public func bookmarkSuppressionState(urlKeyDigest: String) throws -> BookmarkSuppressionState? {
    try database.read { db in
      try Self.bookmarkSuppressionState(db, digest: urlKeyDigest)
    }
  }

  public func bookmarkDeletionCarrierPageIDs(urlKeyDigest: String? = nil) throws -> [PageID] {
    try database.read { db in
      var sql = "SELECT page_id FROM bookmark_deletion_carriers"
      var arguments: StatementArguments = []
      if let urlKeyDigest {
        sql += " WHERE url_key_digest = ?"
        arguments += [urlKeyDigest]
      }
      sql += " ORDER BY page_id"
      return try String.fetchAll(db, sql: sql, arguments: arguments).map(PageID.init(rawValue:))
    }
  }

  public func bookmarkPermanentDeletionHandoffs() throws -> [BookmarkPermanentDeletionHandoff] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT url_key_digest,completed_at FROM bookmark_permanent_delete_handoffs ORDER BY completed_at,url_key_digest"
      ).compactMap { row in
        guard let digest: String = row["url_key_digest"], let completed: Double = row["completed_at"] else {
          return nil
        }
        return .init(urlKeyDigest: digest, completedAt: Date(timeIntervalSince1970: completed))
      }
    }
  }

  private func bookmarkIdentity(for pageID: PageID) throws -> BookmarkURLKey? {
    try database.read { db in
      guard let canonical = try String.fetchOne(
        db,
        sql: "SELECT canonical_url FROM bookmark_identity_candidates WHERE page_id = ? ORDER BY url_key_digest LIMIT 1",
        arguments: [pageID.rawValue]
      ) else { return nil }
      return BookmarkURLKey(submittedURL: canonical)
    }
  }

  private func isBookmarkDeletionCarrier(pageID: PageID) throws -> Bool {
    try database.read { db in
      try Bool.fetchOne(
        db,
        sql: "SELECT EXISTS(SELECT 1 FROM bookmark_deletion_carriers WHERE page_id = ?)",
        arguments: [pageID.rawValue]
      ) ?? false
    }
  }

  public func resolvedBookmarkPages() throws -> [PageSnapshot] {
    try database.read { db in
      try Row.fetchAll(db, sql: """
        SELECT p.* FROM bookmark_identity_candidates c JOIN pages p ON p.id=c.page_id
        WHERE p.deleted_at IS NULL
          AND c.page_id = (SELECT c2.page_id FROM bookmark_identity_candidates c2 JOIN pages p2 ON p2.id=c2.page_id WHERE c2.url_key_digest=c.url_key_digest AND p2.deleted_at IS NULL ORDER BY c2.page_id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM bookmark_identity_suppressions d WHERE d.url_key_digest=c.url_key_digest)
          AND NOT EXISTS (SELECT 1 FROM bookmark_identity_deletions d WHERE d.url_key_digest=c.url_key_digest)
        ORDER BY p.modified_at DESC
        """).map(Self.decodePage)
    }
  }

  func pendingTaskEffectOutboxIdentities() throws -> [TaskEffectOutboxIdentity] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT page_id,effect_kind
          FROM task_effect_outbox
          ORDER BY enqueued_at,page_id,effect_kind
          """
      ).compactMap { row in
        guard let rawPageID: String = row["page_id"],
          let rawKind: String = row["effect_kind"],
          let kind = TaskEffectOutboxKind(rawValue: rawKind)
        else { return nil }
        return TaskEffectOutboxIdentity(
          pageID: PageID(rawValue: rawPageID),
          kind: kind
        )
      }
    }
  }

  func claimTaskEffectOutbox(
    _ identity: TaskEffectOutboxIdentity,
    now: Date = Date(),
    leaseDuration: TimeInterval
  ) throws -> TaskEffectOutboxClaimResult {
    try database.write { db in
      guard
        let row = try Row.fetchOne(
          db,
          sql: """
            SELECT generation,request_authorization,lease_expires_at
            FROM task_effect_outbox
            WHERE page_id = ? AND effect_kind = ?
            """,
          arguments: [identity.pageID.rawValue, identity.kind.rawValue]
        ), let generation: Int64 = row["generation"]
      else { return .noPendingEffect }

      if let leaseExpiresAt: Double = row["lease_expires_at"],
        leaseExpiresAt > now.timeIntervalSince1970
      {
        return .busy
      }

      let leaseID = UUID().uuidString.lowercased()
      try db.execute(
        sql: """
          UPDATE task_effect_outbox
          SET lease_id = ?, lease_generation = generation, lease_expires_at = ?,
              attempt_count = attempt_count + 1
          WHERE page_id = ? AND effect_kind = ?
            AND (lease_id IS NULL OR lease_expires_at <= ?)
          """,
        arguments: [
          leaseID,
          now.addingTimeInterval(leaseDuration).timeIntervalSince1970,
          identity.pageID.rawValue,
          identity.kind.rawValue,
          now.timeIntervalSince1970,
        ]
      )
      guard db.changesCount == 1 else { return .busy }

      let requestingAuthorization: Bool = row["request_authorization"] ?? false
      let page = try Self.fetchPage(db, id: identity.pageID)
      let isActiveTask = page?.deletedAt == nil && page?.taskData?.state == .active
      let effect: TaskMutationEffect
      switch identity.kind {
      case .reminder:
        if isActiveTask, let page {
          effect = .scheduleReminder(
            page,
            requestingAuthorization: requestingAuthorization
          )
        } else {
          effect = .cancelReminder(identity.pageID)
        }
      case .spotlight:
        if isActiveTask, let page {
          effect = .indexSpotlight(page)
        } else {
          effect = .removeSpotlight(identity.pageID)
        }
      }
      return .claimed(
        TaskEffectOutboxClaim(
          identity: identity,
          generation: generation,
          leaseID: leaseID,
          effect: effect
        )
      )
    }
  }

  func finishTaskEffectOutbox(
    _ claim: TaskEffectOutboxClaim,
    disposition: TaskMutationEffectDisposition
  ) throws -> TaskEffectOutboxCompletion {
    try database.write { db in
      guard
        let row = try Row.fetchOne(
          db,
          sql: """
            SELECT generation
            FROM task_effect_outbox
            WHERE page_id = ? AND effect_kind = ? AND lease_id = ?
            """,
          arguments: [
            claim.identity.pageID.rawValue,
            claim.identity.kind.rawValue,
            claim.leaseID,
          ]
        ), let currentGeneration: Int64 = row["generation"]
      else { return .completed }

      if currentGeneration == claim.generation,
        disposition.acknowledgesDurableEffect
      {
        try db.execute(
          sql: """
            DELETE FROM task_effect_outbox
            WHERE page_id = ? AND effect_kind = ? AND lease_id = ? AND generation = ?
            """,
          arguments: [
            claim.identity.pageID.rawValue,
            claim.identity.kind.rawValue,
            claim.leaseID,
            claim.generation,
          ]
        )
        return .completed
      }

      let error: String?
      switch disposition {
      case .failed(let message): error = message
      case .deferred(let reason): error = String(describing: reason)
      case .applied, .notNeeded: error = nil
      }
      try db.execute(
        sql: """
          UPDATE task_effect_outbox
          SET lease_id = NULL, lease_generation = NULL, lease_expires_at = NULL,
              last_error = ?
          WHERE page_id = ? AND effect_kind = ? AND lease_id = ?
          """,
        arguments: [
          error,
          claim.identity.pageID.rawValue,
          claim.identity.kind.rawValue,
          claim.leaseID,
        ]
      )
      return currentGeneration == claim.generation ? .completed : .superseded
    }
  }

  func renewTaskEffectOutboxLease(
    _ claim: TaskEffectOutboxClaim,
    now: Date = Date(),
    leaseDuration: TimeInterval
  ) throws -> Bool {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE task_effect_outbox
          SET lease_expires_at = ?
          WHERE page_id = ? AND effect_kind = ? AND lease_id = ?
          """,
        arguments: [
          now.addingTimeInterval(leaseDuration).timeIntervalSince1970,
          claim.identity.pageID.rawValue,
          claim.identity.kind.rawValue,
          claim.leaseID,
        ]
      )
      return db.changesCount == 1
    }
  }

  func pendingTaskEffectOutboxCount() throws -> Int {
    try database.read { db in
      try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM task_effect_outbox") ?? 0
    }
  }

  static func legacyDefaultDatabaseURLs(manager: FileManager = .default) throws -> [URL] {
    var databases: [URL] = []
    #if os(iOS)
    if let container = manager.containerURL(
      forSecurityApplicationGroupIdentifier: applicationGroupIdentifier
    ) {
      databases.append(
        container
          .appendingPathComponent("vaults", isDirectory: true)
          .appendingPathComponent("local", isDirectory: true)
          .appendingPathComponent("library.sqlite")
      )
    }
    #endif
    databases.append(try legacyLocalDatabaseURL(manager: manager))
    return databases
  }

  private static func legacyLocalDatabaseURL(manager: FileManager) throws -> URL {
    let base = try manager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = base
      .appendingPathComponent("dev.rawkode.enchiridion", isDirectory: true)
      .appendingPathComponent("vaults", isDirectory: true)
      .appendingPathComponent("local", isDirectory: true)
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
#if os(iOS)
    try manager.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: directory.path
    )
#endif
    return directory.appendingPathComponent("library.sqlite")
  }

  /// Publishes the main database file last, so its presence is a durable
  /// completion marker even if copying a WAL-backed database is interrupted.
  static func migrateSQLiteDatabaseIfNeeded(
    from sourceDatabase: URL,
    to destinationDatabase: URL,
    manager: FileManager = .default
  ) throws {
    try withMigrationLock(for: destinationDatabase) {
      guard !manager.fileExists(atPath: destinationDatabase.path) else { return }

      let destinationDirectory = destinationDatabase.deletingLastPathComponent()
      let stagingPrefix = ".library-migration-"
      for entry in try manager.contentsOfDirectory(
        at: destinationDirectory,
        includingPropertiesForKeys: nil
      ) where entry.lastPathComponent.hasPrefix(stagingPrefix) {
        try? manager.removeItem(at: entry)
      }
      for suffix in ["-wal", "-shm"] {
        let orphan = URL(fileURLWithPath: destinationDatabase.path + suffix)
        if manager.fileExists(atPath: orphan.path) {
          try manager.removeItem(at: orphan)
        }
      }

      guard manager.fileExists(atPath: sourceDatabase.path) else { return }

      let stagingDirectory =
        destinationDirectory
        .appendingPathComponent("\(stagingPrefix)\(UUID().uuidString)", isDirectory: true)
      try manager.createDirectory(at: stagingDirectory, withIntermediateDirectories: false)

      let suffixes = ["", "-wal", "-shm"]
      let stagedMain = stagingDirectory.appendingPathComponent("library.sqlite")
      var publishedURLs: [URL] = []
      defer { try? manager.removeItem(at: stagingDirectory) }

      do {
        for suffix in suffixes {
          let source = URL(fileURLWithPath: sourceDatabase.path + suffix)
          guard manager.fileExists(atPath: source.path) else { continue }
          let staged =
            suffix.isEmpty
            ? stagedMain
            : stagingDirectory.appendingPathComponent("library.sqlite\(suffix)")
          try manager.copyItem(at: source, to: staged)
        }

        for suffix in ["-wal", "-shm"] {
          let staged = stagingDirectory.appendingPathComponent("library.sqlite\(suffix)")
          guard manager.fileExists(atPath: staged.path) else { continue }
          let destination = URL(fileURLWithPath: destinationDatabase.path + suffix)
          try manager.moveItem(at: staged, to: destination)
          publishedURLs.append(destination)
        }

        try manager.moveItem(at: stagedMain, to: destinationDatabase)
      } catch {
        for publishedURL in publishedURLs {
          try? manager.removeItem(at: publishedURL)
        }
        throw error
      }
    }
  }

  private static func withMigrationLock<T>(
    for destinationDatabase: URL,
    operation: () throws -> T
  ) throws -> T {
    let lockURL = destinationDatabase.deletingLastPathComponent()
      .appendingPathComponent(".library-migration.lock")
    return try withFileLock(
      at: lockURL,
      timeout: migrationLockTimeout,
      timeoutMessage: "Timed out waiting for the shared-library migration lock.",
      operation: operation
    )
  }

  private static func withDatabaseOpenLock<T>(
    path: String,
    operation: () throws -> T
  ) throws -> T {
    let databaseURL = URL(fileURLWithPath: path)
    let lockURL = databaseURL.deletingLastPathComponent()
      .appendingPathComponent(".library-open.lock")
    return try withFileLock(
      at: lockURL,
      timeout: databaseBusyTimeout,
      timeoutMessage: "Timed out waiting to open the shared library.",
      operation: operation
    )
  }

  private static func withFileLock<T>(
    at lockURL: URL,
    timeout: TimeInterval,
    timeoutMessage: String,
    operation: () throws -> T
  ) throws -> T {
    let descriptor = open(lockURL.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    defer { close(descriptor) }

    let deadline = Date().addingTimeInterval(timeout)
    while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
      guard errno == EWOULDBLOCK || errno == EAGAIN else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      }
      guard Date() < deadline else {
        throw LibraryRepositoryError.databaseUnavailable(timeoutMessage)
      }
      usleep(50_000)
    }
    defer { _ = flock(descriptor, LOCK_UN) }
    return try operation()
  }

  public func page(id: PageID) throws -> PageSnapshot? {
    try database.read { db in
      try Self.fetchPage(db, id: id)
    }
  }

  public func pages(
    in section: LibrarySection,
    matching query: String = "",
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> [PageSnapshot] {
    try database.read { db in
      var predicates: [String] = []
      var arguments: StatementArguments = []
      switch section {
      case .today:
        let day = DayKey(date: now, calendar: calendar)
        predicates.append("kind_tag = 'daily' AND day_key = ? AND deleted_at IS NULL")
        arguments += [day.rawValue]
      case .calendar:
        predicates.append("0")
      case .allPages:
        predicates.append("deleted_at IS NULL AND COALESCE(person_visibility, 'promoted') <> 'other'")
      case .pinned:
        predicates.append("is_pinned = 1 AND deleted_at IS NULL AND COALESCE(person_visibility, 'promoted') <> 'other'")
      case .trash:
        predicates.append("deleted_at IS NOT NULL AND COALESCE(person_visibility, 'promoted') <> 'other'")
      }
      predicates.append("NOT EXISTS (SELECT 1 FROM bookmark_deletion_carriers c WHERE c.page_id=pages.id)")
      if section != .trash {
        predicates.append("NOT EXISTS (SELECT 1 FROM bookmark_identity_candidates c JOIN bookmark_identity_suppressions d ON d.url_key_digest=c.url_key_digest WHERE c.page_id=pages.id)")
      }

      let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmedQuery.isEmpty {
        predicates.append("(title LIKE ? ESCAPE '\\' OR plain_text LIKE ? ESCAPE '\\')")
        let pattern = "%\(Self.escapeLike(trimmedQuery))%"
        arguments += [pattern, pattern]
      }
      let sql = "SELECT * FROM pages WHERE \(predicates.joined(separator: " AND ")) ORDER BY modified_at DESC"
      return try Row.fetchAll(db, sql: sql, arguments: arguments).map(Self.decodePage)
    }
  }

  @discardableResult
  public func createFreePage(title: String = "Untitled", now: Date = Date()) throws -> PageSnapshot {
    try createPage(id: .free(), kind: .free, title: title, now: now)
  }

  @discardableResult
  public func dailyPage(
    for day: DayKey,
    title: String? = nil,
    now: Date = Date()
  ) throws -> PageSnapshot {
    let id = PageID.daily(day)
    if let existing = try page(id: id) { return existing }
    let displayTitle = title ?? Self.dailyTitle(day)
    return try createPage(id: id, kind: .daily(day), title: displayTitle, now: now)
  }

  @discardableResult
  public func calendarEventPages(
    for event: CalendarEventSnapshot,
    now: Date = Date()
  ) throws -> CalendarEventPages {
    try database.write { db in
      var resolvedEvent = event
      if let series = event.identity.series {
        resolvedEvent.identity.series = try Self.canonicalSeries(db, series: series)
      }

      var createdPageIDs: [PageID] = []
      var seriesPage: PageSnapshot?
      if let series = resolvedEvent.identity.series {
        let result = try Self.ensureSeriesPage(db, series: series, title: event.title, now: now)
        seriesPage = result.page
        if result.created { createdPageIDs.append(result.page.id) }
      }

      let occurrenceKey = resolvedEvent.identity.canonicalOccurrenceKey
      let mappedID = try Self.mappedPageID(
        db,
        eventKeys: [resolvedEvent.identity.stableKey, occurrenceKey]
      )
      let occurrenceID = mappedID ?? PageID.calendarOccurrence(resolvedEvent.identity)
      let existed = try Self.fetchPage(db, id: occurrenceID) != nil
      let occurrence = try Self.createPage(
        db,
        id: occurrenceID,
        kind: .calendarEvent(resolvedEvent.identity),
        title: event.title,
        now: now
      )
      if !existed { createdPageIDs.append(occurrence.id) }
      try Self.mapOccurrencePage(
        db,
        pageID: occurrence.id,
        sourceEventKey: resolvedEvent.identity.stableKey,
        occurrenceKey: occurrenceKey,
        seriesKey: resolvedEvent.identity.series?.canonicalKey
      )
      return CalendarEventPages(
        occurrence: occurrence,
        series: seriesPage,
        createdPageIDs: createdPageIDs
      )
    }
  }

  @discardableResult
  public func calendarEventPage(
    for event: CalendarEventSnapshot,
    now: Date = Date()
  ) throws -> PageSnapshot {
    try calendarEventPages(for: event, now: now).occurrence
  }

  public func calendarSeriesPage(
    for event: CalendarEventSnapshot,
    now: Date = Date()
  ) throws -> PageSnapshot? {
    guard let series = event.identity.series else { return nil }
    return try database.write { db in
      let resolved = try Self.canonicalSeries(db, series: series)
      return try Self.ensureSeriesPage(db, series: resolved, title: event.title, now: now).page
    }
  }

  public func persistEditorCommit(_ commit: EditorCommit, now: Date = Date()) throws -> EditorCommitReceipt {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: commit.pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      if let generation: Int64 = try Int64.fetchOne(
        db,
        sql: "SELECT dirty_generation FROM editor_receipts WHERE journal_id = ? AND page_id = ?",
        arguments: [commit.journalID, commit.pageID.rawValue]
      ) {
        return EditorCommitReceipt(
          pageID: commit.pageID,
          journalID: commit.journalID,
          heads: current.heads,
          dirtyGeneration: generation,
          duplicate: true
        )
      }

      guard !commit.baseHeads.values.isEmpty,
        !commit.advertisedHeads.values.isEmpty,
        let baseHashes = Self.changeHashes(for: commit.baseHeads)
      else {
        throw PageDocumentError.invalidHeads
      }

      // Validate the claimed delta against its exact historical base before
      // applying the same changes to the current document for CRDT merging.
      let currentDocument = try Document(current.document)
      let baseDocument: Document
      do {
        baseDocument = try currentDocument.forkAt(heads: baseHashes)
      } catch {
        throw PageDocumentError.invalidHeads
      }
      _ = try PageDocument.applyChanges(
        to: baseDocument.save(),
        encodedChanges: commit.encodedChanges,
        advertisedHeads: commit.advertisedHeads
      )
      let applied = try PageDocument.applyChanges(
        to: current.document,
        encodedChanges: commit.encodedChanges,
        advertisedHeads: .empty
      )
      let generation = current.dirtyGeneration + 1
      let updated = PageSnapshot(
        id: current.id,
        kind: current.kind,
        title: applied.projection.title,
        plainText: applied.projection.plainText,
        document: applied.document,
        heads: applied.heads,
        createdAt: current.createdAt,
        modifiedAt: now,
        deletedAt: applied.projection.deletedAt,
        isPinned: applied.projection.isPinned,
        dirtyGeneration: generation,
        objectMetadata: applied.projection.objectMetadata
      )
      try Self.writePage(db, page: updated, cloudDirty: true)
      try Self.replaceReferences(db, pageID: updated.id, references: applied.projection.references)
      try db.execute(
        sql: "INSERT INTO editor_receipts (journal_id,page_id,dirty_generation,committed_at) VALUES (?,?,?,?)",
        arguments: [commit.journalID, commit.pageID.rawValue, generation, now.timeIntervalSince1970]
      )
      return EditorCommitReceipt(
        pageID: commit.pageID,
        journalID: commit.journalID,
        heads: applied.heads,
        dirtyGeneration: generation,
        duplicate: false
      )
    }
  }

  private static func changeHashes(for heads: AutomergeHeads) -> Set<ChangeHash>? {
    var data = Data()
    for value in heads.values {
      guard value.count == 64 else { return nil }
      var index = value.startIndex
      for _ in 0..<32 {
        let next = value.index(index, offsetBy: 2)
        guard let byte = UInt8(value[index..<next], radix: 16) else { return nil }
        data.append(byte)
        index = next
      }
    }
    return data.heads()
  }

  public func persistRichTextEditor(
    pageID: PageID,
    title: String,
    body: AttributedString,
    now: Date = Date()
  ) throws -> PageSnapshot {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      let result = try PageDocument.replaceRichText(
        title: title,
        body: body,
        in: current.document
      )
      let updated = Self.updatedPage(current, with: result, now: now)
      try Self.writePage(db, page: updated, cloudDirty: true)
      try Self.replaceReferences(db, pageID: updated.id, references: result.projection.references)
      return updated
    }
  }

  /// Renames a page without rewriting its body, semantic marks, or references.
  @discardableResult
  public func renamePage(
    pageID: PageID,
    title: String,
    now: Date = Date()
  ) throws -> PageSnapshot {
    let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTitle.isEmpty else { throw LibraryRepositoryError.invalidRecord }
    return try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      let result = try PageDocument.replaceTitle(with: normalizedTitle, in: current.document)
      let updated = Self.updatedPage(current, with: result, now: now)
      try Self.writePage(db, page: updated, cloudDirty: true)
      try Self.replaceReferences(db, pageID: updated.id, references: result.projection.references)
      return updated
    }
  }

  public func togglePinned(pageID: PageID, now: Date = Date()) throws {
    try mutateDocument(pageID: pageID, now: now) { current in
      try PageDocument.setPinned(!current.isPinned, in: current.document)
    }
  }

  public func moveToTrash(pageID: PageID, now: Date = Date()) throws {
    if let bookmark = try bookmarkIdentity(for: pageID) {
      try deleteBookmarkIdentity(.init(deletionID: UUID(), urlKey: bookmark), now: now)
      return
    }
    if try isBookmarkDeletionCarrier(pageID: pageID) {
      throw LibraryRepositoryError.bookmarkDeletionCarrier
    }
    _ = try setDeleted(now, pageID: pageID, now: now, requiringTask: false)
  }

  public func restore(pageID: PageID, now: Date = Date()) throws {
    if try isBookmarkDeletionCarrier(pageID: pageID) {
      throw LibraryRepositoryError.bookmarkDeletionCarrier
    }
    if let bookmark = try bookmarkIdentity(for: pageID),
      try bookmarkSuppressionState(for: bookmark) != nil
    {
      throw LibraryRepositoryError.bookmarkSuppressed
    }
    _ = try setDeleted(nil, pageID: pageID, now: now, requiringTask: false)
  }

  func moveTaskToTrash(pageID: PageID, now: Date = Date()) throws -> PageSnapshot {
    try setDeleted(now, pageID: pageID, now: now, requiringTask: true)
  }

  func restoreTask(pageID: PageID, now: Date = Date()) throws -> PageSnapshot {
    try setDeleted(nil, pageID: pageID, now: now, requiringTask: true)
  }

  public func purge(pageID: PageID, now: Date = Date()) throws {
    if try isBookmarkDeletionCarrier(pageID: pageID) {
      throw LibraryRepositoryError.bookmarkDeletionCarrier
    }
    if let bookmark = try bookmarkIdentity(for: pageID),
      try bookmarkSuppressionState(for: bookmark) != nil
    {
      try database.write { db in
        try Self.requestPermanentBookmarkDeletion(db, digest: bookmark.digest, now: now)
      }
      return
    }
    try purgePage(pageID: pageID, now: now, requiringTask: false)
  }

  func purgeTask(pageID: PageID, now: Date = Date()) throws {
    try purgePage(pageID: pageID, now: now, requiringTask: true)
  }

  private func setDeleted(
    _ deletedAt: Date?,
    pageID: PageID,
    now: Date,
    requiringTask: Bool
  ) throws -> PageSnapshot {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      if requiringTask, !current.hasSupertag(BuiltInSupertags.task) {
        throw LibraryRepositoryError.invalidRecord
      }
      let result = try PageDocument.setDeleted(deletedAt, in: current.document)
      let updated = Self.updatedPage(current, with: result, now: now)
      try Self.writePage(db, page: updated, cloudDirty: true)
      try Self.replaceReferences(
        db,
        pageID: pageID,
        references: result.projection.references
      )
      if current.hasSupertag(BuiltInSupertags.task) {
        try Self.enqueueTaskEffectOutbox(
          db,
          pageID: pageID,
          generation: updated.dirtyGeneration,
          requestingAuthorization: false,
          now: now
        )
      }
      return updated
    }
  }

  private func purgePage(
    pageID: PageID,
    now: Date,
    requiringTask: Bool
  ) throws {
    try database.write { db in
      guard let page = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      if requiringTask, !page.hasSupertag(BuiltInSupertags.task) {
        throw LibraryRepositoryError.invalidRecord
      }
      guard page.deletedAt != nil else { return }
      let purgeGeneration = page.dirtyGeneration + 1
      try db.execute(
        sql: """
          INSERT OR REPLACE INTO purge_markers
            (page_id,generation,purged_at,cloud_dirty)
          VALUES (?,?,?,1)
          """,
        arguments: [pageID.rawValue, purgeGeneration, now.timeIntervalSince1970]
      )
      if page.hasSupertag(BuiltInSupertags.task) {
        try Self.enqueueTaskEffectOutbox(
          db,
          pageID: pageID,
          generation: purgeGeneration,
          requestingAuthorization: false,
          now: now
        )
      }
      try db.execute(sql: "DELETE FROM pages WHERE id = ?", arguments: [pageID.rawValue])
    }
  }

  public func suggestions(matching query: String, limit: Int = 8) throws -> [PageSuggestion] {
    try database.read { db in
      let pattern = "%\(Self.escapeLike(query.trimmingCharacters(in: .whitespacesAndNewlines)))%"
      return try Row.fetchAll(
        db,
        sql: "SELECT id,title,kind_json FROM pages WHERE deleted_at IS NULL AND COALESCE(person_visibility, 'promoted') <> 'other' AND NOT EXISTS (SELECT 1 FROM bookmark_deletion_carriers c WHERE c.page_id=pages.id) AND NOT EXISTS (SELECT 1 FROM bookmark_identity_candidates c JOIN bookmark_identity_suppressions d ON d.url_key_digest=c.url_key_digest WHERE c.page_id=pages.id) AND title LIKE ? ESCAPE '\\' ORDER BY modified_at DESC LIMIT ?",
        arguments: [pattern, limit]
      ).compactMap { row in
        guard let id: String = row["id"], let title: String = row["title"],
          let kindData: Data = row["kind_json"],
          let kind = try? JSONDecoder.enchiridion.decode(PageKind.self, from: kindData)
        else { return nil }
        return PageSuggestion(id: PageID(rawValue: id), title: title, kind: kind)
      }
    }
  }

  public func backlinks(
    to pageID: PageID,
    includeOthers: Bool = false
  ) throws -> [PageSnapshot] {
    try database.read { db in
      let peoplePredicate = includeOthers
        ? ""
        : " AND COALESCE(p.person_visibility, 'promoted') <> 'other'"
      return try Row.fetchAll(
        db,
        sql: "SELECT p.* FROM pages p JOIN page_references r ON r.source_page_id = p.id WHERE r.target_page_id = ? AND p.deleted_at IS NULL\(peoplePredicate) ORDER BY p.modified_at DESC",
        arguments: [pageID.rawValue]
      ).map(Self.decodePage)
    }
  }

  public func supertags() throws -> [SupertagDefinition] {
    try database.read { db in
      try Row.fetchAll(db, sql: "SELECT definition_json FROM supertag_schemas WHERE deleted = 0 ORDER BY sort_order,name")
        .compactMap { row in
          guard let data: Data = row["definition_json"] else { return nil }
          return try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data)
        }
    }
  }

  public func pages(
    with supertagID: SupertagID,
    includeOthers: Bool = false
  ) throws -> [PageSnapshot] {
    try database.read { db in
      let peoplePredicate = includeOthers
        ? ""
        : " AND COALESCE(p.person_visibility, 'promoted') <> 'other'"
      return try Row.fetchAll(
        db,
        sql: """
          SELECT p.* FROM pages p
          JOIN page_supertags s ON s.page_id = p.id
          WHERE s.supertag_id = ? AND p.deleted_at IS NULL\(peoplePredicate)
          ORDER BY p.title COLLATE NOCASE, p.modified_at DESC
          """,
        arguments: [supertagID.rawValue]
      ).map(Self.decodePage)
    }
  }

  public func tasks(in scope: TaskLifecycleScope) throws -> [PageSnapshot] {
    try pages(with: BuiltInSupertags.task).filter { page in
      page.taskData.map { scope.contains($0.state) } == true
    }
  }

  /// Captures one stable Inbox task and its local association catalog before optional model work.
  /// This is read-only; callers decide whether and when to invoke an interpreter.
  public func taskClarificationSeed(pageID: PageID) throws -> TaskClarificationSeed {
    try database.read { db in
      guard let task = try Self.fetchPage(db, id: pageID),
        task.deletedAt == nil,
        let data = task.taskData,
        data.state == .active,
        data.placement == .inbox,
        let draft = TaskClarificationDraft(task: task)
      else { throw LibraryRepositoryError.taskNotClarifiable }

      func taggedPages(_ supertagID: SupertagID) throws -> [PageSnapshot] {
        try Row.fetchAll(
          db,
          sql: """
            SELECT p.* FROM pages p
            JOIN page_supertags s ON s.page_id = p.id
            WHERE s.supertag_id = ? AND p.deleted_at IS NULL
            ORDER BY p.title COLLATE NOCASE, p.id
            """,
          arguments: [supertagID.rawValue]
        ).map(Self.decodePage)
      }

      let projects = try taggedPages(BuiltInSupertags.project).compactMap {
        page -> TaskClarificationNamedReference? in
        guard page.projectData?.status.isOpen == true else { return nil }
        return TaskClarificationNamedReference(id: page.id, title: page.title)
      }
      let areas = try taggedPages(BuiltInSupertags.area).map {
        TaskClarificationNamedReference(id: $0.id, title: $0.title)
      }
      let parentTasks = try taggedPages(BuiltInSupertags.task).compactMap {
        page -> TaskClarificationNamedReference? in
        guard page.id != task.id, page.taskData?.state == .active else { return nil }
        return TaskClarificationNamedReference(id: page.id, title: page.title)
      }
      let people = try taggedPages(BuiltInSupertags.person).compactMap {
        page -> TaskClarificationNamedReference? in
        guard page.effectivePersonVisibility == .promoted else { return nil }
        return TaskClarificationNamedReference(id: page.id, title: page.title)
      }

      return TaskClarificationSeed(
        taskID: task.id,
        expectedVersion: TaskPageVersion(task),
        input: task.title,
        literalDraft: draft,
        references: TaskClarificationReferenceCatalog(
          projects: projects,
          areas: areas,
          parentTasks: parentTasks,
          people: people
        )
      )
    }
  }

  public func taggedSuggestions(
    matching query: String,
    supertagID: SupertagID,
    limit: Int = 8,
    includeOthers: Bool = false
  ) throws -> [PageSuggestion] {
    try database.read { db in
      let pattern = "%\(Self.escapeLike(query.trimmingCharacters(in: .whitespacesAndNewlines)))%"
      let peoplePredicate = includeOthers
        ? ""
        : " AND COALESCE(p.person_visibility, 'promoted') <> 'other'"
      return try Row.fetchAll(
        db,
        sql: """
          SELECT p.id,p.title,p.kind_json FROM pages p
          JOIN page_supertags s ON s.page_id = p.id
          WHERE s.supertag_id = ? AND p.deleted_at IS NULL\(peoplePredicate) AND p.title LIKE ? ESCAPE '\\'
          ORDER BY p.modified_at DESC LIMIT ?
          """,
        arguments: [supertagID.rawValue, pattern, limit]
      ).compactMap(Self.decodeSuggestion)
    }
  }

  public func otherPeople(matching query: String = "") throws -> [PageSnapshot] {
    try database.read { db in
      var sql = """
        SELECT p.* FROM pages p
        JOIN page_supertags s ON s.page_id = p.id AND s.supertag_id = 'person'
        WHERE p.deleted_at IS NULL AND p.person_visibility = 'other'
        """
      var arguments = StatementArguments()
      let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
      if !value.isEmpty {
        sql += " AND p.title LIKE ? ESCAPE '\\'"
        arguments += ["%\(Self.escapeLike(value))%"]
      }
      sql += " ORDER BY p.title COLLATE NOCASE, p.modified_at DESC"
      return try Row.fetchAll(db, sql: sql, arguments: arguments).map(Self.decodePage)
    }
  }

  @discardableResult
  public func promotePerson(pageID: PageID, now: Date = Date()) throws -> PageSnapshot {
    try setPersonVisibility(.promoted, pageID: pageID, now: now)
  }

  @discardableResult
  public func movePersonToOther(pageID: PageID, now: Date = Date()) throws -> PageSnapshot {
    try setPersonVisibility(.other, pageID: pageID, now: now)
  }

  public func calendarEventOmissionPrefixes() throws -> [String] {
    try database.read { db in
      guard let data = try Data.fetchOne(
        db,
        sql: "SELECT value FROM settings WHERE key = 'calendar.omission-prefixes'"
      ), let decoded = try? JSONDecoder.enchiridion.decode([String].self, from: data)
      else { return CalendarEventOmissionRules.defaultPrefixes }
      return CalendarEventOmissionRules.normalizedPrefixes(decoded)
    }
  }

  public func setCalendarEventOmissionPrefixes(_ prefixes: [String]) throws {
    let normalized = CalendarEventOmissionRules.normalizedPrefixes(prefixes)
    try database.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO settings (key,value) VALUES ('calendar.omission-prefixes',?)",
        arguments: [try JSONEncoder.enchiridion.encode(normalized)]
      )
      // A response was classified under the previous omission policy. It is no
      // longer safe to resume it after this durable policy change.
      try Self.invalidateCalendarProjectionGenerations(db, provider: nil, now: Date())
      for row in try Row.fetchAll(
        db,
        sql: "SELECT event_key,event_json FROM calendar_events WHERE active = 1"
      ) {
        guard let eventKey: String = row["event_key"], let data: Data = row["event_json"],
          let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data),
          CalendarEventOmissionRules.shouldOmit(title: event.title, prefixes: normalized)
        else { continue }
        try db.execute(
          sql: "UPDATE calendar_events SET active = 0 WHERE event_key = ?",
          arguments: [eventKey]
        )
        try db.execute(
          sql: "DELETE FROM calendar_event_attendees WHERE event_key = ?",
          arguments: [eventKey]
        )
      }
      try db.execute(
        sql: """
          DELETE FROM calendar_events
          WHERE active = 0 AND event_key NOT IN (SELECT event_key FROM event_page_map)
          """
      )
      try Self.pruneOrphanedCalendarPeople(db)
    }
    // A fetch that started under the former policy cannot install afterwards.
    authoritativeCalendarRefreshTokens.removeAll()
  }

  public func calendarEventMaterializationEnabled() throws -> Bool {
    try database.read { db in
      guard let data = try Data.fetchOne(
        db, sql: "SELECT value FROM settings WHERE key = ?", arguments: [CalendarEventMaterialization.settingKey]
      ) else { return false }
      return (try? JSONDecoder.enchiridion.decode(Bool.self, from: data)) ?? false
    }
  }

  /// This is intentionally local-only. Turning it off never deletes a synced Event
  /// page; it simply stops provider refreshes from changing it.
  public func setCalendarEventMaterializationEnabled(_ enabled: Bool) throws {
    try database.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)",
        arguments: [CalendarEventMaterialization.settingKey, try JSONEncoder.enchiridion.encode(enabled)]
      )
      guard !enabled else { return }
      // Local projection work is disposable. Never delete the normal Event
      // pages here: users may have edited them and they are cloud documents.
      try Self.invalidateCalendarProjectionGenerations(db, provider: nil, now: Date())
    }
    if !enabled { authoritativeCalendarRefreshTokens.removeAll() }
  }

  /// Call when provider authorization is revoked or the provider is removed.
  /// This clears only local projection data and resumable work, never Event
  /// pages or their CloudKit state.
  public func invalidateCalendarProjectionAccess(provider: String, now: Date = Date()) throws {
    try database.write { db in
      try Self.invalidateCalendarProjectionGenerations(db, provider: provider, now: now)
      try db.execute(sql: "INSERT INTO calendar_projection_access (provider,is_eligible,updated_at) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET is_eligible = excluded.is_eligible, updated_at = excluded.updated_at", arguments: [provider, false, now.timeIntervalSince1970])
    }
    authoritativeCalendarRefreshTokens[provider] = nil
  }

  /// Records current provider authorization for local-only legacy migration.
  /// Callers must pass only providers that can be read right now.
  public func setCalendarProjectionProviderEligible(_ provider: String, now: Date = Date()) throws {
    try database.write { db in
      try db.execute(sql: "INSERT INTO calendar_projection_access (provider,is_eligible,updated_at) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET is_eligible = excluded.is_eligible, updated_at = excluded.updated_at", arguments: [provider, true, now.timeIntervalSince1970])
    }
  }

  /// Makes a crashed in-progress generation resumable. It deliberately does
  /// not scan old `calendar_events`; only exact v31 item ledgers may resume.
  public func recoverCalendarProjectionGenerations(now: Date = Date()) throws {
    try database.write { db in
      try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'staged', updated_at = ? WHERE status = 'materializing'", arguments: [now.timeIntervalSince1970])
    }
  }

  public func calendarProjectionGeneration(provider: String) throws -> CalendarProjectionGeneration? {
    try database.read { db in try Self.calendarProjectionGeneration(db, provider: provider) }
  }

  /// Fetches only the changed page snapshots needed to publish a completed
  /// batch. This avoids a full LibraryStore reload while the ledger drains.
  public func pageSnapshots(ids: [PageID]) throws -> [PageSnapshot] {
    guard !ids.isEmpty else { return [] }
    return try database.read { db in
      try ids.compactMap { try Self.fetchPage(db, id: $0) }
    }
  }

  public func calendarEventMaterializationBackfillState(
    provider: String
  ) throws -> CalendarEventMaterializationBackfillState? {
    try database.read { db in
      guard let data = try Data.fetchOne(
        db, sql: "SELECT state_json FROM calendar_materialization_backfills WHERE provider = ?", arguments: [provider]
      ) else { return nil }
      return try? JSONDecoder.enchiridion.decode(CalendarEventMaterializationBackfillState.self, from: data)
    }
  }

  public func markCalendarEventMaterializationBackfillNeeded(
    provider: String, now: Date = Date()
  ) throws {
    try writeCalendarMaterializationBackfillState(.init(provider: provider, status: .needed, updatedAt: now))
  }

  public func markCalendarEventMaterializationBackfillFailed(
    provider: String, error: String, now: Date = Date()
  ) throws {
    try writeCalendarMaterializationBackfillState(.init(provider: provider, status: .needed, outcome: error, updatedAt: now))
  }

  public func markCalendarEventMaterializationBackfillCompleted(
    provider: String, receipt: CalendarEventMaterializationReceipt, now: Date = Date()
  ) throws {
    try writeCalendarMaterializationBackfillState(
      .init(provider: provider, status: .completed,
            outcome: "Materialized \(receipt.changedPageIDs.count); skipped \(receipt.skippedCount)", updatedAt: now)
    )
  }

  /// The durable running marker is deliberately written before exposing the
  /// in-memory capability, so a failed write can never authorize an apply.
  public func beginAuthoritativeCalendarRefresh(
    provider: String, now: Date = Date()
  ) throws -> AuthoritativeCalendarRefreshToken {
    let token = UUID()
    let start = try database.write { db -> (Int64, Bool) in
      let setting = try Self.calendarMaterializationSetting(db)
      guard setting != false else {
        throw LibraryRepositoryError.calendarMaterializationDisabled
      }
      let epoch = try Self.nextCalendarProjectionEligibilityEpoch(db, provider: provider)
      // A later fetch wins durably, even across a process death. Its apply is
      // the only operation permitted to replace the current local projection.
      let superseded = try String.fetchAll(db, sql: "SELECT id FROM calendar_projection_generations WHERE provider = ? AND status IN ('staged','materializing')", arguments: [provider])
      try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'superseded', updated_at = ? WHERE provider = ? AND status IN ('staged','materializing')", arguments: [now.timeIntervalSince1970, provider])
      for id in superseded { try db.execute(sql: "DELETE FROM calendar_projection_generation_items WHERE generation_id = ?", arguments: [id]) }
      let state = CalendarEventMaterializationBackfillState(
        provider: provider, status: .running, updatedAt: now
      )
      try db.execute(
        sql: "INSERT OR REPLACE INTO calendar_materialization_backfills (provider,state_json) VALUES (?,?)",
        arguments: [provider, try JSONEncoder.enchiridion.encode(state)]
      )
      return (epoch, setting == nil)
    }
    let (epoch, legacyCompatibility) = start
    authoritativeCalendarRefreshTokens[provider] = (token, epoch)
    return .init(provider: provider, id: token, eligibilityEpoch: epoch, legacyCompatibility: legacyCompatibility)
  }

  /// Atomically replaces one provider projection, updates its derived local
  /// records, and materializes normal Event pages. A stale or failed fetch has
  /// no token and therefore cannot change the authoritative projection.
  public func applyAuthoritativeCalendarProjection(
    _ projection: AuthoritativeCalendarProjection,
    token: AuthoritativeCalendarRefreshToken,
    now: Date = Date()
  ) throws -> CalendarEventMaterializationReceipt {
    guard projection.provider == token.provider,
      authoritativeCalendarRefreshTokens[projection.provider]?.id == token.id,
      authoritativeCalendarRefreshTokens[projection.provider]?.eligibilityEpoch == token.eligibilityEpoch
    else { throw LibraryRepositoryError.invalidRecord }
    defer { authoritativeCalendarRefreshTokens[projection.provider] = nil }
    return try database.write { db in
      // This fence must be first: resolving a series can create a local alias,
      // and stale/disabled applies are required to write absolutely nothing.
      let epoch = try Self.currentCalendarProjectionEligibilityEpoch(db, provider: projection.provider)
      guard epoch == token.eligibilityEpoch,
        (try Self.calendarMaterializationEnabled(db) || token.legacyCompatibility)
      else { return .init() }
      let prefixes = try Self.calendarEventOmissionPrefixes(db)
      var partition = try Self.partitionCalendarProjection(projection, prefixes: prefixes)
      // Direct callers from pre-opt-in repositories relied on strict rejection
      // semantics. Explicit enabled v31 callers receive the new mixed/all-
      // invalid partition behavior instead.
      if token.legacyCompatibility, partition.rejectedCount > 0 {
        throw LibraryRepositoryError.invalidRecord
      }
      // Series resolution is part of the immutable generation payload. Batches
      // must materialize the very same identity committed to calendar_events.
      for index in partition.accepted.indices {
        if let series = partition.accepted[index].identity.series {
          partition.accepted[index].identity.series = try Self.resolveSeries(
            db, event: partition.accepted[index], series: series
          )
        }
      }
      let generation = CalendarProjectionGeneration(
        provider: projection.provider, id: token.id, eligibilityEpoch: epoch,
        snapshotVersion: 1, snapshotDigest: partition.snapshotDigest,
        omissionPrefixDigest: partition.omissionPrefixDigest, status: .staged,
        acceptedCount: partition.accepted.count, rejectedCount: partition.rejectedCount,
        retentionEligible: partition.rejectedCount == 0, refreshAt: now,
        nextOrdinal: 0, updatedAt: now
      )
      // Header, immutable items, provider projection and generation membership
      // commit together. A crash produces either the previous generation or an
      // exact resumable one, never a half-replaced provider projection.
      try Self.insertCalendarProjectionGeneration(db, generation: generation, partition: partition, interval: projection.interval)
      // An entirely malformed non-empty response must not erase the last good
      // local projection. It is recorded as a terminal diagnostic only.
      if projection.events.isEmpty == false, partition.accepted.isEmpty {
        try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'completed' WHERE id = ?", arguments: [token.id.uuidString])
        let state = CalendarEventMaterializationBackfillState(provider: projection.provider, status: .completed, outcome: "Rejected \(partition.rejectedCount)", updatedAt: now)
        try db.execute(sql: "INSERT OR REPLACE INTO calendar_materialization_backfills (provider,state_json) VALUES (?,?)", arguments: [projection.provider, try JSONEncoder.enchiridion.encode(state)])
        return .init(skippedCount: partition.rejectedCount)
      }
      try db.execute(sql: "UPDATE calendar_events SET active = 0 WHERE provider = ?", arguments: [projection.provider])
      for event in partition.accepted {
        try db.execute(sql: """
          INSERT INTO calendar_events (event_key,provider,event_json,start_at,end_at,active,refreshed_at,series_source_key,series_canonical_key)
          VALUES (?,?,?,?,?,1,?,?,?) ON CONFLICT(event_key) DO UPDATE SET event_json=excluded.event_json,start_at=excluded.start_at,end_at=excluded.end_at,active=1,refreshed_at=excluded.refreshed_at,series_source_key=excluded.series_source_key,series_canonical_key=excluded.series_canonical_key
          """, arguments: [Self.storageKey(event.identity.stableKey), projection.provider, try JSONEncoder.enchiridion.encode(event), event.startDate.timeIntervalSince1970, event.endDate.timeIntervalSince1970, now.timeIntervalSince1970, event.identity.series.map { Self.storageKey($0.sourceKey) }, event.identity.series.map { Self.storageKey($0.canonicalKey) }])
      }
      try db.execute(sql: "DELETE FROM calendar_event_attendees WHERE event_key IN (SELECT event_key FROM calendar_events WHERE provider = ? AND active = 0)", arguments: [projection.provider])
      try db.execute(sql: "DELETE FROM calendar_events WHERE provider = ? AND active = 0 AND event_key NOT IN (SELECT event_key FROM event_page_map)", arguments: [projection.provider])
      try Self.pruneOrphanedCalendarPeople(db)

      return try Self.resumeCalendarProjectionGeneration(
        db, provider: projection.provider, expectedID: token.id,
        expectedEpoch: epoch, batchLimit: 32, timeLimit: 0.045, now: now,
        allowLegacyDisabled: token.legacyCompatibility
      )
    }
  }

  /// Advances at most one bounded materialization batch. It is safe to call on
  /// every UI turn: stale, disabled, invalidated and already-complete work is a
  /// no-op. A caller should reschedule while `isTerminal` is false.
  public func resumeAuthoritativeCalendarProjection(
    provider: String, batchLimit: Int = 32, timeLimit: TimeInterval = 0.045,
    now: Date = Date()
  ) throws -> CalendarEventMaterializationReceipt {
    try database.write { db in
      guard let generation = try Self.calendarProjectionGeneration(db, provider: provider),
        generation.status == .staged || generation.status == .materializing
      else { return .init() }
      return try Self.resumeCalendarProjectionGeneration(
        db, provider: provider, expectedID: generation.id,
        expectedEpoch: generation.eligibilityEpoch, batchLimit: batchLimit,
        timeLimit: timeLimit, now: now, allowLegacyDisabled: false
      )
    }
  }

  private func writeCalendarMaterializationBackfillState(
    _ state: CalendarEventMaterializationBackfillState
  ) throws {
    try database.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO calendar_materialization_backfills (provider,state_json) VALUES (?,?)",
        arguments: [state.provider, try JSONEncoder.enchiridion.encode(state)]
      )
    }
  }

  private struct CalendarProjectionPartition {
    var accepted: [CalendarEventSnapshot]
    var rejectedCount: Int
    var rejectionCategories: [String: Int]
    var snapshotDigest: String
    var omissionPrefixDigest: String
  }

  private static func partitionCalendarProjection(
    _ projection: AuthoritativeCalendarProjection, prefixes: [String]
  ) throws -> CalendarProjectionPartition {
    let encoder = JSONEncoder.enchiridion
    let prefixData = try encoder.encode(prefixes.sorted())
    let prefixDigest = SHA256.hash(data: prefixData).map { String(format: "%02x", $0) }.joined()
    // The digest commits to the exact ordered provider response, including
    // rejected entries. Immutable items are sorted by their canonical bytes so
    // duplicate/retry behavior is deterministic across launches.
    let encoded = try projection.events.map { try encoder.encode($0) }
    var digestData = Data("v1\u{0}\(projection.provider)\u{0}\(projection.interval.start.timeIntervalSince1970)\u{0}\(projection.interval.end.timeIntervalSince1970)\u{0}".utf8)
    for data in encoded { digestData.append(data); digestData.append(0) }
    let snapshotDigest = SHA256.hash(data: digestData).map { String(format: "%02x", $0) }.joined()
    let ordered = zip(projection.events, encoded).sorted { lhs, rhs in
      lhs.1.lexicographicallyPrecedes(rhs.1)
    }
    var seen = Set<String>()
    var accepted: [CalendarEventSnapshot] = []
    var rejectedCount = 0
    var rejectionCategories: [String: Int] = [:]
    func reject(_ category: String) {
      rejectedCount += 1
      rejectionCategories[category, default: 0] += 1
    }
    for (event, _) in ordered {
      if event.identity.provider != projection.provider { reject("provider"); continue }
      // Omitted items are deliberate policy exclusions, not provider-invalid
      // records and must not poison retention eligibility.
      if CalendarEventOmissionRules.shouldOmit(title: event.title, prefixes: prefixes) { continue }
      guard CalendarEventMaterialization.identity(for: event) != nil else { reject("identity"); continue }
      let key = storageKey(event.identity.stableKey)
      guard seen.insert(key).inserted else { reject("duplicate"); continue }
      accepted.append(event)
    }
    return .init(accepted: accepted, rejectedCount: rejectedCount, rejectionCategories: rejectionCategories, snapshotDigest: snapshotDigest, omissionPrefixDigest: prefixDigest)
  }

  private static func insertCalendarProjectionGeneration(
    _ db: Database, generation: CalendarProjectionGeneration,
    partition: CalendarProjectionPartition, interval: DateInterval
  ) throws {
    let superseded = try String.fetchAll(db, sql: "SELECT id FROM calendar_projection_generations WHERE provider = ? AND id <> ? AND status IN ('staged','materializing')", arguments: [generation.provider, generation.id.uuidString])
    try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'superseded' WHERE provider = ? AND id <> ? AND status IN ('staged','materializing')", arguments: [generation.provider, generation.id.uuidString])
    for id in superseded { try db.execute(sql: "DELETE FROM calendar_projection_generation_items WHERE generation_id = ?", arguments: [id]) }
    try db.execute(sql: "INSERT INTO calendar_projection_generations (provider,id,eligibility_epoch,snapshot_version,snapshot_digest,omission_prefix_digest,status,accepted_count,rejected_count,retention_eligible,refresh_at,next_ordinal,interval_start,interval_end,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", arguments: [generation.provider, generation.id.uuidString, generation.eligibilityEpoch, generation.snapshotVersion, generation.snapshotDigest, generation.omissionPrefixDigest, generation.status.rawValue, generation.acceptedCount, generation.rejectedCount, generation.retentionEligible, generation.refreshAt.timeIntervalSince1970, generation.nextOrdinal, interval.start.timeIntervalSince1970, interval.end.timeIntervalSince1970, generation.updatedAt.timeIntervalSince1970])
    var ordinal = 0
    for event in partition.accepted {
      let key = storageKey(event.identity.stableKey)
      try db.execute(sql: "INSERT INTO calendar_projection_generation_items (provider,generation_id,ordinal,event_key,event_json) VALUES (?,?,?,?,?)", arguments: [generation.provider, generation.id.uuidString, ordinal, key, try JSONEncoder.enchiridion.encode(event)])
      ordinal += 1
    }
    // Do not retain raw malformed identity details in diagnostics. The event
    // snapshot is local-only, but aggregate categories are enough for UI logs.
    for (category, count) in partition.rejectionCategories.sorted(by: { $0.key < $1.key }) {
      try db.execute(sql: "INSERT INTO calendar_projection_generation_rejections (generation_id,category,count) VALUES (?,?,?)", arguments: [generation.id.uuidString, category, count])
    }
  }

  private static func resumeCalendarProjectionGeneration(
    _ db: Database, provider: String, expectedID: UUID, expectedEpoch: Int64,
    batchLimit: Int, timeLimit: TimeInterval, now: Date, allowLegacyDisabled: Bool
  ) throws -> CalendarEventMaterializationReceipt {
    guard batchLimit > 0, (try calendarMaterializationEnabled(db) || allowLegacyDisabled),
      let generation = try calendarProjectionGeneration(db, provider: provider),
      generation.id == expectedID, generation.eligibilityEpoch == expectedEpoch,
      generation.status == .staged || generation.status == .materializing,
      try currentCalendarProjectionEligibilityEpoch(db, provider: provider) == expectedEpoch
    else { return .init() }
    let started = ProcessInfo.processInfo.systemUptime
    let rows = try Row.fetchAll(db, sql: "SELECT ordinal,event_json FROM calendar_projection_generation_items WHERE provider = ? AND generation_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?", arguments: [provider, expectedID.uuidString, generation.nextOrdinal, batchLimit])
    var lastOrdinal = generation.nextOrdinal
    try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'materializing', updated_at = ? WHERE provider = ? AND id = ? AND eligibility_epoch = ? AND status IN ('staged','materializing')", arguments: [now.timeIntervalSince1970, provider, expectedID.uuidString, expectedEpoch])
    guard db.changesCount > 0 else { return .init() }
    // Person/attendee projection is intentionally bounded with page work; the
    // initial authoritative commit never creates a large contact transaction.
    var changed: [PageID] = []
    var skipped = 0
    for row in rows {
      if ProcessInfo.processInfo.systemUptime - started >= timeLimit { break }
      guard let ordinal: Int = row["ordinal"], let data: Data = row["event_json"],
        let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
      else { throw LibraryRepositoryError.invalidRecord }
      try replaceAttendeeProjection(db, event: event, now: generation.refreshAt)
      let receipt = try materializeCalendarEvents(db, [event], provider: provider, authoritativeInterval: nil, now: generation.refreshAt)
      changed.append(contentsOf: receipt.changedPageIDs)
      skipped += receipt.skippedCount
      // Advance only after the exact item's Person and Page work committed in
      // this transaction; a crash resumes the first unfinished ordinal.
      lastOrdinal = ordinal + 1
    }
    let completed = lastOrdinal >= generation.acceptedCount
    if completed {
      let intervalStart: Double = try Double.fetchOne(db, sql: "SELECT interval_start FROM calendar_projection_generations WHERE provider = ? AND id = ?", arguments: [provider, expectedID.uuidString]) ?? now.timeIntervalSince1970
      let intervalEnd: Double = try Double.fetchOne(db, sql: "SELECT interval_end FROM calendar_projection_generations WHERE provider = ? AND id = ?", arguments: [provider, expectedID.uuidString]) ?? now.timeIntervalSince1970
      if generation.retentionEligible {
        try reconcileMaterializedCalendarRetention(db, sourceScope: CalendarEventMaterialization.sourceScopeDigest(for: provider) ?? provider, authoritativeInterval: .init(start: .init(timeIntervalSince1970: intervalStart), end: .init(timeIntervalSince1970: intervalEnd)), completedRefreshAt: generation.refreshAt.timeIntervalSince1970, now: generation.refreshAt, changed: &changed)
      }
      try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'completed', next_ordinal = ?, updated_at = ? WHERE provider = ? AND id = ? AND eligibility_epoch = ?", arguments: [lastOrdinal, now.timeIntervalSince1970, provider, expectedID.uuidString, expectedEpoch])
      let state = CalendarEventMaterializationBackfillState(provider: provider, status: .completed, outcome: "Materialized \(changed.count); rejected \(generation.rejectedCount)", updatedAt: now)
      try db.execute(sql: "INSERT OR REPLACE INTO calendar_materialization_backfills (provider,state_json) VALUES (?,?)", arguments: [provider, try JSONEncoder.enchiridion.encode(state)])
      try db.execute(sql: "DELETE FROM calendar_projection_generation_items WHERE generation_id = ?", arguments: [expectedID.uuidString])
      return .init(changedPageIDs: changed, skippedCount: generation.rejectedCount + skipped, isTerminal: true)
    }
    try db.execute(sql: "UPDATE calendar_projection_generations SET next_ordinal = ?, updated_at = ? WHERE provider = ? AND id = ? AND eligibility_epoch = ?", arguments: [lastOrdinal, now.timeIntervalSince1970, provider, expectedID.uuidString, expectedEpoch])
    return .init(changedPageIDs: changed, skippedCount: generation.rejectedCount + skipped, isTerminal: false)
  }

  private static func calendarMaterializationEnabled(_ db: Database) throws -> Bool {
    try calendarMaterializationSetting(db) ?? false
  }

  private static func calendarMaterializationSetting(_ db: Database) throws -> Bool? {
    guard let data = try Data.fetchOne(db, sql: "SELECT value FROM settings WHERE key = ?", arguments: [CalendarEventMaterialization.settingKey]) else { return nil }
    return (try? JSONDecoder.enchiridion.decode(Bool.self, from: data)) ?? false
  }

  private static func currentCalendarProjectionEligibilityEpoch(_ db: Database, provider: String) throws -> Int64 {
    try Int64.fetchOne(db, sql: "SELECT eligibility_epoch FROM calendar_projection_epochs WHERE provider = ?", arguments: [provider]) ?? 0
  }

  private static func nextCalendarProjectionEligibilityEpoch(_ db: Database, provider: String) throws -> Int64 {
    let next = try currentCalendarProjectionEligibilityEpoch(db, provider: provider) + 1
    try db.execute(sql: "INSERT INTO calendar_projection_epochs (provider,eligibility_epoch) VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET eligibility_epoch = excluded.eligibility_epoch", arguments: [provider, next])
    return next
  }

  private static func calendarProjectionGeneration(_ db: Database, provider: String) throws -> CalendarProjectionGeneration? {
    guard let row = try Row.fetchOne(db, sql: "SELECT provider,id,eligibility_epoch,snapshot_version,snapshot_digest,omission_prefix_digest,status,accepted_count,rejected_count,retention_eligible,refresh_at,next_ordinal,updated_at FROM calendar_projection_generations WHERE provider = ? ORDER BY updated_at DESC LIMIT 1", arguments: [provider]),
      let provider: String = row["provider"], let idString: String = row["id"], let id = UUID(uuidString: idString),
      let epoch: Int64 = row["eligibility_epoch"], let version: Int = row["snapshot_version"],
      let digest: String = row["snapshot_digest"], let prefixes: String = row["omission_prefix_digest"],
      let statusString: String = row["status"], let status = CalendarProjectionGenerationStatus(rawValue: statusString),
      let accepted: Int = row["accepted_count"], let rejected: Int = row["rejected_count"], let eligible: Bool = row["retention_eligible"], let refresh: Double = row["refresh_at"], let next: Int = row["next_ordinal"], let updated: Double = row["updated_at"]
    else { return nil }
    return .init(provider: provider, id: id, eligibilityEpoch: epoch, snapshotVersion: version, snapshotDigest: digest, omissionPrefixDigest: prefixes, status: status, acceptedCount: accepted, rejectedCount: rejected, retentionEligible: eligible, refreshAt: .init(timeIntervalSince1970: refresh), nextOrdinal: next, updatedAt: .init(timeIntervalSince1970: updated))
  }

  private static func invalidateCalendarProjectionGenerations(_ db: Database, provider: String?, now: Date) throws {
    if let provider {
      _ = try nextCalendarProjectionEligibilityEpoch(db, provider: provider)
      try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'invalidated', updated_at = ? WHERE provider = ? AND status IN ('staged','materializing')", arguments: [now.timeIntervalSince1970, provider])
      try db.execute(sql: "DELETE FROM calendar_projection_generation_items WHERE provider = ?", arguments: [provider])
    } else {
      let providers = try String.fetchAll(db, sql: "SELECT DISTINCT provider FROM calendar_projection_generations")
      for provider in providers { _ = try nextCalendarProjectionEligibilityEpoch(db, provider: provider) }
      try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'invalidated', updated_at = ? WHERE status IN ('staged','materializing')", arguments: [now.timeIntervalSince1970])
      try db.execute(sql: "DELETE FROM calendar_projection_generation_items")
    }
  }

  /// Copies the safe, semantic calendar projection into normal Event pages. This
  /// shares the normal document/dirty-generation path, so CloudKit sees every
  /// actual page change and unchanged snapshots are genuine no-ops.
  public func materializeCalendarEvents(
    _ events: [CalendarEventSnapshot],
    provider: String? = nil,
    authoritativeInterval: DateInterval? = nil,
    now: Date = Date()
  ) throws -> CalendarEventMaterializationReceipt {
    guard try calendarEventMaterializationEnabled() else { return .init(skippedCount: events.count) }
    return try database.write { db in
      try Self.materializeCalendarEvents(
        db, events, provider: provider, authoritativeInterval: authoritativeInterval, now: now
      )
    }
  }

  public func materializeActiveCalendarProjectionForUpgrade(
    eligibleProviders: Set<String>? = nil,
    now: Date = Date()
  ) throws -> CalendarEventMaterializationReceipt {
    try database.write { db in
      // v30's unconditional scan made launch latency proportional to the whole
      // historical calendar. Surface one bounded legacy slice so existing
      // local projections do not vanish after migration; the next provider
      // refresh establishes the exact v31 ledger for the remaining horizon.
      // An explicit user disable is authoritative. An absent legacy setting is
      // compatible with the historic upgrade path but never writes a setting.
      if try Self.calendarMaterializationSetting(db) == false { return .init() }
      try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'staged', updated_at = ? WHERE status = 'materializing'", arguments: [now.timeIntervalSince1970])
      let eligible: Set<String>
      if let eligibleProviders {
        eligible = eligibleProviders
      } else {
        eligible = Set(try String.fetchAll(db, sql: "SELECT DISTINCT e.provider FROM calendar_events e LEFT JOIN calendar_projection_access a ON a.provider = e.provider WHERE e.active = 1 AND COALESCE(a.is_eligible,1) = 1"))
      }
      guard !eligible.isEmpty else { return .init() }
      let candidates = try Row.fetchAll(db, sql: "SELECT rowid,event_key,provider,event_json FROM calendar_events WHERE active = 1 AND provider IN (\(eligible.map { _ in "?" }.joined(separator: ","))) AND event_key NOT IN (SELECT event_key FROM calendar_legacy_upgrade_receipts) AND rowid NOT IN (SELECT source_rowid FROM calendar_legacy_upgrade_skips WHERE source_rowid IS NOT NULL) ORDER BY start_at,event_key LIMIT 256", arguments: StatementArguments(eligible.sorted()))
      var changed = Set<PageID>()
      var skipped = 0
      var valid: [(sourceKey: String, rowID: Int64?, event: CalendarEventSnapshot)] = []
      for row in candidates {
        let rowID: Int64? = row["rowid"]
        let key: String? = row["event_key"]
        let storedProvider: String? = row["provider"]
        guard let data: Data = row["event_json"],
          let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
        else {
          try Self.recordLegacyCalendarUpgradeSkip(db, eventKey: key, rowID: rowID, reason: "decode", now: now)
          skipped += 1
          continue
        }
        guard CalendarEventMaterialization.identity(for: event) != nil else {
          try Self.recordLegacyCalendarUpgradeSkip(db, eventKey: key, rowID: rowID, reason: "identity", now: now)
          skipped += 1
          continue
        }
        guard event.identity.provider == storedProvider else {
          try Self.recordLegacyCalendarUpgradeSkip(db, eventKey: key, rowID: rowID, reason: "provider", now: now)
          skipped += 1
          continue
        }
        guard let key else {
          try Self.recordLegacyCalendarUpgradeSkip(db, eventKey: nil, rowID: rowID, reason: "key", now: now)
          skipped += 1
          continue
        }
        valid.append((key, rowID, event))
        if valid.count == 32 { break }
      }
      for (provider, items) in Dictionary(grouping: valid, by: { $0.event.identity.provider }) {
        let events = items.map(\.event)
        let receipt = try Self.materializeCalendarEvents(db, events, provider: provider, authoritativeInterval: nil, now: now)
        changed.formUnion(receipt.changedPageIDs)
        skipped += receipt.skippedCount
        for item in items {
          try db.execute(sql: "INSERT OR IGNORE INTO calendar_legacy_upgrade_receipts (event_key,completed_at) VALUES (?,?)", arguments: [item.sourceKey, now.timeIntervalSince1970])
        }
      }
      return .init(changedPageIDs: changed.sorted { $0.rawValue < $1.rawValue }, skippedCount: skipped)
    }
  }

  private static func recordLegacyCalendarUpgradeSkip(
    _ db: Database, eventKey: String?, rowID: Int64?, reason: String, now: Date
  ) throws {
    // `calendar_events.event_key` is not-null in every supported schema, but
    // retaining rowid makes a damaged legacy row permanently non-selectable
    // even if an external SQLite repair left it malformed.
    let stableKey = eventKey?.isEmpty == false ? eventKey! : "rowid:\(rowID ?? -1)"
    try db.execute(sql: "INSERT OR IGNORE INTO calendar_legacy_upgrade_skips (event_key,source_rowid,reason,recorded_at) VALUES (?,?,?,?)", arguments: [stableKey, rowID, reason, now.timeIntervalSince1970])
  }

  private static func materializeCalendarEvents(
    _ db: Database,
    _ events: [CalendarEventSnapshot],
    provider: String?,
    authoritativeInterval: DateInterval?,
    now: Date
  ) throws -> CalendarEventMaterializationReceipt {
      let providerScope: String?
      if let provider {
        providerScope = CalendarEventMaterialization.sourceScopeDigest(for: provider)
      } else {
        providerScope = Set(events.map { $0.identity.provider }).count == 1
          ? events.first.flatMap { CalendarEventMaterialization.sourceScopeDigest(for: $0.identity.provider) }
          : nil
      }
      var changed: [PageID] = []
      var skipped = 0
      let refreshStamp = now.timeIntervalSince1970
      for event in events {
        guard let identity = CalendarEventMaterialization.identity(for: event) else {
          skipped += 1
          continue
        }
        let pageID = PageID.materializedCalendarEvent(identity)
        let existing = try Self.fetchPage(db, id: pageID)
        var requested = CalendarEventMaterialization.providerProperties(for: event)
        requested.merge(try Self.materializedPeopleProperties(db, event: event)) { _, incoming in incoming }
        let state = try Row.fetchOne(
          db,
          sql: "SELECT detached_at,provider_baseline_json FROM calendar_materialization_state WHERE page_id = ?",
          arguments: [pageID.rawValue]
        )
        let wasDetached: Double? = state?["detached_at"]
        let previousBaselineData: Data? = state?["provider_baseline_json"]
        let previousBaseline = previousBaselineData.flatMap {
          try? JSONDecoder.enchiridion.decode(CalendarEventMaterializationBaseline.self, from: $0)
        }
        let incomingBaseline = CalendarEventMaterializationBaseline(
          title: event.title, properties: requested
        )
        let userTouched = try existing.map { page in
          guard !(try Self.materializedPageHasUserDelta(page, db: db)) else { return true }
          if let previousBaseline { return !previousBaseline.matches(page) }
          // A normal CloudKit import carries the deterministic Event page but
          // not this device's local-only state row. Adopt only an exact incoming
          // projection; anything else could be a user-edited conflict.
          guard state == nil else { return true }
          return !incomingBaseline.matches(page)
        } ?? false
        if existing != nil, wasDetached != nil || userTouched {
          try Self.updateMaterializationState(
            db, pageID: pageID, identity: identity, event: event,
            baselineHash: CalendarEventMaterialization.baselineHash(for: event), now: now, detached: true
          )
          continue
        }
        let base = try Self.createPage(
          db, id: pageID, kind: .calendarMaterializedEvent(identity), title: event.title, now: now
        )
        var mutation = base.document
        var changedDocument = existing == nil
        if existing != nil, base.title != event.title {
          mutation = try PageDocument.replaceTitle(with: event.title, in: mutation).document
          changedDocument = true
        }
        let current = base.objectMetadata.properties
        for (key, values) in requested where current[key] != values {
          mutation = try PageDocument.setProperty(key: key, values: values, in: mutation).document
          changedDocument = true
        }
        // A provider no longer supplying a location must clear only the provider
        // field. User body, title, tags, relations and pins are untouched.
        for field in ["location", "organizer", "attendees"] {
          let key = SupertagPropertyKey(supertagID: BuiltInSupertags.event, fieldID: .init(rawValue: field))
          if requested[key] == nil, current[key] != nil {
            mutation = try PageDocument.setProperty(key: key, values: [], in: mutation).document
            changedDocument = true
          }
        }
        if changedDocument && existing != nil {
          let result = try PageDocument.addSupertag(BuiltInSupertags.event, in: mutation)
          let updated = Self.updatedPage(base, with: result, now: now)
          try Self.writePage(db, page: updated, cloudDirty: true)
          try Self.replaceReferences(db, pageID: updated.id, references: result.projection.references)
          changed.append(updated.id)
        } else if existing == nil {
          // The page is already cloud dirty from creation. Add the Event tag and
          // fields in one document update so it never escapes as a blank note.
          let result = try PageDocument.addSupertag(BuiltInSupertags.event, in: mutation)
          // `mutation` already contains fields; addSupertag preserves them.
          let updated = Self.updatedPage(base, with: result, now: now)
          try Self.writePage(db, page: updated, cloudDirty: true)
          try Self.replaceReferences(db, pageID: updated.id, references: result.projection.references)
          changed.append(updated.id)
        }
        try Self.updateMaterializationState(
          db, pageID: pageID, identity: identity, event: event,
          baselineHash: CalendarEventMaterialization.baselineHash(for: event),
          baseline: incomingBaseline, now: now, detached: false
        )
      }
      // This method is called only after a provider returned its full horizon.
      // Failures/cancellation never reach this transaction, therefore never
      // advance a prune deadline or delete a previously materialized Event.
      // Empty authoritative refreshes are meaningful too.  Never reconcile a
      // mixed/unknown scope: that could age another provider's pages.
      if let providerScope, let authoritativeInterval {
        try Self.reconcileMaterializedCalendarRetention(
          db, sourceScope: providerScope, authoritativeInterval: authoritativeInterval,
          completedRefreshAt: refreshStamp, now: now, changed: &changed
        )
      }
      return .init(changedPageIDs: changed, skippedCount: skipped)
  }

  public func contactCandidates() throws -> [PersonContactCandidate] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT p.id,p.title,p.person_visibility,v.text_value
          FROM pages p
          JOIN page_supertags s
            ON s.page_id = p.id AND s.supertag_id = 'person'
          JOIN page_property_values v
            ON v.page_id = p.id AND v.supertag_id = 'person'
              AND v.field_id = 'email' AND v.type = 'email'
          WHERE p.deleted_at IS NULL AND v.text_value IS NOT NULL
          ORDER BY p.title COLLATE NOCASE,p.id,v.value_index
          """
      ).compactMap { row in
        guard let rawID: String = row["id"], let title: String = row["title"],
          let email: String = row["text_value"]
        else { return nil }
        let visibility = (row["person_visibility"] as String?)
          .flatMap(PersonVisibility.init(rawValue:)) ?? .promoted
        let candidate = PersonContactCandidate(
          pageID: PageID(rawValue: rawID),
          email: email,
          displayName: title,
          visibility: visibility
        )
        return (try? PersonEmail.normalize(candidate.email)) != nil ? candidate : nil
      }
    }
  }

  /// Returns every live Person whose stored Email has the exact canonical value.
  ///
  /// Legacy values participate through the same comparison normalizer, but only a valid input
  /// may start a lookup. Callers must present multiple results for explicit selection.
  public func personEmailCandidates(matchingEmail email: String) throws -> [PersonEmailCandidate] {
    let normalizedEmail = try PersonEmail.normalize(email)
    return try database.read { db in
      try Self.personEmailCandidates(db, matchingNormalizedEmail: normalizedEmail)
    }
  }

  public func contactLink(for pageID: PageID) throws -> PersonContactLink? {
    try database.read { db in try Self.contactLink(db, pageID: pageID) }
  }

  public func contactLinks() throws -> [PersonContactLink] {
    try database.read { db in
      try Row.fetchAll(db, sql: "SELECT * FROM person_contact_links ORDER BY refreshed_at DESC")
        .compactMap(Self.decodeContactLink)
    }
  }

  @discardableResult
  public func saveContactLink(
    _ record: DeviceContactRecord,
    for pageID: PageID,
    matchedEmail: String,
    now: Date = Date()
  ) throws -> PersonContactLink {
    let normalizedEmail = DeviceContactRecord.normalizedEmail(matchedEmail)
    guard !record.identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      record.normalizedEmails.contains(normalizedEmail)
    else { throw LibraryRepositoryError.invalidRecord }
    return try database.write { db in
      let personEmails = try String.fetchAll(
        db,
        sql: """
          SELECT v.text_value FROM page_supertags s
          JOIN page_property_values v ON v.page_id = s.page_id
          WHERE s.page_id = ? AND s.supertag_id = 'person'
            AND v.supertag_id = 'person' AND v.field_id = 'email'
            AND v.text_value IS NOT NULL
          """,
        arguments: [pageID.rawValue]
      )
      guard personEmails.map(DeviceContactRecord.normalizedEmail).contains(normalizedEmail)
      else { throw LibraryRepositoryError.invalidRecord }
      try db.execute(
        sql: """
          INSERT INTO person_contact_links
            (person_page_id,contact_identifier,matched_email,contact_json,refreshed_at)
          VALUES (?,?,?,?,?)
          ON CONFLICT(person_page_id) DO UPDATE SET
            contact_identifier=excluded.contact_identifier,
            matched_email=excluded.matched_email,
            contact_json=excluded.contact_json,
            refreshed_at=excluded.refreshed_at
          """,
        arguments: [
          pageID.rawValue,
          record.identifier,
          normalizedEmail,
          try JSONEncoder.enchiridion.encode(record),
          now.timeIntervalSince1970,
        ]
      )
      return PersonContactLink(
        pageID: pageID,
        contactIdentifier: record.identifier,
        matchedEmail: normalizedEmail,
        record: record,
        refreshedAt: now
      )
    }
  }

  public func removeContactLink(for pageID: PageID) throws {
    try database.write { db in
      try db.execute(
        sql: "DELETE FROM person_contact_links WHERE person_page_id = ?",
        arguments: [pageID.rawValue]
      )
    }
  }

  /// Explicitly adopts a linked device contact name as the canonical Person title.
  ///
  /// Contact links themselves are deliberately local-only. This is the only path that may copy a
  /// contact name into a page, and the title is rechecked inside the write transaction so it can
  /// never overwrite a concurrent authored rename.
  public func adoptLinkedContactName(
    pageID: PageID,
    now: Date = Date()
  ) throws -> PersonContactNameAdoptionOutcome {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID),
        current.hasSupertag(BuiltInSupertags.person),
        let link = try Self.contactLink(db, pageID: pageID)
      else { return .unavailable }

      let emails = Self.personEmails(in: current)
      guard let contactName = PersonDisplayName.linkedContactName(
        emails: emails,
        contactLink: link
      ) else { return .unavailable }
      guard PersonDisplayName.isSafeFallbackTitle(
        current.title,
        emails: emails,
        origin: current.personOrigin
      ) else { return .unchanged(current) }
      guard contactName != current.title.trimmingCharacters(in: .whitespacesAndNewlines)
      else { return .unchanged(current) }

      var result: (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection)
      if current.effectivePersonVisibility == .other {
        let classification = try PageDocument.setPersonClassification(
          visibility: .promoted,
          origin: current.personOrigin ?? .manual,
          in: current.document
        )
        result = try PageDocument.replaceTitle(with: contactName, in: classification.document)
      } else {
        result = try PageDocument.replaceTitle(with: contactName, in: current.document)
      }
      let updated = Self.updatedPage(current, with: result, now: now)
      try Self.writePage(db, page: updated, cloudDirty: true)
      try db.execute(
        sql: "UPDATE pages SET person_cloud_eligible = 1 WHERE id = ?",
        arguments: [updated.id.rawValue]
      )
      try Self.replaceReferences(db, pageID: updated.id, references: result.projection.references)
      return .adopted(updated)
    }
  }

  public func removeAllContactLinks() throws {
    try database.write { db in
      try db.execute(sql: "DELETE FROM person_contact_links")
    }
  }

  @discardableResult
  public func createTaggedPage(
    title: String,
    supertagID: SupertagID,
    id: PageID? = nil,
    now: Date = Date()
  ) throws -> PageSnapshot {
    let page = try createPage(id: id ?? .free(), kind: .free, title: title, now: now)
    try addSupertag(supertagID, to: page.id, now: now)
    guard let updated = try self.page(id: page.id) else { throw LibraryRepositoryError.pageNotFound }
    return updated
  }

  /// Creates (or explicitly resolves) a typed entity and its canonical graph
  /// edge in one transaction. It is intentionally separate from editor inline
  /// references: the relation is durable graph state, not rich text markup.
  public func createEntityAndRelationship(
    _ request: CreateEntityAndRelationshipRequest,
    now: Date = Date()
  ) throws -> EntityRelationshipMutationReceipt {
    try database.write { db in
      let title = request.title.trimmingCharacters(in: .whitespacesAndNewlines)
      let explicitPersonResolution: (pageID: PageID, matchingEmail: String)?
      switch request.existingPersonResolution {
      case .none:
        explicitPersonResolution = nil
      case .useExisting:
        // The original payload did not contain the lookup email, so accepting it would make a
        // stale asynchronous picker indistinguishable from a deliberate selection.
        throw GraphRelationshipAuthoringError.invalidPersonSelection
      case .useExistingMatchingEmail(let pageID, let matchingEmail):
        explicitPersonResolution = (pageID, try PersonEmail.normalize(matchingEmail))
      }
      guard explicitPersonResolution != nil || !title.isEmpty else {
        throw GraphRelationshipAuthoringError.invalidTitle
      }
      guard let relation = try Row.fetchOne(
        db,
        sql: "SELECT definition_json FROM _graph_relation_definitions WHERE id = ? AND is_deleted = 0",
        arguments: [request.intent.relation.id.rawValue]
      ).flatMap(Self.decodeRelation) else {
        throw GraphModelError.unknownRelation(request.intent.relation.id)
      }
      guard let presented = try Self.fetchPage(db, id: request.intent.presentedSourceID),
        presented.deletedAt == nil
      else { throw GraphModelError.invalidEndpoint }

      let presentedTags = try Self.effectiveTagIDs(db, nodeID: presented.id)
      let presentedRequirements = request.intent.direction == .forward
        ? relation.sourceTagIDs
        : relation.targetTagIDs
      guard presentedRequirements.isEmpty || !presentedTags.isDisjoint(with: presentedRequirements)
      else { throw GraphModelError.invalidEndpoint }
      guard try Self.hasLiveSupertag(db, id: request.selectedTargetTypeID) else {
        throw GraphRelationshipAuthoringError.incompatibleType
      }
      let definitions = try Row.fetchAll(
        db,
        sql: "SELECT definition_json FROM supertag_schemas WHERE deleted = 0"
      ).compactMap { row -> SupertagDefinition? in
        guard let data: Data = row["definition_json"] else { return nil }
        return try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data)
      }
      let selectedEffectiveTags = SupertagInheritance.effectiveTagIDs(
        for: Set([request.selectedTargetTypeID]), definitions: definitions
      )
      let targetRequirements = request.intent.direction == .forward
        ? relation.targetTagIDs
        : relation.sourceTagIDs
      guard targetRequirements.isEmpty || !selectedEffectiveTags.isDisjoint(with: targetRequirements),
        request.intent.compatibleTargetTypeIDs.contains(request.selectedTargetTypeID)
      else { throw GraphRelationshipAuthoringError.incompatibleType }

      let initialProperties: [SupertagPropertyKey: [SupertagValue]]
      do {
        initialProperties = try Self.validatedInitialProperties(
          request.initialProperties,
          targetSupertagID: request.selectedTargetTypeID,
          db: db
        )
      } catch {
        throw GraphRelationshipAuthoringError.invalidProperties
      }

      let isPerson = selectedEffectiveTags.contains(BuiltInSupertags.person)
      let normalizedEmails = try initialProperties[Self.personEmailKey, default: []].compactMap { value -> String? in
        guard case .email(let email) = value else { return nil }
        return try PersonEmail.normalize(email)
      }
      var entity: PageSnapshot
      if let resolution = explicitPersonResolution {
        guard isPerson, initialProperties.isEmpty else {
          throw GraphRelationshipAuthoringError.invalidProperties
        }
        let candidates = try Self.personEmailCandidates(
          db,
          matchingNormalizedEmail: resolution.matchingEmail
        )
        guard candidates.contains(where: { $0.pageID == resolution.pageID }),
          let page = try Self.fetchPage(db, id: resolution.pageID),
          page.deletedAt == nil
        else { throw GraphRelationshipAuthoringError.invalidPersonSelection }
        let selectedTags = try Self.effectiveTagIDs(db, nodeID: page.id)
        guard selectedTags.contains(BuiltInSupertags.person),
          targetRequirements.isEmpty || !selectedTags.isDisjoint(with: targetRequirements)
        else { throw GraphRelationshipAuthoringError.invalidPersonSelection }
        // Explicit reuse creates only the canonical edge. The target's title, tags, properties,
        // classification, and cloud eligibility remain exactly as the user last set them.
        entity = page
      } else if isPerson, let email = normalizedEmails.first {
        let candidates = try Self.personEmailCandidates(db, matchingNormalizedEmail: email)
        if candidates.isEmpty {
          entity = try Self.createRelationshipEntity(
            title: title,
            supertagID: request.selectedTargetTypeID,
            initialProperties: initialProperties,
            isEffectivePerson: isPerson,
            now: now,
            db: db
          )
        } else {
          // A matching Person, including a calendar-backed projection, is never adopted by an
          // implicit create request. Reusing it requires the explicit, link-only resolution
          // above so a stale picker cannot alter another person's title, tags, or privacy.
          throw GraphRelationshipAuthoringError.personSelectionRequired
        }
      } else {
        entity = try Self.createRelationshipEntity(
          title: title,
          supertagID: request.selectedTargetTypeID,
          initialProperties: initialProperties,
          isEffectivePerson: isPerson,
          now: now,
          db: db
        )
      }

      let endpoints = request.intent.canonicalEndpoints(selectedTargetID: entity.id)
      let edge = try Self.createEdge(
        in: db,
        relationID: relation.id,
        from: endpoints.source,
        to: endpoints.target,
        now: now
      )
      let changedIDs = Array(Set([entity.id, endpoints.source])).sorted { $0.rawValue < $1.rawValue }
      return EntityRelationshipMutationReceipt(
        entity: entity,
        edge: edge,
        canonicalSourceID: endpoints.source,
        canonicalTargetID: endpoints.target,
        changedPageIDs: changedIDs
      )
    }
  }

  /// Atomically creates a tagged target page and persists a reference to it in
  /// the source page. The source is guarded by its exact durable Automerge
  /// heads, so a stale editor can never create an unlinked page.
  public func createTaggedPageAndPersistReference(
    _ request: TaggedPageReferenceInsertionRequest,
    now: Date = Date()
  ) throws -> TaggedPageReferenceInsertionResult {
    do {
      return try database.write { db in
        let targetTitle = request.targetTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !targetTitle.isEmpty else {
          throw TaggedPageReferenceInsertionError.invalidTargetTitle
        }
        guard let source = try Self.fetchPage(db, id: request.sourcePageID) else {
          throw TaggedPageReferenceInsertionError.sourceDeleted
        }
        guard source.deletedAt == nil else {
          throw TaggedPageReferenceInsertionError.sourceDeleted
        }
        guard source.heads == request.expectedSourceHeads else {
          throw TaggedPageReferenceInsertionError.sourceStale
        }
        guard try Self.fetchPage(db, id: request.targetPageID) == nil else {
          throw TaggedPageReferenceInsertionError.targetOccupied
        }
        guard try !Self.hasPurgeMarker(db, pageID: request.targetPageID) else {
          throw TaggedPageReferenceInsertionError.targetPurged
        }
        guard try Self.hasLiveSupertag(db, id: request.supertagID) else {
          throw TaggedPageReferenceInsertionError.invalidSupertag
        }
        let initialProperties = try Self.validatedInitialProperties(
          request.initialProperties,
          targetSupertagID: request.supertagID,
          db: db
        )
        for case .email(let email) in initialProperties[Self.personEmailKey] ?? [] {
          guard try Self.personEmailCandidates(db, matchingNormalizedEmail: email).isEmpty else {
            throw TaggedPageReferenceInsertionError.personEmailAlreadyExists
          }
        }

        let sourceResult = try PageDocument.replaceRichText(
          title: request.sourceTitle,
          body: request.sourceBody,
          in: source.document
        )
        let createdTarget = try Self.createPage(
          db,
          id: request.targetPageID,
          kind: .free,
          title: targetTitle,
          now: now
        )
        var targetResult = try Self.addingSupertag(
          request.supertagID,
          in: createdTarget.document
        )
        for (key, values) in initialProperties.sorted(by: { $0.key.storageKey < $1.key.storageKey }) {
          targetResult = try PageDocument.setProperty(
            key: key,
            values: values,
            in: targetResult.document
          )
        }
        let matchingReferences = sourceResult.projection.references.filter {
          $0.targetPageID == request.targetPageID && $0.fallbackLabel == targetTitle
        }
        guard matchingReferences.count == 1 else {
          throw TaggedPageReferenceInsertionError.missingTargetReference
        }
        let target = Self.updatedPage(createdTarget, with: targetResult, now: now)
        try Self.writePage(db, page: target, cloudDirty: true)
        try Self.replaceReferences(
          db,
          pageID: target.id,
          references: targetResult.projection.references
        )

        let updatedSource = Self.updatedPage(source, with: sourceResult, now: now)
        try Self.writePage(db, page: updatedSource, cloudDirty: true)
        try Self.replaceReferences(
          db,
          pageID: updatedSource.id,
          references: sourceResult.projection.references
        )
        return TaggedPageReferenceInsertionResult(source: updatedSource, target: target)
      }
    } catch let error as TaggedPageReferenceInsertionError {
      throw error
    } catch let error as PersonEmailValidationError {
      throw error
    } catch {
      throw TaggedPageReferenceInsertionError.persistenceFailure(error.localizedDescription)
    }
  }

  @discardableResult
  public func createProject(
    title: String,
    data: ProjectData = .init(),
    now: Date = Date()
  ) throws -> PageSnapshot {
    let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTitle.isEmpty else { throw LibraryRepositoryError.invalidRecord }
    let normalizedData = ProjectData(
      status: data.status,
      outcome: data.outcome,
      areaID: data.areaID,
      startDate: data.startDate,
      dueDate: data.dueDate,
      lastReviewedAt: data.lastReviewedAt,
      closedAt: data.status.isOpen ? nil : (data.closedAt ?? now)
    )
    return try database.write { db in
      let page = try Self.createPage(
        db,
        id: .free(),
        kind: .free,
        title: normalizedTitle,
        now: now
      )
      let result = try PageDocument.setProperties(
        ProjectFields.properties(for: normalizedData),
        ensuring: BuiltInSupertags.project,
        message: "Create project",
        in: page.document
      )
      let project = Self.updatedPage(page, with: result, now: now)
      try Self.writePage(db, page: project, cloudDirty: true)
      try Self.replaceReferences(
        db,
        pageID: project.id,
        references: result.projection.references
      )
      return project
    }
  }

  @discardableResult
  public func updateProject(
    pageID: PageID,
    data: ProjectData,
    now: Date = Date()
  ) throws -> PageSnapshot {
    let requested = ProjectData(
      status: data.status,
      outcome: data.outcome,
      areaID: data.areaID,
      startDate: data.startDate,
      dueDate: data.dueDate,
      lastReviewedAt: data.lastReviewedAt,
      closedAt: data.closedAt
    )
    return try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      guard let currentData = current.projectData else {
        throw LibraryRepositoryError.invalidRecord
      }
      var normalized = requested
      normalized.closedAt = normalized.status.isOpen
        ? nil
        : (normalized.closedAt ?? currentData.closedAt ?? now)
      if currentData.status.isOpen, !normalized.status.isOpen {
        let activeTaskCount = try Self.activeTaskCount(db, projectID: pageID)
        guard activeTaskCount == 0 else {
          throw LibraryRepositoryError.projectHasActiveTasks(count: activeTaskCount)
        }
      }
      return try Self.writeProjectUpdate(
        db,
        current: current,
        data: normalized,
        message: "Update project plan",
        now: now
      )
    }
  }

  /// Completes a project only when no active task still refers to it.
  ///
  /// The task count and project write share one database transaction, so a blocked result never
  /// partially changes the project or its cloud-dirty generation.
  public func closeProject(
    pageID: PageID,
    resolution: ProjectClosureResolution = .strict,
    now: Date = Date()
  ) throws -> ProjectCloseResult {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      guard let projectBeforeData = current.projectData else {
        throw LibraryRepositoryError.invalidRecord
      }
      guard projectBeforeData.status.isOpen else {
        return .closed(
          ProjectClosureOutcome(project: current, affectedTasks: [], undoReceipt: nil)
        )
      }

      let activeTasks = try Self.activeProjectTasks(db, projectID: pageID)
      if resolution == .strict, !activeTasks.isEmpty {
        return .blocked(activeTaskCount: activeTasks.count)
      }

      let affectedTaskIDs = Set(activeTasks.map(\.id))
      var preparedTasks: [PreparedTaskPageWrite] = []
      var taskUndoEntries: [TaskBatchUndoEntry] = []
      for task in activeTasks {
        guard var data = task.taskData, data.state == .active, data.projectID == pageID else {
          throw LibraryRepositoryError.invalidRecord
        }
        let before = data
        let operation: TaskBatchOperation
        switch resolution {
        case .strict:
          throw LibraryRepositoryError.invalidRecord
        case .detachActiveTasks:
          operation = .patch
          data.projectID = nil
          if data.parentTaskID.map(affectedTaskIDs.contains) != true {
            data.parentTaskID = nil
          }
        case .cancelActiveTasks:
          operation = .cancel
          data.state = .canceled
          data.completedAt = now
        }
        let result = try PageDocument.setProperties(
          TaskFields.properties(for: data),
          ensuring: BuiltInSupertags.task,
          message: resolution == .detachActiveTasks
            ? "Detach task while closing project"
            : "Cancel task while closing project",
          in: task.document
        )
        let updated = Self.updatedPage(task, with: result, now: now)
        preparedTasks.append(
          PreparedTaskPageWrite(page: updated, references: result.projection.references)
        )
        taskUndoEntries.append(
          TaskBatchUndoEntry(
            operation: operation,
            sourceAfterMutation: TaskPageVersion(updated),
            sourceBeforeTaskData: before
          )
        )
      }

      var projectAfterData = projectBeforeData
      projectAfterData.status = resolution == .cancelActiveTasks ? .cancelled : .completed
      projectAfterData.closedAt = now
      let projectResult = try PageDocument.setProperties(
        ProjectFields.properties(for: projectAfterData),
        ensuring: BuiltInSupertags.project,
        message: resolution == .cancelActiveTasks ? "Cancel project" : "Complete project",
        in: current.document
      )
      let closed = Self.updatedPage(current, with: projectResult, now: now)
      let undoReceipt = ProjectClosureUndoReceipt(
        resolution: resolution,
        projectAfterClosure: TaskPageVersion(closed),
        projectBeforeData: projectBeforeData,
        taskReceipt: TaskBatchUndoReceipt(entries: taskUndoEntries)
      )

      for prepared in preparedTasks {
        try Self.writePreparedTaskPage(db, prepared: prepared, now: now)
      }
      try Self.writePage(db, page: closed, cloudDirty: true)
      try Self.replaceReferences(
        db,
        pageID: closed.id,
        references: projectResult.projection.references
      )
      return .closed(
        ProjectClosureOutcome(
          project: closed,
          affectedTasks: preparedTasks.map(\.page),
          undoReceipt: undoReceipt
        )
      )
    }
  }

  @discardableResult
  public func undoProjectClosure(
    _ receipt: ProjectClosureUndoReceipt,
    now: Date = Date()
  ) throws -> ProjectClosureUndoResult {
    let entries = receipt.taskReceipt.entries
    let taskIDs = Set(entries.map(\.sourceAfterMutation.id))
    guard taskIDs.count == entries.count,
      receipt.projectBeforeData.status.isOpen,
      !taskIDs.contains(receipt.projectAfterClosure.id),
      receipt.resolution != .strict || entries.isEmpty
    else { throw LibraryRepositoryError.projectClosureUndoUnavailable }

    return try database.write { db in
      guard let project = try Self.fetchPage(db, id: receipt.projectAfterClosure.id),
        project.deletedAt == nil,
        project.heads == receipt.projectAfterClosure.heads,
        project.dirtyGeneration == receipt.projectAfterClosure.dirtyGeneration,
        let currentProjectData = project.projectData,
        currentProjectData.status
          == (receipt.resolution == .cancelActiveTasks ? .cancelled : .completed),
        currentProjectData.closedAt != nil
      else { throw LibraryRepositoryError.projectClosureUndoUnavailable }

      var restoredTasks: [PreparedTaskPageWrite] = []
      for entry in entries {
        guard entry.createdSuccessor == nil,
          let source = try Self.fetchPage(db, id: entry.sourceAfterMutation.id),
          source.deletedAt == nil,
          source.heads == entry.sourceAfterMutation.heads,
          source.dirtyGeneration == entry.sourceAfterMutation.dirtyGeneration,
          var expectedCurrentData = Optional(entry.sourceBeforeTaskData),
          expectedCurrentData.state == .active,
          expectedCurrentData.projectID == project.id
        else { throw LibraryRepositoryError.projectClosureUndoUnavailable }

        switch receipt.resolution {
        case .strict:
          throw LibraryRepositoryError.projectClosureUndoUnavailable
        case .detachActiveTasks:
          guard entry.operation == .patch else {
            throw LibraryRepositoryError.projectClosureUndoUnavailable
          }
          expectedCurrentData.projectID = nil
          if expectedCurrentData.parentTaskID.map(taskIDs.contains) != true {
            expectedCurrentData.parentTaskID = nil
          }
        case .cancelActiveTasks:
          guard entry.operation == .cancel else {
            throw LibraryRepositoryError.projectClosureUndoUnavailable
          }
          expectedCurrentData.state = .canceled
          expectedCurrentData.completedAt = currentProjectData.closedAt
        }
        guard source.taskData == expectedCurrentData else {
          throw LibraryRepositoryError.projectClosureUndoUnavailable
        }

        let taskResult = try PageDocument.setProperties(
          TaskFields.properties(for: entry.sourceBeforeTaskData),
          ensuring: BuiltInSupertags.task,
          message: "Undo project closure",
          in: source.document
        )
        restoredTasks.append(
          PreparedTaskPageWrite(
            page: Self.updatedPage(source, with: taskResult, now: now),
            references: taskResult.projection.references
          )
        )
      }

      var restoredProjectData = receipt.projectBeforeData
      restoredProjectData.closedAt = nil
      let projectResult = try PageDocument.setProperties(
        ProjectFields.properties(for: restoredProjectData),
        ensuring: BuiltInSupertags.project,
        message: "Undo project closure",
        in: project.document
      )
      let restoredProject = Self.updatedPage(project, with: projectResult, now: now)

      for prepared in restoredTasks {
        try Self.writePreparedTaskPage(db, prepared: prepared, now: now)
      }
      try Self.writePage(db, page: restoredProject, cloudDirty: true)
      try Self.replaceReferences(
        db,
        pageID: restoredProject.id,
        references: projectResult.projection.references
      )
      return ProjectClosureUndoResult(
        project: restoredProject,
        restoredTasks: restoredTasks.map(\.page)
      )
    }
  }

  /// Reopens a completed or cancelled project as active. Calling this for an open project is a
  /// no-op so retries do not create needless document or sync generations.
  public func reopenProject(
    pageID: PageID,
    now: Date = Date()
  ) throws -> PageSnapshot {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      guard var data = current.projectData else {
        throw LibraryRepositoryError.invalidRecord
      }
      guard !data.status.isOpen else { return current }

      data.status = .active
      data.closedAt = nil
      return try Self.writeProjectUpdate(
        db,
        current: current,
        data: data,
        message: "Reopen project",
        now: now
      )
    }
  }

  @discardableResult
  public func createTask(
    _ draft: TaskDraft,
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> PageSnapshot {
    let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { throw LibraryRepositoryError.invalidRecord }
    return try database.write { db in
      let page = try Self.createPage(db, id: .free(), kind: .free, title: title, now: now)
      let data = Self.normalizedTaskData(draft.data, pageID: page.id, calendar: calendar)
      try Self.validateTaskParent(
        db,
        pageID: page.id,
        parentTaskID: data.parentTaskID
      )
      try Self.validateActiveTaskProjectStatus(db, data: data)
      var result = try PageDocument.setProperties(
        TaskFields.properties(for: data),
        ensuring: BuiltInSupertags.task,
        message: "Create task",
        in: page.document
      )
      if !draft.notes.isEmpty {
        result = try PageDocument.replaceBody(with: draft.notes, in: result.document)
      }
      let updated = Self.updatedPage(page, with: result, now: now)
      try Self.writePage(db, page: updated, cloudDirty: true)
      try Self.replaceReferences(db, pageID: updated.id, references: result.projection.references)
      try Self.enqueueTaskEffectOutbox(
        db,
        pageID: updated.id,
        generation: updated.dirtyGeneration,
        requestingAuthorization: draft.data.reminder != nil,
        now: now
      )
      return updated
    }
  }

  @discardableResult
  public func updateTask(
    pageID: PageID,
    data: TaskData,
    title: String? = nil,
    notes: String? = nil,
    expectedVersion: TaskPageVersion? = nil,
    now: Date = Date(),
    calendar: Calendar = .current,
    requestingReminderAuthorization: Bool? = nil
  ) throws -> PageSnapshot {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID),
        current.hasSupertag(BuiltInSupertags.task)
      else { throw LibraryRepositoryError.invalidRecord }
      if let expectedVersion {
        guard current.heads == expectedVersion.heads,
          current.dirtyGeneration == expectedVersion.dirtyGeneration
        else { throw LibraryRepositoryError.taskClarificationStale }
      }
      let normalizedData = Self.normalizedTaskData(
        data,
        pageID: pageID,
        previous: current.taskData,
        calendar: calendar
      )
      try Self.validateTaskParent(
        db,
        pageID: pageID,
        parentTaskID: normalizedData.parentTaskID
      )
      try Self.validateActiveTaskProjectStatus(db, data: normalizedData)
      var result = try PageDocument.setProperties(
        TaskFields.properties(for: normalizedData),
        ensuring: BuiltInSupertags.task,
        message: "Update task",
        in: current.document
      )
      if let title {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { throw LibraryRepositoryError.invalidRecord }
        result = try PageDocument.replaceTitle(with: normalized, in: result.document)
      }
      if let notes {
        result = try PageDocument.replaceBody(with: notes, in: result.document)
      }
      let updatedPage = Self.updatedPage(current, with: result, now: now)
      try Self.writePage(db, page: updatedPage, cloudDirty: true)
      try Self.replaceReferences(
        db,
        pageID: updatedPage.id,
        references: result.projection.references
      )
      try Self.enqueueTaskEffectOutbox(
        db,
        pageID: updatedPage.id,
        generation: updatedPage.dirtyGeneration,
        requestingAuthorization: requestingReminderAuthorization ?? (data.reminder != nil),
        now: now
      )
      return updatedPage
    }
  }

  /// Applies one explicitly confirmed clarification. The proposal's captured version is checked
  /// before any document preparation or write, so a stale confirmation has no partial effects.
  @discardableResult
  public func applyTaskClarification(
    pageID: PageID,
    draft: TaskClarificationDraft,
    expectedVersion: TaskPageVersion,
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> TaskClarificationMutationResult {
    try mutateTaskClarification(
      pageID: pageID,
      expectedVersion: expectedVersion,
      mutation: .apply(draft),
      now: now,
      calendar: calendar
    )
  }

  /// Defers an Inbox task without interpretation. Someday is intentionally unscheduled; deadline
  /// and reminder metadata remain independent and are preserved.
  @discardableResult
  public func moveClarificationTaskToSomeday(
    pageID: PageID,
    expectedVersion: TaskPageVersion,
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> TaskClarificationMutationResult {
    try mutateTaskClarification(
      pageID: pageID,
      expectedVersion: expectedVersion,
      mutation: .moveToSomeday,
      now: now,
      calendar: calendar
    )
  }

  @discardableResult
  public func undoTaskClarification(
    _ receipt: TaskClarificationUndoReceipt,
    now: Date = Date()
  ) throws -> TaskClarificationUndoResult {
    try database.write { db in
      let version = receipt.sourceAfterMutation
      guard let current = try Self.fetchPage(db, id: version.id),
        current.deletedAt == nil,
        current.heads == version.heads,
        current.dirtyGeneration == version.dirtyGeneration,
        let currentData = current.taskData
      else { throw LibraryRepositoryError.taskClarificationUndoUnavailable }

      try Self.validateTaskClarificationReferenceChanges(
        db,
        pageID: current.id,
        source: currentData,
        updated: receipt.sourceBeforeTaskData
      )
      var result = try PageDocument.setProperties(
        TaskFields.properties(for: receipt.sourceBeforeTaskData),
        ensuring: BuiltInSupertags.task,
        message: "Undo task clarification",
        in: current.document
      )
      result = try PageDocument.replaceTitle(
        with: receipt.sourceBeforeTitle,
        in: result.document
      )
      let restored = PreparedTaskPageWrite(
        page: Self.updatedPage(current, with: result, now: now),
        references: result.projection.references
      )
      try Self.writePreparedTaskPage(db, prepared: restored, now: now)
      return TaskClarificationUndoResult(restoredTask: restored.page)
    }
  }

  private enum TaskClarificationMutation {
    case apply(TaskClarificationDraft)
    case moveToSomeday

    var action: TaskClarificationActionKind {
      switch self {
      case .apply: .applyAndContinue
      case .moveToSomeday: .moveToSomeday
      }
    }

    var documentMessage: String {
      switch self {
      case .apply: "Clarify Inbox task"
      case .moveToSomeday: "Move Inbox task to Someday"
      }
    }
  }

  private func mutateTaskClarification(
    pageID: PageID,
    expectedVersion: TaskPageVersion,
    mutation: TaskClarificationMutation,
    now: Date,
    calendar: Calendar
  ) throws -> TaskClarificationMutationResult {
    try database.write { db in
      guard expectedVersion.id == pageID,
        let current = try Self.fetchPage(db, id: pageID),
        current.deletedAt == nil,
        current.heads == expectedVersion.heads,
        current.dirtyGeneration == expectedVersion.dirtyGeneration
      else { throw LibraryRepositoryError.taskClarificationStale }
      guard let sourceData = current.taskData,
        sourceData.state == .active,
        sourceData.placement == .inbox
      else { throw LibraryRepositoryError.taskNotClarifiable }

      let title: String
      var proposedData: TaskData
      switch mutation {
      case .apply(let draft):
        title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw LibraryRepositoryError.invalidRecord }
        proposedData = draft.applying(to: sourceData, placement: .anytime)
      case .moveToSomeday:
        title = current.title
        proposedData = sourceData
        proposedData.placement = .someday
        proposedData.scheduledAt = nil
      }
      let data = Self.normalizedTaskData(
        proposedData,
        pageID: pageID,
        previous: sourceData,
        calendar: calendar
      )
      try Self.validateTaskClarificationReferenceChanges(
        db,
        pageID: pageID,
        source: sourceData,
        updated: data
      )

      var result = try PageDocument.setProperties(
        TaskFields.properties(for: data),
        ensuring: BuiltInSupertags.task,
        message: mutation.documentMessage,
        in: current.document
      )
      if case .apply = mutation {
        result = try PageDocument.replaceTitle(with: title, in: result.document)
      }
      let prepared = PreparedTaskPageWrite(
        page: Self.updatedPage(current, with: result, now: now),
        references: result.projection.references
      )
      try Self.writePreparedTaskPage(db, prepared: prepared, now: now)
      return TaskClarificationMutationResult(
        task: prepared.page,
        undoReceipt: TaskClarificationUndoReceipt(
          action: mutation.action,
          sourceAfterMutation: TaskPageVersion(prepared.page),
          sourceBeforeTitle: current.title,
          sourceBeforeTaskData: sourceData
        )
      )
    }
  }

  @discardableResult
  public func completeTask(
    pageID: PageID,
    expectedVersion: TaskPageVersion? = nil,
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> TaskCompletionResult {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID), var data = current.taskData else {
        throw LibraryRepositoryError.invalidRecord
      }
      if let expectedVersion {
        guard current.heads == expectedVersion.heads,
          current.dirtyGeneration == expectedVersion.dirtyGeneration
        else { throw LibraryRepositoryError.taskClarificationStale }
      }
      guard data.state == .active else { throw LibraryRepositoryError.taskNotActive }

      let sourceBeforeTaskData = data
      data = Self.normalizedTaskData(
        data,
        pageID: pageID,
        previous: data,
        calendar: calendar,
        normalizingTemporalValues: false
      )
      var preparedSuccessor: (data: TaskData, id: PageID)?
      if data.recurrence != nil,
        var successorData = TaskTemporalPolicy.successorData(
          from: data,
          createdAt: current.createdAt,
          completedAt: now,
          calendar: calendar
        )
      {
        guard let seriesID = data.recurrenceSeriesID,
          let sequence = data.recurrenceSequence
        else { throw LibraryRepositoryError.invalidRecord }
        let (nextSequence, overflow) = sequence.addingReportingOverflow(1)
        guard !overflow else { throw LibraryRepositoryError.invalidRecord }
        successorData.recurrenceSeriesID = seriesID
        successorData.recurrenceSequence = nextSequence
        if let generation = TaskTemporalPolicy.completionSuccessorGeneration(
          from: data,
          successor: successorData,
          completedAt: now
        ) {
          data.completionSuccessorGeneration = generation
          successorData.completionSuccessorGeneration = generation
        }
        preparedSuccessor = (
          successorData,
          PageID.taskOccurrence(seriesID: seriesID, sequence: nextSequence)
        )
      }

      data.state = .completed
      data.completedAt = now
      let completedResult = try PageDocument.setProperties(
        TaskFields.properties(for: data),
        ensuring: BuiltInSupertags.task,
        message: "Complete task",
        in: current.document
      )
      let completed = Self.updatedPage(current, with: completedResult, now: now)
      try Self.writePage(db, page: completed, cloudDirty: true)
      try Self.enqueueTaskEffectOutbox(
        db,
        pageID: completed.id,
        generation: completed.dirtyGeneration,
        requestingAuthorization: false,
        now: now
      )

      guard let preparedSuccessor else {
        return TaskCompletionResult(
          completed: completed,
          successor: nil,
          undoReceipt: try Self.taskCompletionUndoReceipt(
            sourceBeforeTaskData: sourceBeforeTaskData,
            completed: completed,
            createdSuccessor: nil
          )
        )
      }
      let successorData = preparedSuccessor.data
      let successorID = preparedSuccessor.id

      if let existing = try Self.fetchPage(db, id: successorID) {
        guard let existingData = existing.taskData,
          existingData.recurrenceSeriesID == successorData.recurrenceSeriesID,
          existingData.recurrenceSequence == successorData.recurrenceSequence
        else { throw LibraryRepositoryError.invalidRecord }
        try Self.enqueueTaskEffectOutbox(
          db,
          pageID: existing.id,
          generation: existing.dirtyGeneration,
          requestingAuthorization: false,
          now: now
        )
        // This invocation did not create the deterministic successor, so it cannot safely offer
        // an inverse that removes it.
        return TaskCompletionResult(completed: completed, successor: existing, undoReceipt: nil)
      }

      // Fork before applying completion so independently-created successors share the original
      // Automerge ancestry and do not inherit a concurrent completed-at write from their parent.
      let fork = try PageDocument.fork(
        current.document,
        to: successorID,
        message: "Fork recurring task occurrence"
      )
      let successorBase = PageSnapshot(
        id: successorID,
        kind: .free,
        title: fork.projection.title,
        plainText: fork.projection.plainText,
        document: fork.document,
        heads: fork.heads,
        createdAt: now,
        modifiedAt: now,
        dirtyGeneration: 0,
        objectMetadata: fork.projection.objectMetadata
      )
      let successorResult = try PageDocument.setProperties(
        TaskFields.properties(for: successorData),
        ensuring: BuiltInSupertags.task,
        message: "Create recurring task",
        in: successorBase.document
      )
      let successor = Self.updatedPage(successorBase, with: successorResult, now: now)
      // Re-completing after an undo intentionally recreates the same deterministic occurrence.
      try db.execute(
        sql: "DELETE FROM purge_markers WHERE page_id = ?",
        arguments: [successor.id.rawValue]
      )
      try Self.writePage(db, page: successor, cloudDirty: true)
      try Self.replaceReferences(
        db,
        pageID: successor.id,
        references: successorResult.projection.references
      )
      try Self.enqueueTaskEffectOutbox(
        db,
        pageID: successor.id,
        generation: successor.dirtyGeneration,
        requestingAuthorization: false,
        now: now
      )
      return TaskCompletionResult(
        completed: completed,
        successor: successor,
        undoReceipt: try Self.taskCompletionUndoReceipt(
          sourceBeforeTaskData: sourceBeforeTaskData,
          completed: completed,
          createdSuccessor: successor
        )
      )
    }
  }

  @discardableResult
  public func undoTaskCompletion(
    _ receipt: TaskCompletionUndoReceipt,
    now: Date = Date()
  ) throws -> TaskCompletionUndoResult {
    try database.write { db in
      guard receipt.sourceBeforeTaskData.state == .active,
        let source = try Self.fetchPage(db, id: receipt.sourceAfterCompletion.id),
        source.deletedAt == nil,
        source.heads == receipt.sourceAfterCompletion.heads,
        source.dirtyGeneration == receipt.sourceAfterCompletion.dirtyGeneration,
        source.taskData?.state == .completed
      else { throw LibraryRepositoryError.taskCompletionUndoUnavailable }

      var successorToRemove: PageSnapshot?
      if let createdSuccessor = receipt.createdSuccessor {
        let sourceSeriesID = receipt.sourceBeforeTaskData.recurrenceSeriesID
          ?? .derived(from: source.id)
        let sourceSequence = receipt.sourceBeforeTaskData.recurrenceSequence ?? 0
        let (expectedSequence, overflow) = sourceSequence.addingReportingOverflow(1)
        guard receipt.sourceBeforeTaskData.recurrence != nil,
          !overflow,
          createdSuccessor.seriesID == sourceSeriesID,
          createdSuccessor.sequence == expectedSequence,
          createdSuccessor.version.id == PageID.taskOccurrence(
            seriesID: sourceSeriesID,
            sequence: expectedSequence
          ),
          let successor = try Self.fetchPage(db, id: createdSuccessor.version.id),
          successor.deletedAt == nil,
          successor.heads == createdSuccessor.version.heads,
          successor.dirtyGeneration == createdSuccessor.version.dirtyGeneration,
          let successorData = successor.taskData,
          successorData.recurrenceSeriesID == createdSuccessor.seriesID,
          successorData.recurrenceSequence == createdSuccessor.sequence,
          try Bool.fetchOne(
            db,
            sql: "SELECT EXISTS(SELECT 1 FROM page_references WHERE target_page_id = ?)",
            arguments: [successor.id.rawValue]
          ) != true,
          try Bool.fetchOne(
            db,
            sql: "SELECT EXISTS(SELECT 1 FROM purge_markers WHERE page_id = ?)",
            arguments: [successor.id.rawValue]
          ) != true
        else { throw LibraryRepositoryError.taskCompletionUndoUnavailable }
        successorToRemove = successor
      }

      let reopenedResult = try PageDocument.setProperties(
        TaskFields.properties(for: receipt.sourceBeforeTaskData),
        ensuring: BuiltInSupertags.task,
        message: "Undo task completion",
        in: source.document
      )
      let reopened = Self.updatedPage(source, with: reopenedResult, now: now)
      try Self.writePage(db, page: reopened, cloudDirty: true)
      try Self.replaceReferences(
        db,
        pageID: reopened.id,
        references: reopenedResult.projection.references
      )
      try Self.enqueueTaskEffectOutbox(
        db,
        pageID: reopened.id,
        generation: reopened.dirtyGeneration,
        requestingAuthorization: false,
        now: now
      )

      if let successorToRemove {
        let purgeGeneration = successorToRemove.dirtyGeneration + 1
        try db.execute(
          sql: """
            INSERT OR REPLACE INTO purge_markers
              (page_id,generation,purged_at,cloud_dirty)
            VALUES (?,?,?,1)
            """,
          arguments: [
            successorToRemove.id.rawValue,
            purgeGeneration,
            now.timeIntervalSince1970,
          ]
        )
        try Self.enqueueTaskEffectOutbox(
          db,
          pageID: successorToRemove.id,
          generation: purgeGeneration,
          requestingAuthorization: false,
          now: now
        )
        try db.execute(
          sql: "DELETE FROM pages WHERE id = ?",
          arguments: [successorToRemove.id.rawValue]
        )
      }

      return TaskCompletionUndoResult(
        reopened: reopened,
        removedSuccessorID: successorToRemove?.id
      )
    }
  }

  public static let maximumTaskBatchSize = 100

  @discardableResult
  public func completeTasks(
    _ pageIDs: [PageID],
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> TaskBatchMutationResult {
    try mutateTasks(pageIDs, mutation: .complete, now: now, calendar: calendar)
  }

  @discardableResult
  public func reopenTasks(
    _ pageIDs: [PageID],
    now: Date = Date()
  ) throws -> TaskBatchMutationResult {
    try mutateTasks(pageIDs, mutation: .reopen, now: now, calendar: .current)
  }

  @discardableResult
  public func cancelTasks(
    _ pageIDs: [PageID],
    now: Date = Date()
  ) throws -> TaskBatchMutationResult {
    try mutateTasks(pageIDs, mutation: .cancel, now: now, calendar: .current)
  }

  @discardableResult
  public func trashTasks(
    _ pageIDs: [PageID],
    now: Date = Date()
  ) throws -> TaskBatchMutationResult {
    try mutateTasks(pageIDs, mutation: .trash, now: now, calendar: .current)
  }

  @discardableResult
  public func patchTasks(
    _ pageIDs: [PageID],
    patch: TaskMetadataPatch,
    now: Date = Date(),
    calendar: Calendar = .current
  ) throws -> TaskBatchMutationResult {
    guard !patch.isEmpty else { throw LibraryRepositoryError.invalidRecord }
    return try mutateTasks(pageIDs, mutation: .patch(patch), now: now, calendar: calendar)
  }

  @discardableResult
  public func undoTaskBatch(
    _ receipt: TaskBatchUndoReceipt,
    now: Date = Date()
  ) throws -> TaskBatchUndoResult {
    let sourceIDs = Set(receipt.entries.map(\.sourceAfterMutation.id))
    let restoringTrashedSourceIDs = Set(
      receipt.entries.lazy
        .filter { $0.operation == .trash }
        .map(\.sourceAfterMutation.id)
    )
    try Self.validateTaskBatchIDs(Array(sourceIDs))
    guard sourceIDs.count == receipt.entries.count else {
      throw LibraryRepositoryError.invalidRecord
    }
    return try database.write { db in
      var restored: [PreparedTaskPageWrite] = []
      var successorsToRemove: [PageSnapshot] = []
      var successorIDs: Set<PageID> = []

      // Preflight the entire receipt before preparing or issuing a write. Heads and generation
      // checks make this the batch equivalent of the completion undo safety contract.
      for entry in receipt.entries {
        let version = entry.sourceAfterMutation
        guard let source = try Self.fetchPage(db, id: version.id),
          (entry.operation == .trash ? source.deletedAt != nil : source.deletedAt == nil),
          source.heads == version.heads,
          source.dirtyGeneration == version.dirtyGeneration,
          let currentData = source.taskData,
          Self.taskStatesMatchBatchOperation(
            current: currentData.state,
            before: entry.sourceBeforeTaskData.state,
            operation: entry.operation
          ),
          entry.operation != .trash || currentData == entry.sourceBeforeTaskData,
          entry.operation != .trash || entry.createdSuccessor == nil
        else { throw LibraryRepositoryError.taskCompletionUndoUnavailable }

        try Self.validateTaskDataReferences(
          db,
          pageID: source.id,
          data: entry.sourceBeforeTaskData,
          allowingDeletedPageIDs: restoringTrashedSourceIDs
        )

        if let createdSuccessor = entry.createdSuccessor {
          guard entry.operation == .complete,
            !sourceIDs.contains(createdSuccessor.version.id),
            successorIDs.insert(createdSuccessor.version.id).inserted,
            let recurrence = entry.sourceBeforeTaskData.recurrence,
            recurrence.interval > 0,
            let sourceSequence = entry.sourceBeforeTaskData.recurrenceSequence
          else { throw LibraryRepositoryError.taskCompletionUndoUnavailable }
          let seriesID = entry.sourceBeforeTaskData.recurrenceSeriesID
            ?? .derived(from: source.id)
          let (expectedSequence, overflow) = sourceSequence.addingReportingOverflow(1)
          guard !overflow,
            createdSuccessor.seriesID == seriesID,
            createdSuccessor.sequence == expectedSequence,
            createdSuccessor.version.id == PageID.taskOccurrence(
              seriesID: seriesID,
              sequence: expectedSequence
            ),
            let successor = try Self.fetchPage(db, id: createdSuccessor.version.id),
            successor.deletedAt == nil,
            successor.heads == createdSuccessor.version.heads,
            successor.dirtyGeneration == createdSuccessor.version.dirtyGeneration,
            let successorData = successor.taskData,
            successorData.recurrenceSeriesID == seriesID,
            successorData.recurrenceSequence == expectedSequence,
            try Bool.fetchOne(
              db,
              sql: "SELECT EXISTS(SELECT 1 FROM page_references WHERE target_page_id = ?)",
              arguments: [successor.id.rawValue]
            ) != true,
            try Bool.fetchOne(
              db,
              sql: "SELECT EXISTS(SELECT 1 FROM purge_markers WHERE page_id = ?)",
              arguments: [successor.id.rawValue]
            ) != true
          else { throw LibraryRepositoryError.taskCompletionUndoUnavailable }
          successorsToRemove.append(successor)
        }

        let result =
          if entry.operation == .trash {
            try PageDocument.setDeleted(nil, in: source.document)
          } else {
            try PageDocument.setProperties(
              TaskFields.properties(for: entry.sourceBeforeTaskData),
              ensuring: BuiltInSupertags.task,
              message: "Undo batch task mutation",
              in: source.document
            )
          }
        restored.append(
          PreparedTaskPageWrite(
            page: Self.updatedPage(source, with: result, now: now),
            references: result.projection.references
          )
        )
      }

      let restoredReferenceTargets = Set(restored.flatMap(\.references).map(\.targetPageID))
      guard restoredReferenceTargets.isDisjoint(with: successorIDs) else {
        throw LibraryRepositoryError.taskCompletionUndoUnavailable
      }

      for prepared in restored {
        try Self.writePreparedTaskPage(db, prepared: prepared, now: now)
      }
      for successor in successorsToRemove {
        let purgeGeneration = successor.dirtyGeneration + 1
        try db.execute(
          sql: """
            INSERT OR REPLACE INTO purge_markers
              (page_id,generation,purged_at,cloud_dirty)
            VALUES (?,?,?,1)
            """,
          arguments: [successor.id.rawValue, purgeGeneration, now.timeIntervalSince1970]
        )
        try Self.enqueueTaskEffectOutbox(
          db,
          pageID: successor.id,
          generation: purgeGeneration,
          requestingAuthorization: false,
          now: now
        )
        try db.execute(sql: "DELETE FROM pages WHERE id = ?", arguments: [successor.id.rawValue])
      }

      return TaskBatchUndoResult(
        restoredTasks: restored.map(\.page),
        removedSuccessorIDs: successorsToRemove.map(\.id)
      )
    }
  }

  private enum TaskBatchMutation {
    case complete
    case reopen
    case cancel
    case patch(TaskMetadataPatch)
    case trash

    var operation: TaskBatchOperation {
      switch self {
      case .complete: .complete
      case .reopen: .reopen
      case .cancel: .cancel
      case .patch: .patch
      case .trash: .trash
      }
    }

    var documentMessage: String {
      switch self {
      case .complete: "Complete task batch"
      case .reopen: "Reopen task batch"
      case .cancel: "Cancel task batch"
      case .patch: "Patch task batch"
      case .trash: "Move task batch to Trash"
      }
    }
  }

  private struct PreparedTaskPageWrite {
    var page: PageSnapshot
    var references: [PageReference]
  }

  private struct PreparedTaskBatchEntry {
    var source: PreparedTaskPageWrite
    var sourceBeforeTaskData: TaskData
    var createdSuccessor: PreparedTaskPageWrite?
  }

  private func mutateTasks(
    _ pageIDs: [PageID],
    mutation: TaskBatchMutation,
    now: Date,
    calendar: Calendar
  ) throws -> TaskBatchMutationResult {
    try Self.validateTaskBatchIDs(pageIDs)
    return try database.write { db in
      var preparedEntries: [PreparedTaskBatchEntry] = []
      var plannedSuccessorIDs: Set<PageID> = []

      // All task, lifecycle, relationship, and document checks happen in this phase. No database
      // write is issued until every selected task has a complete mutation plan.
      for pageID in pageIDs {
        guard let current = try Self.fetchPage(db, id: pageID),
          current.deletedAt == nil,
          let sourceBeforeTaskData = current.taskData
        else { throw LibraryRepositoryError.invalidRecord }

        var data = sourceBeforeTaskData
        var preparedSuccessor: PreparedTaskPageWrite?
        switch mutation {
        case .complete:
          guard data.state == .active else { throw LibraryRepositoryError.taskNotActive }
          data = Self.normalizedTaskData(
            data,
            pageID: pageID,
            previous: data,
            calendar: calendar,
            normalizingTemporalValues: false
          )
          if data.recurrence != nil,
            var successorData = TaskTemporalPolicy.successorData(
              from: data,
              createdAt: current.createdAt,
              completedAt: now,
              calendar: calendar
            )
          {
            guard let seriesID = data.recurrenceSeriesID,
              let sequence = data.recurrenceSequence
            else { throw LibraryRepositoryError.invalidRecord }
            let (nextSequence, overflow) = sequence.addingReportingOverflow(1)
            guard !overflow else { throw LibraryRepositoryError.invalidRecord }
            successorData.recurrenceSeriesID = seriesID
            successorData.recurrenceSequence = nextSequence
            if let generation = TaskTemporalPolicy.completionSuccessorGeneration(
              from: data,
              successor: successorData,
              completedAt: now
            ) {
              data.completionSuccessorGeneration = generation
              successorData.completionSuccessorGeneration = generation
            }
            let successorID = PageID.taskOccurrence(seriesID: seriesID, sequence: nextSequence)
            if let existing = try Self.fetchPage(db, id: successorID) {
              guard let existingData = existing.taskData,
                existingData.recurrenceSeriesID == seriesID,
                existingData.recurrenceSequence == nextSequence
              else { throw LibraryRepositoryError.invalidRecord }
            } else {
              guard plannedSuccessorIDs.insert(successorID).inserted else {
                throw LibraryRepositoryError.invalidRecord
              }
              try Self.validateTaskDataReferences(
                db,
                pageID: successorID,
                data: successorData
              )
              let fork = try PageDocument.fork(
                current.document,
                to: successorID,
                message: "Fork recurring task occurrence"
              )
              let successorBase = PageSnapshot(
                id: successorID,
                kind: .free,
                title: fork.projection.title,
                plainText: fork.projection.plainText,
                document: fork.document,
                heads: fork.heads,
                createdAt: now,
                modifiedAt: now,
                dirtyGeneration: 0,
                objectMetadata: fork.projection.objectMetadata
              )
              let result = try PageDocument.setProperties(
                TaskFields.properties(for: successorData),
                ensuring: BuiltInSupertags.task,
                message: "Create recurring task",
                in: successorBase.document
              )
              preparedSuccessor = PreparedTaskPageWrite(
                page: Self.updatedPage(successorBase, with: result, now: now),
                references: result.projection.references
              )
            }
          }
          data.state = .completed
          data.completedAt = now
        case .reopen:
          guard TaskLifecycleScope.closed.contains(data.state) else {
            throw LibraryRepositoryError.taskNotClosed
          }
          data.state = .active
          data.completedAt = nil
        case .cancel:
          guard data.state == .active else { throw LibraryRepositoryError.taskNotActive }
          data.state = .canceled
          data.completedAt = now
        case .patch(let patch):
          data = Self.normalizedTaskData(
            patch.applying(to: data),
            pageID: pageID,
            previous: data,
            calendar: calendar
          )
        case .trash:
          break
        }

        if case .trash = mutation {
          // Moving a task out of sight must remain possible even when a historical reference has
          // since become unavailable. Trash does not change task metadata or create references.
        } else {
          try Self.validateTaskDataReferences(db, pageID: pageID, data: data)
        }
        let result =
          if case .trash = mutation {
            try PageDocument.setDeleted(now, in: current.document)
          } else {
            try PageDocument.setProperties(
              TaskFields.properties(for: data),
              ensuring: BuiltInSupertags.task,
              message: mutation.documentMessage,
              in: current.document
            )
          }
        preparedEntries.append(
          PreparedTaskBatchEntry(
            source: PreparedTaskPageWrite(
              page: Self.updatedPage(current, with: result, now: now),
              references: result.projection.references
            ),
            sourceBeforeTaskData: sourceBeforeTaskData,
            createdSuccessor: preparedSuccessor
          )
        )
      }

      let entries = try preparedEntries.map { entry -> TaskBatchUndoEntry in
        let successorReceipt: TaskCreatedSuccessorReceipt?
        if let successor = entry.createdSuccessor?.page {
          guard let successorData = successor.taskData,
            let seriesID = successorData.recurrenceSeriesID,
            let sequence = successorData.recurrenceSequence
          else { throw LibraryRepositoryError.invalidRecord }
          successorReceipt = TaskCreatedSuccessorReceipt(
            version: TaskPageVersion(successor),
            seriesID: seriesID,
            sequence: sequence
          )
        } else {
          successorReceipt = nil
        }
        return TaskBatchUndoEntry(
          operation: mutation.operation,
          sourceAfterMutation: TaskPageVersion(entry.source.page),
          sourceBeforeTaskData: entry.sourceBeforeTaskData,
          createdSuccessor: successorReceipt
        )
      }

      for entry in preparedEntries {
        try Self.writePreparedTaskPage(db, prepared: entry.source, now: now)
        if let successor = entry.createdSuccessor {
          try db.execute(
            sql: "DELETE FROM purge_markers WHERE page_id = ?",
            arguments: [successor.page.id.rawValue]
          )
          try Self.writePreparedTaskPage(db, prepared: successor, now: now)
        }
      }
      return TaskBatchMutationResult(
        tasks: preparedEntries.map(\.source.page),
        createdSuccessors: preparedEntries.compactMap(\.createdSuccessor?.page),
        undoReceipt: TaskBatchUndoReceipt(entries: entries)
      )
    }
  }

  private static func validateTaskBatchIDs(_ pageIDs: [PageID]) throws {
    guard !pageIDs.isEmpty,
      pageIDs.count <= maximumTaskBatchSize,
      Set(pageIDs).count == pageIDs.count
    else { throw LibraryRepositoryError.invalidRecord }
  }

  private static func taskStatesMatchBatchOperation(
    current: TaskState,
    before: TaskState,
    operation: TaskBatchOperation
  ) -> Bool {
    switch operation {
    case .complete: current == .completed && before == .active
    case .reopen: current == .active && TaskLifecycleScope.closed.contains(before)
    case .cancel: current == .canceled && before == .active
    case .patch: current == before
    case .trash: current == before
    }
  }

  private static func activeTaskCount(
    _ db: Database,
    projectID: PageID
  ) throws -> Int {
    try activeProjectTasks(db, projectID: projectID).count
  }

  private static func activeProjectTasks(
    _ db: Database,
    projectID: PageID
  ) throws -> [PageSnapshot] {
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT DISTINCT p.*
        FROM pages p
        JOIN page_supertags s
          ON s.page_id = p.id AND s.supertag_id = ?
        JOIN page_property_values project
          ON project.page_id = p.id
          AND project.supertag_id = ?
          AND project.field_id = ?
          AND project.entity_page_id = ?
        WHERE p.deleted_at IS NULL
        """,
      arguments: [
        BuiltInSupertags.task.rawValue,
        BuiltInSupertags.task.rawValue,
        TaskFields.project.fieldID.rawValue,
        projectID.rawValue,
      ]
    )
    return try rows
      .map(Self.decodePage)
      .filter { $0.taskData?.isActive == true }
      .sorted { lhs, rhs in
        if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
        return lhs.id.rawValue < rhs.id.rawValue
      }
  }

  private static func writeProjectUpdate(
    _ db: Database,
    current: PageSnapshot,
    data: ProjectData,
    message: String,
    now: Date
  ) throws -> PageSnapshot {
    let result = try PageDocument.setProperties(
      ProjectFields.properties(for: data),
      ensuring: BuiltInSupertags.project,
      message: message,
      in: current.document
    )
    let updated = updatedPage(current, with: result, now: now)
    try writePage(db, page: updated, cloudDirty: true)
    try replaceReferences(db, pageID: updated.id, references: result.projection.references)
    return updated
  }

  private static func validateTaskDataReferences(
    _ db: Database,
    pageID: PageID,
    data: TaskData,
    allowingDeletedPageIDs: Set<PageID> = []
  ) throws {
    try validateTaskParent(
      db,
      pageID: pageID,
      parentTaskID: data.parentTaskID,
      allowingDeletedPageIDs: allowingDeletedPageIDs
    )

    let area: PageSnapshot?
    if let areaID = data.areaID {
      guard let candidate = try fetchPage(db, id: areaID),
        candidate.deletedAt == nil || allowingDeletedPageIDs.contains(candidate.id),
        candidate.hasSupertag(BuiltInSupertags.area)
      else { throw LibraryRepositoryError.invalidRecord }
      area = candidate
    } else {
      area = nil
    }

    if let projectID = data.projectID {
      guard let project = try fetchPage(db, id: projectID),
        project.deletedAt == nil || allowingDeletedPageIDs.contains(project.id),
        let projectData = project.projectData
      else { throw LibraryRepositoryError.invalidRecord }
      try validateActiveTaskProjectStatus(db, data: data)
      if let projectAreaID = projectData.areaID {
        guard let projectArea = try fetchPage(db, id: projectAreaID),
          projectArea.deletedAt == nil || allowingDeletedPageIDs.contains(projectArea.id),
          projectArea.hasSupertag(BuiltInSupertags.area),
          area == nil || area?.id == projectAreaID
        else { throw LibraryRepositoryError.invalidRecord }
      }
    }

    for assigneeID in data.assigneeIDs {
      guard let assignee = try fetchPage(db, id: assigneeID),
        assignee.deletedAt == nil || allowingDeletedPageIDs.contains(assignee.id),
        assignee.hasSupertag(BuiltInSupertags.person)
      else { throw LibraryRepositoryError.invalidRecord }
    }
  }

  /// Keeps direct task writes compatible with their existing permissive reference handling while
  /// enforcing the project lifecycle invariant whenever the referenced project is locally known.
  private static func validateActiveTaskProjectStatus(
    _ db: Database,
    data: TaskData
  ) throws {
    guard data.isActive,
      let projectID = data.projectID,
      let project = try fetchPage(db, id: projectID),
      project.deletedAt == nil,
      let projectData = project.projectData,
      !projectData.status.isOpen
    else { return }
    throw LibraryRepositoryError.taskProjectClosed(projectID: projectID)
  }

  /// Validates only references introduced or changed by clarification. Existing unresolved
  /// references are preserved byte-for-byte for sync compatibility and do not become a reason an
  /// otherwise independent clarification fails.
  private static func validateTaskClarificationReferenceChanges(
    _ db: Database,
    pageID: PageID,
    source: TaskData,
    updated: TaskData
  ) throws {
    if source.parentTaskID != updated.parentTaskID {
      try validateTaskParent(db, pageID: pageID, parentTaskID: updated.parentTaskID)
    }

    if source.areaID != updated.areaID, let areaID = updated.areaID {
      guard let area = try fetchPage(db, id: areaID),
        area.deletedAt == nil,
        area.hasSupertag(BuiltInSupertags.area)
      else { throw LibraryRepositoryError.invalidRecord }
    }

    if source.projectID != updated.projectID, let projectID = updated.projectID {
      guard let project = try fetchPage(db, id: projectID),
        project.deletedAt == nil,
        let projectData = project.projectData
      else { throw LibraryRepositoryError.invalidRecord }
      if let projectAreaID = projectData.areaID,
        let areaID = updated.areaID,
        areaID != projectAreaID
      {
        throw LibraryRepositoryError.invalidRecord
      }
    }

    let addedAssigneeIDs = Set(updated.assigneeIDs).subtracting(source.assigneeIDs)
    for assigneeID in addedAssigneeIDs {
      guard let assignee = try fetchPage(db, id: assigneeID),
        assignee.deletedAt == nil,
        assignee.hasSupertag(BuiltInSupertags.person)
      else { throw LibraryRepositoryError.invalidRecord }
    }

    if source.areaID != updated.areaID,
      let projectID = updated.projectID,
      let project = try fetchPage(db, id: projectID),
      let projectAreaID = project.projectData?.areaID,
      let areaID = updated.areaID,
      areaID != projectAreaID
    {
      throw LibraryRepositoryError.invalidRecord
    }
    try validateActiveTaskProjectStatus(db, data: updated)
  }

  private static func writePreparedTaskPage(
    _ db: Database,
    prepared: PreparedTaskPageWrite,
    now: Date
  ) throws {
    try writePage(db, page: prepared.page, cloudDirty: true)
    try replaceReferences(db, pageID: prepared.page.id, references: prepared.references)
    try enqueueTaskEffectOutbox(
      db,
      pageID: prepared.page.id,
      generation: prepared.page.dirtyGeneration,
      requestingAuthorization: false,
      now: now
    )
  }

  private static func taskCompletionUndoReceipt(
    sourceBeforeTaskData: TaskData,
    completed: PageSnapshot,
    createdSuccessor: PageSnapshot?
  ) throws -> TaskCompletionUndoReceipt {
    let successorReceipt: TaskCreatedSuccessorReceipt?
    if let createdSuccessor {
      guard let data = createdSuccessor.taskData,
        let seriesID = data.recurrenceSeriesID,
        let sequence = data.recurrenceSequence
      else { throw LibraryRepositoryError.invalidRecord }
      successorReceipt = TaskCreatedSuccessorReceipt(
        version: TaskPageVersion(createdSuccessor),
        seriesID: seriesID,
        sequence: sequence
      )
    } else {
      successorReceipt = nil
    }
    return TaskCompletionUndoReceipt(
      sourceAfterCompletion: TaskPageVersion(completed),
      sourceBeforeTaskData: sourceBeforeTaskData,
      createdSuccessor: successorReceipt
    )
  }

  private static func normalizedTaskData(
    _ data: TaskData,
    pageID: PageID,
    previous: TaskData? = nil,
    calendar: Calendar = .current,
    normalizingTemporalValues: Bool = true
  ) -> TaskData {
    var normalized: TaskData
    if normalizingTemporalValues {
      normalized = TaskTemporalPolicy.normalized(data, calendar: calendar)
    } else {
      normalized = data
    }
    if let recurrence = normalized.recurrence {
      normalized.recurrence = TaskTemporalPolicy.normalized(recurrence, calendar: calendar)
    }
    if normalizingTemporalValues, let previous {
      if data.scheduleGranularity == previous.scheduleGranularity,
        data.scheduledAt == previous.scheduledAt
      {
        normalized.scheduledAt = previous.scheduledAt
      }
      if data.deadline == previous.deadline {
        normalized.deadline = previous.deadline
      }
    }
    if let previous {
      if hasManualTemporalMutation(data, comparedWith: previous) {
        normalized.temporalProvenance = .manualMutation
      } else {
        normalized.temporalProvenance = previous.temporalProvenance
      }
    } else {
      normalized.temporalProvenance = nil
    }

    // Once established, a page's series cannot be reassigned and its sequence cannot move
    // backwards through an ordinary task edit.
    if let existingSeriesID = previous?.recurrenceSeriesID {
      normalized.recurrenceSeriesID = existingSeriesID
    }
    if let existingSequence = previous?.recurrenceSequence {
      normalized.recurrenceSequence = max(
        existingSequence,
        normalized.recurrenceSequence ?? existingSequence
      )
    } else if let sequence = normalized.recurrenceSequence {
      normalized.recurrenceSequence = max(0, sequence)
    }

    guard normalized.recurrence != nil else { return normalized }
    if normalized.recurrenceSeriesID == nil {
      normalized.recurrenceSeriesID = .derived(from: pageID)
    }
    if normalized.recurrenceSequence == nil {
      normalized.recurrenceSequence = 0
    }
    return normalized
  }

  private static func hasManualTemporalMutation(
    _ data: TaskData,
    comparedWith previous: TaskData
  ) -> Bool {
    data.scheduledAt != previous.scheduledAt
      || data.scheduleGranularity != previous.scheduleGranularity
      || data.deadline != previous.deadline
      || data.reminder != previous.reminder
      || data.recurrence != previous.recurrence
  }

  private static func validateTaskParent(
    _ db: Database,
    pageID: PageID,
    parentTaskID: PageID?,
    allowingDeletedPageIDs: Set<PageID> = []
  ) throws {
    var ancestorID = parentTaskID
    var visited: Set<PageID> = [pageID]
    while let candidateID = ancestorID {
      guard visited.insert(candidateID).inserted,
        let candidate = try fetchPage(db, id: candidateID),
        candidate.deletedAt == nil || allowingDeletedPageIDs.contains(candidate.id),
        let taskData = candidate.taskData
      else {
        throw LibraryRepositoryError.invalidRecord
      }
      ancestorID = taskData.parentTaskID
    }
  }

  private static func existingRecurrenceSuccessor(
    _ db: Database,
    data: TaskData
  ) throws -> PageSnapshot? {
    guard data.recurrence != nil,
      let seriesID = data.recurrenceSeriesID,
      let sequence = data.recurrenceSequence
    else { return nil }
    let (nextSequence, overflow) = sequence.addingReportingOverflow(1)
    guard !overflow else { return nil }
    let successorID = PageID.taskOccurrence(seriesID: seriesID, sequence: nextSequence)
    guard let successor = try fetchPage(db, id: successorID) else { return nil }
    guard let successorData = successor.taskData,
      successorData.recurrenceSeriesID == seriesID,
      successorData.recurrenceSequence == nextSequence
    else { throw LibraryRepositoryError.invalidRecord }
    return successor
  }

  @discardableResult
  public func reopenTask(pageID: PageID, now: Date = Date()) throws -> PageSnapshot {
    guard let current = try page(id: pageID), var data = current.taskData else {
      throw LibraryRepositoryError.invalidRecord
    }
    guard TaskLifecycleScope.closed.contains(data.state) else {
      throw LibraryRepositoryError.taskNotClosed
    }
    data.state = .active
    data.completedAt = nil
    return try updateTask(
      pageID: pageID,
      data: data,
      now: now,
      requestingReminderAuthorization: false
    )
  }

  @discardableResult
  public func cancelTask(pageID: PageID, now: Date = Date()) throws -> PageSnapshot {
    guard let current = try page(id: pageID), var data = current.taskData else {
      throw LibraryRepositoryError.invalidRecord
    }
    data.state = .canceled
    data.completedAt = now
    return try updateTask(
      pageID: pageID,
      data: data,
      now: now,
      requestingReminderAuthorization: false
    )
  }

  public func addSupertag(_ supertagID: SupertagID, to pageID: PageID, now: Date = Date()) throws {
    guard try supertags().contains(where: { $0.id == supertagID }) else {
      throw LibraryRepositoryError.invalidRecord
    }
    try mutateDocument(pageID: pageID, now: now) { current in
      try Self.addingSupertag(supertagID, in: current.document)
    }
    try database.write { db in
      try Self.reconcileCloudPrivacyDesiredStates(in: db)
    }
  }

  public func removeSupertag(_ supertagID: SupertagID, from pageID: PageID, now: Date = Date()) throws {
    try mutateDocument(
      pageID: pageID,
      now: now,
      afterWrite: { db, _ in
        guard supertagID == BuiltInSupertags.person else { return }
        // Removing an explicit Person tag removes its classification, but it is not a privacy
        // promotion. Reconciliation below preserves the page's already-established eligibility.
        try db.execute(
          sql: "UPDATE pages SET person_visibility = NULL, person_origin = NULL WHERE id = ?",
          arguments: [pageID.rawValue]
        )
      }
    ) { current in
      let untagged = try PageDocument.removeSupertag(supertagID, in: current.document)
      guard supertagID == BuiltInSupertags.person else { return untagged }
      return try PageDocument.clearPersonClassification(in: untagged.document)
    }
    try database.write { db in
      try Self.reconcileCloudPrivacyDesiredStates(in: db)
    }
  }

  public func setProperty(
    pageID: PageID,
    key: SupertagPropertyKey,
    values: [SupertagValue],
    now: Date = Date()
  ) throws {
    guard let schema = try supertags().first(where: { $0.id == key.supertagID }),
      let field = schema.fields.first(where: { $0.id == key.fieldID && !$0.isDeleted })
    else { throw LibraryRepositoryError.invalidRecord }
    let normalizedValues = try Self.validatedValues(values, key: key, field: field)
    let requestedProjectStatus: ProjectStatus? = {
      guard key == ProjectFields.status,
        normalizedValues.count == 1,
        case .select(let rawValue) = normalizedValues[0]
      else { return nil }
      return ProjectStatus(rawValue: rawValue)
    }()
    try mutateDocument(
      pageID: pageID,
      now: now,
      validation: { db, current in
        guard let requestedProjectStatus,
          !requestedProjectStatus.isOpen,
          current.projectData?.status.isOpen == true
        else { return }
        let activeTaskCount = try Self.activeTaskCount(db, projectID: pageID)
        guard activeTaskCount == 0 else {
          throw LibraryRepositoryError.projectHasActiveTasks(count: activeTaskCount)
        }
      },
      afterWrite: { db, updated in
        guard key == Self.personEmailKey else { return }
        try Self.removeStaleContactLink(db, for: updated)
      },
      mutation: { current in
        if let requestedProjectStatus, var data = current.projectData {
          data.status = requestedProjectStatus
          data.closedAt = requestedProjectStatus.isOpen ? nil : (data.closedAt ?? now)
          return try PageDocument.setProperties(
            ProjectFields.properties(for: data),
            ensuring: BuiltInSupertags.project,
            message: "Update project status",
            in: current.document
          )
        }
        if key == ProjectFields.closedAt, var data = current.projectData {
          let requestedDate = normalizedValues.first.flatMap { value -> Date? in
            switch value {
            case .date(let date), .dateTime(let date): date
            default: nil
            }
          }
          data.closedAt = data.status.isOpen ? nil : (requestedDate ?? data.closedAt ?? now)
          return try PageDocument.setProperties(
            ProjectFields.properties(for: data),
            ensuring: BuiltInSupertags.project,
            message: "Update project closure history",
            in: current.document
          )
        }
        return try PageDocument.setProperty(
          key: key,
          values: normalizedValues,
          in: current.document
        )
      }
    )
  }

  public func saveSupertag(
    _ definition: SupertagDefinition,
    now: Date = Date()
  ) throws {
    guard !definition.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw LibraryRepositoryError.invalidRecord
    }
    try database.write { db in
      if let data = try Data.fetchOne(
        db,
        sql: "SELECT definition_json FROM supertag_schemas WHERE id = ?",
        arguments: [definition.id.rawValue]
      ), let previous = try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data) {
        for field in definition.fields {
          guard let old = previous.fields.first(where: { $0.id == field.id }),
            old.type != field.type || old.allowsMultiple != field.allowsMultiple
          else { continue }
          let count = try Int.fetchOne(
            db,
            sql: "SELECT COUNT(*) FROM page_property_values WHERE supertag_id = ? AND field_id = ?",
            arguments: [definition.id.rawValue, field.id.rawValue]
          ) ?? 0
          guard count == 0 else { throw LibraryRepositoryError.invalidRecord }
        }
      }
      try db.execute(
        sql: """
          INSERT INTO supertag_schemas
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty)
          VALUES (?,?,?,?,COALESCE((SELECT sort_order FROM supertag_schemas WHERE id = ?),999),?,1,1)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=excluded.deleted,
            modified_at=excluded.modified_at,
            dirty_generation=supertag_schemas.dirty_generation + 1,
            cloud_dirty=1
          """,
        arguments: [
          definition.id.rawValue,
          definition.name,
          try JSONEncoder.enchiridion.encode(definition),
          definition.isDeleted,
          definition.id.rawValue,
          now.timeIntervalSince1970,
        ]
      )
      try GraphDatabaseSchema.rebuildTagClosure(in: db)
      try Self.reconcileCloudPrivacyDesiredStates(in: db)
      try GraphProjectionStore.refreshIssues(in: db)
    }
  }

  public func dirtySupertags() throws -> [SupertagCloudRecord] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT * FROM supertag_schemas WHERE cloud_dirty = 1 AND id NOT LIKE 'dev.rawkode.enchiridion.%' ORDER BY modified_at"
      ).compactMap(Self.decodeSupertagCloudRecord)
    }
  }

  public func supertagCloudRecord(id: SupertagID) throws -> SupertagCloudRecord? {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return nil }
    return try database.read { db in
      try Row.fetchOne(
        db,
        sql: "SELECT * FROM supertag_schemas WHERE id = ?",
        arguments: [id.rawValue]
      ).flatMap(Self.decodeSupertagCloudRecord)
    }
  }

  @discardableResult
  public func markSupertagCloudSaved(
    id: SupertagID,
    sentGeneration: Int64,
    systemFields: Data
  ) throws -> Bool {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return false }
    return try database.write { db in
      try db.execute(
        sql: """
          UPDATE supertag_schemas
          SET cloud_record = ?,
              cloud_synced_generation = MAX(cloud_synced_generation, ?),
              cloud_dirty = CASE WHEN dirty_generation <= ? THEN 0 ELSE 1 END
          WHERE id = ?
          """,
        arguments: [systemFields, sentGeneration, sentGeneration, id.rawValue]
      )
      return try Bool.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM supertag_schemas WHERE id = ?",
        arguments: [id.rawValue]
      ) ?? false
    }
  }

  @discardableResult
  public func mergeCloudSupertag(
    id: SupertagID,
    definition: SupertagDefinition,
    isDeleted: Bool,
    sortOrder: Int,
    modifiedAt: Date,
    dirtyGeneration: Int64,
    systemFields: Data
  ) throws -> Bool {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return false }
    return try database.write { db in
      var normalized = definition
      normalized.id = id
      normalized.isDeleted = isDeleted
      if let localIsDirty = try Bool.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM supertag_schemas WHERE id = ?",
        arguments: [id.rawValue]
      ), localIsDirty {
        try db.execute(
          sql: "UPDATE supertag_schemas SET cloud_record = ?, cloud_dirty = 1 WHERE id = ?",
          arguments: [systemFields, id.rawValue]
        )
        return true
      }
      try db.execute(
        sql: """
          INSERT INTO supertag_schemas
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,
             cloud_dirty,cloud_synced_generation,cloud_record)
          VALUES (?,?,?,?,?,?,?,0,?,?)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=excluded.deleted,
            sort_order=excluded.sort_order,
            modified_at=excluded.modified_at,
            dirty_generation=excluded.dirty_generation,
            cloud_dirty=0,
            cloud_synced_generation=excluded.cloud_synced_generation,
            cloud_record=excluded.cloud_record
          """,
        arguments: [
          id.rawValue,
          normalized.name,
          try JSONEncoder.enchiridion.encode(normalized),
          isDeleted,
          sortOrder,
          modifiedAt.timeIntervalSince1970,
          dirtyGeneration,
          dirtyGeneration,
          systemFields,
        ]
      )
      try GraphDatabaseSchema.rebuildTagClosure(in: db)
      try Self.reconcileCloudPrivacyDesiredStates(in: db)
      try GraphProjectionStore.refreshIssues(in: db)
      return false
    }
  }

  @discardableResult
  public func applyCloudSupertagRecordDeletion(id: SupertagID) throws -> Bool {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return false }
    return try database.write { db in
      guard let localIsDirty = try Bool.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM supertag_schemas WHERE id = ?",
        arguments: [id.rawValue]
      ) else { return false }
      if localIsDirty {
        try db.execute(
          sql: "UPDATE supertag_schemas SET cloud_record = NULL, cloud_dirty = 1 WHERE id = ?",
          arguments: [id.rawValue]
        )
        return true
      }
      try db.execute(
        sql: """
          UPDATE supertag_schemas
          SET deleted = 1, cloud_record = NULL, cloud_dirty = 0,
              cloud_synced_generation = dirty_generation
          WHERE id = ?
          """,
        arguments: [id.rawValue]
      )
      try GraphDatabaseSchema.rebuildTagClosure(in: db)
      try Self.reconcileCloudPrivacyDesiredStates(in: db)
      try GraphProjectionStore.refreshIssues(in: db)
      return false
    }
  }

  public func clearSupertagCloudRecordMetadata(id: SupertagID) throws {
    guard !ModuleNamespace.isCompiledIdentifier(id.rawValue) else { return }
    try database.write { db in
      try db.execute(
        sql: "UPDATE supertag_schemas SET cloud_record = NULL, cloud_dirty = 1 WHERE id = ?",
        arguments: [id.rawValue]
      )
    }
  }

  public func savedViews() throws -> [LiveQueryDefinition] {
    try database.read { db in
      try Row.fetchAll(db, sql: "SELECT definition_json FROM saved_query_views WHERE deleted = 0 ORDER BY sort_order,name")
        .compactMap { row in
          guard let data: Data = row["definition_json"] else { return nil }
          return try? JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: data)
        }
    }
  }

  public func whiteboardDocuments() throws -> [LiveQueryID: WhiteboardDocument] {
    try database.read { db in
      var documents: [LiveQueryID: WhiteboardDocument] = [:]
      for row in try Row.fetchAll(
        db,
        sql: "SELECT id,whiteboard_json FROM saved_query_views WHERE deleted = 0"
      ) {
        guard let rawID: String = row["id"] else { continue }
        documents[.init(rawValue: rawID)] = try Self.decodeWhiteboardDocument(row["whiteboard_json"])
      }
      return documents
    }
  }

  public func whiteboardDocument(for viewID: LiveQueryID) throws -> WhiteboardDocument? {
    try database.read { db in
      guard let row = try Row.fetchOne(
        db,
        sql: "SELECT whiteboard_json FROM saved_query_views WHERE id = ? AND deleted = 0",
        arguments: [viewID.rawValue]
      ) else { return nil }
      return try Self.decodeWhiteboardDocument(row["whiteboard_json"])
    }
  }

  public func saveView(_ definition: LiveQueryDefinition, now: Date = Date()) throws {
    _ = try DomainQueryCodec.parse(definition.domainSQL, id: definition.id, name: definition.name)
    try database.write { db in
      try db.execute(
        sql: """
          INSERT INTO saved_query_views
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty,whiteboard_json)
          VALUES (?,?,?,?,COALESCE((SELECT sort_order FROM saved_query_views WHERE id = ?),999),?,1,1,?)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=excluded.deleted,
            modified_at=excluded.modified_at,
            dirty_generation=saved_query_views.dirty_generation + 1,
            cloud_dirty=1
          """,
        arguments: [
          definition.id.rawValue,
          definition.name,
          try JSONEncoder.enchiridion.encode(definition),
          false,
          definition.id.rawValue,
          now.timeIntervalSince1970,
          try Self.encodeWhiteboardDocument(.empty),
        ]
      )
    }
  }

  public func duplicateView(
    _ definition: LiveQueryDefinition,
    from sourceID: LiveQueryID,
    now: Date = Date()
  ) throws {
    guard definition.id != sourceID else { throw LibraryRepositoryError.invalidRecord }
    _ = try DomainQueryCodec.parse(definition.domainSQL, id: definition.id, name: definition.name)
    try database.write { db in
      guard let source = try Row.fetchOne(
        db,
        sql: "SELECT whiteboard_json FROM saved_query_views WHERE id = ? AND deleted = 0",
        arguments: [sourceID.rawValue]
      ) else { throw WhiteboardError.viewNotFound }
      var whiteboard = try Self.decodeWhiteboardDocument(source["whiteboard_json"])
      whiteboard.revision = 0
      try db.execute(
        sql: """
          INSERT INTO saved_query_views
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty,whiteboard_json)
          VALUES (?,?,?,?,999,?,1,1,?)
          """,
        arguments: [
          definition.id.rawValue,
          definition.name,
          try JSONEncoder.enchiridion.encode(definition),
          false,
          now.timeIntervalSince1970,
          try Self.encodeWhiteboardDocument(whiteboard),
        ]
      )
    }
  }

  public func deleteView(_ id: LiveQueryID, now: Date = Date()) throws {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET deleted = 1, whiteboard_json = ?, modified_at = ?,
              dirty_generation = dirty_generation + 1, cloud_dirty = 1
          WHERE id = ?
          """,
        arguments: [try Self.encodeWhiteboardDocument(.empty), now.timeIntervalSince1970, id.rawValue]
      )
    }
  }

  @discardableResult
  public func replaceWhiteboardDocument(
    _ document: WhiteboardDocument,
    for viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) {
      $0 = document
    }
  }

  @discardableResult
  public func upsertWhiteboardElements(
    _ elements: [WhiteboardElement],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    guard elements.count <= WhiteboardLimits.maximumElementsPerMutation else {
      throw WhiteboardError.limitExceeded(
        "A single canvas edit can change at most \(WhiteboardLimits.maximumElementsPerMutation) elements."
      )
    }
    guard Set(elements.map(\.id)).count == elements.count else {
      throw WhiteboardError.invalid("A canvas edit cannot contain duplicate element identifiers.")
    }
    return try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) { document in
      for element in elements {
        if let index = document.elements.firstIndex(where: { $0.id == element.id }) {
          var replacement = element
          replacement.zIndex = document.elements[index].zIndex
          document.elements[index] = replacement
        } else {
          document.elements.append(element)
        }
      }
    }
  }

  @discardableResult
  public func moveWhiteboardElements(
    _ moves: [WhiteboardElementMove],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    guard moves.count <= WhiteboardLimits.maximumElementsPerMutation else {
      throw WhiteboardError.limitExceeded(
        "A single canvas edit can move at most \(WhiteboardLimits.maximumElementsPerMutation) elements."
      )
    }
    guard Set(moves.map(\.elementID)).count == moves.count else {
      throw WhiteboardError.invalid("A canvas edit cannot move the same element twice.")
    }
    return try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) { document in
      for move in moves {
        guard move.deltaX.isFinite, move.deltaY.isFinite,
          let index = document.elements.firstIndex(where: { $0.id == move.elementID })
        else { throw WhiteboardError.elementNotFound(move.elementID) }
        document.elements[index] = document.elements[index].translated(
          x: move.deltaX,
          y: move.deltaY
        )
      }
    }
  }

  @discardableResult
  public func deleteWhiteboardElements(
    _ elementIDs: Set<WhiteboardElementID>,
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    guard elementIDs.count <= WhiteboardLimits.maximumElementsPerMutation else {
      throw WhiteboardError.limitExceeded(
        "A single canvas edit can delete at most \(WhiteboardLimits.maximumElementsPerMutation) elements."
      )
    }
    return try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) { document in
      document.elements.removeAll { elementIDs.contains($0.id) }
      document.elements = document.elements.map { element in
        guard case .arrow(var arrow) = element.kind else { return element }
        if let start = arrow.start, elementIDs.contains(start.elementID) { arrow.start = nil }
        if let end = arrow.end, elementIDs.contains(end.elementID) { arrow.end = nil }
        var copy = element
        copy.kind = .arrow(arrow)
        return copy
      }
    }
  }

  @discardableResult
  public func connectWhiteboardArrow(
    _ arrowID: WhiteboardElementID,
    start: WhiteboardConnectionEndpoint?,
    end: WhiteboardConnectionEndpoint?,
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) { document in
      guard let index = document.elements.firstIndex(where: { $0.id == arrowID }) else {
        throw WhiteboardError.elementNotFound(arrowID)
      }
      guard case .arrow(var arrow) = document.elements[index].kind else {
        throw WhiteboardError.elementIsNotArrow(arrowID)
      }
      arrow.start = start
      arrow.end = end
      document.elements[index].kind = .arrow(arrow)
    }
  }

  @discardableResult
  public func disconnectWhiteboardArrow(
    _ arrowID: WhiteboardElementID,
    endpoint: WhiteboardArrowEndpoint,
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) { document in
      guard let index = document.elements.firstIndex(where: { $0.id == arrowID }) else {
        throw WhiteboardError.elementNotFound(arrowID)
      }
      guard case .arrow(var arrow) = document.elements[index].kind else {
        throw WhiteboardError.elementIsNotArrow(arrowID)
      }
      switch endpoint {
      case .start: arrow.start = nil
      case .end: arrow.end = nil
      }
      document.elements[index].kind = .arrow(arrow)
    }
  }

  @discardableResult
  public func ensureWhiteboardPageCards(
    _ pageIDs: [PageID],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    try validatePageCardMutation(pageIDs)
    return try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) { document in
      let existingPages = Set(document.elements.compactMap { element -> PageID? in
        guard case .page(let pageID) = element.kind else { return nil }
        return pageID
      })
      let missing = Set(pageIDs).subtracting(existingPages).sorted { $0.rawValue < $1.rawValue }
      let startIndex = existingPages.count
      for (offset, pageID) in missing.enumerated() {
        document.elements.append(Self.pageCard(pageID, layoutIndex: startIndex + offset))
      }
    }
  }

  /// Ensures cards for the current query result without deleting inactive cards. Retaining inactive
  /// placements lets filtering hide and later restore a card at the user's chosen position.
  @discardableResult
  public func reconcileWhiteboardPageCards(
    _ pageIDs: [PageID],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    try ensureWhiteboardPageCards(
      pageIDs,
      in: viewID,
      expectedRevision: expectedRevision,
      now: now
    )
  }

  @discardableResult
  public func resetWhiteboardPageCards(
    _ pageIDs: [PageID],
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    try validatePageCardMutation(pageIDs)
    let orderedPageIDs = Array(Set(pageIDs)).sorted { $0.rawValue < $1.rawValue }
    return try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) { document in
      for (layoutIndex, pageID) in orderedPageIDs.enumerated() {
        let card = Self.pageCard(pageID, layoutIndex: layoutIndex)
        if let index = document.elements.firstIndex(where: {
          guard case .page(let currentPageID) = $0.kind else { return false }
          return currentPageID == pageID
        }) {
          document.elements[index].bounds = card.bounds
        } else {
          document.elements.append(card)
        }
      }
    }
  }

  @discardableResult
  public func updateWhiteboardViewport(
    _ viewport: WhiteboardViewport,
    in viewID: LiveQueryID,
    expectedRevision: Int64? = nil,
    now: Date = Date()
  ) throws -> WhiteboardMutationReceipt {
    try WhiteboardDocumentValidator.validate(viewport: viewport)
    return try mutateWhiteboard(viewID: viewID, expectedRevision: expectedRevision, now: now) {
      $0.viewport = viewport
    }
  }

  public func whiteboardFitMetadata(
    for viewID: LiveQueryID,
    viewportSize: WhiteboardSize,
    padding: Double = 48
  ) throws -> WhiteboardFitMetadata {
    try WhiteboardDocumentValidator.validate(size: viewportSize)
    guard padding.isFinite, (0...10_000).contains(padding) else {
      throw WhiteboardError.invalid("Canvas fit padding is outside the supported range.")
    }
    guard let document = try whiteboardDocument(for: viewID) else {
      throw WhiteboardError.viewNotFound
    }
    guard let contentBounds = document.elements.map(\.bounds).reduce(nil, { partial, bounds in
      partial.map { $0.union(bounds) } ?? bounds
    }) else {
      return .init(contentBounds: nil, viewport: .init())
    }
    let paddedWidth = max(contentBounds.width + padding * 2, 1)
    let paddedHeight = max(contentBounds.height + padding * 2, 1)
    let zoom = min(
      WhiteboardLimits.maximumZoom,
      max(
        WhiteboardLimits.minimumZoom,
        min(viewportSize.width / paddedWidth, viewportSize.height / paddedHeight)
      )
    )
    return .init(
      contentBounds: contentBounds,
      viewport: .init(
        center: .init(x: contentBounds.midX, y: contentBounds.midY),
        zoom: zoom
      )
    )
  }

  public func dirtyViews() throws -> [SavedViewCloudRecord] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT * FROM saved_query_views WHERE cloud_dirty = 1 ORDER BY modified_at"
      ).compactMap(Self.decodeSavedViewCloudRecord)
    }
  }

  public func savedViewCloudRecord(id: LiveQueryID) throws -> SavedViewCloudRecord? {
    try database.read { db in
      try Row.fetchOne(db, sql: "SELECT * FROM saved_query_views WHERE id = ?", arguments: [id.rawValue])
        .flatMap(Self.decodeSavedViewCloudRecord)
    }
  }

  @discardableResult
  public func markViewCloudSaved(
    id: LiveQueryID,
    sentGeneration: Int64,
    systemFields: Data
  ) throws -> Bool {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET cloud_record = ?,
              cloud_synced_generation = MAX(cloud_synced_generation, ?),
              cloud_dirty = CASE WHEN dirty_generation <= ? THEN 0 ELSE 1 END
          WHERE id = ?
          """,
        arguments: [systemFields, sentGeneration, sentGeneration, id.rawValue]
      )
      return try Bool.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM saved_query_views WHERE id = ?",
        arguments: [id.rawValue]
      ) ?? false
    }
  }

  @discardableResult
  public func mergeCloudView(
    id: LiveQueryID,
    definition: LiveQueryDefinition,
    isDeleted: Bool,
    sortOrder: Int,
    modifiedAt: Date,
    dirtyGeneration: Int64,
    systemFields: Data,
    whiteboardDocument: WhiteboardDocument? = nil
  ) throws -> Bool {
    try database.write { db in
      var normalizedDefinition = definition
      normalizedDefinition.id = id
      var existingWhiteboardData: Data?
      var existingLocalGeneration: Int64 = 0
      if let row = try Row.fetchOne(
        db,
        sql: """
          SELECT modified_at,dirty_generation,cloud_dirty,whiteboard_json
          FROM saved_query_views WHERE id = ?
          """,
        arguments: [id.rawValue]
      ) {
        existingWhiteboardData = row["whiteboard_json"]
        let localGeneration: Int64 = row["dirty_generation"] ?? 0
        existingLocalGeneration = localGeneration
        let localIsDirty: Bool = row["cloud_dirty"] ?? false
        if localIsDirty {
          try db.execute(
            sql: "UPDATE saved_query_views SET cloud_record = ?, cloud_dirty = 1 WHERE id = ?",
            arguments: [systemFields, id.rawValue]
          )
          return true
        }
      }
      let whiteboardData: Data
      if isDeleted {
        whiteboardData = try Self.encodeWhiteboardDocument(.empty)
      } else if let whiteboardDocument {
        whiteboardData = try Self.encodeWhiteboardDocument(whiteboardDocument)
      } else {
        // Records created by older clients have no whiteboard field. Never let one erase local work.
        whiteboardData = try existingWhiteboardData ?? Self.encodeWhiteboardDocument(.empty)
      }
      let existingWhiteboardIsEmpty = try Self.decodeWhiteboardDocument(existingWhiteboardData) == .empty
      let preservingLegacyWhiteboard = !isDeleted
        && whiteboardDocument == nil
        && !existingWhiteboardIsEmpty
      let mergedGeneration = preservingLegacyWhiteboard
        ? max(dirtyGeneration, existingLocalGeneration) + 1
        : dirtyGeneration
      let syncedGeneration = preservingLegacyWhiteboard ? 0 : mergedGeneration
      try db.execute(
        sql: """
          INSERT INTO saved_query_views
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty,cloud_synced_generation,cloud_record,whiteboard_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=excluded.deleted,
            sort_order=excluded.sort_order,
            modified_at=excluded.modified_at,
            dirty_generation=excluded.dirty_generation,
            cloud_dirty=excluded.cloud_dirty,
            cloud_synced_generation=excluded.cloud_synced_generation,
            cloud_record=excluded.cloud_record,
            whiteboard_json=excluded.whiteboard_json
          """,
        arguments: [
          id.rawValue, normalizedDefinition.name, try JSONEncoder.enchiridion.encode(normalizedDefinition),
          isDeleted, sortOrder, modifiedAt.timeIntervalSince1970, mergedGeneration,
          preservingLegacyWhiteboard, syncedGeneration, systemFields, whiteboardData,
        ]
      )
      return preservingLegacyWhiteboard
    }
  }

  @discardableResult
  public func applyCloudViewRecordDeletion(id: LiveQueryID) throws -> Bool {
    try database.write { db in
      guard let row = try Row.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM saved_query_views WHERE id = ?",
        arguments: [id.rawValue]
      ) else { return false }
      let localIsDirty: Bool = row["cloud_dirty"] ?? false
      if localIsDirty {
        try db.execute(
          sql: "UPDATE saved_query_views SET cloud_record = NULL, cloud_dirty = 1 WHERE id = ?",
          arguments: [id.rawValue]
        )
        return true
      }
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET deleted = 1, whiteboard_json = ?, cloud_record = NULL,
              cloud_dirty = 0, cloud_synced_generation = dirty_generation
          WHERE id = ?
          """,
        arguments: [try Self.encodeWhiteboardDocument(.empty), id.rawValue]
      )
      return false
    }
  }

  public func run(_ definition: LiveQueryDefinition) throws -> [LiveQueryItem] {
    try database.read { db in
      var items: [LiveQueryItem] = []
      switch definition.source {
      case .pages:
        items = try Row.fetchAll(
          db,
          sql: "SELECT * FROM pages WHERE deleted_at IS NULL"
        ).map { .page(try Self.decodePage($0)) }
      case .supertag(let tagID):
        items = try Row.fetchAll(
          db,
          sql: """
            SELECT p.* FROM pages p JOIN page_supertags s ON s.page_id = p.id
            WHERE s.supertag_id = ? AND p.deleted_at IS NULL
            """,
          arguments: [tagID.rawValue]
        ).map { .page(try Self.decodePage($0)) }
      case .calendarEvents:
        items = try Self.liveCalendarItems(db, limit: 5_000)
      case .workCalendar:
        let startOfToday = Calendar.current.startOfDay(for: Date())
        items = try Self.liveCalendarItems(db, limit: 5_000, startingAt: startOfToday)
        let pages = try Row.fetchAll(
          db,
          sql: """
            SELECT DISTINCT p.*
            FROM pages p
            JOIN page_supertags s ON s.page_id = p.id
            JOIN page_property_values v
              ON v.page_id = p.id AND v.supertag_id = s.supertag_id
            WHERE p.deleted_at IS NULL AND v.date_value >= ? AND (
              (s.supertag_id = ? AND v.field_id = 'due') OR
              (s.supertag_id = ? AND v.field_id IN ('start-date','due-date'))
            )
            """,
          arguments: [
            startOfToday.timeIntervalSince1970,
            BuiltInSupertags.task.rawValue,
            BuiltInSupertags.project.rawValue,
          ]
        ).map { LiveQueryItem.page(try Self.decodePage($0)) }
        items.append(contentsOf: pages)
      }
      if definition.peopleScope == .promotedOnly {
        items.removeAll { item in
          guard case .page(let page) = item else { return false }
          return page.isOtherPerson
        }
      }
      items = items.filter { item in
        definition.filters.allSatisfy { Self.matches($0, item: item, definition: definition) }
      }
      items.sort { Self.isOrderedBefore($0, $1, definition: definition) }
      let effectiveLimit = definition.viewKind == .canvas
        ? min(definition.limit, WhiteboardLimits.maximumPageCards)
        : definition.limit
      return Array(items.prefix(effectiveLimit))
    }
  }

  public func replaceCalendarProjection(
    _ events: [CalendarEventSnapshot],
    provider: String,
    refreshedAt: Date = Date()
  ) throws -> [CalendarEventSnapshot] {
    try database.write { db in
      let omissionPrefixes = try Self.calendarEventOmissionPrefixes(db)
      var accepted: [CalendarEventSnapshot] = []
      try db.execute(sql: "UPDATE calendar_events SET active = 0 WHERE provider = ?", arguments: [provider])
      for sourceEvent in events where !CalendarEventOmissionRules.shouldOmit(
        title: sourceEvent.title,
        prefixes: omissionPrefixes
      ) {
        var event = sourceEvent
        if let series = event.identity.series {
          event.identity.series = try Self.resolveSeries(db, event: event, series: series)
        }
        accepted.append(event)
        try db.execute(
          sql: """
            INSERT INTO calendar_events
              (event_key,provider,event_json,start_at,end_at,active,refreshed_at,
               series_source_key,series_canonical_key)
            VALUES (?,?,?,?,?,1,?,?,?)
            ON CONFLICT(event_key) DO UPDATE SET
              event_json=excluded.event_json,
              start_at=excluded.start_at,
              end_at=excluded.end_at,
              active=1,
              refreshed_at=excluded.refreshed_at,
              series_source_key=excluded.series_source_key,
              series_canonical_key=excluded.series_canonical_key
            """,
          arguments: [
            Self.storageKey(event.identity.stableKey),
            provider,
            try JSONEncoder.enchiridion.encode(event),
            event.startDate.timeIntervalSince1970,
            event.endDate.timeIntervalSince1970,
            refreshedAt.timeIntervalSince1970,
            event.identity.series.map { Self.storageKey($0.sourceKey) },
            event.identity.series.map { Self.storageKey($0.canonicalKey) },
          ]
        )
        try Self.replaceAttendeeProjection(db, event: event, now: refreshedAt)
      }
      try db.execute(
        sql: """
          DELETE FROM calendar_event_attendees
          WHERE event_key IN (
            SELECT event_key FROM calendar_events WHERE provider = ? AND active = 0
          )
          """,
        arguments: [provider]
      )
      try db.execute(
        sql: "DELETE FROM calendar_events WHERE provider = ? AND active = 0 AND event_key NOT IN (SELECT event_key FROM event_page_map)",
        arguments: [provider]
      )
      try Self.pruneOrphanedCalendarPeople(db)
      return accepted
    }
  }

  public func calendarEvents(from start: Date, through end: Date) throws -> [CalendarEventSnapshot] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: """
          SELECT e.event_json,e.active,COALESCE(a.canonical_key,e.series_canonical_key) AS canonical_key
          FROM calendar_events e
          LEFT JOIN calendar_series_aliases a ON a.source_key = e.series_source_key
          WHERE e.active = 1 AND e.start_at < ? AND e.end_at > ?
          ORDER BY e.start_at
          """,
        arguments: [end.timeIntervalSince1970, start.timeIntervalSince1970]
      ).compactMap { row in
        guard let data: Data = row["event_json"],
          var event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
        else { return nil }
        let active: Bool = row["active"] ?? false
        event.isDetached = event.isDetached || !active
        if let canonicalKey: String = row["canonical_key"], let series = event.identity.series {
          event.identity.series = series.resolved(to: Self.rawKey(canonicalKey))
        }
        return event
      }
    }
  }

  /// Returns provider-owned meeting projections for a Person without creating a
  /// page, edge, or any other durable record.
  public func calendarMeetingRelationships(
    for personID: PageID,
    now: Date = Date()
  ) throws -> [CalendarMeetingRelationship] {
    try database.read { db in
      guard let person = try Self.fetchPage(db, id: personID),
        person.deletedAt == nil,
        try Self.effectiveTagIDs(db, nodeID: personID).contains(BuiltInSupertags.person)
      else { return [] }

      // Attendee mappings stay anchored to deterministic, provider-owned Person
      // IDs. At read time, every live Person with an exact normalized email is
      // intentionally a peer of that mapping, so duplicate user-visible People
      // sharing an email see the same meetings without mutating either record.
      let normalizedEmails = Set(
        Self.personEmails(in: person).compactMap { rawEmail in
          try? PersonEmail.normalize(rawEmail)
        }
      )
      guard !normalizedEmails.isEmpty else { return [] }
      let sortedEmails = normalizedEmails.sorted()
      let placeholders = Array(repeating: "?", count: sortedEmails.count).joined(separator: ",")
      let rows = try Row.fetchAll(
        db,
        sql: """
          SELECT e.event_json,
                 a.role AS attendee_role,
                 a.response_status AS attendee_response_status,
                 COALESCE(alias.canonical_key, e.series_canonical_key) AS canonical_series_key
          FROM calendar_events e
          JOIN calendar_event_attendees a ON a.event_key = e.event_key
          LEFT JOIN calendar_series_aliases alias ON alias.source_key = e.series_source_key
          WHERE e.active = 1 AND a.email IN (\(placeholders))
          """,
        arguments: StatementArguments(sortedEmails)
      )

      var byOccurrenceKey: [String: CalendarMeetingRelationship] = [:]
      for row in rows {
        guard let data: Data = row["event_json"],
          var event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data),
          let role: String = row["attendee_role"],
          let responseStatus: String = row["attendee_response_status"]
        else { continue }
        if let canonicalSeriesKey: String = row["canonical_series_key"],
          let series = event.identity.series
        {
          event.identity.series = series.resolved(to: Self.rawKey(canonicalSeriesKey))
        }
        let occurrenceKey = event.identity.series == nil
          ? event.identity.stableKey
          : event.identity.canonicalOccurrenceKey
        let timing: CalendarMeetingRelationship.Timing = event.endDate >= now ? .upcoming : .past
        let candidate = CalendarMeetingRelationship(
          id: occurrenceKey,
          event: event,
          attendeeRole: role,
          attendeeResponseStatus: responseStatus,
          timing: timing
        )
        if let existing = byOccurrenceKey[occurrenceKey] {
          let existingWinner = "\(existing.event.identity.provider)\u{0}\(existing.event.identity.stableKey)"
          let candidateWinner = "\(event.identity.provider)\u{0}\(event.identity.stableKey)"
          if candidateWinner < existingWinner { byOccurrenceKey[occurrenceKey] = candidate }
        } else {
          byOccurrenceKey[occurrenceKey] = candidate
        }
      }
      return byOccurrenceKey.values.sorted { lhs, rhs in
        switch (lhs.timing, rhs.timing) {
        case (.upcoming, .past): return true
        case (.past, .upcoming): return false
        case (.upcoming, .upcoming):
          return lhs.event.startDate == rhs.event.startDate ? lhs.id < rhs.id : lhs.event.startDate < rhs.event.startDate
        case (.past, .past):
          return lhs.event.startDate == rhs.event.startDate ? lhs.id < rhs.id : lhs.event.startDate > rhs.event.startDate
        }
      }
    }
  }

  public func calendarPageContexts() throws -> [PageID: CalendarPageContext] {
    try database.read { db in
      let pages = try Row.fetchAll(
        db,
        sql: "SELECT * FROM pages WHERE kind_tag IN ('calendarEvent','calendarSeries')"
      ).map(Self.decodePage)
      var contexts: [PageID: CalendarPageContext] = [:]

      for page in pages {
        switch page.kind {
        case .calendarEvent(let identity):
          let event = try Self.eventForPage(db, pageID: page.id)
          let series = event?.identity.series ?? identity.series
          let seriesPageID = try series.flatMap {
            try String.fetchOne(
              db,
              sql: "SELECT page_id FROM series_page_map WHERE series_key = ?",
              arguments: [Self.storageKey($0.canonicalKey)]
            ).map { PageID(rawValue: $0) }
          }
          let fallbackEvent = CalendarEventSnapshot(
            identity: identity,
            title: page.displayTitle,
            startDate: identity.occurrenceStart,
            endDate: identity.occurrenceStart,
            isAllDay: false,
            location: nil,
            notes: nil,
            url: nil,
            calendarTitle: "Calendar",
            isDetached: true
          )
          contexts[page.id] = CalendarPageContext(
            kind: .occurrence,
            event: event ?? fallbackEvent,
            series: series,
            seriesPageID: seriesPageID,
            calendarTitle: event?.calendarTitle,
            sourceUnavailable: event == nil || event?.isDetached == true
          )

        case .calendarSeries(let series):
          let occurrences = try Self.occurrenceNotes(db, seriesKey: series.canonicalKey)
          let calendarTitle = try Self.calendarTitle(db, seriesKey: series.canonicalKey)
          contexts[page.id] = CalendarPageContext(
            kind: .series,
            series: series,
            seriesPageID: page.id,
            calendarTitle: calendarTitle,
            occurrences: occurrences,
            sourceUnavailable: calendarTitle == nil
          )

        case .calendarMaterializedEvent, .daily, .free:
          break
        }
      }
      return contexts
    }
  }

  public func dirtyPages() throws -> [PageSnapshot] {
    try database.write { db in
      try Self.reconcileCloudPrivacyDesiredStates(in: db)
      return try Row.fetchAll(
        db,
        sql: """
          SELECT * FROM pages
          WHERE cloud_dirty = 1 AND person_cloud_eligible = 1
          ORDER BY modified_at
          """
      )
        .map(Self.decodePage)
    }
  }

  /// Returns a page only when it is currently eligible for CloudKit upload. This check is used
  /// while preparing a pending record so a queue entry created before a person was classified as
  /// local-only cannot leak that page later.
  public func cloudEligiblePage(pageID: PageID) throws -> PageSnapshot? {
    try database.read { db in
      try Row.fetchOne(
        db,
        sql: "SELECT * FROM pages WHERE id = ? AND person_cloud_eligible = 1",
        arguments: [pageID.rawValue]
      ).map(Self.decodePage)
    }
  }

  /// Claims current privacy-removal delete intents. The desired row remains after a successful
  /// acknowledgement so a steady local-only Person never recreates the deletion.
  public func claimCloudPrivacyRemovalsForSync() throws -> [CloudPrivacyRemoval] {
    try database.write { db in
      try LibraryRepository.reconcileCloudPrivacyDesiredStates(in: db)
      let removals = try Row.fetchAll(
        db,
        sql: """
          SELECT page_id,generation FROM page_cloud_privacy_states
          WHERE desired_operation = 'delete'
            AND acknowledged_generation < generation
            AND enqueued_generation < generation
          ORDER BY page_id
          """
      ).compactMap { row -> CloudPrivacyRemoval? in
        guard let id: String = row["page_id"], let generation: Int64 = row["generation"] else {
          return nil
        }
        return CloudPrivacyRemoval(pageID: .init(rawValue: id), generation: generation)
      }
      for removal in removals {
        try db.execute(
          sql: "UPDATE page_cloud_privacy_states SET enqueued_generation = ? WHERE page_id = ? AND generation = ?",
          arguments: [removal.generation, removal.pageID.rawValue, removal.generation]
        )
      }
      return removals
    }
  }

  /// Claims a transitional save caused by promotion or a tag-closure change. Its expected page
  /// generation is recorded so an acknowledgement for an older save cannot settle this state.
  public func claimCloudPrivacySavesForSync() throws -> [CloudPrivacySave] {
    try database.write { db in
      try Self.reconcileCloudPrivacyDesiredStates(in: db)
      let saves = try Row.fetchAll(
        db,
        sql: """
          SELECT s.page_id,s.generation,p.dirty_generation
          FROM page_cloud_privacy_states s
          JOIN pages p ON p.id = s.page_id
          WHERE s.desired_operation = 'save'
            AND s.acknowledged_generation < s.generation
            AND s.enqueued_generation < s.generation
            AND p.deleted_at IS NULL
            AND p.person_cloud_eligible = 1
          ORDER BY s.page_id
          """
      ).compactMap { row -> CloudPrivacySave? in
        guard let id: String = row["page_id"],
          let desiredGeneration: Int64 = row["generation"],
          let pageDirtyGeneration: Int64 = row["dirty_generation"]
        else { return nil }
        return CloudPrivacySave(
          pageID: .init(rawValue: id),
          desiredGeneration: desiredGeneration,
          pageDirtyGeneration: pageDirtyGeneration
        )
      }
      for save in saves {
        try db.execute(
          sql: """
            UPDATE page_cloud_privacy_states
            SET enqueued_generation = ?, save_dirty_generation = ?
            WHERE page_id = ? AND generation = ? AND desired_operation = 'save'
            """,
          arguments: [
            save.desiredGeneration,
            save.pageDirtyGeneration,
            save.pageID.rawValue,
            save.desiredGeneration,
          ]
        )
      }
      return saves
    }
  }

  /// Claims the current promotion-save intent before the coordinator queues a compensating
  /// record save from a late delete acknowledgement. Persisting the expected page generation
  /// here makes that save acknowledgement terminal instead of starting another save cycle.
  private static func claimCloudPrivacySave(
    in db: Database,
    pageID: PageID,
    desiredGeneration: Int64
  ) throws -> Bool {
    guard let pageDirtyGeneration = try Int64.fetchOne(
      db,
      sql: """
        SELECT p.dirty_generation
        FROM page_cloud_privacy_states s
        JOIN pages p ON p.id = s.page_id
        WHERE s.page_id = ?
          AND s.desired_operation = 'save'
          AND s.generation = ?
          AND s.acknowledged_generation < s.generation
          AND s.enqueued_generation < s.generation
          AND p.deleted_at IS NULL
          AND p.person_cloud_eligible = 1
        """,
      arguments: [pageID.rawValue, desiredGeneration]
    ) else {
      return false
    }
    try db.execute(
      sql: """
        UPDATE page_cloud_privacy_states
        SET enqueued_generation = ?, save_dirty_generation = ?
        WHERE page_id = ?
          AND desired_operation = 'save'
          AND generation = ?
          AND acknowledged_generation < generation
          AND enqueued_generation < generation
        """,
      arguments: [desiredGeneration, pageDirtyGeneration, pageID.rawValue, desiredGeneration]
    )
    return true
  }

  public func acknowledgeCloudPrivacyRemoval(
    pageID: PageID,
    sentGeneration: Int64
  ) throws -> CloudPrivacyAcknowledgement {
    try database.write { db in
      guard let row = try Row.fetchOne(
        db,
        sql: "SELECT desired_operation,generation,acknowledged_generation FROM page_cloud_privacy_states WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ), let operation: String = row["desired_operation"], let generation: Int64 = row["generation"],
        let acknowledgedGeneration: Int64 = row["acknowledged_generation"]
      else { return .none }
      guard let desired = CloudPrivacyDesiredOperation(rawValue: operation) else { return .none }
      switch desired {
      case .delete where generation == sentGeneration:
        try db.execute(
          sql: """
            UPDATE page_cloud_privacy_states
            SET acknowledged_generation = MAX(acknowledged_generation, ?)
            WHERE page_id = ? AND generation = ? AND desired_operation = 'delete'
            """,
          arguments: [sentGeneration, pageID.rawValue, sentGeneration]
        )
        return .none
      case .delete:
        return acknowledgedGeneration < generation
          ? .delete(.init(pageID: pageID, generation: generation))
          : .none
      case .save:
        // A delete can finish after a newer promotion save was acknowledged. That leaves the
        // remote record absent, so advance the desired generation and enqueue one compensating
        // save with a distinct acknowledgement token.
        if acknowledgedGeneration >= generation {
          let replacementGeneration = generation + 1
          try db.execute(
            sql: """
              UPDATE page_cloud_privacy_states
              SET generation = ?, enqueued_generation = 0, acknowledged_generation = 0,
                  save_dirty_generation = NULL
              WHERE page_id = ? AND desired_operation = 'save' AND generation = ?
              """,
            arguments: [replacementGeneration, pageID.rawValue, generation]
          )
          try db.execute(
            sql: "UPDATE pages SET person_cloud_eligible = 1, cloud_dirty = 1 WHERE id = ?",
            arguments: [pageID.rawValue]
          )
          if try Self.claimCloudPrivacySave(
            in: db,
            pageID: pageID,
            desiredGeneration: replacementGeneration
          ) {
            return .save(pageID)
          }
          return .none
        }
        if try Self.claimCloudPrivacySave(
          in: db,
          pageID: pageID,
          desiredGeneration: generation
        ) {
          return .save(pageID)
        }
        return .none
      }
    }
  }

  public func cloudPrivacyRemovalGenerationAwaitingAcknowledgement(
    pageID: PageID
  ) throws -> Int64? {
    try database.read { db in
      try Int64.fetchOne(
        db,
        sql: """
          SELECT enqueued_generation FROM page_cloud_privacy_states
          WHERE page_id = ? AND desired_operation = 'delete'
            AND enqueued_generation = generation
            AND acknowledged_generation < generation
          """,
        arguments: [pageID.rawValue]
      )
    }
  }

  public func acknowledgeCloudPrivacySave(
    pageID: PageID,
    sentPageGeneration: Int64
  ) throws -> CloudPrivacyAcknowledgement {
    try database.write { db in
      guard let row = try Row.fetchOne(
        db,
        sql: """
          SELECT desired_operation,generation,enqueued_generation,acknowledged_generation,save_dirty_generation
          FROM page_cloud_privacy_states WHERE page_id = ?
          """,
        arguments: [pageID.rawValue]
      ), let operation: String = row["desired_operation"], let generation: Int64 = row["generation"],
        let enqueuedGeneration: Int64 = row["enqueued_generation"],
        let acknowledgedGeneration: Int64 = row["acknowledged_generation"],
        let desired = CloudPrivacyDesiredOperation(rawValue: operation)
      else { return .none }
      switch desired {
      case .save:
        let expectedPageGeneration: Int64? = row["save_dirty_generation"]
        guard acknowledgedGeneration < generation else { return .none }
        guard enqueuedGeneration == generation, let expectedPageGeneration else {
          return .save(pageID)
        }
        if sentPageGeneration < expectedPageGeneration {
          // This acknowledgement belongs to an older regular save. Make the current privacy
          // intent claimable again instead of allowing that stale record to settle it.
          try db.execute(
            sql: "UPDATE page_cloud_privacy_states SET enqueued_generation = acknowledged_generation WHERE page_id = ? AND generation = ? AND desired_operation = 'save'",
            arguments: [pageID.rawValue, generation]
          )
          return .save(pageID)
        }
        if sentPageGeneration > expectedPageGeneration {
          // A page edit landed after the privacy intent was claimed but before record
          // preparation. The CloudKit record advertises the newer page generation, so persist
          // that actual generation before accepting its acknowledgement.
          try db.execute(
            sql: "UPDATE page_cloud_privacy_states SET save_dirty_generation = ? WHERE page_id = ? AND generation = ? AND desired_operation = 'save'",
            arguments: [sentPageGeneration, pageID.rawValue, generation]
          )
        }
        try db.execute(
          sql: """
            UPDATE page_cloud_privacy_states
            SET acknowledged_generation = MAX(acknowledged_generation, ?)
            WHERE page_id = ? AND generation = ? AND desired_operation = 'save'
            """,
          arguments: [generation, pageID.rawValue, generation]
        )
        return .none
      case .delete:
        return acknowledgedGeneration < generation
          ? .delete(.init(pageID: pageID, generation: generation))
          : .none
      }
    }
  }

  /// Makes a failed delete claim eligible for a later enqueue without acknowledging it. A stale
  /// failure can only requeue the current desired delete, never override a promotion.
  public func retryCloudPrivacyRemoval(
    pageID: PageID,
    sentGeneration: Int64
  ) throws -> CloudPrivacyAcknowledgement {
    try database.write { db in
      guard let row = try Row.fetchOne(
        db,
        sql: "SELECT desired_operation,generation,acknowledged_generation FROM page_cloud_privacy_states WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ), let operation: String = row["desired_operation"], let generation: Int64 = row["generation"],
        let acknowledgedGeneration: Int64 = row["acknowledged_generation"],
        let desired = CloudPrivacyDesiredOperation(rawValue: operation)
      else { return .none }
      switch desired {
      case .delete where generation == sentGeneration && acknowledgedGeneration < generation:
        try db.execute(
          sql: "UPDATE page_cloud_privacy_states SET enqueued_generation = acknowledged_generation WHERE page_id = ? AND generation = ?",
          arguments: [pageID.rawValue, sentGeneration]
        )
        return .delete(.init(pageID: pageID, generation: generation))
      case .delete:
        return acknowledgedGeneration < generation
          ? .delete(.init(pageID: pageID, generation: generation))
          : .none
      case .save:
        guard acknowledgedGeneration < generation else { return .none }
        if try Self.claimCloudPrivacySave(
          in: db,
          pageID: pageID,
          desiredGeneration: generation
        ) {
          return .save(pageID)
        }
        return .none
      }
    }
  }

  public func cloudRecordMetadata(pageID: PageID) throws -> Data? {
    try database.read { db in
      try Data.fetchOne(
        db,
        sql: "SELECT cloud_record FROM pages WHERE id = ?",
        arguments: [pageID.rawValue]
      )
    }
  }

  public func clearPageCloudRecordMetadata(pageID: PageID) throws {
    try database.write { db in
      try db.execute(
        sql: "UPDATE pages SET cloud_record = NULL, cloud_dirty = 1 WHERE id = ?",
        arguments: [pageID.rawValue]
      )
    }
  }

  public func clearViewCloudRecordMetadata(id: LiveQueryID) throws {
    try database.write { db in
      try db.execute(
        sql: "UPDATE saved_query_views SET cloud_record = NULL, cloud_dirty = 1 WHERE id = ?",
        arguments: [id.rawValue]
      )
    }
  }

  public func clearPurgeCloudRecordMetadata(pageID: PageID) throws {
    try database.write { db in
      try db.execute(
        sql: "UPDATE purge_markers SET cloud_record = NULL, cloud_dirty = 1 WHERE page_id = ?",
        arguments: [pageID.rawValue]
      )
    }
  }

  public func cloudAccountID() throws -> String? {
    try database.read { db in
      guard let data = try Data.fetchOne(db, sql: "SELECT value FROM settings WHERE key = 'cloud.account-id'") else {
        return nil
      }
      return String(data: data, encoding: .utf8)
    }
  }

  public func bindCloudAccountID(_ accountID: String) throws {
    try database.write { db in
      if let data = try Data.fetchOne(db, sql: "SELECT value FROM settings WHERE key = 'cloud.account-id'"),
        String(data: data, encoding: .utf8) != accountID
      {
        throw LibraryRepositoryError.databaseUnavailable("This vault belongs to a different iCloud account.")
      }
      try db.execute(
        sql: "INSERT OR IGNORE INTO settings (key,value) VALUES ('cloud.account-id',?)",
        arguments: [Data(accountID.utf8)]
      )
    }
  }

  @discardableResult
  public func markCloudSaved(
    pageID: PageID,
    sentGeneration: Int64,
    systemFields: Data
  ) throws -> Bool {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE pages
          SET cloud_record = ?,
              cloud_synced_generation = MAX(cloud_synced_generation, ?),
              cloud_dirty = CASE WHEN dirty_generation <= ? THEN 0 ELSE 1 END
          WHERE id = ?
        """,
        arguments: [systemFields, sentGeneration, sentGeneration, pageID.rawValue]
      )
      try Self.acknowledgeBookmarkCarrierSave(
        db,
        pageID: pageID,
        sentGeneration: sentGeneration,
        now: Date()
      )
      return try Bool.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM pages WHERE id = ?",
        arguments: [pageID.rawValue]
      ) ?? false
    }
  }

  public func dirtyPurgeMarkers() throws -> [PurgeMarker] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql: "SELECT page_id,generation,purged_at,cloud_record FROM purge_markers WHERE cloud_dirty = 1"
      ).compactMap { row in
        guard let pageID: String = row["page_id"],
          let generation: Int64 = row["generation"],
          let purgedAt: Double = row["purged_at"]
        else { return nil }
        return PurgeMarker(
          pageID: PageID(rawValue: pageID),
          generation: generation,
          purgedAt: Date(timeIntervalSince1970: purgedAt),
          cloudRecord: row["cloud_record"]
        )
      }
    }
  }

  public func purgeMarker(pageID: PageID) throws -> PurgeMarker? {
    try database.read { db in
      guard let row = try Row.fetchOne(
        db,
        sql: "SELECT page_id,generation,purged_at,cloud_record FROM purge_markers WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ), let generation: Int64 = row["generation"], let purgedAt: Double = row["purged_at"] else {
        return nil
      }
      return PurgeMarker(
        pageID: pageID,
        generation: generation,
        purgedAt: Date(timeIntervalSince1970: purgedAt),
        cloudRecord: row["cloud_record"]
      )
    }
  }

  @discardableResult
  public func markPurgeCloudSaved(
    pageID: PageID,
    sentGeneration: Int64,
    systemFields: Data
  ) throws -> Bool {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE purge_markers
          SET cloud_record = ?,
              cloud_dirty = CASE WHEN generation <= ? THEN 0 ELSE 1 END
          WHERE page_id = ?
          """,
        arguments: [systemFields, sentGeneration, pageID.rawValue]
      )
      return try Bool.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM purge_markers WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ) ?? false
    }
  }

  @discardableResult
  public func applyCloudPageRecordDeletion(
    pageID: PageID,
    deletedAt: Date = Date()
  ) throws -> Bool {
    try database.write { db in
      if let carrierResult = try Self.applyBookmarkCarrierCloudDeletion(
        db,
        pageID: pageID,
        deletedAt: deletedAt
      ) {
        return carrierResult
      }
      if let operation = try String.fetchOne(
        db,
        sql: "SELECT desired_operation FROM page_cloud_privacy_states WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ).flatMap(CloudPrivacyDesiredOperation.init(rawValue:)) {
        // A fetched deletion may be the echo of this device's privacy removal. It must never
        // delete the retained local document. A promotion that raced the delete instead queues
        // a compensating save.
        switch operation {
        case .delete:
          return false
        case .save:
          return true
        }
      }
      if let row = try Row.fetchOne(
        db,
        sql: "SELECT dirty_generation,cloud_dirty FROM pages WHERE id = ?",
        arguments: [pageID.rawValue]
      ) {
        let localIsDirty: Bool = row["cloud_dirty"] ?? false
        if localIsDirty {
          try db.execute(
            sql: "UPDATE pages SET cloud_record = NULL, cloud_dirty = 1 WHERE id = ?",
            arguments: [pageID.rawValue]
          )
          return true
        }
        let generation: Int64 = row["dirty_generation"] ?? 0
        try db.execute(sql: "DELETE FROM pages WHERE id = ?", arguments: [pageID.rawValue])
        try db.execute(
          sql: """
            INSERT OR REPLACE INTO purge_markers
              (page_id,generation,purged_at,cloud_dirty,cloud_record)
            VALUES (?,?,?,0,NULL)
            """,
          arguments: [pageID.rawValue, generation + 1, deletedAt.timeIntervalSince1970]
        )
        return false
      }
      try db.execute(
        sql: """
          UPDATE purge_markers
          SET cloud_record = NULL, cloud_dirty = 0
          WHERE page_id = ?
          """,
        arguments: [pageID.rawValue]
      )
      return false
    }
  }

  @discardableResult
  public func applyCloudPurge(
    pageID: PageID,
    generation: Int64,
    purgedAt: Date,
    systemFields: Data
  ) throws -> Bool {
    try database.write { db in
      if let carrierResult = try Self.applyBookmarkCarrierCloudDeletion(
        db,
        pageID: pageID,
        deletedAt: purgedAt
      ) {
        return carrierResult
      }
      if let row = try Row.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM pages WHERE id = ?",
        arguments: [pageID.rawValue]
      ) {
        let localIsDirty: Bool = row["cloud_dirty"] ?? false
        if localIsDirty {
          try db.execute(
            sql: "UPDATE pages SET cloud_record = ?, cloud_dirty = 1 WHERE id = ?",
            arguments: [systemFields, pageID.rawValue]
          )
          try db.execute(
            sql: "DELETE FROM purge_markers WHERE page_id = ?",
            arguments: [pageID.rawValue]
          )
          return true
        }
      }
      let localGeneration: Int64 = try Int64.fetchOne(
        db,
        sql: "SELECT generation FROM purge_markers WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ) ?? 0
      if generation < localGeneration {
        try db.execute(
          sql: "UPDATE purge_markers SET cloud_record = ?, cloud_dirty = 1 WHERE page_id = ?",
          arguments: [systemFields, pageID.rawValue]
        )
        return true
      }
      try db.execute(sql: "DELETE FROM pages WHERE id = ?", arguments: [pageID.rawValue])
      try db.execute(
        sql: "INSERT OR REPLACE INTO purge_markers (page_id,generation,purged_at,cloud_dirty,cloud_record) VALUES (?,?,?,0,?)",
        arguments: [pageID.rawValue, generation, purgedAt.timeIntervalSince1970, systemFields]
      )
      return false
    }
  }

  public func mergeCloudPage(
    pageID: PageID,
    kind: PageKind,
    remoteDocument: Data,
    systemFields: Data,
    now: Date = Date()
  ) throws -> CloudPageMergeResult {
    try database.write { db in
      if let marker = try Row.fetchOne(
        db,
        sql: "SELECT cloud_dirty FROM purge_markers WHERE page_id = ?",
        arguments: [pageID.rawValue]
      ) {
        let markerIsDirty: Bool = marker["cloud_dirty"] ?? false
        if markerIsDirty {
          try db.execute(
            sql: "UPDATE purge_markers SET cloud_record = ?, cloud_dirty = 1 WHERE page_id = ?",
            arguments: [systemFields, pageID.rawValue]
          )
          return CloudPageMergeResult(page: nil, needsUpload: true)
        }
        try db.execute(
          sql: "DELETE FROM purge_markers WHERE page_id = ?",
          arguments: [pageID.rawValue]
        )
      }
      let page: PageSnapshot
      let needsUpload: Bool
      if let local = try Self.fetchPage(db, id: pageID) {
        let localProjection = try PageDocument.inspect(local.document, pageID: pageID)
        let remoteProjection = try PageDocument.inspect(remoteDocument, pageID: pageID)
        var merged = try PageDocument.merge(
          local: local.document,
          remote: remoteDocument,
          pageID: pageID
        )
        let temporalResolutions = TaskTemporalPolicy.canonicalAfterCompletionConflictValues(
          in: merged.projection.objectMetadata
        )
        if !temporalResolutions.isEmpty {
          merged = try PageDocument.setProperties(
            temporalResolutions,
            ensuring: BuiltInSupertags.task,
            message: "Resolve recurring task timing",
            in: merged.document
          )
        }
        let promotedOrigins = [localProjection, remoteProjection].compactMap {
          Self.promotedPersonOrigin(in: $0)
        }
        if !promotedOrigins.isEmpty {
          let dominantOrigin: PersonOrigin = promotedOrigins.contains(.manual)
            ? .manual
            : .calendarAttendee
          if merged.projection.objectMetadata.personVisibility != .promoted
            || merged.projection.objectMetadata.personOrigin != dominantOrigin
          {
            merged = try PageDocument.setPersonClassification(
              visibility: .promoted,
              origin: dominantOrigin,
              in: merged.document
            )
          }
        }
        let existingCloudEligibility: Bool = try Bool.fetchOne(
          db,
          sql: "SELECT person_cloud_eligible FROM pages WHERE id = ?",
          arguments: [pageID.rawValue]
        ) ?? true
        let finalCloudEligibility = try Self.cloudEligibility(
          in: db,
          metadata: merged.projection.objectMetadata,
          existingEligibility: existingCloudEligibility
        )
        needsUpload = finalCloudEligibility && merged.document != remoteDocument
        page = PageSnapshot(
          id: pageID,
          kind: local.kind,
          title: merged.projection.title,
          plainText: merged.projection.plainText,
          document: merged.document,
          heads: merged.heads,
          createdAt: local.createdAt,
          modifiedAt: now,
          deletedAt: merged.projection.deletedAt,
          isPinned: merged.projection.isPinned,
          dirtyGeneration: local.dirtyGeneration + (needsUpload ? 1 : 0),
          objectMetadata: merged.projection.objectMetadata
        )
        try Self.writePage(
          db,
          page: page,
          cloudDirty: needsUpload,
          cloudRecord: systemFields,
          bookmarkOrigin: .remote
        )
        try db.execute(
          sql: "UPDATE pages SET person_cloud_eligible = ? WHERE id = ?",
          arguments: [finalCloudEligibility, pageID.rawValue]
        )
        try Self.reconcileCloudPrivacyDesiredStates(in: db)
        try Self.replaceReferences(db, pageID: pageID, references: merged.projection.references)
      } else {
        let projection = try PageDocument.inspect(remoteDocument, pageID: pageID)
        let finalCloudEligibility = try Self.cloudEligibility(
          in: db,
          metadata: projection.objectMetadata,
          existingEligibility: true
        )
        needsUpload = false
        page = PageSnapshot(
          id: pageID,
          kind: kind,
          title: projection.title,
          plainText: projection.plainText,
          document: remoteDocument,
          heads: try Self.documentHeads(remoteDocument),
          createdAt: now,
          modifiedAt: now,
          deletedAt: projection.deletedAt,
          isPinned: projection.isPinned,
          dirtyGeneration: 0,
          objectMetadata: projection.objectMetadata
        )
        try Self.writePage(
          db,
          page: page,
          cloudDirty: false,
          cloudRecord: systemFields,
          bookmarkOrigin: .remote
        )
        try db.execute(
          sql: "UPDATE pages SET person_cloud_eligible = ? WHERE id = ?",
          arguments: [finalCloudEligibility, pageID.rawValue]
        )
        try Self.reconcileCloudPrivacyDesiredStates(in: db)
        try Self.replaceReferences(db, pageID: pageID, references: projection.references)
      }
      return CloudPageMergeResult(page: page, needsUpload: needsUpload)
    }
  }

  public func cloudState() throws -> Data? {
    try setting(key: "cloudkit.state")
  }

  public func setCloudState(_ data: Data) throws {
    try setSetting(key: "cloudkit.state", value: data)
  }

  public func clearCloudState() throws {
    try database.write { db in
      try db.execute(sql: "DELETE FROM settings WHERE key = 'cloudkit.state'")
    }
  }

  public func markAllCloudDataForZoneRecovery() throws {
    try database.write { db in
      try db.execute(
        sql: """
          UPDATE pages
          SET cloud_dirty = person_cloud_eligible,
              cloud_record = NULL,
              cloud_synced_generation = 0
          """
      )
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET cloud_dirty = 1, cloud_record = NULL, cloud_synced_generation = 0
          """
      )
      try db.execute(
        sql: """
          UPDATE supertag_schemas
          SET cloud_dirty = 1, cloud_record = NULL, cloud_synced_generation = 0
          """
      )
      try db.execute(
        sql: """
          UPDATE _graph_relation_definitions
          SET cloud_dirty = CASE WHEN is_system = 1 THEN 0 ELSE 1 END,
              cloud_record = NULL,
              cloud_synced_generation = 0
          """
      )
      try db.execute(
        sql: """
          UPDATE _saved_graph_queries
          SET cloud_dirty = 1, cloud_record = NULL, cloud_synced_generation = 0
          """
      )
      try db.execute(
        sql: "UPDATE purge_markers SET cloud_dirty = 1, cloud_record = NULL"
      )
    }
  }

  public func unresolvedCloudRecordNames() throws -> Set<String> {
    try database.read { db in
      Set(try String.fetchAll(db, sql: "SELECT record_name FROM cloud_unresolved_records"))
    }
  }

  public func markCloudRecordUnresolved(
    recordName: String,
    detectedAt: Date = Date()
  ) throws {
    try database.write { db in
      try db.execute(
        sql: """
          INSERT OR REPLACE INTO cloud_unresolved_records (record_name,detected_at)
          VALUES (?,?)
          """,
        arguments: [recordName, detectedAt.timeIntervalSince1970]
      )
    }
  }

  public func clearUnresolvedCloudRecord(recordName: String) throws {
    try database.write { db in
      try db.execute(
        sql: "DELETE FROM cloud_unresolved_records WHERE record_name = ?",
        arguments: [recordName]
      )
    }
  }

  public func clearAllUnresolvedCloudRecords() throws {
    try database.write { db in
      try db.execute(sql: "DELETE FROM cloud_unresolved_records")
    }
  }

  public func setting(key: String) throws -> Data? {
    try database.read { db in
      try Data.fetchOne(db, sql: "SELECT value FROM settings WHERE key = ?", arguments: [key])
    }
  }

  public func setSetting(key: String, value: Data) throws {
    try database.write { db in
      try db.execute(
        sql: "INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)",
        arguments: [key, value]
      )
    }
  }

  private static func resolveSeries(
    _ db: Database,
    event: CalendarEventSnapshot,
    series: CalendarSeriesIdentity
  ) throws -> CalendarSeriesIdentity {
    var canonical = try String.fetchOne(
      db,
      sql: "SELECT canonical_key FROM calendar_series_aliases WHERE source_key = ?",
      arguments: [storageKey(series.sourceKey)]
    ).map(rawKey) ?? series.preferredCanonicalKey

    let candidates = try Row.fetchAll(
      db,
      sql: """
        SELECT event_json,series_canonical_key
        FROM calendar_events
        WHERE active = 1 AND provider <> ? AND series_source_key IS NOT NULL
        ORDER BY start_at
        """,
      arguments: [event.identity.provider]
    )
    for row in candidates {
      guard let data: Data = row["event_json"],
        let candidate = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data),
        let candidateSeries = candidate.identity.series
      else { continue }
      let exactIdentifierMatch = series.preferredCanonicalKey == candidateSeries.preferredCanonicalKey
      guard exactIdentifierMatch || CalendarSeriesMatcher.likelyMatch(event, candidate) else { continue }

      let candidateCanonical = (row["series_canonical_key"] as String?).map(rawKey)
        ?? candidateSeries.canonicalKey
      if event.identity.provider == "google" {
        canonical = series.preferredCanonicalKey
      } else if candidate.identity.provider == "google" {
        canonical = candidateSeries.preferredCanonicalKey
      } else {
        canonical = min(canonical, candidateCanonical)
      }
      try db.execute(
        sql: "UPDATE calendar_series_aliases SET canonical_key = ? WHERE canonical_key IN (?,?)",
        arguments: [storageKey(canonical), storageKey(candidateCanonical), storageKey(series.preferredCanonicalKey)]
      )
      try db.execute(
        sql: "INSERT OR REPLACE INTO calendar_series_aliases (source_key,canonical_key) VALUES (?,?)",
        arguments: [storageKey(candidateSeries.sourceKey), storageKey(canonical)]
      )
      break
    }
    try db.execute(
      sql: "INSERT OR REPLACE INTO calendar_series_aliases (source_key,canonical_key) VALUES (?,?)",
      arguments: [storageKey(series.sourceKey), storageKey(canonical)]
    )
    return series.resolved(to: canonical)
  }

  private static func replaceAttendeeProjection(
    _ db: Database,
    event: CalendarEventSnapshot,
    now: Date
  ) throws {
    let eventKey = storageKey(event.identity.stableKey)
    try db.execute(sql: "DELETE FROM calendar_event_attendees WHERE event_key = ?", arguments: [eventKey])
    var identities = event.attendees ?? []
    if let organizer = event.organizer, !identities.contains(where: { $0.id == organizer.id }) {
      identities.append(organizer)
    }
    var seenEmails: Set<String> = []
    for identity in identities where !identity.isCurrentUser {
      guard let rawEmail = identity.email,
        let email = try? PersonEmail.normalize(rawEmail),
        seenEmails.insert(email).inserted
      else { continue }
      let pageID = PageID.person(email: email)
      let displayName = identity.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
      let title = (displayName?.isEmpty == false ? displayName : nil) ?? email
      let existing = try fetchPage(db, id: pageID)
      var page = try createPage(
        db,
        id: pageID,
        kind: .free,
        title: title,
        now: now,
        cloudDirty: false
      )
      let emailKey = SupertagPropertyKey(
        supertagID: BuiltInSupertags.person,
        fieldID: .init(rawValue: "email")
      )
      let alreadyTagged = page.objectMetadata.supertagIDs.contains(BuiltInSupertags.person)
      let hasEmail = page.objectMetadata.properties[emailKey]?.contains { value in
        guard case .email(let storedEmail) = value else { return false }
        return PersonEmail.normalizedForComparison(storedEmail) == email
      } == true
      let needsClassification = page.objectMetadata.personVisibility == nil
      var createdDerivedOther = false
      if !alreadyTagged || !hasEmail || needsClassification {
        var mutation = try PageDocument.addSupertag(BuiltInSupertags.person, in: page.document)
        if !hasEmail {
          var emails = mutation.projection.objectMetadata.properties[emailKey] ?? []
          emails.append(.email(email))
          mutation = try PageDocument.setProperty(key: emailKey, values: emails, in: mutation.document)
        }
        if needsClassification {
          let visibility: PersonVisibility = existing?.hasSupertag(BuiltInSupertags.person) == true
            ? .promoted
            : .other
          createdDerivedOther = visibility == .other
          mutation = try PageDocument.setPersonClassification(
            visibility: visibility,
            origin: visibility == .promoted ? .manual : .calendarAttendee,
            in: mutation.document
          )
        }
        page = PageSnapshot(
          id: page.id,
          kind: page.kind,
          title: mutation.projection.title,
          plainText: mutation.projection.plainText,
          document: mutation.document,
          heads: mutation.heads,
          createdAt: page.createdAt,
          modifiedAt: now,
          deletedAt: page.deletedAt,
          isPinned: page.isPinned,
          dirtyGeneration: page.dirtyGeneration + 1,
          objectMetadata: mutation.projection.objectMetadata
        )
        try writePage(
          db,
          page: page,
          cloudDirty: page.effectivePersonVisibility == .promoted
        )
        if createdDerivedOther {
          try db.execute(
            sql: "UPDATE pages SET person_cloud_eligible = 0 WHERE id = ?",
            arguments: [page.id.rawValue]
          )
        }
      }
      try db.execute(
        sql: """
          INSERT INTO calendar_event_attendees
            (event_key,person_page_id,email,role,response_status)
          VALUES (?,?,?,?,?)
          """,
        arguments: [eventKey, pageID.rawValue, email, identity.role, identity.responseStatus]
      )
    }
  }

  private static func canonicalSeries(
    _ db: Database,
    series: CalendarSeriesIdentity
  ) throws -> CalendarSeriesIdentity {
    let canonical = try String.fetchOne(
      db,
      sql: "SELECT canonical_key FROM calendar_series_aliases WHERE source_key = ?",
      arguments: [storageKey(series.sourceKey)]
    ).map(rawKey) ?? series.canonicalKey
    try db.execute(
      sql: "INSERT OR IGNORE INTO calendar_series_aliases (source_key,canonical_key) VALUES (?,?)",
      arguments: [storageKey(series.sourceKey), storageKey(canonical)]
    )
    return series.resolved(to: canonical)
  }

  private static func ensureSeriesPage(
    _ db: Database,
    series: CalendarSeriesIdentity,
    title: String,
    now: Date
  ) throws -> (page: PageSnapshot, created: Bool) {
    let mapped: String? = try String.fetchOne(
      db,
      sql: """
        SELECT page_id FROM series_page_map
        WHERE series_key = ?
           OR series_key IN (
             SELECT source_key FROM calendar_series_aliases WHERE canonical_key = ?
           )
        LIMIT 1
        """,
      arguments: [storageKey(series.canonicalKey), storageKey(series.canonicalKey)]
    )
    if let mapped, let page = try fetchPage(db, id: PageID(rawValue: mapped)) {
      try db.execute(
        sql: "INSERT OR REPLACE INTO series_page_map (series_key,page_id) VALUES (?,?)",
        arguments: [storageKey(series.canonicalKey), page.id.rawValue]
      )
      return (page, false)
    }
    let id = PageID.calendarSeries(series)
    let existed = try fetchPage(db, id: id) != nil
    let page = try createPage(db, id: id, kind: .calendarSeries(series), title: title, now: now)
    try db.execute(
      sql: "INSERT OR REPLACE INTO series_page_map (series_key,page_id) VALUES (?,?)",
      arguments: [storageKey(series.canonicalKey), page.id.rawValue]
    )
    return (page, !existed)
  }

  private static func mappedPageID(_ db: Database, eventKeys: [String]) throws -> PageID? {
    for key in Set(eventKeys) {
      if let value = try String.fetchOne(
        db,
        sql: "SELECT page_id FROM event_page_map WHERE event_key = ? OR occurrence_key = ? LIMIT 1",
        arguments: [storageKey(key), storageKey(key)]
      ) {
        return PageID(rawValue: value)
      }
    }
    return nil
  }

  private static func mapOccurrencePage(
    _ db: Database,
    pageID: PageID,
    sourceEventKey: String,
    occurrenceKey: String,
    seriesKey: String?
  ) throws {
    for eventKey in Set([sourceEventKey, occurrenceKey]) {
      try db.execute(
        sql: "INSERT OR REPLACE INTO event_page_map (event_key,occurrence_key,series_key,page_id) VALUES (?,?,?,?)",
        arguments: [
          storageKey(eventKey),
          storageKey(occurrenceKey),
          seriesKey.map(storageKey),
          pageID.rawValue,
        ]
      )
    }
  }

  private static func eventForPage(_ db: Database, pageID: PageID) throws -> CalendarEventSnapshot? {
    guard let row = try Row.fetchOne(
      db,
      sql: """
        SELECT e.event_json,e.active,COALESCE(a.canonical_key,e.series_canonical_key) AS canonical_key
        FROM event_page_map m
        JOIN calendar_events e ON e.event_key = m.event_key
        LEFT JOIN calendar_series_aliases a ON a.source_key = e.series_source_key
        WHERE m.page_id = ?
        ORDER BY e.active DESC, CASE e.provider WHEN 'google' THEN 0 ELSE 1 END
        LIMIT 1
        """,
      arguments: [pageID.rawValue]
    ), let data: Data = row["event_json"],
      var event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
    else { return nil }
    let active: Bool = row["active"] ?? false
    event.isDetached = event.isDetached || !active
    if let canonical: String = row["canonical_key"], let series = event.identity.series {
      event.identity.series = series.resolved(to: rawKey(canonical))
    }
    return event
  }

  private static func occurrenceNotes(
    _ db: Database,
    seriesKey: String
  ) throws -> [CalendarOccurrenceNote] {
    let pages = try Row.fetchAll(
      db,
      sql: """
        SELECT DISTINCT p.*
        FROM pages p
        JOIN event_page_map m ON m.page_id = p.id
        WHERE m.series_key = ? AND p.kind_tag = 'calendarEvent' AND p.deleted_at IS NULL
        """,
      arguments: [storageKey(seriesKey)]
    ).map(decodePage)
    return try pages.compactMap { page in
      guard case .calendarEvent(let identity) = page.kind else { return nil }
      let event = try eventForPage(db, pageID: page.id)
      return CalendarOccurrenceNote(
        pageID: page.id,
        title: page.displayTitle,
        preview: page.preview,
        startDate: event?.startDate ?? identity.occurrenceStart,
        endDate: event?.endDate,
        isAllDay: event?.isAllDay ?? false
      )
    }.sorted { $0.startDate > $1.startDate }
  }

  private static func calendarTitle(_ db: Database, seriesKey: String) throws -> String? {
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT e.event_json
        FROM calendar_events e
        LEFT JOIN calendar_series_aliases a ON a.source_key = e.series_source_key
        WHERE COALESCE(a.canonical_key, e.series_canonical_key) = ? AND e.active = 1
        ORDER BY e.start_at
        LIMIT 1
        """,
      arguments: [storageKey(seriesKey)]
    )
    guard let data: Data = rows.first?["event_json"],
      let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
    else { return nil }
    return event.calendarTitle
  }

  private static func storageKey(_ value: String) -> String {
    Data(value.utf8).base64EncodedString()
  }

  private static func calendarEventOmissionPrefixes(_ db: Database) throws -> [String] {
    guard let data = try Data.fetchOne(
      db,
      sql: "SELECT value FROM settings WHERE key = 'calendar.omission-prefixes'"
    ), let prefixes = try? JSONDecoder.enchiridion.decode([String].self, from: data)
    else { return CalendarEventOmissionRules.defaultPrefixes }
    return CalendarEventOmissionRules.normalizedPrefixes(prefixes)
  }

  private static func rawKey(_ value: String) -> String {
    guard let data = Data(base64Encoded: value), let decoded = String(data: data, encoding: .utf8) else {
      return value
    }
    return decoded
  }

  private static func promotedPersonOrigin(
    in projection: PageDocumentProjection
  ) -> PersonOrigin? {
    guard projection.objectMetadata.supertagIDs.contains(BuiltInSupertags.person),
      projection.objectMetadata.personVisibility != .other
    else { return nil }
    return projection.objectMetadata.personOrigin ?? .manual
  }

  /// Removes only untouched local projections whose final calendar edge disappeared. Previously
  /// promoted/demoted people remain cloud eligible and are therefore retained; authored content,
  /// references, pins, extra tags/properties, and contact links are also explicit retention signals.
  private static func pruneOrphanedCalendarPeople(_ db: Database) throws {
    try db.execute(
      sql: """
        DELETE FROM pages
        WHERE person_visibility = 'other'
          AND person_origin = 'calendarAttendee'
          AND person_cloud_eligible = 0
          AND cloud_dirty = 0
          AND is_pinned = 0
          AND TRIM(plain_text) = ''
          AND NOT EXISTS (
            SELECT 1 FROM calendar_event_attendees a WHERE a.person_page_id = pages.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM page_cloud_privacy_states s
            WHERE s.page_id = pages.id AND s.desired_operation = 'delete'
          )
          AND NOT EXISTS (
            SELECT 1 FROM page_references r
            WHERE r.source_page_id = pages.id OR r.target_page_id = pages.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM person_contact_links c WHERE c.person_page_id = pages.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM page_supertags s
            WHERE s.page_id = pages.id AND s.supertag_id <> 'person'
          )
          AND NOT EXISTS (
            SELECT 1 FROM page_property_values v
            WHERE v.page_id = pages.id
              AND NOT (v.supertag_id = 'person' AND v.field_id = 'email')
          )
        """
    )
  }

  private func createPage(
    id: PageID,
    kind: PageKind,
    title: String,
    now: Date
  ) throws -> PageSnapshot {
    try database.write { db in
      try Self.createPage(db, id: id, kind: kind, title: title, now: now)
    }
  }

  private func setPersonVisibility(
    _ visibility: PersonVisibility,
    pageID: PageID,
    now: Date
  ) throws -> PageSnapshot {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID),
        try Self.effectiveTagIDs(db, nodeID: pageID).contains(BuiltInSupertags.person)
      else { throw LibraryRepositoryError.invalidRecord }
      if current.effectivePersonVisibility == visibility { return current }
      let result = try PageDocument.setPersonClassification(
        visibility: visibility,
        origin: current.personOrigin ?? .manual,
        in: current.document
      )
      let updated = PageSnapshot(
        id: current.id,
        kind: current.kind,
        title: result.projection.title,
        plainText: result.projection.plainText,
        document: result.document,
        heads: result.heads,
        createdAt: current.createdAt,
        modifiedAt: now,
        deletedAt: result.projection.deletedAt,
        isPinned: result.projection.isPinned,
        dirtyGeneration: current.dirtyGeneration + 1,
        objectMetadata: result.projection.objectMetadata
      )
      try Self.writePage(db, page: updated, cloudDirty: true)
      // Promotion must supersede an already-claimed local-only deletion immediately. Demotion
      // must do the converse in this transaction: the store queues a page change after this
      // method returns, so an eligible dirty page must never escape for a local-only Person.
      if visibility == .promoted {
        try db.execute(
          sql: "UPDATE pages SET person_cloud_eligible = 1 WHERE id = ?",
          arguments: [pageID.rawValue]
        )
      }
      try Self.reconcileCloudPrivacyDesiredStates(in: db)
      return updated
    }
  }

  private static func createPage(
    _ db: Database,
    id: PageID,
    kind: PageKind,
    title: String,
    now: Date,
    cloudDirty: Bool = true
  ) throws -> PageSnapshot {
    if try Bool.fetchOne(
      db,
      sql: "SELECT EXISTS(SELECT 1 FROM purge_markers WHERE page_id = ?)",
      arguments: [id.rawValue]
    ) == true {
      throw LibraryRepositoryError.pagePurged
    }
    if let existing = try fetchPage(db, id: id) { return existing }
    let created = try PageDocument.create(id: id, kind: kind, title: title, createdAt: now)
    let page = PageSnapshot(
      id: id,
      kind: kind,
      title: title,
      plainText: "",
      document: created.document,
      heads: created.heads,
      createdAt: now,
      modifiedAt: now,
      dirtyGeneration: 1,
      objectMetadata: .init()
    )
    try writePage(db, page: page, cloudDirty: cloudDirty)
    return page
  }

  private static func updateMaterializationState(
    _ db: Database,
    pageID: PageID,
    identity: CalendarMaterializedIdentity,
    event: CalendarEventSnapshot,
    baselineHash: String,
    baseline: CalendarEventMaterializationBaseline? = nil,
    now: Date,
    detached: Bool
  ) throws {
    let timestamp = now.timeIntervalSince1970
    try db.execute(
      sql: """
        INSERT INTO calendar_materialization_state
          (page_id,generated_at,last_seen_complete_refresh_at,provider_baseline_hash,user_touched_at,
           detached_at,prune_after,source_scope,event_end_at,provider_title,provider_baseline_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(page_id) DO UPDATE SET
          last_seen_complete_refresh_at=excluded.last_seen_complete_refresh_at,
          provider_baseline_hash=excluded.provider_baseline_hash,
          user_touched_at=CASE WHEN excluded.user_touched_at IS NOT NULL
            THEN COALESCE(calendar_materialization_state.user_touched_at, excluded.user_touched_at)
            ELSE calendar_materialization_state.user_touched_at END,
          detached_at=CASE WHEN excluded.detached_at IS NOT NULL
            THEN COALESCE(calendar_materialization_state.detached_at, excluded.detached_at)
            ELSE calendar_materialization_state.detached_at END,
          prune_after=NULL,
          source_scope=excluded.source_scope,
          event_end_at=excluded.event_end_at,
          provider_title=excluded.provider_title,
          provider_baseline_json=COALESCE(excluded.provider_baseline_json, calendar_materialization_state.provider_baseline_json)
        """,
      arguments: [
        pageID.rawValue, timestamp, timestamp, baselineHash,
        detached ? timestamp : nil, detached ? timestamp : nil, nil,
        identity.sourceScopeDigest ?? identity.uidDigest, event.endDate.timeIntervalSince1970, event.title,
        baseline.flatMap { try? JSONEncoder.enchiridion.encode($0) },
      ]
    )
  }

  private static func materializedPageHasUserDelta(
    _ page: PageSnapshot,
    db: Database
  ) throws -> Bool {
    guard page.deletedAt == nil else { return true }
    guard page.plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      !page.isPinned,
      page.objectMetadata.supertagIDs.allSatisfy({ $0 == BuiltInSupertags.event })
    else { return true }
    // Provider fields and their entity references are evaluated against the
    // structured baseline above. Only independent page structure is a delta.
    return false
  }

  private static func materializedPeopleProperties(
    _ db: Database,
    event: CalendarEventSnapshot
  ) throws -> [SupertagPropertyKey: [SupertagValue]] {
    let eventKey = storageKey(event.identity.stableKey)
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT a.person_page_id,a.role
        FROM calendar_event_attendees a JOIN pages p ON p.id = a.person_page_id
        WHERE a.event_key = ? AND p.person_visibility = ? AND p.person_cloud_eligible = 1
        ORDER BY a.role,a.person_page_id
        """,
      arguments: [eventKey, PersonVisibility.promoted.rawValue]
    )
    var organizer: [SupertagValue] = []
    var attendees: [SupertagValue] = []
    for row in rows {
      guard let rawID: String = row["person_page_id"] else { continue }
      let value: SupertagValue = .page(.init(rawValue: rawID))
      if (row["role"] as String?) == "organizer" { organizer.append(value) }
      else { attendees.append(value) }
    }
    var output: [SupertagPropertyKey: [SupertagValue]] = [:]
    let tag = BuiltInSupertags.event
    if !organizer.isEmpty { output[.init(supertagID: tag, fieldID: .init(rawValue: "organizer"))] = organizer }
    if !attendees.isEmpty { output[.init(supertagID: tag, fieldID: .init(rawValue: "attendees"))] = attendees }
    return output
  }

  private static func reconcileMaterializedCalendarRetention(
    _ db: Database,
    sourceScope: String,
    authoritativeInterval: DateInterval,
    completedRefreshAt: Double,
    now: Date,
    changed: inout [PageID]
  ) throws {
    let grace = now.addingTimeInterval(30 * 24 * 60 * 60).timeIntervalSince1970
    for row in try Row.fetchAll(
      db,
      sql: "SELECT page_id,event_end_at,prune_after,provider_baseline_json FROM calendar_materialization_state WHERE source_scope = ? AND detached_at IS NULL AND last_seen_complete_refresh_at < ? AND event_end_at >= ? AND event_end_at <= ?",
      arguments: [
        sourceScope, completedRefreshAt,
        authoritativeInterval.start.timeIntervalSince1970,
        authoritativeInterval.end.timeIntervalSince1970,
      ]
    ) {
      guard let rawID: String = row["page_id"] else { continue }
      if let deadline: Double = row["prune_after"], deadline <= now.timeIntervalSince1970 {
        let pageID = PageID(rawValue: rawID)
        guard let page = try fetchPage(db, id: pageID) else { continue }
        let baselineData: Data? = row["provider_baseline_json"]
        let baseline = baselineData.flatMap {
          try? JSONDecoder.enchiridion.decode(CalendarEventMaterializationBaseline.self, from: $0)
        }
        if try materializedPageHasUserDelta(page, db: db) || baseline.map({ !$0.matches(page) }) ?? true {
          try db.execute(sql: "UPDATE calendar_materialization_state SET user_touched_at = ?, detached_at = ?, prune_after = NULL WHERE page_id = ?", arguments: [now.timeIntervalSince1970, now.timeIntervalSince1970, rawID])
          continue
        }
        let result = try PageDocument.setDeleted(now, in: page.document)
        let deleted = updatedPage(page, with: result, now: now)
        try writePage(db, page: deleted, cloudDirty: true)
        try replaceReferences(db, pageID: pageID, references: result.projection.references)
        changed.append(pageID)
      } else {
        try db.execute(sql: "UPDATE calendar_materialization_state SET prune_after = ? WHERE page_id = ?", arguments: [grace, rawID])
      }
    }
  }

  private static func hasPurgeMarker(_ db: Database, pageID: PageID) throws -> Bool {
    try Bool.fetchOne(
      db,
      sql: "SELECT EXISTS(SELECT 1 FROM purge_markers WHERE page_id = ?)",
      arguments: [pageID.rawValue]
    ) ?? false
  }

  private static func hasLiveSupertag(_ db: Database, id: SupertagID) throws -> Bool {
    try Bool.fetchOne(
      db,
      sql: "SELECT EXISTS(SELECT 1 FROM supertag_schemas WHERE id = ? AND deleted = 0)",
      arguments: [id.rawValue]
    ) ?? false
  }

  private static func addingSupertag(
    _ supertagID: SupertagID,
    in document: Data
  ) throws -> (
    document: Data,
    heads: AutomergeHeads,
    projection: PageDocumentProjection
  ) {
    let tagged = try PageDocument.addSupertag(supertagID, in: document)
    guard supertagID == BuiltInSupertags.person,
      tagged.projection.objectMetadata.personVisibility == nil
    else { return tagged }
    return try PageDocument.setPersonClassification(
      visibility: .promoted,
      origin: .manual,
      in: tagged.document
    )
  }

  private static func createRelationshipEntity(
    title: String,
    supertagID: SupertagID,
    initialProperties: [SupertagPropertyKey: [SupertagValue]],
    isEffectivePerson: Bool,
    now: Date,
    db: Database
  ) throws -> PageSnapshot {
    let created = try createPage(db, id: .free(), kind: .free, title: title, now: now)
    return try updatingCreatedRelationshipEntity(
      created,
      supertagID: supertagID,
      initialProperties: initialProperties,
      promoteCalendarPerson: false,
      isEffectivePerson: isEffectivePerson,
      now: now,
      db: db
    )
  }

  private static func updatingCreatedRelationshipEntity(
    _ current: PageSnapshot,
    supertagID: SupertagID,
    initialProperties: [SupertagPropertyKey: [SupertagValue]],
    promoteCalendarPerson: Bool,
    isEffectivePerson: Bool,
    now: Date,
    db: Database
  ) throws -> PageSnapshot {
    var mutation = try addingSupertag(supertagID, in: current.document)
    for (key, values) in initialProperties.sorted(by: { $0.key.storageKey < $1.key.storageKey }) {
      mutation = try PageDocument.setProperty(key: key, values: values, in: mutation.document)
    }
    if promoteCalendarPerson, mutation.projection.objectMetadata.personVisibility == .other {
      mutation = try PageDocument.setPersonClassification(
        visibility: .promoted,
        origin: current.personOrigin ?? .calendarAttendee,
        in: mutation.document
      )
    } else if isEffectivePerson, mutation.projection.objectMetadata.personVisibility == nil {
      mutation = try PageDocument.setPersonClassification(
        visibility: .promoted,
        origin: .manual,
        in: mutation.document
      )
    }
    let updated = updatedPage(current, with: mutation, now: now)
    try writePage(db, page: updated, cloudDirty: true)
    try replaceReferences(db, pageID: updated.id, references: mutation.projection.references)
    if promoteCalendarPerson || isEffectivePerson {
      try db.execute(
        sql: "UPDATE pages SET person_cloud_eligible = 1 WHERE id = ?",
        arguments: [updated.id.rawValue]
      )
    }
    return updated
  }

  private func mutateDocument(
    pageID: PageID,
    now: Date,
    validation: ((Database, PageSnapshot) throws -> Void)? = nil,
    afterWrite: ((Database, PageSnapshot) throws -> Void)? = nil,
    mutation: (PageSnapshot) throws -> (
      document: Data,
      heads: AutomergeHeads,
      projection: PageDocumentProjection
    )
  ) throws {
    try database.write { db in
      guard let current = try Self.fetchPage(db, id: pageID) else {
        throw LibraryRepositoryError.pageNotFound
      }
      try validation?(db, current)
      let result = try mutation(current)
      let updated = PageSnapshot(
        id: current.id,
        kind: current.kind,
        title: result.projection.title,
        plainText: result.projection.plainText,
        document: result.document,
        heads: result.heads,
        createdAt: current.createdAt,
        modifiedAt: now,
        deletedAt: result.projection.deletedAt,
        isPinned: result.projection.isPinned,
        dirtyGeneration: current.dirtyGeneration + 1,
        objectMetadata: result.projection.objectMetadata
      )
      try Self.writePage(db, page: updated, cloudDirty: true)
      try Self.replaceReferences(db, pageID: pageID, references: result.projection.references)
      try afterWrite?(db, updated)
    }
  }

  private func mutateWhiteboard(
    viewID: LiveQueryID,
    expectedRevision: Int64?,
    now: Date,
    mutation: (inout WhiteboardDocument) throws -> Void
  ) throws -> WhiteboardMutationReceipt {
    try database.write { db in
      guard let row = try Row.fetchOne(
        db,
        sql: "SELECT deleted,whiteboard_json FROM saved_query_views WHERE id = ?",
        arguments: [viewID.rawValue]
      ) else { throw WhiteboardError.viewNotFound }
      let deleted: Bool = row["deleted"] ?? false
      guard !deleted else { throw WhiteboardError.viewDeleted }

      let before = try Self.decodeWhiteboardDocument(row["whiteboard_json"])
      if let expectedRevision, expectedRevision != before.revision {
        throw WhiteboardError.staleRevision(expected: expectedRevision, actual: before.revision)
      }
      var after = before
      try mutation(&after)
      after.version = WhiteboardDocument.currentVersion
      after.revision = before.revision
      after.normalizeElementOrder()
      try WhiteboardDocumentValidator.validate(after)
      guard after != before else { return .init(before: before, after: before) }
      after.revision = before.revision + 1
      let encoded = try Self.encodeWhiteboardDocument(after)
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET whiteboard_json = ?, modified_at = ?,
              dirty_generation = dirty_generation + 1, cloud_dirty = 1
          WHERE id = ?
          """,
        arguments: [encoded, now.timeIntervalSince1970, viewID.rawValue]
      )
      return .init(before: before, after: after)
    }
  }

  private func validatePageCardMutation(_ pageIDs: [PageID]) throws {
    guard Set(pageIDs).count <= WhiteboardLimits.maximumPageCards else {
      throw WhiteboardError.limitExceeded(
        "A canvas can contain at most \(WhiteboardLimits.maximumPageCards) live-query page cards."
      )
    }
  }

  private static func pageCard(_ pageID: PageID, layoutIndex: Int) -> WhiteboardElement {
    let column = layoutIndex % 5
    let row = layoutIndex / 5
    return .init(
      id: .pageCard(pageID),
      kind: .page(pageID),
      bounds: .init(
        x: Double(64 + column * 288),
        y: Double(64 + row * 180),
        width: 240,
        height: 132
      )
    )
  }

  private static func decodeWhiteboardDocument(_ data: Data?) throws -> WhiteboardDocument {
    guard let data, !data.isEmpty else { return .empty }
    var document = try JSONDecoder.enchiridion.decode(WhiteboardDocument.self, from: data)
    document.normalizeElementOrder()
    try WhiteboardDocumentValidator.validate(document)
    return document
  }

  private static func encodeWhiteboardDocument(_ document: WhiteboardDocument) throws -> Data {
    var normalized = document
    normalized.normalizeElementOrder()
    try WhiteboardDocumentValidator.validate(normalized)
    let data = try JSONEncoder.enchiridion.encode(normalized)
    guard data.count <= WhiteboardLimits.maximumEncodedBytes else {
      throw WhiteboardError.limitExceeded(
        "The canvas exceeds its \(WhiteboardLimits.maximumEncodedBytes)-byte storage limit."
      )
    }
    return data
  }

  static func projectSchemaByAddingClosedAt(
    to definition: SupertagDefinition
  ) -> SupertagDefinition {
    guard !definition.fields.contains(where: { $0.id == ProjectFields.closedAt.fieldID }),
      let builtInProject = BuiltInSupertags.all.first(where: {
        $0.id == BuiltInSupertags.project
      }),
      let closedAtField = builtInProject.fields.first(where: {
        $0.id == ProjectFields.closedAt.fieldID
      })
    else { return definition }
    var updated = definition
    updated.fields.append(closedAtField)
    return updated
  }

  private static let migrator: DatabaseMigrator = {
    var migrator = DatabaseMigrator()
    migrator.registerMigration("v1-local-authority") { db in
      try db.create(table: "pages") { table in
        table.column("id", .text).primaryKey()
        table.column("kind_tag", .text).notNull()
        table.column("kind_json", .blob).notNull()
        table.column("day_key", .text)
        table.column("title", .text).notNull()
        table.column("plain_text", .text).notNull()
        table.column("document", .blob).notNull()
        table.column("heads_json", .blob).notNull()
        table.column("created_at", .double).notNull()
        table.column("modified_at", .double).notNull().indexed()
        table.column("deleted_at", .double).indexed()
        table.column("is_pinned", .boolean).notNull().defaults(to: false)
        table.column("dirty_generation", .integer).notNull().defaults(to: 0)
        table.column("cloud_dirty", .boolean).notNull().defaults(to: true).indexed()
        table.column("cloud_synced_generation", .integer).notNull().defaults(to: 0)
        table.column("cloud_record", .blob)
      }
      try db.create(table: "page_references") { table in
        table.column("source_page_id", .text).notNull()
          .references("pages", onDelete: .cascade)
        table.column("target_page_id", .text).notNull().indexed()
        table.column("fallback_label", .text).notNull()
        table.primaryKey(["source_page_id", "target_page_id"])
      }
      try db.create(table: "editor_receipts") { table in
        table.column("journal_id", .text).notNull()
        table.column("page_id", .text).notNull()
          .references("pages", onDelete: .cascade)
        table.column("dirty_generation", .integer).notNull()
        table.column("committed_at", .double).notNull()
        table.primaryKey(["journal_id", "page_id"])
      }
      try db.create(table: "purge_markers") { table in
        table.column("page_id", .text).primaryKey()
        table.column("generation", .integer).notNull()
        table.column("purged_at", .double).notNull()
        table.column("cloud_dirty", .boolean).notNull().defaults(to: true)
        table.column("cloud_record", .blob)
      }
      try db.create(table: "calendar_events") { table in
        table.column("event_key", .text).primaryKey()
        table.column("provider", .text).notNull().indexed()
        table.column("event_json", .blob).notNull()
        table.column("start_at", .double).notNull().indexed()
        table.column("end_at", .double).notNull().indexed()
        table.column("active", .boolean).notNull().defaults(to: true)
        table.column("refreshed_at", .double).notNull()
      }
      try db.create(table: "event_page_map") { table in
        table.column("event_key", .text).primaryKey()
        table.column("page_id", .text).notNull().unique()
          .references("pages", onDelete: .cascade)
      }
      try db.create(table: "link_metadata") { table in
        table.column("url", .text).primaryKey()
        table.column("metadata", .blob).notNull()
        table.column("refreshed_at", .double).notNull()
      }
      try db.create(table: "settings") { table in
        table.column("key", .text).primaryKey()
        table.column("value", .blob).notNull()
      }
    }
    migrator.registerMigration("v2-calendar-provider") { db in
      let columns = try db.columns(in: "calendar_events")
      if !columns.contains(where: { $0.name == "provider" }) {
        try db.alter(table: "calendar_events") { table in
          table.add(column: "provider", .text).notNull().defaults(to: "eventkit").indexed()
        }
      }
    }
    migrator.registerMigration("v3-calendar-series") { db in
      let eventColumns = try db.columns(in: "calendar_events")
      if !eventColumns.contains(where: { $0.name == "series_source_key" }) {
        try db.alter(table: "calendar_events") { table in
          table.add(column: "series_source_key", .text)
          table.add(column: "series_canonical_key", .text)
        }
        try db.create(index: "calendar_events_on_series_canonical_key", on: "calendar_events", columns: ["series_canonical_key"])
      }

      for row in try Row.fetchAll(db, sql: "SELECT rowid,event_json FROM calendar_events") {
        guard let rowID: Int64 = row["rowid"], let data: Data = row["event_json"],
          let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
        else { continue }
        try db.execute(
          sql: "UPDATE calendar_events SET event_key = ? WHERE rowid = ?",
          arguments: [LibraryRepository.storageKey(event.identity.stableKey), rowID]
        )
      }

      try db.rename(table: "event_page_map", to: "event_page_map_v2")
      try db.create(table: "event_page_map") { table in
        table.column("event_key", .text).primaryKey()
        table.column("occurrence_key", .text).notNull().indexed()
        table.column("series_key", .text).indexed()
        table.column("page_id", .text).notNull().indexed()
          .references("pages", onDelete: .cascade)
      }
      for row in try Row.fetchAll(db, sql: "SELECT page_id,event_key FROM event_page_map_v2") {
        guard let pageID: String = row["page_id"] else { continue }
        let pageKindData = try Data.fetchOne(
          db,
          sql: "SELECT kind_json FROM pages WHERE id = ?",
          arguments: [pageID]
        )
        let identity = pageKindData
          .flatMap { try? JSONDecoder.enchiridion.decode(PageKind.self, from: $0) }
          .flatMap { kind -> CalendarEventIdentity? in
            guard case .calendarEvent(let identity) = kind else { return nil }
            return identity
          }
        let rawEventKey: String = identity?.stableKey ?? (row["event_key"] ?? pageID)
        let rawOccurrenceKey = identity?.canonicalOccurrenceKey ?? rawEventKey
        try db.execute(
          sql: "INSERT INTO event_page_map (event_key,occurrence_key,series_key,page_id) VALUES (?,?,?,?)",
          arguments: [
            LibraryRepository.storageKey(rawEventKey),
            LibraryRepository.storageKey(rawOccurrenceKey),
            identity?.series.map { LibraryRepository.storageKey($0.canonicalKey) },
            pageID,
          ]
        )
      }
      try db.drop(table: "event_page_map_v2")

      try db.create(table: "series_page_map") { table in
        table.column("series_key", .text).primaryKey()
        table.column("page_id", .text).notNull().indexed()
          .references("pages", onDelete: .cascade)
      }
      try db.create(table: "calendar_series_aliases") { table in
        table.column("source_key", .text).primaryKey()
        table.column("canonical_key", .text).notNull().indexed()
      }
    }
    migrator.registerMigration("v4-supertags") { db in
      try db.create(table: "supertag_schemas") { table in
        table.column("id", .text).primaryKey()
        table.column("name", .text).notNull().indexed()
        table.column("definition_json", .blob).notNull()
        table.column("deleted", .boolean).notNull().defaults(to: false)
        table.column("sort_order", .integer).notNull().defaults(to: 0)
      }
      try db.create(table: "page_supertags") { table in
        table.column("page_id", .text).notNull()
        table.column("supertag_id", .text).notNull().indexed()
        table.primaryKey(["page_id", "supertag_id"])
      }
      try db.create(table: "page_property_values") { table in
        table.column("page_id", .text).notNull().references("pages", onDelete: .cascade)
        table.column("supertag_id", .text).notNull().indexed()
        table.column("field_id", .text).notNull().indexed()
        table.column("value_index", .integer).notNull()
        table.column("type", .text).notNull()
        table.column("text_value", .text)
        table.column("number_value", .double)
        table.column("boolean_value", .boolean)
        table.column("date_value", .double)
        table.column("entity_page_id", .text).indexed()
        table.primaryKey(["page_id", "supertag_id", "field_id", "value_index"])
      }
      try db.create(table: "calendar_event_attendees") { table in
        table.column("event_key", .text).notNull().indexed()
        table.column("person_page_id", .text).notNull().indexed().references("pages", onDelete: .cascade)
        table.column("email", .text).notNull().indexed()
        table.column("role", .text).notNull()
        table.column("response_status", .text).notNull()
        table.primaryKey(["event_key", "person_page_id"])
      }
      for (index, definition) in BuiltInSupertags.all.enumerated() {
        try db.execute(
          sql: "INSERT INTO supertag_schemas (id,name,definition_json,deleted,sort_order) VALUES (?,?,?,?,?)",
          arguments: [
            definition.id.rawValue,
            definition.name,
            try JSONEncoder.enchiridion.encode(definition),
            false,
            index,
          ]
        )
      }
      for row in try Row.fetchAll(db, sql: "SELECT id,document FROM pages") {
        guard let id: String = row["id"], let document: Data = row["document"],
          let projection = try? PageDocument.inspect(document, pageID: PageID(rawValue: id))
        else { continue }
        try LibraryRepository.replaceObjectProjection(db, pageID: PageID(rawValue: id), metadata: projection.objectMetadata)
      }
    }
    migrator.registerMigration("v5-live-views") { db in
      try db.create(table: "saved_query_views") { table in
        table.column("id", .text).primaryKey()
        table.column("name", .text).notNull().indexed()
        table.column("definition_json", .blob).notNull()
        table.column("deleted", .boolean).notNull().defaults(to: false)
        table.column("sort_order", .integer).notNull().defaults(to: 0)
      }
      for (index, definition) in BuiltInLiveQueries.all.enumerated() {
        try db.execute(
          sql: "INSERT INTO saved_query_views (id,name,definition_json,deleted,sort_order) VALUES (?,?,?,?,?)",
          arguments: [
            definition.id.rawValue,
            definition.name,
            try JSONEncoder.enchiridion.encode(definition),
            false,
            index,
          ]
        )
      }
    }
    migrator.registerMigration("v6-synced-live-views") { db in
      try db.alter(table: "saved_query_views") { table in
        table.add(column: "modified_at", .double).notNull().defaults(to: 0)
        table.add(column: "dirty_generation", .integer).notNull().defaults(to: 1)
        table.add(column: "cloud_dirty", .boolean).notNull().defaults(to: true).indexed()
        table.add(column: "cloud_synced_generation", .integer).notNull().defaults(to: 0)
        table.add(column: "cloud_record", .blob)
      }
      try db.execute(
        sql: "UPDATE saved_query_views SET modified_at = CAST(strftime('%s','now') AS REAL) WHERE modified_at = 0"
      )
    }
    migrator.registerMigration("v7-work-calendar-date-sort") { db in
      guard let data = try Data.fetchOne(
        db,
        sql: "SELECT definition_json FROM saved_query_views WHERE id = 'view_work_calendar'"
      ), let current = try? JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: data),
        current.source == .workCalendar,
        current.filters.isEmpty,
        current.sorts == [.init(systemField: "title")],
        let replacement = BuiltInLiveQueries.all.first(where: { $0.id.rawValue == "view_work_calendar" })
      else { return }
      try db.execute(
        sql: """
          UPDATE saved_query_views
          SET definition_json = ?, modified_at = ?, dirty_generation = dirty_generation + 1, cloud_dirty = 1
          WHERE id = 'view_work_calendar'
          """,
        arguments: [try JSONEncoder.enchiridion.encode(replacement), Date().timeIntervalSince1970]
      )
    }
    migrator.registerMigration("v8-whiteboard-documents") { db in
      try db.alter(table: "saved_query_views") { table in
        table.add(column: "whiteboard_json", .blob)
      }
      try db.execute(
        sql: "UPDATE saved_query_views SET whiteboard_json = ? WHERE whiteboard_json IS NULL",
        arguments: [try LibraryRepository.encodeWhiteboardDocument(.empty)]
      )
    }
    migrator.registerMigration("v9-synced-supertags") { db in
      try db.alter(table: "supertag_schemas") { table in
        table.add(column: "modified_at", .double).notNull().defaults(to: 0)
        table.add(column: "dirty_generation", .integer).notNull().defaults(to: 1)
        table.add(column: "cloud_dirty", .boolean).notNull().defaults(to: true).indexed()
        table.add(column: "cloud_synced_generation", .integer).notNull().defaults(to: 0)
        table.add(column: "cloud_record", .blob)
      }
      try db.execute(
        sql: "UPDATE supertag_schemas SET modified_at = CAST(strftime('%s','now') AS REAL) WHERE modified_at = 0"
      )
    }
    migrator.registerMigration("v10-unresolved-cloud-records") { db in
      try db.create(table: "cloud_unresolved_records") { table in
        table.column("record_name", .text).primaryKey()
        table.column("detected_at", .double).notNull()
      }
    }
    migrator.registerMigration("v11-calendar-filters-and-people") { db in
      try db.alter(table: "pages") { table in
        table.add(column: "person_visibility", .text)
        table.add(column: "person_origin", .text)
      }
      try db.create(
        index: "pages_on_person_visibility",
        on: "pages",
        columns: ["person_visibility"]
      )
      try db.execute(
        sql: """
          UPDATE pages
          SET person_visibility = 'promoted', person_origin = 'manual'
          WHERE id IN (
            SELECT page_id FROM page_supertags WHERE supertag_id = 'person'
          )
          """
      )
      try db.execute(
        sql: """
          UPDATE pages
          SET person_visibility = 'other', person_origin = 'calendarAttendee'
          WHERE id IN (SELECT person_page_id FROM calendar_event_attendees)
          """
      )
      try db.create(table: "person_contact_links") { table in
        table.column("person_page_id", .text).primaryKey()
          .references("pages", onDelete: .cascade)
        table.column("contact_identifier", .text).notNull().indexed()
        table.column("matched_email", .text).notNull().indexed()
        table.column("contact_json", .blob).notNull()
        table.column("refreshed_at", .double).notNull()
      }
      try db.execute(
        sql: "INSERT OR IGNORE INTO settings (key,value) VALUES ('calendar.omission-prefixes',?)",
        arguments: [try JSONEncoder.enchiridion.encode(CalendarEventOmissionRules.defaultPrefixes)]
      )
    }
    migrator.registerMigration("v12-person-cloud-eligibility") { db in
      try db.alter(table: "pages") { table in
        table.add(column: "person_cloud_eligible", .boolean).notNull().defaults(to: true)
      }
      try db.execute(
        sql: """
          UPDATE pages
          SET person_cloud_eligible = 0
          WHERE person_visibility = 'other'
            AND id IN (SELECT person_page_id FROM calendar_event_attendees)
          """
      )
    }
    migrator.registerMigration("v13-task-foundation") { db in
      for (index, definition) in BuiltInSupertags.all.enumerated() {
        try db.execute(
          sql: """
            INSERT INTO supertag_schemas
              (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty)
            VALUES (?,?,?,?,?,?,1,1)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name,
              definition_json=excluded.definition_json,
              deleted=0,
              sort_order=excluded.sort_order,
              modified_at=excluded.modified_at,
              dirty_generation=supertag_schemas.dirty_generation + 1,
              cloud_dirty=1
            """,
          arguments: [
            definition.id.rawValue,
            definition.name,
            try JSONEncoder.enchiridion.encode(definition),
            false,
            index,
            Date().timeIntervalSince1970,
          ]
        )
      }
    }
    migrator.registerMigration("v14-task-schedule-granularity") { db in
      guard let definition = BuiltInSupertags.all.first(where: { $0.id == BuiltInSupertags.task })
      else { return }
      try db.execute(
        sql: """
          INSERT INTO supertag_schemas
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty)
          VALUES (?,?,?,?,?,?,1,1)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=0,
            modified_at=excluded.modified_at,
            dirty_generation=supertag_schemas.dirty_generation + 1,
            cloud_dirty=1
          """,
        arguments: [
          definition.id.rawValue,
          definition.name,
          try JSONEncoder.enchiridion.encode(definition),
          false,
          BuiltInSupertags.all.firstIndex(where: { $0.id == definition.id }) ?? 0,
          Date().timeIntervalSince1970,
        ]
      )
    }
    migrator.registerMigration("v15-project-planning") { db in
      guard let definition = BuiltInSupertags.all.first(where: { $0.id == BuiltInSupertags.project })
      else { return }
      try db.execute(
        sql: """
          INSERT INTO supertag_schemas
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty)
          VALUES (?,?,?,?,?,?,1,1)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=0,
            modified_at=excluded.modified_at,
            dirty_generation=supertag_schemas.dirty_generation + 1,
            cloud_dirty=1
          """,
        arguments: [
          definition.id.rawValue,
          definition.name,
          try JSONEncoder.enchiridion.encode(definition),
          false,
          BuiltInSupertags.all.firstIndex(where: { $0.id == definition.id }) ?? 0,
          Date().timeIntervalSince1970,
        ]
      )
    }
    migrator.registerMigration("v16-task-people") { db in
      guard let definition = BuiltInSupertags.all.first(where: { $0.id == BuiltInSupertags.task })
      else { return }
      try db.execute(
        sql: """
          INSERT INTO supertag_schemas
            (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty)
          VALUES (?,?,?,?,?,?,1,1)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            definition_json=excluded.definition_json,
            deleted=0,
            sort_order=excluded.sort_order,
            modified_at=excluded.modified_at,
            dirty_generation=supertag_schemas.dirty_generation + 1,
            cloud_dirty=1
          """,
        arguments: [
          definition.id.rawValue,
          definition.name,
          try JSONEncoder.enchiridion.encode(definition),
          false,
          BuiltInSupertags.all.firstIndex(where: { $0.id == definition.id }) ?? 0,
          Date().timeIntervalSince1970,
        ]
      )
    }
    migrator.registerMigration("v17-task-effect-outbox") { db in
      try db.create(table: "task_effect_outbox") { table in
        table.column("page_id", .text).notNull()
        table.column("effect_kind", .text).notNull()
        table.column("generation", .integer).notNull()
        table.column("request_authorization", .boolean).notNull().defaults(to: false)
        table.column("enqueued_at", .double).notNull()
        table.column("lease_id", .text)
        table.column("lease_generation", .integer)
        table.column("lease_expires_at", .double)
        table.column("attempt_count", .integer).notNull().defaults(to: 0)
        table.column("last_error", .text)
        table.primaryKey(["page_id", "effect_kind"])
      }
      try db.create(
        index: "task_effect_outbox_on_enqueued_at",
        on: "task_effect_outbox",
        columns: ["enqueued_at"]
      )
    }
    migrator.registerMigration("v18-project-closure-history") { db in
      guard let encoded: Data = try Data.fetchOne(
        db,
        sql: "SELECT definition_json FROM supertag_schemas WHERE id = ?",
        arguments: [BuiltInSupertags.project.rawValue]
      ),
        let existing = try? JSONDecoder.enchiridion.decode(
          SupertagDefinition.self,
          from: encoded
        )
      else { return }
      let updated = projectSchemaByAddingClosedAt(to: existing)
      guard updated != existing else { return }
      try db.execute(
        sql: """
          UPDATE supertag_schemas
          SET definition_json = ?,
              modified_at = ?,
              dirty_generation = dirty_generation + 1,
              cloud_dirty = 1
          WHERE id = ?
          """,
        arguments: [
          try JSONEncoder.enchiridion.encode(updated),
          Date().timeIntervalSince1970,
          BuiltInSupertags.project.rawValue,
        ]
      )
    }
    migrator.registerMigration("v19-knowledge-graph") { db in
      try GraphDatabaseSchema.install(in: db)
    }
    migrator.registerMigration("v20-synced-graph-metadata") { db in
      let columns = try db.columns(in: "_graph_relation_definitions")
      if !columns.contains(where: { $0.name == "dirty_generation" }) {
        try db.alter(table: "_graph_relation_definitions") { table in
          table.add(column: "dirty_generation", .integer).notNull().defaults(to: 1)
          table.add(column: "cloud_dirty", .boolean).notNull().defaults(to: true).indexed()
          table.add(column: "cloud_synced_generation", .integer).notNull().defaults(to: 0)
          table.add(column: "cloud_record", .blob)
        }
        try db.execute(
          sql: "UPDATE _graph_relation_definitions SET cloud_dirty = 0 WHERE is_system = 1"
        )
      }
    }
    migrator.registerMigration("v21-person-cloud-privacy-desired-state") { db in
      try db.create(table: "page_cloud_privacy_states") { table in
        table.column("page_id", .text).primaryKey()
          .references("pages", onDelete: .cascade)
        table.column("desired_operation", .text).notNull()
        table.column("generation", .integer).notNull()
        table.column("enqueued_generation", .integer).notNull().defaults(to: 0)
        table.column("acknowledged_generation", .integer).notNull().defaults(to: 0)
        table.column("save_dirty_generation", .integer)
      }
      try db.create(
        index: "page_cloud_privacy_states_on_operation",
        on: "page_cloud_privacy_states",
        columns: ["desired_operation", "generation"]
      )
      // Existing eligibility is authoritative when visibility is nil. Only known `other`
      // People become deletion intents during migration, and their local documents remain.
      try LibraryRepository.reconcileCloudPrivacyDesiredStates(in: db)
    }
    migrator.registerMigration("v22-person-cloud-privacy-acknowledgements") { db in
      let columns = try db.columns(in: "page_cloud_privacy_states")
      if !columns.contains(where: { $0.name == "acknowledged_generation" }) {
        try db.alter(table: "page_cloud_privacy_states") { table in
          table.add(column: "acknowledged_generation", .integer).notNull().defaults(to: 0)
          table.add(column: "save_dirty_generation", .integer)
        }
      }
    }
    migrator.registerMigration("v23-workout-import-receipts") { db in
      try db.create(table: "workout_import_receipts") { table in
        table.column("module_id", .text).notNull()
        table.column("event_id", .text).notNull()
        table.column("payload_hash", .text).notNull()
        table.column("root_page_id", .text).notNull().references("pages", onDelete: .restrict)
        table.column("imported_at", .double).notNull()
        table.primaryKey(["module_id", "event_id"])
      }
      try db.create(table: "workout_import_quarantine") { table in
        table.column("module_id", .text).notNull()
        table.column("event_id", .text).notNull()
        table.column("payload_hash", .text).notNull()
        table.column("reason", .text).notNull()
        table.column("received_at", .double).notNull()
        table.primaryKey(["module_id", "event_id", "payload_hash"])
      }
      try GraphDatabaseSchema.createWorkoutPublicViews(in: db)
    }
    migrator.registerMigration("v24-calendar-event-materialization") { db in
      try db.create(table: "calendar_materialization_state") { table in
        table.column("page_id", .text).primaryKey().references("pages", onDelete: .cascade)
        table.column("generated_at", .double).notNull()
        table.column("last_seen_complete_refresh_at", .double).notNull().indexed()
        table.column("provider_baseline_hash", .text).notNull()
        table.column("user_touched_at", .double)
        table.column("detached_at", .double)
        table.column("prune_after", .double).indexed()
        table.column("source_scope", .text).notNull()
        table.column("event_end_at", .double).notNull().indexed()
        table.column("provider_title", .text).notNull().defaults(to: "")
        table.column("provider_baseline_json", .blob)
      }
    }
    migrator.registerMigration("v25-calendar-event-materialization-provider-title") { db in
      let columns = try db.columns(in: "calendar_materialization_state")
      if !columns.contains(where: { $0.name == "provider_title" }) {
        try db.alter(table: "calendar_materialization_state") { table in
          table.add(column: "provider_title", .text).notNull().defaults(to: "")
        }
      }
    }
    migrator.registerMigration("v26-calendar-event-materialization-baseline") { db in
      let columns = try db.columns(in: "calendar_materialization_state")
      if !columns.contains(where: { $0.name == "provider_baseline_json" }) {
        try db.alter(table: "calendar_materialization_state") { table in
          table.add(column: "provider_baseline_json", .blob)
        }
      }
    }
    migrator.registerMigration("v27-calendar-event-materialization-backfills") { db in
      try db.create(table: "calendar_materialization_backfills") { table in
        table.column("provider", .text).primaryKey()
        table.column("state_json", .blob).notNull()
      }
    }
    migrator.registerMigration("v28-bookmark-capture-foundation") { db in
      // Immutable bookmark records are deliberately outside the Automerge/Page projection.
      // They are local-only until an explicitly reviewed transport owns their replication.
      try db.create(table: "bookmark_identity_candidates") { table in
        table.column("url_key_digest", .text).notNull()
        table.column("url_key_version", .text).notNull()
        table.column("canonical_url", .text).notNull()
        // Keep candidates independent of pages: receipts and identity facts must survive a
        // normal page purge so retries cannot allocate a replacement.
        table.column("page_id", .text).notNull()
        table.primaryKey(["url_key_digest", "page_id"])
      }
      try db.create(table: "bookmark_capture_events") { table in
        table.column("capture_id", .text).primaryKey()
        table.column("url_key_digest", .text).notNull().indexed()
        table.column("url_key_version", .text).notNull()
        table.column("canonical_url", .text).notNull()
        table.column("submitted_url", .text).notNull()
        table.column("note", .text)
        table.column("captured_at", .double).notNull()
        table.column("day_key", .text).notNull().indexed()
        table.column("time_zone", .text).notNull()
        table.column("source", .text).notNull()
        table.column("platform", .text).notNull()
        table.column("vault_id", .text).notNull()
      }
      try db.create(table: "bookmark_identity_deletions") { table in
        table.column("url_key_digest", .text).notNull()
        table.column("url_key_version", .text).notNull()
        table.column("canonical_url", .text).notNull()
        table.column("deletion_id", .text).notNull()
        table.primaryKey(["url_key_digest", "deletion_id"])
      }
      try db.create(table: "bookmark_capture_receipts") { table in
        table.column("capture_id", .text).primaryKey()
        // Receipts deliberately outlive page purge so replay cannot recreate deleted content.
        table.column("page_id", .text).notNull()
      }
      let definition = BuiltInSupertags.all.first { $0.id == BuiltInSupertags.bookmark }!
      try db.execute(sql: """
        INSERT INTO supertag_schemas (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty,cloud_synced_generation)
        VALUES (?,?,?,?,?, ?,1,1,0)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,definition_json=excluded.definition_json,deleted=0,
          modified_at=excluded.modified_at,dirty_generation=supertag_schemas.dirty_generation+1,cloud_dirty=1
      """, arguments: [definition.id.rawValue, definition.name, try JSONEncoder.enchiridion.encode(definition), false, BuiltInSupertags.all.count - 1, Date().timeIntervalSince1970])
      try GraphDatabaseSchema.rebuildTagClosure(in: db)
    }
    migrator.registerMigration("v29-bookmark-capture-receipt-key") { db in
      let receiptColumns = try db.columns(in: "bookmark_capture_receipts")
      if !receiptColumns.contains(where: { $0.name == "url_key_version" }) {
        try db.alter(table: "bookmark_capture_receipts") { table in
          table.add(column: "url_key_version", .text)
        }
      }
      if !receiptColumns.contains(where: { $0.name == "canonical_url" }) {
        try db.alter(table: "bookmark_capture_receipts") { table in
          table.add(column: "canonical_url", .text)
        }
      }
      // v28 had only the page ID. Preserve its replay behavior wherever a candidate is still
      // available; newly written receipts always carry the frozen URL key directly.
      try db.execute(sql: """
        UPDATE bookmark_capture_receipts
        SET url_key_version = ?, canonical_url = (
          SELECT canonical_url FROM bookmark_identity_candidates c
          WHERE c.page_id = bookmark_capture_receipts.page_id
          ORDER BY c.url_key_digest LIMIT 1
        )
        WHERE canonical_url IS NULL
        """, arguments: [BookmarkURLKey.version])
      // `graph_tags` predates Bookmark. Keep this in a later migration so a database that
      // already recorded v28 from an earlier build still refreshes the view definition.
      try db.execute(sql: "DROP VIEW IF EXISTS graph_tags")
      try db.execute(sql: """
        CREATE VIEW graph_tags AS
        SELECT id AS tag_id,
               name,
               sort_order,
               deleted,
               CASE WHEN id IN ('person','organization','company','event','place','area','project','task','bookmark')
                 THEN 1 ELSE 0 END AS is_base
        FROM supertag_schemas
        WHERE id IS NOT NULL
        """)
    }
    migrator.registerMigration("v30-bookmark-synced-history-and-deletion-state") { db in
      try db.create(table: "bookmark_capture_event_sources") { table in
        table.column("page_id", .text).notNull().references("pages", onDelete: .cascade)
        table.column("root_key", .text).notNull()
        table.column("capture_id", .text).notNull().indexed()
        table.column("raw_hash", .text).notNull()
        table.column("encoded_envelope", .text).notNull()
        table.column("url_key_digest", .text).notNull().indexed()
        table.column("captured_at", .double).notNull().indexed()
        table.column("day_key", .text).notNull().indexed()
        table.column("time_zone", .text).notNull()
        table.column("valid_identity", .boolean).notNull().defaults(to: false)
        table.primaryKey(["page_id", "root_key", "raw_hash"])
      }
      try db.create(table: "bookmark_capture_event_issues") { table in
        table.column("page_id", .text).notNull().references("pages", onDelete: .cascade)
        table.column("issue_key", .text).notNull()
        table.column("root_key", .text).notNull()
        table.column("raw_hash", .text).notNull()
        table.column("kind", .text).notNull()
        table.primaryKey(["page_id", "issue_key"])
      }
      try db.create(table: "bookmark_frozen_identities") { table in
        table.column("page_id", .text).primaryKey().references("pages", onDelete: .cascade)
        table.column("url_key_digest", .text).notNull().indexed()
      }
      try db.create(table: "bookmark_identity_suppressions") { table in
        table.column("url_key_digest", .text).primaryKey()
        table.column("url_key_version", .text).notNull()
        table.column("deletion_id", .text).notNull()
        table.column("deleted_at", .double).notNull()
        table.column("stage", .text).notNull()
        table.column("active_carrier_page_id", .text)
        table.column("required_generation", .integer)
        table.column("acknowledged_carrier_page_id", .text)
        table.column("acknowledged_generation", .integer)
        table.column("permanent_requested_at", .double)
        table.column("stable_at", .double)
      }
      try db.create(table: "bookmark_deletion_carriers") { table in
        table.column("page_id", .text).primaryKey().references("pages", onDelete: .cascade)
        table.column("url_key_digest", .text).notNull().indexed()
        table.column("deletion_id", .text).notNull()
        table.column("generation", .integer).notNull()
        table.column("acknowledged_generation", .integer)
      }
      try db.create(table: "bookmark_permanent_delete_handoffs") { table in
        table.column("url_key_digest", .text).primaryKey()
        table.column("completed_at", .double).notNull()
      }
      try db.create(table: "bookmark_projection_backfills") { table in
        table.column("projection", .text).primaryKey()
        table.column("completed_at", .double).notNull()
      }

      let migrationDate = Date()
      try db.execute(sql: """
        INSERT OR IGNORE INTO bookmark_identity_suppressions
          (url_key_digest,url_key_version,deletion_id,deleted_at,stage)
        SELECT url_key_digest,MIN(url_key_version),MIN(deletion_id),?,?
        FROM bookmark_identity_deletions
        GROUP BY url_key_digest
        """, arguments: [migrationDate.timeIntervalSince1970, BookmarkPermanentDeletionStage.preparing.rawValue])

      for row in try Row.fetchAll(db, sql: "SELECT * FROM pages ORDER BY id") {
        let page = try LibraryRepository.decodePage(row)
        try LibraryRepository.reconcileBookmarkCaptureEventProjection(db, page: page)
      }
      try LibraryRepository.recoverBookmarkDeletionState(db, now: migrationDate)
      try db.execute(
        sql: "INSERT OR REPLACE INTO bookmark_projection_backfills (projection,completed_at) VALUES ('capture-events-v30',?)",
        arguments: [migrationDate.timeIntervalSince1970]
      )
    }
    migrator.registerMigration("v31-calendar-projection-generation-ledger") { db in
      // Local-only staging: raw event snapshots and rejection detail never
      // enter a page document or CloudKit record.
      try db.create(table: "calendar_projection_epochs") { table in
        table.column("provider", .text).primaryKey()
        table.column("eligibility_epoch", .integer).notNull().defaults(to: 0)
      }
      try db.create(table: "calendar_projection_generations") { table in
        table.column("provider", .text).notNull().indexed()
        table.column("id", .text).primaryKey()
        table.column("eligibility_epoch", .integer).notNull()
        table.column("snapshot_version", .integer).notNull()
        table.column("snapshot_digest", .text).notNull()
        table.column("omission_prefix_digest", .text).notNull()
        table.column("status", .text).notNull().indexed()
        table.column("accepted_count", .integer).notNull()
        table.column("rejected_count", .integer).notNull()
        table.column("retention_eligible", .boolean).notNull()
        table.column("refresh_at", .double).notNull()
        table.column("next_ordinal", .integer).notNull().defaults(to: 0)
        table.column("interval_start", .double).notNull()
        table.column("interval_end", .double).notNull()
        table.column("updated_at", .double).notNull()
      }
      try db.create(index: "calendar_projection_generations_provider_updated", on: "calendar_projection_generations", columns: ["provider", "updated_at"])
      try db.create(table: "calendar_projection_generation_items") { table in
        table.column("provider", .text).notNull()
        table.column("generation_id", .text).notNull().references("calendar_projection_generations", onDelete: .cascade)
        table.column("ordinal", .integer).notNull()
        table.column("event_key", .text).notNull()
        table.column("event_json", .blob).notNull()
        table.primaryKey(["generation_id", "ordinal"])
      }
      try db.create(index: "calendar_projection_generation_items_resume", on: "calendar_projection_generation_items", columns: ["provider", "generation_id", "ordinal"])
      try db.create(table: "calendar_projection_generation_rejections") { table in
        table.column("generation_id", .text).notNull().references("calendar_projection_generations", onDelete: .cascade)
        table.column("category", .text).notNull()
        table.column("count", .integer).notNull()
        table.primaryKey(["generation_id", "category"])
      }
    }
    migrator.registerMigration("v32-calendar-projection-ledger-corrections") { db in
      let columns = try db.columns(in: "calendar_projection_generations")
      if !columns.contains(where: { $0.name == "retention_eligible" }) {
        try db.alter(table: "calendar_projection_generations") { table in
          table.add(column: "retention_eligible", .boolean).notNull().defaults(to: false)
          table.add(column: "refresh_at", .double).notNull().defaults(to: 0)
        }
      }
      // Generation payload is restartable staging, so discard the short-lived
      // v31 item shape rather than retaining rejected raw snapshots or a
      // not-null `accepted` column that the corrected writer must not use.
      // v32 changes the immutable-item shape. Any old in-flight payload is
      // intentionally discarded, so terminalize its header in the same
      // migration before recovery can observe an orphan resumable job.
      try db.execute(sql: "UPDATE calendar_projection_generations SET status = 'invalidated', updated_at = ? WHERE status IN ('staged','materializing')", arguments: [Date().timeIntervalSince1970])
      try db.drop(table: "calendar_projection_generation_items")
      try db.create(table: "calendar_projection_generation_items") { table in
        table.column("provider", .text).notNull()
        table.column("generation_id", .text).notNull().references("calendar_projection_generations", onDelete: .cascade)
        table.column("ordinal", .integer).notNull()
        table.column("event_key", .text).notNull()
        table.column("event_json", .blob).notNull()
        table.primaryKey(["generation_id", "ordinal"])
      }
      try db.create(index: "calendar_projection_generation_items_resume_v32", on: "calendar_projection_generation_items", columns: ["provider", "generation_id", "ordinal"])
      try db.drop(table: "calendar_projection_generation_rejections")
      try db.create(table: "calendar_projection_generation_rejections") { table in
        table.column("generation_id", .text).notNull().references("calendar_projection_generations", onDelete: .cascade)
        table.column("category", .text).notNull()
        table.column("count", .integer).notNull()
        table.primaryKey(["generation_id", "category"])
      }
    }
    migrator.registerMigration("v33-calendar-legacy-upgrade-progress-and-access") { db in
      try db.create(table: "calendar_projection_access") { table in
        table.column("provider", .text).primaryKey()
        table.column("is_eligible", .boolean).notNull()
        table.column("updated_at", .double).notNull()
      }
      try db.create(table: "calendar_legacy_upgrade_receipts") { table in
        table.column("event_key", .text).primaryKey()
        table.column("completed_at", .double).notNull()
      }
      try db.create(table: "calendar_legacy_upgrade_skips") { table in
        table.column("event_key", .text).primaryKey()
        table.column("source_rowid", .integer).unique()
        table.column("reason", .text).notNull()
        table.column("recorded_at", .double).notNull()
      }
    }
    migrator.registerMigration("v34-calendar-legacy-upgrade-poison-rows") { db in
      let columns = try db.columns(in: "calendar_legacy_upgrade_skips")
      if !columns.contains(where: { $0.name == "source_rowid" }) {
        try db.alter(table: "calendar_legacy_upgrade_skips") { table in
          // SQLite cannot add a UNIQUE column. The separate partial index below
          // preserves uniqueness while allowing existing v33 databases to open.
          table.add(column: "source_rowid", .integer)
        }
      }
      try db.create(index: "calendar_legacy_upgrade_skips_source_rowid", on: "calendar_legacy_upgrade_skips", columns: ["source_rowid"], options: .unique)
    }
    return migrator
  }()

  private static func localSyncedBookmarkCaptureEvent(
    _ db: Database,
    captureID: String
  ) throws -> BookmarkSyncedCaptureEvent? {
    let projected = try String.fetchAll(
      db,
      sql: "SELECT DISTINCT encoded_envelope FROM bookmark_capture_event_sources WHERE capture_id = ? ORDER BY encoded_envelope",
      arguments: [captureID]
    )
    if projected.count > 1 { throw LibraryRepositoryError.bookmarkCaptureHistoryConflict }
    if let encoded = projected.first,
      let data = encoded.data(using: .utf8),
      let event = try? JSONDecoder.enchiridion.decode(BookmarkSyncedCaptureEvent.self, from: data)
    {
      return event
    }
    guard let row = try Row.fetchOne(
      db,
      sql: """
        SELECT canonical_url,submitted_url,captured_at,day_key,time_zone
        FROM bookmark_capture_events WHERE capture_id = ?
        """,
      arguments: [captureID]
    ), let canonical: String = row["canonical_url"],
      let submitted: String = row["submitted_url"],
      let key = BookmarkURLKey(submittedURL: canonical),
      let timestamp: Double = row["captured_at"],
      let day: String = row["day_key"],
      let timeZone: String = row["time_zone"],
      let id = UUID(uuidString: captureID)
    else { return nil }
    do {
      return try BookmarkSyncedCaptureEvent(
        captureID: id,
        urlKey: key,
        submittedURL: submitted,
        capturedAt: Date(timeIntervalSince1970: timestamp),
        dayKey: DayKey(rawValue: day),
        timeZoneIdentifier: timeZone
      )
    } catch {
      throw LibraryRepositoryError.invalidRecord
    }
  }

  private static func bookmarkSourceURLKey(in page: PageSnapshot) -> BookmarkURLKey? {
    let sourceKey = SupertagPropertyKey(
      supertagID: BuiltInSupertags.bookmark,
      fieldID: BuiltInSupertags.bookmarkSourceURLField
    )
    guard let sourceURL = page.objectMetadata.properties[sourceKey]?.compactMap({ value -> String? in
      guard case .url(let url) = value else { return nil }
      return url
    }).first else { return nil }
    return BookmarkURLKey(submittedURL: sourceURL)
  }

  static func validateFrozenBookmarkIdentity(_ db: Database, page: PageSnapshot) throws {
    let existingDigest = try String.fetchOne(
      db,
      sql: "SELECT url_key_digest FROM bookmark_frozen_identities WHERE page_id = ?",
      arguments: [page.id.rawValue]
    )
    let inspection = try PageDocument.bookmarkCaptureEvents(in: page.document)
    let eventDigests = Set(inspection.events.map(\.event.urlKey.digest))
    guard existingDigest != nil || !eventDigests.isEmpty else { return }
    guard eventDigests.count == 1, let eventDigest = eventDigests.first else {
      throw LibraryRepositoryError.bookmarkCaptureHistoryConflict
    }
    if let existingDigest, existingDigest != eventDigest {
      throw LibraryRepositoryError.bookmarkIdentityFrozen
    }
    guard page.hasSupertag(BuiltInSupertags.bookmark),
      bookmarkSourceURLKey(in: page)?.digest == eventDigest
    else {
      throw LibraryRepositoryError.bookmarkIdentityFrozen
    }
  }

  static func reconcileBookmarkCaptureEventProjection(
    _ db: Database,
    page: PageSnapshot
  ) throws {
    try db.execute(
      sql: "DELETE FROM bookmark_capture_event_sources WHERE page_id = ?",
      arguments: [page.id.rawValue]
    )
    try db.execute(
      sql: "DELETE FROM bookmark_capture_event_issues WHERE page_id = ?",
      arguments: [page.id.rawValue]
    )
    try db.execute(
      sql: "DELETE FROM bookmark_frozen_identities WHERE page_id = ?",
      arguments: [page.id.rawValue]
    )

    let inspection = try PageDocument.bookmarkCaptureEvents(in: page.document)
    let eventDigests = Set(inspection.events.map(\.event.urlKey.digest))
    let sourceDigest = bookmarkSourceURLKey(in: page)?.digest
    let hasBookmarkTag = page.hasSupertag(BuiltInSupertags.bookmark)
    let invalidRoots = Set(inspection.issues.map(\.rootKey))
    let uniqueDigest = eventDigests.count == 1 ? eventDigests.first : nil

    for source in inspection.events {
      let event = source.event
      let validIdentity = uniqueDigest == event.urlKey.digest
        && sourceDigest == event.urlKey.digest
        && hasBookmarkTag
        && !invalidRoots.contains(source.rootKey)
      try db.execute(sql: """
        INSERT INTO bookmark_capture_event_sources
          (page_id,root_key,capture_id,raw_hash,encoded_envelope,url_key_digest,
           captured_at,day_key,time_zone,valid_identity)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        """, arguments: [
          page.id.rawValue,
          source.rootKey,
          event.captureID.uuidString.lowercased(),
          source.rawHash,
          source.encodedEnvelope,
          event.urlKey.digest,
          event.capturedAt.timeIntervalSince1970,
          event.dayKey.rawValue,
          event.timeZoneIdentifier,
          validIdentity,
        ])
    }

    for issue in inspection.issues {
      let key = "\(issue.kind.rawValue):\(issue.rootKey):\(issue.rawHash):\(issue.occurrence)"
      try db.execute(sql: """
        INSERT INTO bookmark_capture_event_issues
          (page_id,issue_key,root_key,raw_hash,kind)
        VALUES (?,?,?,?,?)
        """, arguments: [page.id.rawValue, key, issue.rootKey, issue.rawHash, issue.kind.rawValue])
    }

    if let uniqueDigest {
      try db.execute(
        sql: "INSERT INTO bookmark_frozen_identities (page_id,url_key_digest) VALUES (?,?)",
        arguments: [page.id.rawValue, uniqueDigest]
      )
      if !hasBookmarkTag || sourceDigest != uniqueDigest {
        let rawHash = inspection.events.first?.rawHash ?? "identity"
        try db.execute(sql: """
          INSERT OR REPLACE INTO bookmark_capture_event_issues
            (page_id,issue_key,root_key,raw_hash,kind)
          VALUES (?,?,?,?,?)
          """, arguments: [page.id.rawValue, "source-mismatch", "bookmark-source", rawHash, "sourceMismatch"])
      }
    } else if !eventDigests.isEmpty {
      try db.execute(sql: """
        INSERT OR REPLACE INTO bookmark_capture_event_issues
          (page_id,issue_key,root_key,raw_hash,kind)
        VALUES (?,?,?,?,?)
        """, arguments: [page.id.rawValue, "identity-conflict", "bookmark-identity", "multiple", "multipleIdentityDigests"])
    }
  }

  private static func sanitizedBookmarkHistoryIssueReason(_ kind: String) -> String {
    switch kind {
    case "sourceMismatch": return "Bookmark source does not match synced capture identity"
    case "multipleIdentityDigests": return "Conflicting bookmark identities on one page"
    case BookmarkCaptureEventIssueKind.conflictingValues.rawValue:
      return "Conflicting synced capture values"
    case BookmarkCaptureEventIssueKind.limitExceeded.rawValue:
      return "Synced capture history exceeds the supported limit"
    default:
      return "Invalid synced capture history"
    }
  }

  private static func isBookmarkIdentitySuppressed(_ db: Database, digest: String) throws -> Bool {
    try Bool.fetchOne(db, sql: """
      SELECT EXISTS(
        SELECT 1 FROM bookmark_identity_suppressions WHERE url_key_digest = ?
        UNION ALL
        SELECT 1 FROM bookmark_identity_deletions WHERE url_key_digest = ?
      )
      """, arguments: [digest, digest]) ?? false
  }

  private static func bookmarkSuppressionState(
    _ db: Database,
    digest: String
  ) throws -> BookmarkSuppressionState? {
    guard let row = try Row.fetchOne(db, sql: """
      SELECT stage,active_carrier_page_id,required_generation,acknowledged_generation,
             permanent_requested_at
      FROM bookmark_identity_suppressions WHERE url_key_digest = ?
      """, arguments: [digest]),
      let rawStage: String = row["stage"],
      let stage = BookmarkPermanentDeletionStage(rawValue: rawStage)
    else { return nil }
    let rawCarrier: String? = row["active_carrier_page_id"]
    let required: Int64? = row["required_generation"]
    let acknowledged: Int64? = row["acknowledged_generation"]
    let permanentAt: Double? = row["permanent_requested_at"]
    return .init(
      urlKeyDigest: digest,
      stage: stage,
      carrierPageID: rawCarrier.map(PageID.init(rawValue:)),
      requiredGeneration: required,
      acknowledgedGeneration: acknowledged,
      permanentRequested: permanentAt != nil
    )
  }

  static func reconcileBookmarkDeletionProjection(
    _ db: Database,
    page: PageSnapshot,
    origin: BookmarkPageWriteOrigin,
    cloudDirty: Bool
  ) throws {
    let inspection = try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: page.document)
    let deletions = inspection.deletionInspection.deletions.map(\.envelope)
    guard !deletions.isEmpty else {
      if origin == .remote,
        let digest = try String.fetchOne(
          db,
          sql: "SELECT url_key_digest FROM bookmark_deletion_carriers WHERE page_id = ?",
          arguments: [page.id.rawValue]
        )
      {
        try ensureBookmarkDeletionCarrier(db, digest: digest, now: page.modifiedAt, forceNew: true)
      }
      return
    }
    for deletion in deletions {
      try db.execute(
        sql: """
          INSERT INTO bookmark_identity_suppressions
            (url_key_digest,url_key_version,deletion_id,deleted_at,stage)
          VALUES (?,?,?,?,?) ON CONFLICT(url_key_digest) DO NOTHING
          """,
        arguments: [
          deletion.urlKeyDigest,
          deletion.urlKeyVersion,
          deletion.deletionID.uuidString.lowercased(),
          deletion.deletedAt.timeIntervalSince1970,
          BookmarkPermanentDeletionStage.preparing.rawValue,
        ]
      )
    }
    if inspection.isCanonicalCarrier, let canonical = inspection.canonicalDeletion {
      let provesCurrentGeneration = origin == .remote && !cloudDirty
      let acknowledged: Int64? = provesCurrentGeneration ? page.dirtyGeneration : nil
      try db.execute(
        sql: """
          INSERT INTO bookmark_deletion_carriers
            (page_id,url_key_digest,deletion_id,generation,acknowledged_generation)
          VALUES (?,?,?,?,?)
          ON CONFLICT(page_id) DO UPDATE SET
            url_key_digest=excluded.url_key_digest,
            deletion_id=excluded.deletion_id,
            generation=excluded.generation,
            acknowledged_generation=COALESCE(
              excluded.acknowledged_generation,
              bookmark_deletion_carriers.acknowledged_generation
            )
          """,
        arguments: [
          page.id.rawValue,
          canonical.urlKeyDigest,
          canonical.deletionID.uuidString.lowercased(),
          page.dirtyGeneration,
          acknowledged,
        ]
      )
      if provesCurrentGeneration {
        try db.execute(
          sql: """
            UPDATE bookmark_identity_suppressions
            SET stage=?,active_carrier_page_id=?,required_generation=?,
                acknowledged_carrier_page_id=?,acknowledged_generation=?
            WHERE url_key_digest=?
            """,
          arguments: [
            BookmarkPermanentDeletionStage.carrierAcknowledged.rawValue,
            page.id.rawValue,
            page.dirtyGeneration,
            page.id.rawValue,
            page.dirtyGeneration,
            canonical.urlKeyDigest,
          ]
        )
      } else {
        let acked = try Bool.fetchOne(
          db,
          sql: """
            SELECT EXISTS(
              SELECT 1 FROM bookmark_deletion_carriers c JOIN pages p ON p.id=c.page_id
              WHERE c.url_key_digest=? AND c.acknowledged_generation=c.generation
            )
            """,
          arguments: [canonical.urlKeyDigest]
        ) ?? false
        if !acked {
          try db.execute(
            sql: """
              UPDATE bookmark_identity_suppressions
              SET stage=?,active_carrier_page_id=?,required_generation=?,
                  acknowledged_carrier_page_id=NULL,acknowledged_generation=NULL
              WHERE url_key_digest=?
              """,
            arguments: [
              BookmarkPermanentDeletionStage.carrierPendingAck.rawValue,
              page.id.rawValue,
              page.dirtyGeneration,
              canonical.urlKeyDigest,
            ]
          )
        }
      }
      try tombstoneBookmarkCandidates(db, digest: canonical.urlKeyDigest, now: canonical.deletedAt)
      if provesCurrentGeneration,
        try Double.fetchOne(
          db,
          sql: "SELECT permanent_requested_at FROM bookmark_identity_suppressions WHERE url_key_digest=?",
          arguments: [canonical.urlKeyDigest]
        ) != nil
      {
        try purgeSuppressedBookmarkCandidates(
          db,
          digest: canonical.urlKeyDigest,
          now: page.modifiedAt
        )
      }
    } else {
      // A system tombstone may preserve malformed deletion roots from a late old-client Page.
      // The outer remote/local reconciliation owns carrier recovery; recursing here can allocate
      // carriers without bound if the Page is intentionally noncanonical.
      guard origin != .system else { return }
      for digest in Set(deletions.map(\.urlKeyDigest)).sorted() {
        try tombstoneBookmarkCandidates(db, digest: digest, now: page.modifiedAt)
        try ensureBookmarkDeletionCarrier(db, digest: digest, now: page.modifiedAt)
      }
    }
  }

  private static func suppressBookmarkIdentity(
    _ db: Database,
    deletion: BookmarkIdentityDeletion,
    now: Date
  ) throws {
    try db.execute(
      sql: """
        INSERT INTO bookmark_identity_deletions
          (url_key_digest,url_key_version,canonical_url,deletion_id)
        VALUES (?,?,?,?) ON CONFLICT(url_key_digest,deletion_id) DO NOTHING
        """,
      arguments: [
        deletion.urlKey.digest,
        BookmarkURLKey.version,
        deletion.urlKey.canonicalURL,
        deletion.deletionID.uuidString.lowercased(),
      ]
    )
    try db.execute(
      sql: """
        INSERT INTO bookmark_identity_suppressions
          (url_key_digest,url_key_version,deletion_id,deleted_at,stage)
        VALUES (?,?,?,?,?) ON CONFLICT(url_key_digest) DO NOTHING
        """,
      arguments: [
        deletion.urlKey.digest,
        BookmarkURLKey.version,
        deletion.deletionID.uuidString.lowercased(),
        now.timeIntervalSince1970,
        BookmarkPermanentDeletionStage.preparing.rawValue,
      ]
    )
    try ensureBookmarkDeletionCarrier(db, digest: deletion.urlKey.digest, now: now)
    try tombstoneBookmarkCandidates(db, digest: deletion.urlKey.digest, now: now)
  }

  private static func ensureBookmarkDeletionCarrier(
    _ db: Database,
    digest: String,
    now: Date,
    forceNew: Bool = false
  ) throws {
    if !forceNew {
      let carrierIDs = try String.fetchAll(
        db,
        sql: """
          SELECT c.page_id FROM bookmark_deletion_carriers c JOIN pages p ON p.id=c.page_id
          WHERE c.url_key_digest=? ORDER BY c.page_id
          """,
        arguments: [digest]
      )
      for rawID in carrierIDs {
        let pageID = PageID(rawValue: rawID)
        guard let page = try fetchPage(db, id: pageID),
          let carrier = try? PageDocument.bookmarkIdentityDeletionCarrierInspection(in: page.document),
          carrier.isCanonicalCarrier
        else { continue }
        let ack = try Int64.fetchOne(
          db,
          sql: "SELECT acknowledged_generation FROM bookmark_deletion_carriers WHERE page_id=?",
          arguments: [rawID]
        )
        let stage: BookmarkPermanentDeletionStage = ack == page.dirtyGeneration
          ? .carrierAcknowledged
          : .carrierPendingAck
        try db.execute(
          sql: """
            UPDATE bookmark_identity_suppressions
            SET stage=?,active_carrier_page_id=?,required_generation=?,
                acknowledged_carrier_page_id=?,acknowledged_generation=?
            WHERE url_key_digest=?
            """,
          arguments: [
            stage.rawValue,
            rawID,
            page.dirtyGeneration,
            stage == .carrierAcknowledged ? rawID : nil,
            stage == .carrierAcknowledged ? ack : nil,
            digest,
          ]
        )
        return
      }
    }
    guard let row = try Row.fetchOne(
      db,
      sql: "SELECT deletion_id,deleted_at FROM bookmark_identity_suppressions WHERE url_key_digest=?",
      arguments: [digest]
    ), let deletedAt: Double = row["deleted_at"]
    else { return }
    let stored: String? = row["deletion_id"]
    let deletionID = forceNew ? UUID() : (stored.flatMap(UUID.init(uuidString:)) ?? UUID())
    let envelope = try BookmarkIdentityDeletionEnvelope(
      deletionID: deletionID,
      urlKeyDigest: digest,
      deletedAt: Date(timeIntervalSince1970: deletedAt)
    )
    let candidate = try String.fetchOne(
      db,
      sql: "SELECT page_id FROM bookmark_identity_candidates WHERE url_key_digest=? ORDER BY page_id LIMIT 1",
      arguments: [digest]
    ).map(PageID.init(rawValue:)) ?? .free()
    var carrierID = PageID.free()
    while true {
      if carrierID != candidate, try fetchPage(db, id: carrierID) == nil { break }
      carrierID = .free()
    }
    let document = try PageDocument.makeBookmarkIdentityDeletionCarrier(
      id: carrierID,
      replacingCandidateID: candidate,
      deletion: envelope
    )
    let carrierInspection = try PageDocument.bookmarkIdentityDeletionCarrierInspection(
      in: document.document
    )
    guard carrierInspection.isCanonicalCarrier,
      carrierInspection.canonicalDeletion?.urlKeyDigest == digest
    else {
      throw LibraryRepositoryError.invalidRecord
    }
    let carrier = PageSnapshot(
      id: carrierID,
      kind: .free,
      title: document.projection.title,
      plainText: document.projection.plainText,
      document: document.document,
      heads: document.heads,
      createdAt: envelope.deletedAt,
      modifiedAt: now,
      deletedAt: document.projection.deletedAt,
      isPinned: document.projection.isPinned,
      dirtyGeneration: 1,
      objectMetadata: document.projection.objectMetadata
    )
    try writePage(db, page: carrier, cloudDirty: true, bookmarkOrigin: .system)
    try db.execute(
      sql: """
        UPDATE bookmark_identity_suppressions
        SET stage=?,active_carrier_page_id=?,required_generation=?,
            acknowledged_carrier_page_id=NULL,acknowledged_generation=NULL
        WHERE url_key_digest=?
        """,
      arguments: [
        BookmarkPermanentDeletionStage.carrierPendingAck.rawValue,
        carrierID.rawValue,
        carrier.dirtyGeneration,
        digest,
      ]
    )
  }

  private static func tombstoneBookmarkCandidates(
    _ db: Database,
    digest: String,
    now: Date
  ) throws {
    let ids = try String.fetchAll(
      db,
      sql: """
        SELECT p.id FROM bookmark_identity_candidates c JOIN pages p ON p.id=c.page_id
        WHERE c.url_key_digest=? AND p.deleted_at IS NULL ORDER BY p.id
        """,
      arguments: [digest]
    )
    for rawID in ids {
      let id = PageID(rawValue: rawID)
      guard let page = try fetchPage(db, id: id) else { continue }
      let mutation = try PageDocument.setDeleted(now, in: page.document)
      let updated = updatedPage(page, with: mutation, now: now)
      try writePage(db, page: updated, cloudDirty: true, bookmarkOrigin: .system)
      try replaceReferences(db, pageID: id, references: mutation.projection.references)
    }
  }

  private static func requestPermanentBookmarkDeletion(
    _ db: Database,
    digest: String,
    now: Date
  ) throws {
    try db.execute(
      sql: """
        UPDATE bookmark_identity_suppressions
        SET permanent_requested_at=COALESCE(permanent_requested_at,?)
        WHERE url_key_digest=?
        """,
      arguments: [now.timeIntervalSince1970, digest]
    )
    try ensureBookmarkDeletionCarrier(db, digest: digest, now: now)
    let acked = try Bool.fetchOne(
      db,
      sql: """
        SELECT EXISTS(
          SELECT 1 FROM bookmark_deletion_carriers c JOIN pages p ON p.id=c.page_id
          WHERE c.url_key_digest=? AND c.acknowledged_generation=c.generation
        )
        """,
      arguments: [digest]
    ) ?? false
    guard acked else { return }
    try db.execute(
      sql: "UPDATE bookmark_identity_suppressions SET stage=? WHERE url_key_digest=?",
      arguments: [BookmarkPermanentDeletionStage.carrierAcknowledged.rawValue, digest]
    )
    try purgeSuppressedBookmarkCandidates(db, digest: digest, now: now)
  }

  private static func acknowledgeBookmarkCarrierSave(
    _ db: Database,
    pageID: PageID,
    sentGeneration: Int64,
    now: Date
  ) throws {
    guard let row = try Row.fetchOne(
      db,
      sql: """
        SELECT c.url_key_digest,c.generation,p.dirty_generation
        FROM bookmark_deletion_carriers c JOIN pages p ON p.id=c.page_id
        WHERE c.page_id=?
        """,
      arguments: [pageID.rawValue]
    ), let digest: String = row["url_key_digest"],
      let carrierGeneration: Int64 = row["generation"],
      let pageGeneration: Int64 = row["dirty_generation"],
      carrierGeneration == sentGeneration,
      pageGeneration == sentGeneration
    else { return }
    try db.execute(
      sql: """
        UPDATE bookmark_deletion_carriers SET acknowledged_generation=?
        WHERE page_id=? AND generation=?
        """,
      arguments: [sentGeneration, pageID.rawValue, sentGeneration]
    )
    try db.execute(
      sql: """
        UPDATE bookmark_identity_suppressions
        SET stage=?,active_carrier_page_id=?,required_generation=?,
            acknowledged_carrier_page_id=?,acknowledged_generation=?
        WHERE url_key_digest=?
        """,
      arguments: [
        BookmarkPermanentDeletionStage.carrierAcknowledged.rawValue,
        pageID.rawValue,
        sentGeneration,
        pageID.rawValue,
        sentGeneration,
        digest,
      ]
    )
    if try Double.fetchOne(
      db,
      sql: "SELECT permanent_requested_at FROM bookmark_identity_suppressions WHERE url_key_digest=?",
      arguments: [digest]
    ) != nil {
      try purgeSuppressedBookmarkCandidates(db, digest: digest, now: now)
    }
  }

  private static func purgeSuppressedBookmarkCandidates(
    _ db: Database,
    digest: String,
    now: Date
  ) throws {
    let acked = try Bool.fetchOne(
      db,
      sql: """
        SELECT EXISTS(
          SELECT 1 FROM bookmark_deletion_carriers c JOIN pages p ON p.id=c.page_id
          WHERE c.url_key_digest=? AND c.acknowledged_generation=c.generation
        )
        """,
      arguments: [digest]
    ) ?? false
    guard acked else { return }
    try db.execute(
      sql: "UPDATE bookmark_identity_suppressions SET stage=? WHERE url_key_digest=?",
      arguments: [BookmarkPermanentDeletionStage.purgingCandidates.rawValue, digest]
    )
    let ids = try String.fetchAll(
      db,
      sql: "SELECT page_id FROM bookmark_identity_candidates WHERE url_key_digest=? ORDER BY page_id",
      arguments: [digest]
    )
    for rawID in ids {
      if let row = try Row.fetchOne(
        db,
        sql: "SELECT dirty_generation,cloud_record FROM pages WHERE id=?",
        arguments: [rawID]
      ) {
        let generation: Int64 = row["dirty_generation"] ?? 0
        let cloudRecord: Data? = row["cloud_record"]
        try db.execute(
          sql: """
            INSERT OR REPLACE INTO purge_markers
              (page_id,generation,purged_at,cloud_dirty,cloud_record)
            VALUES (?,?,?,1,?)
            """,
          arguments: [rawID, generation + 1, now.timeIntervalSince1970, cloudRecord]
        )
        try db.execute(sql: "DELETE FROM pages WHERE id=?", arguments: [rawID])
      }
    }
    if !ids.isEmpty {
      let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
      try db.execute(
        sql: "DELETE FROM bookmark_capture_receipts WHERE page_id IN (\(placeholders))",
        arguments: StatementArguments(ids)
      )
    }
    try db.execute(
      sql: """
        DELETE FROM bookmark_capture_receipts
        WHERE capture_id IN (
          SELECT capture_id FROM bookmark_capture_events WHERE url_key_digest=?
        )
        """,
      arguments: [digest]
    )
    try db.execute(
      sql: "DELETE FROM bookmark_capture_events WHERE url_key_digest=?",
      arguments: [digest]
    )
    try db.execute(
      sql: "DELETE FROM bookmark_identity_candidates WHERE url_key_digest=?",
      arguments: [digest]
    )
    try db.execute(
      sql: "DELETE FROM bookmark_identity_deletions WHERE url_key_digest=?",
      arguments: [digest]
    )
    try db.execute(
      sql: """
        INSERT INTO bookmark_permanent_delete_handoffs (url_key_digest,completed_at)
        VALUES (?,?) ON CONFLICT(url_key_digest) DO UPDATE SET completed_at=excluded.completed_at
        """,
      arguments: [digest, now.timeIntervalSince1970]
    )
    try db.execute(
      sql: """
        UPDATE bookmark_identity_suppressions SET stage=?,stable_at=?
        WHERE url_key_digest=?
        """,
      arguments: [BookmarkPermanentDeletionStage.stable.rawValue, now.timeIntervalSince1970, digest]
    )
  }

  static func recoverBookmarkDeletionState(_ db: Database, now: Date) throws {
    let digests = try String.fetchAll(
      db,
      sql: "SELECT url_key_digest FROM bookmark_identity_suppressions ORDER BY url_key_digest"
    )
    for digest in digests {
      try ensureBookmarkDeletionCarrier(db, digest: digest, now: now)
      try tombstoneBookmarkCandidates(db, digest: digest, now: now)
      if try Double.fetchOne(
        db,
        sql: "SELECT permanent_requested_at FROM bookmark_identity_suppressions WHERE url_key_digest=?",
        arguments: [digest]
      ) != nil {
        try requestPermanentBookmarkDeletion(db, digest: digest, now: now)
      }
    }
  }

  private static func applyBookmarkCarrierCloudDeletion(
    _ db: Database,
    pageID: PageID,
    deletedAt: Date
  ) throws -> Bool? {
    guard let row = try Row.fetchOne(
      db,
      sql: """
        SELECT c.url_key_digest,p.cloud_dirty
        FROM bookmark_deletion_carriers c JOIN pages p ON p.id=c.page_id
        WHERE c.page_id=?
        """,
      arguments: [pageID.rawValue]
    ), let digest: String = row["url_key_digest"]
    else { return nil }
    let cloudDirty: Bool = row["cloud_dirty"] ?? false
    if cloudDirty {
      try db.execute(
        sql: "UPDATE pages SET cloud_record=NULL,cloud_dirty=1 WHERE id=?",
        arguments: [pageID.rawValue]
      )
      return true
    }
    try db.execute(sql: "DELETE FROM pages WHERE id=?", arguments: [pageID.rawValue])
    if let survivor = try Row.fetchOne(
      db,
      sql: """
        SELECT c.page_id,c.generation,c.acknowledged_generation
        FROM bookmark_deletion_carriers c JOIN pages p ON p.id=c.page_id
        WHERE c.url_key_digest=? ORDER BY c.page_id LIMIT 1
        """,
      arguments: [digest]
    ), let raw: String = survivor["page_id"],
      let generation: Int64 = survivor["generation"]
    {
      let ack: Int64? = survivor["acknowledged_generation"]
      let stage: BookmarkPermanentDeletionStage = ack == generation
        ? .carrierAcknowledged
        : .carrierPendingAck
      try db.execute(
        sql: """
          UPDATE bookmark_identity_suppressions
          SET stage=?,active_carrier_page_id=?,required_generation=?,
              acknowledged_carrier_page_id=?,acknowledged_generation=?
          WHERE url_key_digest=?
          """,
        arguments: [
          stage.rawValue,
          raw,
          generation,
          ack == generation ? raw : nil,
          ack == generation ? ack : nil,
          digest,
        ]
      )
      return false
    }
    try ensureBookmarkDeletionCarrier(db, digest: digest, now: deletedAt, forceNew: true)
    return true
  }

  private static func enqueueTaskEffectOutbox(
    _ db: Database,
    pageID: PageID,
    generation: Int64,
    requestingAuthorization: Bool,
    now: Date
  ) throws {
    for kind in TaskEffectOutboxKind.allCases {
      try db.execute(
        sql: """
          INSERT INTO task_effect_outbox
            (page_id,effect_kind,generation,request_authorization,enqueued_at)
          VALUES (?,?,?,?,?)
          ON CONFLICT(page_id,effect_kind) DO UPDATE SET
            generation=excluded.generation,
            request_authorization=excluded.request_authorization,
            enqueued_at=excluded.enqueued_at,
            last_error=NULL
          WHERE excluded.generation >= task_effect_outbox.generation
          """,
        arguments: [
          pageID.rawValue,
          kind.rawValue,
          generation,
          requestingAuthorization,
          now.timeIntervalSince1970,
        ]
      )
    }
  }

  static func writePage(
    _ db: Database,
    page: PageSnapshot,
    cloudDirty: Bool,
    cloudRecord: Data? = nil,
    bookmarkOrigin: BookmarkPageWriteOrigin = .local
  ) throws {
    if bookmarkOrigin == .local,
      try Bool.fetchOne(
        db,
        sql: "SELECT EXISTS(SELECT 1 FROM bookmark_deletion_carriers WHERE page_id = ?)",
        arguments: [page.id.rawValue]
      ) ?? false
    {
      throw LibraryRepositoryError.bookmarkDeletionCarrier
    }
    if bookmarkOrigin == .local {
      try validateFrozenBookmarkIdentity(db, page: page)
    }
    var affectedRelationIDs = try GraphProjectionStore.relationIDs(touching: page.id, in: db)
    let kindTag: String
    let dayKey: String?
    switch page.kind {
    case .daily(let day):
      kindTag = "daily"
      dayKey = day.rawValue
    case .free:
      kindTag = "free"
      dayKey = nil
    case .calendarEvent:
      kindTag = "calendarEvent"
      dayKey = nil
    case .calendarSeries:
      kindTag = "calendarSeries"
      dayKey = nil
    case .calendarMaterializedEvent:
      kindTag = "calendarMaterializedEvent"
      dayKey = nil
    }
    try db.execute(
      sql: """
        INSERT INTO pages
          (id,kind_tag,kind_json,day_key,title,plain_text,document,heads_json,
           created_at,modified_at,deleted_at,is_pinned,dirty_generation,cloud_dirty,cloud_record,
           person_visibility,person_origin)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          kind_tag=excluded.kind_tag,
          kind_json=excluded.kind_json,
          day_key=excluded.day_key,
          title=excluded.title,
          plain_text=excluded.plain_text,
          document=excluded.document,
          heads_json=excluded.heads_json,
          modified_at=excluded.modified_at,
          deleted_at=excluded.deleted_at,
          is_pinned=excluded.is_pinned,
          dirty_generation=excluded.dirty_generation,
          cloud_dirty=excluded.cloud_dirty,
          cloud_record=COALESCE(excluded.cloud_record,pages.cloud_record),
          person_visibility=COALESCE(excluded.person_visibility,pages.person_visibility),
          person_origin=COALESCE(excluded.person_origin,pages.person_origin)
        """,
      arguments: [
        page.id.rawValue,
        kindTag,
        try JSONEncoder.enchiridion.encode(page.kind),
        dayKey,
        page.title,
        page.plainText,
        page.document,
        try JSONEncoder.enchiridion.encode(page.heads),
        page.createdAt.timeIntervalSince1970,
        page.modifiedAt.timeIntervalSince1970,
        page.deletedAt?.timeIntervalSince1970,
        page.isPinned,
        page.dirtyGeneration,
        cloudDirty,
        cloudRecord,
        page.objectMetadata.personVisibility?.rawValue,
        page.objectMetadata.personOrigin?.rawValue,
      ]
    )
    try replaceObjectProjection(db, pageID: page.id, metadata: page.objectMetadata)
    try reconcileBookmarkCaptureEventProjection(db, page: page)
    try reconcileBookmarkDeletionProjection(
      db,
      page: page,
      origin: bookmarkOrigin,
      cloudDirty: cloudDirty
    )
    try reconcileBookmarkCandidate(db, page: page)
    try GraphProjectionStore.replacePage(page, references: nil, in: db)
    affectedRelationIDs.formUnion(
      try GraphProjectionStore.relationIDs(touching: page.id, in: db)
    )
    try GraphProjectionStore.refreshIssues(for: affectedRelationIDs, in: db)
    switch page.kind {
    case .calendarEvent(let identity):
      try mapOccurrencePage(
        db,
        pageID: page.id,
        sourceEventKey: identity.stableKey,
        occurrenceKey: identity.canonicalOccurrenceKey,
        seriesKey: identity.series?.canonicalKey
      )
    case .calendarSeries(let series):
      try db.execute(
        sql: "INSERT OR REPLACE INTO series_page_map (series_key,page_id) VALUES (?,?)",
        arguments: [series.canonicalKey, page.id.rawValue]
      )
    case .calendarMaterializedEvent, .daily, .free:
      break
    }
    try enforceSuppressedBookmarkPage(db, page: page)
  }

  /// Bookmark identity is an event-authoritative projection of the ordinary Bookmark Page.
  /// Candidates deliberately survive tombstoning and suppression until acknowledged purge.
  private static func reconcileBookmarkCandidate(_ db: Database, page: PageSnapshot) throws {
    try db.execute(
      sql: "DELETE FROM bookmark_identity_candidates WHERE page_id = ?",
      arguments: [page.id.rawValue]
    )
    if try Bool.fetchOne(
      db,
      sql: "SELECT EXISTS(SELECT 1 FROM bookmark_deletion_carriers WHERE page_id=?)",
      arguments: [page.id.rawValue]
    ) ?? false {
      return
    }
    let events = try PageDocument.bookmarkCaptureEvents(in: page.document).events.map(\.event)
    let digests = Set(events.map(\.urlKey.digest))
    if digests.count == 1,
      let event = events.sorted(by: { $0.captureID.uuidString < $1.captureID.uuidString }).first
    {
      try db.execute(
        sql: """
          INSERT INTO bookmark_identity_candidates
            (url_key_digest,url_key_version,canonical_url,page_id)
          VALUES (?,?,?,?)
          ON CONFLICT(url_key_digest,page_id) DO UPDATE SET
            url_key_version=excluded.url_key_version,
            canonical_url=excluded.canonical_url
          """,
        arguments: [
          event.urlKey.digest,
          BookmarkURLKey.version,
          event.urlKey.canonicalURL,
          page.id.rawValue,
        ]
      )
      return
    }
    guard page.hasSupertag(BuiltInSupertags.bookmark),
      let key = bookmarkSourceURLKey(in: page)
    else { return }
    try db.execute(
      sql: """
        INSERT INTO bookmark_identity_candidates
          (url_key_digest,url_key_version,canonical_url,page_id)
        VALUES (?,?,?,?) ON CONFLICT(url_key_digest,page_id) DO NOTHING
        """,
      arguments: [key.digest, BookmarkURLKey.version, key.canonicalURL, page.id.rawValue]
    )
  }

  private static func enforceSuppressedBookmarkPage(
    _ db: Database,
    page: PageSnapshot
  ) throws {
    guard let digest = try String.fetchOne(
      db,
      sql: """
        SELECT c.url_key_digest
        FROM bookmark_identity_candidates c
        JOIN bookmark_identity_suppressions d ON d.url_key_digest=c.url_key_digest
        WHERE c.page_id=?
        """,
      arguments: [page.id.rawValue]
    ) else { return }
    let permanent = try Double.fetchOne(
      db,
      sql: "SELECT permanent_requested_at FROM bookmark_identity_suppressions WHERE url_key_digest=?",
      arguments: [digest]
    ) != nil
    let acked = try Bool.fetchOne(
      db,
      sql: """
        SELECT EXISTS(
          SELECT 1 FROM bookmark_deletion_carriers c JOIN pages p ON p.id=c.page_id
          WHERE c.url_key_digest=? AND c.acknowledged_generation=c.generation
        )
        """,
      arguments: [digest]
    ) ?? false
    if permanent && acked {
      try purgeSuppressedBookmarkCandidates(db, digest: digest, now: page.modifiedAt)
      return
    }
    guard page.deletedAt == nil, let stored = try fetchPage(db, id: page.id) else { return }
    let mutation = try PageDocument.setDeleted(page.modifiedAt, in: stored.document)
    let tombstone = updatedPage(stored, with: mutation, now: page.modifiedAt)
    try writePage(db, page: tombstone, cloudDirty: true, bookmarkOrigin: .system)
    try replaceReferences(db, pageID: page.id, references: mutation.projection.references)
  }

  static func updatedPage(
    _ current: PageSnapshot,
    with result: (
      document: Data,
      heads: AutomergeHeads,
      projection: PageDocumentProjection
    ),
    now: Date
  ) -> PageSnapshot {
    PageSnapshot(
      id: current.id,
      kind: current.kind,
      title: result.projection.title,
      plainText: result.projection.plainText,
      document: result.document,
      heads: result.heads,
      createdAt: current.createdAt,
      modifiedAt: now,
      deletedAt: result.projection.deletedAt,
      isPinned: result.projection.isPinned,
      dirtyGeneration: current.dirtyGeneration + 1,
      objectMetadata: result.projection.objectMetadata
    )
  }

  private static func replaceReferences(
    _ db: Database,
    pageID: PageID,
    references: [PageReference]
  ) throws {
    try db.execute(
      sql: "DELETE FROM page_references WHERE source_page_id = ?",
      arguments: [pageID.rawValue]
    )
    for reference in references {
      try db.execute(
        sql: "INSERT INTO page_references (source_page_id,target_page_id,fallback_label) VALUES (?,?,?)",
        arguments: [pageID.rawValue, reference.targetPageID.rawValue, reference.fallbackLabel]
      )
    }
    try GraphProjectionStore.replaceMentions(from: pageID, references: references, in: db)
    try GraphProjectionStore.refreshIssues(for: [BuiltInRelations.mentions], in: db)
  }

  static func fetchPage(_ db: Database, id: PageID) throws -> PageSnapshot? {
    guard let row = try Row.fetchOne(db, sql: "SELECT * FROM pages WHERE id = ?", arguments: [id.rawValue]) else {
      return nil
    }
    return try Self.decodePage(row)
  }

  static func decodePage(_ row: Row) throws -> PageSnapshot {
    guard let id: String = row["id"],
      let kindData: Data = row["kind_json"],
      let title: String = row["title"],
      let plainText: String = row["plain_text"],
      let document: Data = row["document"],
      let headsData: Data = row["heads_json"],
      let createdAt: Double = row["created_at"],
      let modifiedAt: Double = row["modified_at"],
      let dirtyGeneration: Int64 = row["dirty_generation"]
    else { throw LibraryRepositoryError.invalidRecord }
    let idValue = PageID(rawValue: id)
    var metadata = (try? PageDocument.inspect(document, pageID: idValue).objectMetadata) ?? .init()
    if metadata.personVisibility == nil, let value: String = row["person_visibility"] {
      metadata.personVisibility = PersonVisibility(rawValue: value)
    }
    if metadata.personOrigin == nil, let value: String = row["person_origin"] {
      metadata.personOrigin = PersonOrigin(rawValue: value)
    }
    return PageSnapshot(
      id: idValue,
      kind: try JSONDecoder.enchiridion.decode(PageKind.self, from: kindData),
      title: title,
      plainText: plainText,
      document: document,
      heads: try JSONDecoder.enchiridion.decode(AutomergeHeads.self, from: headsData),
      createdAt: Date(timeIntervalSince1970: createdAt),
      modifiedAt: Date(timeIntervalSince1970: modifiedAt),
      deletedAt: (row["deleted_at"] as Double?).map { Date(timeIntervalSince1970: $0) },
      isPinned: row["is_pinned"] ?? false,
      dirtyGeneration: dirtyGeneration,
      objectMetadata: metadata
    )
  }

  private static func decodeSuggestion(_ row: Row) -> PageSuggestion? {
    guard let id: String = row["id"], let title: String = row["title"],
      let kindData: Data = row["kind_json"],
      let kind = try? JSONDecoder.enchiridion.decode(PageKind.self, from: kindData)
    else { return nil }
    return PageSuggestion(id: PageID(rawValue: id), title: title, kind: kind)
  }

  private static func contactLink(_ db: Database, pageID: PageID) throws -> PersonContactLink? {
    try Row.fetchOne(
      db,
      sql: "SELECT * FROM person_contact_links WHERE person_page_id = ?",
      arguments: [pageID.rawValue]
    ).flatMap(decodeContactLink)
  }

  private static func decodeContactLink(_ row: Row) -> PersonContactLink? {
    guard let rawPageID: String = row["person_page_id"],
      let identifier: String = row["contact_identifier"],
      let matchedEmail: String = row["matched_email"],
      let recordData: Data = row["contact_json"],
      let refreshedAt: Double = row["refreshed_at"],
      let record = try? JSONDecoder.enchiridion.decode(DeviceContactRecord.self, from: recordData)
    else { return nil }
    return PersonContactLink(
      pageID: PageID(rawValue: rawPageID),
      contactIdentifier: identifier,
      matchedEmail: matchedEmail,
      record: record,
      refreshedAt: Date(timeIntervalSince1970: refreshedAt)
    )
  }

  private static let personEmailKey = SupertagPropertyKey(
    supertagID: BuiltInSupertags.person,
    fieldID: .init(rawValue: "email")
  )

  private static func personEmails(in page: PageSnapshot) -> [String] {
    (page.objectMetadata.properties[personEmailKey] ?? []).compactMap { value in
      guard case .email(let email) = value else { return nil }
      return email
    }
  }

  private static func personEmailCandidates(
    _ db: Database,
    matchingNormalizedEmail normalizedEmail: String
  ) throws -> [PersonEmailCandidate] {
    let people = try Row.fetchAll(
      db,
      sql: """
        SELECT p.* FROM pages p
        JOIN graph_node_tags t ON t.node_id = p.id AND t.tag_id = 'person'
        WHERE p.deleted_at IS NULL
        ORDER BY p.title COLLATE NOCASE, p.id
        """
    ).map(Self.decodePage)
    return try people.compactMap { page in
      let emails = personEmails(in: page)
      guard emails.contains(where: { PersonEmail.normalizedForComparison($0) == normalizedEmail })
      else { return nil }
      return PersonEmailCandidate(
        pageID: page.id,
        displayName: try personDisplayName(db, page: page),
        email: normalizedEmail
      )
    }
  }

  /// Reconciles the durable CloudKit intent after the effective tag closure changes and before
  /// local changes are enqueued. A visibility of `nil` intentionally keeps the persisted
  /// eligibility untouched: adding a Person ancestor must never make legacy data local-only.
  private static func reconcileCloudPrivacyDesiredStates(in db: Database) throws {
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT p.id,p.person_visibility,p.person_cloud_eligible,p.cloud_record,
               s.desired_operation,s.generation
        FROM pages p
        LEFT JOIN page_cloud_privacy_states s ON s.page_id = p.id
        WHERE p.deleted_at IS NULL
        """
    )
    for row in rows {
      guard let id: String = row["id"] else { continue }
      let pageID = PageID(rawValue: id)
      let effectivePerson = try Bool.fetchOne(
        db,
        sql: "SELECT EXISTS(SELECT 1 FROM graph_node_tags WHERE node_id = ? AND tag_id = 'person')",
        arguments: [id]
      ) ?? false
      let visibility = (row["person_visibility"] as String?).flatMap(PersonVisibility.init(rawValue:))
      let prior = (row["desired_operation"] as String?).flatMap(CloudPrivacyDesiredOperation.init(rawValue:))
      let previousGeneration: Int64 = row["generation"] ?? 0
      let cloudEligible: Bool = row["person_cloud_eligible"] ?? true
      let hasCloudRecord: Bool = (row["cloud_record"] as Data?) != nil

      let target: CloudPrivacyDesiredOperation?
      if effectivePerson {
        switch visibility {
        case .other?:
          // Fresh calendar projections are already local-only and have no CloudKit record to
          // remove. A state begins only when a formerly eligible or uploaded Person crosses the
          // boundary (or when an earlier desired state must remain durable).
          target = prior == .delete || cloudEligible || hasCloudRecord ? .delete : nil
        case .promoted?: target = prior == .delete ? .save : prior
        case nil: target = prior
        }
      } else {
        // Unknown/non-Person effective types have no privacy instruction. Keep both the prior
        // eligibility and any durable in-flight operation instead of implicitly publishing a
        // page that was previously made local-only.
        target = prior
      }
      guard let target else { continue }
      guard target != prior else { continue }
      let generation = previousGeneration + 1
      try db.execute(
        sql: """
          INSERT INTO page_cloud_privacy_states
            (page_id,desired_operation,generation,enqueued_generation,acknowledged_generation,save_dirty_generation)
          VALUES (?,?,?,0,0,NULL)
          ON CONFLICT(page_id) DO UPDATE SET
            desired_operation=excluded.desired_operation,
            generation=excluded.generation,
            enqueued_generation=0,
            acknowledged_generation=0,
            save_dirty_generation=NULL
          """,
        arguments: [pageID.rawValue, target.rawValue, generation]
      )
      switch target {
      case .delete:
        try db.execute(
          sql: "UPDATE pages SET person_cloud_eligible = 0, cloud_dirty = 0 WHERE id = ?",
          arguments: [pageID.rawValue]
        )
      case .save:
        try db.execute(
          sql: "UPDATE pages SET person_cloud_eligible = 1, cloud_dirty = 1 WHERE id = ?",
          arguments: [pageID.rawValue]
        )
      }
    }
  }

  /// Resolves CloudKit eligibility from a schema's effective tag closure, not just its direct
  /// tags. Person privacy is explicit; all unknown classifications retain their persisted
  /// eligibility so a schema or merge cannot silently publish local data.
  private static func cloudEligibility(
    in db: Database,
    metadata: PageObjectMetadata,
    existingEligibility: Bool
  ) throws -> Bool {
    let definitions = try Row.fetchAll(
      db,
      sql: "SELECT definition_json FROM supertag_schemas WHERE deleted = 0"
    ).compactMap { row -> SupertagDefinition? in
      guard let data: Data = row["definition_json"] else { return nil }
      return try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data)
    }
    let effectiveTags = SupertagInheritance.effectiveTagIDs(
      for: Set(metadata.supertagIDs),
      definitions: definitions
    )
    guard effectiveTags.contains(BuiltInSupertags.person) else {
      return existingEligibility
    }
    switch metadata.personVisibility {
    case .other?: return false
    case .promoted?: return true
    case nil: return existingEligibility
    }
  }

  private static func personDisplayName(_ db: Database, page: PageSnapshot) throws -> String {
    let emails = personEmails(in: page)
    let link = try contactLink(db, pageID: page.id)
    return PersonDisplayName.resolved(
      title: page.title,
      emails: emails,
      origin: page.personOrigin,
      contactLink: link
    )
  }

  private static func removeStaleContactLink(_ db: Database, for page: PageSnapshot) throws {
    let normalizedEmails = Set(personEmails(in: page).map(PersonEmail.normalizedForComparison))
    guard let link = try contactLink(db, pageID: page.id),
      !normalizedEmails.contains(link.matchedEmail)
    else { return }
    try db.execute(
      sql: "DELETE FROM person_contact_links WHERE person_page_id = ?",
      arguments: [page.id.rawValue]
    )
  }

  private static func validatedInitialProperties(
    _ initialProperties: [SupertagPropertyKey: [SupertagValue]],
    targetSupertagID: SupertagID,
    db: Database
  ) throws -> [SupertagPropertyKey: [SupertagValue]] {
    let fields = try effectiveSupertagFields(db, for: targetSupertagID)
    var result: [SupertagPropertyKey: [SupertagValue]] = [:]
    for (key, values) in initialProperties {
      guard let field = fields[key] else {
        throw TaggedPageReferenceInsertionError.invalidInitialProperties
      }
      do {
        result[key] = try validatedValues(values, key: key, field: field)
      } catch is PersonEmailValidationError {
        throw TaggedPageReferenceInsertionError.invalidInitialProperties
      } catch {
        throw TaggedPageReferenceInsertionError.invalidInitialProperties
      }
    }
    return result
  }

  /// Resolves the direct supertag and all of its live ancestors. Property keys retain the
  /// definition that owns the field, so identically named fields never collide.
  private static func effectiveSupertagFields(
    _ db: Database,
    for rootID: SupertagID
  ) throws -> [SupertagPropertyKey: SupertagFieldDefinition] {
    let definitions = try Row.fetchAll(
      db,
      sql: "SELECT definition_json FROM supertag_schemas WHERE deleted = 0"
    ).compactMap { row -> SupertagDefinition? in
      guard let data: Data = row["definition_json"] else { return nil }
      return try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data)
    }
    let definitionsByID = Dictionary(uniqueKeysWithValues: definitions.map { ($0.id, $0) })
    guard definitionsByID[rootID] != nil else {
      throw TaggedPageReferenceInsertionError.invalidSupertag
    }
    guard definitionsByID[rootID] != nil else {
      throw TaggedPageReferenceInsertionError.invalidSupertag
    }
    return Dictionary(
      uniqueKeysWithValues: SupertagInheritance.effectiveFields(
        for: rootID,
        definitions: definitions
      ).compactMap { field in
        guard !field.definition.isDeleted else { return nil }
        return (field.propertyKey, field.definition)
      }
    )
  }

  private static func validatedValues(
    _ values: [SupertagValue],
    key: SupertagPropertyKey,
    field: SupertagFieldDefinition
  ) throws -> [SupertagValue] {
    try validate(values: values, for: field)
    guard key == personEmailKey else { return values }
    return try values.map { value in
      guard case .email(let email) = value else { throw LibraryRepositoryError.invalidRecord }
      return .email(try PersonEmail.normalize(email))
    }
  }

  private static func validate(values: [SupertagValue], for field: SupertagFieldDefinition) throws {
    if !field.allowsMultiple && values.count > 1 { throw LibraryRepositoryError.invalidRecord }
    for value in values {
      let valid: Bool
      switch (field.type, value) {
      case (.text, .text), (.number, .number), (.boolean, .boolean), (.date, .date),
        (.dateTime, .dateTime), (.url, .url), (.email, .email), (.phone, .phone),
        (.entityReference, .page):
        valid = true
      case (.select, .select(let option)):
        valid = field.options.contains { $0.id == option }
      default:
        valid = false
      }
      guard valid else { throw LibraryRepositoryError.invalidRecord }
    }
  }

  private static func replaceObjectProjection(
    _ db: Database,
    pageID: PageID,
    metadata: PageObjectMetadata
  ) throws {
    try db.execute(sql: "DELETE FROM page_supertags WHERE page_id = ?", arguments: [pageID.rawValue])
    try db.execute(sql: "DELETE FROM page_property_values WHERE page_id = ?", arguments: [pageID.rawValue])
    for tagID in metadata.supertagIDs {
      try db.execute(
        sql: "INSERT INTO page_supertags (page_id,supertag_id) VALUES (?,?)",
        arguments: [pageID.rawValue, tagID.rawValue]
      )
    }
    for (key, values) in metadata.properties {
      for (index, value) in values.enumerated() {
        var type = "text"
        var text: String?
        var number: Double?
        var boolean: Bool?
        var date: Double?
        var entity: String?
        switch value {
        case .text(let value): text = value
        case .number(let value): type = "number"; number = value
        case .boolean(let value): type = "boolean"; boolean = value
        case .date(let value): type = "date"; date = value.timeIntervalSince1970
        case .dateTime(let value): type = "dateTime"; date = value.timeIntervalSince1970
        case .select(let value): type = "select"; text = value
        case .url(let value): type = "url"; text = value
        case .email(let value): type = "email"; text = value
        case .phone(let value): type = "phone"; text = value
        case .page(let value): type = "entityReference"; entity = value.rawValue
        }
        try db.execute(
          sql: """
            INSERT INTO page_property_values
              (page_id,supertag_id,field_id,value_index,type,text_value,number_value,boolean_value,date_value,entity_page_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
          arguments: [
            pageID.rawValue, key.supertagID.rawValue, key.fieldID.rawValue, index,
            type, text, number, boolean, date, entity,
          ]
        )
      }
    }
  }

  private static func liveCalendarItems(
    _ db: Database,
    limit: Int,
    startingAt: Date? = nil
  ) throws -> [LiveQueryItem] {
    let rows: [Row]
    if let startingAt {
      rows = try Row.fetchAll(
        db,
        sql: "SELECT event_json FROM calendar_events WHERE active = 1 AND end_at >= ? ORDER BY start_at LIMIT ?",
        arguments: [startingAt.timeIntervalSince1970, limit]
      )
    } else {
      rows = try Row.fetchAll(
        db,
        sql: "SELECT event_json FROM calendar_events WHERE active = 1 ORDER BY start_at LIMIT ?",
        arguments: [limit]
      )
    }
    return rows.compactMap { row in
      guard let data: Data = row["event_json"],
        let event = try? JSONDecoder.enchiridion.decode(CalendarEventSnapshot.self, from: data)
      else { return nil }
      return .event(event)
    }
  }

  private static func decodeSavedViewCloudRecord(_ row: Row) -> SavedViewCloudRecord? {
    guard let id: String = row["id"],
      let definitionData: Data = row["definition_json"],
      let definition = try? JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: definitionData)
    else { return nil }
    let modified: Double = row["modified_at"] ?? 0
    return SavedViewCloudRecord(
      id: .init(rawValue: id),
      definition: definition,
      whiteboardDocument: (try? decodeWhiteboardDocument(row["whiteboard_json"])) ?? .empty,
      isDeleted: row["deleted"] ?? false,
      sortOrder: row["sort_order"] ?? 999,
      modifiedAt: Date(timeIntervalSince1970: modified),
      dirtyGeneration: row["dirty_generation"] ?? 0,
      cloudRecord: row["cloud_record"]
    )
  }

  private static func decodeSupertagCloudRecord(_ row: Row) -> SupertagCloudRecord? {
    guard let id: String = row["id"],
      let definitionData: Data = row["definition_json"],
      let definition = try? JSONDecoder.enchiridion.decode(
        SupertagDefinition.self,
        from: definitionData
      )
    else { return nil }
    let modified: Double = row["modified_at"] ?? 0
    return SupertagCloudRecord(
      id: .init(rawValue: id),
      definition: definition,
      isDeleted: row["deleted"] ?? false,
      sortOrder: row["sort_order"] ?? 999,
      modifiedAt: Date(timeIntervalSince1970: modified),
      dirtyGeneration: row["dirty_generation"] ?? 0,
      cloudRecord: row["cloud_record"]
    )
  }

  private static func liveDate(for item: LiveQueryItem) -> Date? {
    switch item {
    case .event(let event):
      return event.startDate
    case .page(let page):
      return page.objectMetadata.properties.values.flatMap { $0 }.compactMap { value in
        switch value {
        case .date(let date), .dateTime(let date): date
        default: nil
        }
      }.min()
    }
  }

  private static func matches(
    _ filter: LiveQueryFilter,
    item: LiveQueryItem,
    definition: LiveQueryDefinition
  ) -> Bool {
    let values = queryValues(
      item: item,
      fieldID: filter.fieldID,
      systemField: filter.systemField,
      definition: definition
    )
    switch filter.operation {
    case .isEmpty:
      return values.isEmpty
    case .isNotEmpty:
      return !values.isEmpty
    case .equals:
      guard let expected = filter.value else { return false }
      return values.contains { queryEquals($0, expected) }
    case .notEquals:
      guard let expected = filter.value else { return false }
      return !values.contains { queryEquals($0, expected) }
    case .contains:
      guard let needle = filter.value.map(queryString), !needle.isEmpty else { return false }
      return values.contains { queryString($0).localizedCaseInsensitiveContains(needle) }
    case .before:
      guard let expected = filter.value.flatMap(queryDate) else { return false }
      return values.compactMap(queryDate).contains { $0 < expected }
    case .after:
      guard let expected = filter.value.flatMap(queryDate) else { return false }
      return values.compactMap(queryDate).contains { $0 > expected }
    }
  }

  private static func isOrderedBefore(
    _ lhs: LiveQueryItem,
    _ rhs: LiveQueryItem,
    definition: LiveQueryDefinition
  ) -> Bool {
    let sorts = definition.sorts.isEmpty
      ? [LiveQuerySort(systemField: definition.source == .workCalendar ? "start" : "title")]
      : definition.sorts
    for sort in sorts {
      let left = queryValues(
        item: lhs, fieldID: sort.fieldID, systemField: sort.systemField, definition: definition
      ).first
      let right = queryValues(
        item: rhs, fieldID: sort.fieldID, systemField: sort.systemField, definition: definition
      ).first
      let comparison = compare(left, right)
      if comparison != .orderedSame {
        return sort.ascending ? comparison == .orderedAscending : comparison == .orderedDescending
      }
    }
    return lhs.id < rhs.id
  }

  private static func queryValues(
    item: LiveQueryItem,
    fieldID: SupertagFieldID?,
    systemField: String?,
    definition: LiveQueryDefinition
  ) -> [SupertagValue] {
    if let systemField {
      switch (systemField.lowercased(), item) {
      case ("title", _): return [.text(item.title)]
      case ("created", .page(let page)): return [.dateTime(page.createdAt)]
      case ("modified", .page(let page)): return [.dateTime(page.modifiedAt)]
      case ("kind", .page(let page)): return [.text(pageKindName(page.kind))]
      case ("kind", .event): return [.text("calendar event")]
      case ("start", .event(let event)): return [.dateTime(event.startDate)]
      case ("end", .event(let event)): return [.dateTime(event.endDate)]
      case ("calendar", .event(let event)): return [.text(event.calendarTitle)]
      case ("source", .event(let event)): return [.text(event.identity.provider)]
      case ("source", .page): return [.text("page")]
      case ("start", .page(let page)):
        return pageDateValues(page, preferred: definition.startFieldID)
      case ("end", .page(let page)):
        return pageDateValues(page, preferred: definition.endFieldID)
      default: return []
      }
    }
    guard let fieldID, case .page(let page) = item else { return [] }
    if case .supertag(let tagID) = definition.source {
      return page.objectMetadata.properties[
        .init(supertagID: tagID, fieldID: fieldID)
      ] ?? []
    }
    return page.objectMetadata.properties
      .filter { $0.key.fieldID == fieldID }
      .flatMap(\.value)
  }

  private static func pageDateValues(
    _ page: PageSnapshot,
    preferred fieldID: SupertagFieldID?
  ) -> [SupertagValue] {
    if let fieldID {
      return page.objectMetadata.properties
        .filter { $0.key.fieldID == fieldID }
        .flatMap(\.value)
    }
    return page.objectMetadata.properties.values.flatMap { $0 }.filter { queryDate($0) != nil }
  }

  private static func pageKindName(_ kind: PageKind) -> String {
    switch kind {
    case .daily: "daily"
    case .free: "page"
    case .calendarEvent: "calendar event note"
    case .calendarSeries: "calendar series note"
    case .calendarMaterializedEvent: "calendar event"
    }
  }

  private static func queryEquals(_ lhs: SupertagValue, _ rhs: SupertagValue) -> Bool {
    if let left = queryDate(lhs), let right = queryDate(rhs) { return left == right }
    switch (lhs, rhs) {
    case (.number(let left), .number(let right)): return left == right
    case (.boolean(let left), .boolean(let right)): return left == right
    case (.page(let left), .page(let right)): return left == right
    default: return queryString(lhs).localizedCaseInsensitiveCompare(queryString(rhs)) == .orderedSame
    }
  }

  private static func queryString(_ value: SupertagValue) -> String {
    switch value {
    case .text(let value), .select(let value), .url(let value), .email(let value), .phone(let value): value
    case .number(let value): String(value)
    case .boolean(let value): value ? "true" : "false"
    case .date(let value), .dateTime(let value): String(value.timeIntervalSince1970)
    case .page(let value): value.rawValue
    }
  }

  private static func queryDate(_ value: SupertagValue) -> Date? {
    switch value {
    case .date(let value), .dateTime(let value): value
    default: nil
    }
  }

  private static func compare(_ lhs: SupertagValue?, _ rhs: SupertagValue?) -> ComparisonResult {
    switch (lhs, rhs) {
    case (nil, nil): return .orderedSame
    case (nil, _): return .orderedDescending
    case (_, nil): return .orderedAscending
    case (.some(let lhs), .some(let rhs)):
      if let left = queryDate(lhs), let right = queryDate(rhs) {
        if left == right { return .orderedSame }
        return left < right ? .orderedAscending : .orderedDescending
      }
      if case .number(let left) = lhs, case .number(let right) = rhs {
        if left == right { return .orderedSame }
        return left < right ? .orderedAscending : .orderedDescending
      }
      if case .boolean(let left) = lhs, case .boolean(let right) = rhs {
        if left == right { return .orderedSame }
        return left == false ? .orderedAscending : .orderedDescending
      }
      return queryString(lhs).localizedStandardCompare(queryString(rhs))
    }
  }

  private static func documentHeads(_ data: Data) throws -> AutomergeHeads {
    let document = try Document(data)
    return AutomergeHeads(document.heads().map(\.debugDescription))
  }

  private static func escapeLike(_ value: String) -> String {
    value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "%", with: "\\%")
      .replacingOccurrences(of: "_", with: "\\_")
  }

  private static func dailyTitle(_ day: DayKey) -> String {
    let parts = day.rawValue.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3,
      let date = Calendar(identifier: .gregorian).date(
        from: DateComponents(year: parts[0], month: parts[1], day: parts[2])
      )
    else { return day.rawValue }
    return date.formatted(date: .complete, time: .omitted)
  }
}
