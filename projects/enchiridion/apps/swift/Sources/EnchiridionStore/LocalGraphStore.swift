// LocalGraphStore.swift
// EnchiridionStore
//
// The on-device projection authority: a GRDB `DatabasePool`-backed SQLite
// database holding `LocalGraphSchema`'s tables/views, plus the write path
// that turns one page's `PageDocumentProjection` (EnchiridionSync) into
// rows there. Apps read/query this for everything in the graph (plan
// §Native apps: "Apps read/query local GRDB projections for everything in
// the graph"); `GraphSQLExecutor` (this target) is the bounded read surface
// layered on top for free-form queries, while this type's own methods are
// the direct, typed write/read surface used by the projection pipeline
// itself and by simple lookups that don't need the bounded-query ceremony.
//
// Task #78 addition: also the durable authority for a page's raw CRDT
// document snapshot (`saveDocumentSnapshot`/`documentSnapshot(for:)`,
// `_local_page_snapshots` — see `LocalGraphSchema.swift`'s
// "v3-page-document-snapshots" migration). Before this task, nothing in
// this package persisted that snapshot anywhere durable — only the
// *derived* projection below ever reached disk; see this file's own former
// "Design note" section (still present further down, now updated) for the
// gap this closes.

import CryptoKit
import EnchiridionCore
import EnchiridionSync
import Foundation
import GRDB

public enum LocalGraphStoreError: Error, LocalizedError, Equatable {
  case invalidPath

  public var errorDescription: String? {
    switch self {
    case .invalidPath: "The local graph database path is invalid."
    }
  }
}

/// One row of the `graph_nodes` view, decoded for direct (non-bounded-query)
/// reads — used by `LocalGraphStore`'s own convenience accessors and by
/// tests asserting `writeProjection`'s row shape. Column shape matches
/// `LocalGraphSchema`'s `graph_nodes` view exactly (see that file).
public struct LocalGraphNodeRow: Codable, Hashable, Sendable, FetchableRecord {
  public var nodeID: PageID
  public var title: String
  public var plainText: String
  public var kind: String
  public var createdAt: Date
  public var modifiedAt: Date
  public var deletedAt: Date?
  public var isPinned: Bool
  // task #66 addition — see `LocalGraphSchema`'s "v2-assistant-person-visibility"
  // migration header for why these two columns exist.
  public var personVisibility: PersonVisibility?
  public var personOrigin: PersonOrigin?

  public init(row: Row) {
    nodeID = PageID(rawValue: row["node_id"])
    title = row["title"]
    plainText = row["plain_text"]
    kind = row["kind"]
    createdAt = Date(millisecondsSince1970: row["created_at"])
    modifiedAt = Date(millisecondsSince1970: row["modified_at"])
    deletedAt = (row["deleted_at"] as Int64?).map(Date.init(millisecondsSince1970:))
    isPinned = row["is_pinned"]
    personVisibility = (row["person_visibility"] as String?).flatMap(PersonVisibility.init(rawValue:))
    personOrigin = (row["person_origin"] as String?).flatMap(PersonOrigin.init(rawValue:))
  }
}

/// One row of the `graph_facts` view. See `LocalGraphNodeRow`'s doc comment.
public struct LocalGraphFactRow: Codable, Hashable, Sendable, FetchableRecord {
  public var factID: String
  public var nodeID: PageID
  public var predicateID: String
  public var tagID: SupertagID
  public var fieldID: SupertagFieldID
  public var valueIndex: Int
  public var valueType: String
  public var textValue: String?
  public var numberValue: Double?
  public var booleanValue: Bool?
  public var localDateValue: String?
  public var dateTimeValue: Date?

  public init(row: Row) {
    factID = row["fact_id"]
    nodeID = PageID(rawValue: row["node_id"])
    predicateID = row["predicate_id"]
    tagID = SupertagID(rawValue: row["tag_id"])
    fieldID = SupertagFieldID(rawValue: row["field_id"])
    valueIndex = row["value_index"]
    valueType = row["value_type"]
    textValue = row["text_value"]
    numberValue = row["number_value"]
    booleanValue = (row["boolean_value"] as Int64?).map { $0 != 0 }
    localDateValue = row["local_date_value"]
    dateTimeValue = (row["date_time_value"] as Int64?).map(Date.init(millisecondsSince1970:))
  }
}

/// One row of the `_local_page_snapshots` table (task #78) — the durable
/// CRDT document for one page: the current `LoroDoc.exportSnapshot()`
/// bytes (`snapshot`), its `PageDocument.currentVersion(of:)` token
/// (`version`, so a caller can detect staleness without re-decoding the
/// whole document — see `PageDocument.versionMatches`), and `updatedAt`
/// (this row's last write time, independent of the page's own
/// CRDT-tracked `modifiedAt` metadata). Never exposed through
/// `GraphSQLExecutor`'s bounded query surface — see
/// `LocalGraphSchema.swift`'s "v3-page-document-snapshots" migration
/// comment for why.
public struct PageDocumentSnapshotRecord: Hashable, Sendable, FetchableRecord {
  public var pageID: PageID
  public var snapshot: Data
  public var version: PageDocumentVersion
  public var updatedAt: Date

  public init(row: Row) {
    pageID = PageID(rawValue: row["page_id"])
    snapshot = row["snapshot"]
    version = PageDocumentVersion(encoded: row["version"])
    updatedAt = Date(millisecondsSince1970: row["updated_at"])
  }
}

/// Whether a durable document write originated on this device or was applied
/// by the Vault sync consumer. Outbound sync listens only to `.local`, which
/// prevents a received snapshot being reflected straight back to the server.
public enum LocalDocumentSnapshotOrigin: Hashable, Sendable {
  case local
  case remote
}

/// One successfully committed document snapshot. The stream on
/// `LocalGraphStore` emits only after the SQLite transaction has completed,
/// so a sync consumer never observes bytes that would disappear on relaunch.
public struct LocalDocumentSnapshotChange: Hashable, Sendable {
  public let pageID: PageID
  public let snapshot: Data
  public let version: PageDocumentVersion
  public let origin: LocalDocumentSnapshotOrigin

  public init(
    pageID: PageID,
    snapshot: Data,
    version: PageDocumentVersion,
    origin: LocalDocumentSnapshotOrigin
  ) {
    self.pageID = pageID
    self.snapshot = snapshot
    self.version = version
    self.origin = origin
  }
}

/// One row of the `graph_edges` view (post forward/inverse expansion — see
/// `LocalGraphSchema`). See `LocalGraphNodeRow`'s doc comment.
public struct LocalGraphEdgeRow: Codable, Hashable, Sendable, FetchableRecord {
  public var edgeID: EdgeID
  public var fromNodeID: PageID
  public var toNodeID: PageID
  public var relationID: RelationID
  public var relationshipName: String
  public var direction: String
  public var origin: String

  public init(row: Row) {
    edgeID = EdgeID(rawValue: row["edge_id"])
    fromNodeID = PageID(rawValue: row["from_node_id"])
    toNodeID = PageID(rawValue: row["to_node_id"])
    relationID = RelationID(rawValue: row["relation_id"])
    relationshipName = row["relationship_name"]
    direction = row["direction"]
    origin = row["origin"]
  }
}

/// Wraps a GRDB `DatabasePool` over `LocalGraphSchema`'s tables and offers
/// the write path from a page's CRDT projection, plus small typed read
/// helpers. An `actor` (not merely `Sendable`) because `writeProjection`
/// runs multi-statement transactions that must not interleave with each
/// other page-by-page, even though GRDB's own connection pool is
/// thread-safe on its own terms — actor isolation keeps the *sequence* of
/// writes for a given store predictable for callers (e.g. a future
/// reprojection-from-sync pipeline processing several updated pages).
public actor LocalGraphStore {
  /// Path to the underlying SQLite file — `nonisolated` and stored
  /// separately from `database` (not derived by asking GRDB for it) so
  /// `GraphSQLExecutor`'s dedicated read-only connection (see that file's
  /// header for why it must be separate from `database`) can be opened
  /// without hopping onto the actor.
  public nonisolated let path: String
  private let database: DatabasePool

  /// Durable snapshot-write subscribers, notified only after commit. Each
  /// caller receives its own stream: the sync coordinator and an open editor
  /// must both see a remote update, rather than competing to consume it.
  private var documentSnapshotChangeContinuations: [UUID: AsyncStream<LocalDocumentSnapshotChange>.Continuation] = [:]

  public init(path: String) throws {
    guard !path.isEmpty else { throw LocalGraphStoreError.invalidPath }
    self.path = path
    var configuration = Configuration()
    configuration.journalMode = .wal
    configuration.prepareDatabase { db in
      try db.execute(sql: "PRAGMA foreign_keys = ON")
    }
    let database = try DatabasePool(path: path, configuration: configuration)
    try LocalGraphSchema.migrator.migrate(database)
    self.database = database
  }

  /// Returns an independent subscription to committed document snapshots.
  /// Multiple consumers are deliberately broadcast subscribers, not multiple
  /// iterators over one shared stream: sync and UI update observation may run
  /// at the same time in an app process.
  public func documentSnapshotChanges() -> AsyncStream<LocalDocumentSnapshotChange> {
    let subscriptionID = UUID()
    let (stream, continuation) = AsyncStream<LocalDocumentSnapshotChange>.makeStream()
    documentSnapshotChangeContinuations[subscriptionID] = continuation
    continuation.onTermination = { [weak self] _ in
      Task {
        await self?.removeDocumentSnapshotChangeSubscriber(subscriptionID)
      }
    }
    return stream
  }

  private func removeDocumentSnapshotChangeSubscriber(_ subscriptionID: UUID) {
    documentSnapshotChangeContinuations.removeValue(forKey: subscriptionID)
  }

  private func publishDocumentSnapshotChange(_ change: LocalDocumentSnapshotChange) {
    for continuation in documentSnapshotChangeContinuations.values {
      continuation.yield(change)
    }
  }

  /// Opens a fresh store at a unique temporary file — for tests and
  /// previews. Not `:memory:`: `GraphSQLExecutor` opens its own connection
  /// by file path (see that file's header), which an in-memory database
  /// cannot support (each `sqlite3_open_v2(":memory:")` call gets its own
  /// private database, not a second handle onto the same one).
  public static func openTemporary() throws -> LocalGraphStore {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-local-graph-store-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let path = directory.appendingPathComponent("graph.sqlite").path
    return try LocalGraphStore(path: path)
  }

  // MARK: - Write path

  /// Writes one page's projection into the local tables, replacing
  /// whatever was previously stored for `pageID` — full-replace-on-write,
  /// same strategy as the old app's `GraphProjectionStore.replacePage`
  /// (apps/enchiridion/Sources/EnchiridionCore/GraphDatabase.swift:424) and
  /// `workers/vault/src/projection.ts`'s upsert-per-update model, so a
  /// removed field or edge actually disappears from the projection rather
  /// than leaking a stale row.
  ///
  /// `kind`/`createdAt`/`modifiedAt` are supplied by the caller rather than
  /// read off `projection` because `PageDocumentProjection`
  /// (EnchiridionSync/PageDocument.swift) does not carry them today — see
  /// that type's doc comment; it exposes only what
  /// `PageDocument.projection(of:)` currently extracts from the CRDT
  /// document. A future task extending `PageDocumentProjection` to include
  /// `kind`/`createdAt` would let a caller stop threading them through
  /// separately; not done here since `EnchiridionSync` is out of this
  /// task's scope (see constraints).
  ///
  /// Populates: `_local_nodes` (title/plainText/kind/pinned/deleted/
  /// timestamps), `_local_facts` (every scalar `SupertagValue` in
  /// `projection.objectMetadata.properties` — `.page` values are skipped
  /// here because they are already represented as edges, both directly via
  /// `projection.graphEdges` and, redundantly, as `.page` entries in
  /// `properties` itself — see `PageDocument`'s
  /// `objectMetadataProjection`, which folds edges back into `properties`
  /// for the property/edge duality; recording them as facts too would
  /// double the data with no new information), `_local_edges`
  /// (`projection.graphEdges`, plus `projection.references` mapped to a
  /// synthetic "mentions" relation — see `Self.mentionsRelationID`'s doc
  /// comment), `_local_node_tags` (direct membership only — see
  /// `LocalGraphSchema`'s header for why closure isn't computed here), and
  /// `graph_text_search` (FTS5).
  public func writeProjection(
    pageID: PageID,
    kind: PageKind,
    createdAt: Date,
    modifiedAt: Date,
    projection: PageDocumentProjection
  ) throws {
    try database.write { db in
      try db.execute(
        sql: """
          INSERT INTO _local_nodes
            (node_id, title, plain_text, kind, created_at, modified_at, deleted_at, is_pinned,
             person_visibility, person_origin)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(node_id) DO UPDATE SET
            title = excluded.title,
            plain_text = excluded.plain_text,
            kind = excluded.kind,
            created_at = excluded.created_at,
            modified_at = excluded.modified_at,
            deleted_at = excluded.deleted_at,
            is_pinned = excluded.is_pinned,
            person_visibility = excluded.person_visibility,
            person_origin = excluded.person_origin
          """,
        arguments: [
          pageID.rawValue,
          projection.title,
          projection.plainText,
          Self.storageKind(for: kind),
          createdAt.millisecondsSince1970,
          modifiedAt.millisecondsSince1970,
          projection.deletedAt?.millisecondsSince1970,
          projection.isPinned,
          projection.objectMetadata.personVisibility?.rawValue,
          projection.objectMetadata.personOrigin?.rawValue,
        ]
      )

      try db.execute(sql: "DELETE FROM _local_facts WHERE node_id = ?", arguments: [pageID.rawValue])
      for (key, values) in projection.objectMetadata.properties {
        for (index, value) in values.enumerated() where !value.isPageReference {
          try Self.insertFact(
            pageID: pageID, key: key, value: value, index: index, createdAt: createdAt, in: db)
        }
      }

      try db.execute(sql: "DELETE FROM _local_edges WHERE source_node_id = ?", arguments: [pageID.rawValue])
      for edge in projection.graphEdges {
        try Self.insertEdge(edge, in: db)
      }
      for (index, reference) in projection.references.enumerated() {
        try Self.insertEdge(
          KnowledgeEdge(
            id: Self.deterministicMentionEdgeID(source: pageID, target: reference.targetPageID, ordinal: index),
            relationID: Self.mentionsRelationID,
            sourceNodeID: pageID,
            targetNodeID: reference.targetPageID,
            origin: .inlineReference,
            createdAt: modifiedAt
          ),
          in: db
        )
      }

      try db.execute(sql: "DELETE FROM _local_node_tags WHERE node_id = ?", arguments: [pageID.rawValue])
      for tagID in projection.objectMetadata.supertagIDs {
        try db.execute(
          sql: """
            INSERT INTO _local_node_tags (node_id, tag_id, depth, direct)
            VALUES (?, ?, 0, 1)
            """,
          arguments: [pageID.rawValue, tagID.rawValue]
        )
      }

      try db.execute(sql: "DELETE FROM graph_text_search WHERE node_id = ?", arguments: [pageID.rawValue])
      if projection.deletedAt == nil {
        try db.execute(
          sql: "INSERT INTO graph_text_search (node_id, title, body) VALUES (?, ?, ?)",
          arguments: [pageID.rawValue, projection.title, projection.plainText]
        )
      }
    }
  }

  /// Removes every row associated with `pageID` — the local-store
  /// counterpart of the sync protocol's catalog tombstone purge (plan:
  /// "tombstone sync purges that page's projection rows on both sides").
  /// Not `writeProjection` with an empty projection, because that would
  /// leave a `_local_nodes` row behind (a tombstoned page should have none
  /// locally, matching "purges that page's projection rows", not "marks
  /// them deleted" — `deleted_at` on `_local_nodes` represents the page's
  /// own soft-delete state, which is a different, CRDT-visible concept from
  /// catalog tombstoning). Also removes the page's persisted CRDT snapshot
  /// (`_local_page_snapshots`, task #78) for the identical reason: a
  /// catalog-tombstoned page should have nothing left locally, not just no
  /// projection rows.
  public func removeProjection(pageID: PageID) throws {
    try database.write { db in
      for table in ["_local_nodes", "_local_facts", "_local_edges", "_local_node_tags"] {
        let column = table == "_local_edges" ? "source_node_id" : "node_id"
        try db.execute(sql: "DELETE FROM \(table) WHERE \(column) = ?", arguments: [pageID.rawValue])
      }
      try db.execute(sql: "DELETE FROM graph_text_search WHERE node_id = ?", arguments: [pageID.rawValue])
      try db.execute(sql: "DELETE FROM _local_page_snapshots WHERE page_id = ?", arguments: [pageID.rawValue])
    }
  }

  // MARK: - Document snapshot persistence (task #78)

  /// Persists (creating or replacing — full upsert, same
  /// `ON CONFLICT ... DO UPDATE` shape `writeProjection` already uses)
  /// `pageID`'s CURRENT CRDT document snapshot. Every local write path that
  /// produces a new `PageDocument.MutationResult`/`.create(...)` result
  /// must call this alongside (not instead of) `writeProjection` — a
  /// projection with no backing snapshot cannot survive a relaunch or
  /// participate in a real CRDT merge; see `LocalGraphSchema.swift`'s
  /// "v3-page-document-snapshots" migration comment for the full context
  /// this closes.
  public func saveDocumentSnapshot(
    pageID: PageID,
    snapshot: Data,
    version: PageDocumentVersion,
    updatedAt: Date = Date(),
    origin: LocalDocumentSnapshotOrigin = .local
  ) throws {
    try database.write { db in
      try db.execute(
        sql: """
          INSERT INTO _local_page_snapshots (page_id, snapshot, version, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(page_id) DO UPDATE SET
            snapshot = excluded.snapshot,
            version = excluded.version,
            updated_at = excluded.updated_at
          """,
        arguments: [pageID.rawValue, snapshot, version.encoded, updatedAt.millisecondsSince1970]
      )
    }
    publishDocumentSnapshotChange(
      LocalDocumentSnapshotChange(pageID: pageID, snapshot: snapshot, version: version, origin: origin))
  }

  /// Loads `pageID`'s persisted CRDT document snapshot, or `nil` if none
  /// has ever been saved (a genuinely new, never-flushed page). Callers
  /// opening a page for editing (`PageEditorController.open`) must consult
  /// this FIRST and only fall back to `PageDocument.create` when it returns
  /// `nil` — loading straight into `PageDocument.create` unconditionally is
  /// exactly the bug this store's snapshot table exists to prevent (it
  /// silently discards every prior edit's CRDT history on each relaunch).
  public func documentSnapshot(for pageID: PageID) throws -> PageDocumentSnapshotRecord? {
    try database.read { db in
      try PageDocumentSnapshotRecord.fetchOne(
        db, sql: "SELECT * FROM _local_page_snapshots WHERE page_id = ?", arguments: [pageID.rawValue])
    }
  }

  /// Every durable page document in deterministic order. The local Vault sync
  /// coordinator uses this after a successful catalog handshake so writes
  /// made while the app was offline are eventually uploaded as well.
  public func documentSnapshots() throws -> [PageDocumentSnapshotRecord] {
    try database.read { db in
      try PageDocumentSnapshotRecord.fetchAll(db, sql: "SELECT * FROM _local_page_snapshots ORDER BY page_id")
    }
  }

  /// Compare-and-swap persist of `pageID`'s CRDT document snapshot (task
  /// #90). Unlike the plain `saveDocumentSnapshot` above — an unconditional
  /// upsert — this only writes if the row's CURRENT `version` still equals
  /// `expectedVersion` (the version the caller's mutation was computed
  /// against). Returns `false` without writing anything if the version has
  /// already moved (a genuine conflict the caller must surface, never
  /// silently overwrite); returns `true` once the write has landed.
  ///
  /// WHY THIS EXISTS, AND WHY A CALLER-SIDE VERSION CHECK ISN'T ENOUGH:
  /// `documentSnapshot(for:)` and `saveDocumentSnapshot` are two separate
  /// actor entry points. The CALLER (not this actor) suspends between them
  /// while it computes the new snapshot (`PageDocument.setProperties`
  /// etc.) — that suspension is a real `async` gap another call for the
  /// same `pageID` can land in. Two concurrent callers that both read the
  /// same base snapshot, each compute a full new snapshot from that same
  /// base, then each call plain `saveDocumentSnapshot`: whichever lands
  /// second completely overwrites the store with its own snapshot,
  /// silently discarding the first caller's change — not merely
  /// conflicting on one field. A version check performed by the caller
  /// BEFORE re-entering this actor (mirroring
  /// `AssistantTaskMutationApplier.requireCurrentVersion`'s in-memory
  /// check) does not close this gap either: the TOCTOU window is between
  /// that check and the eventual write, and that window still spans an
  /// actor suspension. Only a check-and-write performed atomically INSIDE
  /// one `database.write` transaction — this method — actually closes it:
  /// GRDB's `DatabasePool` serializes writer transactions against each
  /// other, so no other write for this (or any) page can land between this
  /// method's read of the current version and its conditional `UPDATE`.
  ///
  /// Deliberately a distinct method (not an overload of
  /// `saveDocumentSnapshot`) so every call site states in its own name
  /// whether it wants unconditional-upsert or compare-and-swap semantics.
  public func saveDocumentSnapshotIfCurrentVersion(
    pageID: PageID,
    expectedVersion: PageDocumentVersion,
    snapshot: Data,
    version: PageDocumentVersion,
    updatedAt: Date = Date(),
    origin: LocalDocumentSnapshotOrigin = .local
  ) throws -> Bool {
    let saved = try database.write { db in
      let currentVersion: Data? = try Data.fetchOne(
        db, sql: "SELECT version FROM _local_page_snapshots WHERE page_id = ?", arguments: [pageID.rawValue])
      guard currentVersion == expectedVersion.encoded else { return false }
      try db.execute(
        sql: """
          UPDATE _local_page_snapshots
          SET snapshot = ?, version = ?, updated_at = ?
          WHERE page_id = ?
          """,
        arguments: [snapshot, version.encoded, updatedAt.millisecondsSince1970, pageID.rawValue]
      )
      return true
    }
    if saved {
      publishDocumentSnapshotChange(
        LocalDocumentSnapshotChange(pageID: pageID, snapshot: snapshot, version: version, origin: origin))
    }
    return saved
  }

  // MARK: - Typed reads

  public func node(for pageID: PageID) throws -> LocalGraphNodeRow? {
    try database.read { db in
      try LocalGraphNodeRow.fetchOne(
        db, sql: "SELECT * FROM graph_nodes WHERE node_id = ?", arguments: [pageID.rawValue])
    }
  }

  public func facts(for pageID: PageID) throws -> [LocalGraphFactRow] {
    try database.read { db in
      try LocalGraphFactRow.fetchAll(
        db, sql: "SELECT * FROM graph_facts WHERE node_id = ? ORDER BY field_id, value_index",
        arguments: [pageID.rawValue])
    }
  }

  public func edges(from pageID: PageID) throws -> [LocalGraphEdgeRow] {
    try database.read { db in
      try LocalGraphEdgeRow.fetchAll(
        db,
        sql: """
          SELECT * FROM graph_edges
          WHERE from_node_id = ? AND direction = 'forward'
          ORDER BY created_at
          """,
        arguments: [pageID.rawValue])
    }
  }

  // MARK: - Bounded query surface

  /// Thin wrapper over `GraphSQLExecutor.execute(path:...)` — see that
  /// file's header for why the executor opens its own connection rather
  /// than reusing `database`. `nonisolated` because the executor is
  /// stateless per call and opens/closes its own connection; routing it
  /// through the actor would only add unneeded serialization against
  /// unrelated writes (SQLite's WAL mode already gives this reader a
  /// consistent snapshot without blocking on, or blocking, `database`'s
  /// writer).
  public nonisolated func query(
    sql: String,
    arguments: [String: GraphSQLValue] = [:],
    limits: GraphQueryLimits = .init()
  ) throws -> GraphQueryResult {
    try GraphSQLExecutor.execute(path: path, sql: sql, arguments: arguments, limits: limits)
  }

  // MARK: - Internals

  /// The generic fallback "mentions" relation for inline `[[page]]`
  /// references (`PageDocumentProjection.references`), standing in for the
  /// old app's declared `BuiltInRelations.mentions` — which has no
  /// counterpart yet in this codebase's `EnchiridionCore.BuiltInRelations`
  /// (that type currently keeps only the generic entityReference-field
  /// synthetic-key fallback; see its doc comment's TODO). Scoped to this
  /// target rather than added to `EnchiridionCore` because this task's
  /// constraints exclude modifying that module. A future task wiring real
  /// declared relations (`packages/schema`/`EnchiridionSchema`) should
  /// replace this constant with whatever that registry declares for
  /// mentions, at which point existing rows using this ID are the ones a
  /// reconciliation materializer (plan §"Schema migration") would need to
  /// migrate.
  static let mentionsRelationID = RelationID(rawValue: "system-relation:mentions")

  static func deterministicMentionEdgeID(source: PageID, target: PageID, ordinal: Int) -> EdgeID {
    EdgeID(
      rawValue: "edge_\(Self.localDigest("\(source.rawValue)|\(target.rawValue)|\(ordinal)"))"
    )
  }

  /// A local, deterministic storage-key digest — NOT `PageID`'s
  /// cross-language-contract digest (`EnchiridionCore/Identity.swift`'s
  /// `PageID.digest`, which is `internal`/unexported and, per that file's
  /// header, load-bearing for cross-language golden tests). This one only
  /// needs to be stable *within* this store's own SQLite primary keys
  /// (fact IDs, synthetic mention-edge IDs) so repeated `writeProjection`
  /// calls for the same logical value are idempotent upserts rather than
  /// growing duplicates; nothing outside this file reads or compares these
  /// IDs against a TS-side value.
  private static func localDigest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
      .prefix(20)
      .map { String(format: "%02x", $0) }
      .joined()
  }

  static func storageKind(for kind: PageKind) -> String {
    switch kind {
    case .daily: "daily"
    case .free: "free"
    case .calendarEvent: "calendarEvent"
    case .calendarSeries: "calendarSeries"
    case .calendarMaterializedEvent: "calendarMaterializedEvent"
    }
  }

  private static func insertFact(
    pageID: PageID,
    key: SupertagPropertyKey,
    value: SupertagValue,
    index: Int,
    createdAt: Date,
    in db: Database
  ) throws {
    let predicateID = PredicateID.property(tagID: key.supertagID, fieldID: key.fieldID)
    let factID =
      "fact_\(localDigest("\(pageID.rawValue)|\(predicateID.rawValue)|\(index)|\(value.id)"))"

    var valueType = ""
    var text: String?
    var number: Double?
    var boolean: Bool?
    var localDate: String?
    var dateTimeMillis: Int64?
    switch value {
    case .text(let v): valueType = "text"; text = v
    case .number(let v): valueType = "number"; number = v
    case .boolean(let v): valueType = "boolean"; boolean = v
    case .date(let v): valueType = "localDate"; localDate = v.enchiridionISO8601
    case .dateTime(let v): valueType = "dateTime"; dateTimeMillis = v.millisecondsSince1970
    case .select(let v): valueType = "select"; text = v
    case .url(let v): valueType = "url"; text = v
    case .email(let v): valueType = "email"; text = v
    case .phone(let v): valueType = "phone"; text = v
    case .page: preconditionFailure("References are projected as edges, not facts")
    }

    try db.execute(
      sql: """
        INSERT OR REPLACE INTO _local_facts
          (fact_id, node_id, predicate_id, tag_id, field_id, value_index, value_type,
           text_value, number_value, boolean_value, local_date_value, date_time_value,
           origin, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
      arguments: [
        factID, pageID.rawValue, predicateID.rawValue, key.supertagID.rawValue,
        key.fieldID.rawValue, index, valueType, text, number, boolean, localDate,
        dateTimeMillis, GraphEdgeOrigin.user.rawValue, createdAt.millisecondsSince1970,
      ]
    )
  }

  private static func insertEdge(_ edge: KnowledgeEdge, in db: Database) throws {
    try db.execute(
      sql: """
        INSERT OR REPLACE INTO _local_edges
          (edge_id, relation_id, source_node_id, target_node_id, origin, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
      arguments: [
        edge.id.rawValue, edge.relationID.rawValue, edge.sourceNodeID.rawValue,
        edge.targetNodeID.rawValue, edge.origin.rawValue, edge.createdAt.millisecondsSince1970,
      ]
    )
  }
}

// MARK: - Epoch-millisecond timestamps

/// `LocalGraphSchema`'s timestamp columns are epoch-millisecond `INTEGER`,
/// matching `workers/vault/src/schema.ts` (see that file's header) — this
/// is a local convenience, not a cross-language identity contract (unlike
/// `PageID`'s digest derivation, which genuinely is one; see
/// `EnchiridionCore/Identity.swift`'s header).
extension Date {
  init(millisecondsSince1970 milliseconds: Int64) {
    self.init(timeIntervalSince1970: Double(milliseconds) / 1_000)
  }

  var millisecondsSince1970: Int64 {
    Int64((timeIntervalSince1970 * 1_000).rounded())
  }
}

// MARK: - Sync integration
//
// `EnchiridionUI/LocalVaultSyncCoordinator` owns the concrete local Vault
// protocol loop. This actor deliberately remains the durable store boundary:
// it publishes only committed snapshots, persists received snapshots before
// their projections, and makes no transport or catalog decisions itself.
