// OldVaultSQLiteSource.swift
// EnchiridionImporter
//
// Reads two tables directly out of the old app's GRDB/SQLite database file:
//   - `pages.document` — the raw Automerge bytes `OldPageDocumentDecoder`
//     decodes. This is NOT a derived SQL projection (the plan's explicit
//     concern: "Importer reads the old app's Automerge docs, not its SQL
//     projections") — `document` is the CRDT source of truth itself,
//     stored as an opaque BLOB column; every other `pages` column
//     (`title`, `plain_text`, ...) IS a derived projection and is
//     deliberately never read here.
//   - `supertag_schemas.definition_json` — the pre-migration step's input
//     (plan: "enumerate the old vault's runtime user-created supertags").
//     Unlike page content, supertag DEFINITIONS have no CRDT document at
//     all in the old app — `ModuleFoundation.swift`'s `reconcileModule`
//     writes them straight into this SQLite table as local, non-CloudKit-synced
//     metadata (see that file's header: "local metadata and must never
//     enter CloudKit's user-editable schema stream"), so this table IS
//     their authoritative source, not a projection of something else.
//
// Uses the system `SQLite3` C API directly (no GRDB dependency) — this
// target's dependency footprint is deliberately EnchiridionCore +
// EnchiridionSync + automerge-swift only (see Package.swift's comment on
// the automerge-swift pin), and reading two simple tables read-only doesn't
// need an ORM.
import Foundation
import SQLite3

public enum OldVaultSQLiteError: Error, Sendable {
  case cannotOpen(path: String, message: String)
  case queryFailed(String)
}

public struct OldVaultSupertagRow: Sendable {
  public var id: String
  public var name: String
  public var definitionJSON: Data
  public var deleted: Bool
}

/// Read-only access to one old-app vault SQLite file. Opened
/// `SQLITE_OPEN_READONLY` — this importer never writes to the old app's
/// database.
public struct OldVaultSQLiteSource {
  private let path: String

  public init(path: String) {
    self.path = path
  }

  /// Every non-deleted page's `(id, document)` pair. Soft-deleted pages
  /// (`deleted_at IS NOT NULL`) are still included — the old app models
  /// trash as a page flag, not a row deletion, and `PageReencoder` carries
  /// `deletedAt` through so the migrated page lands in the new vault's
  /// trash too, rather than silently resurrecting it.
  public func readPageDocuments() throws -> [(id: String, document: Data)] {
    let db = try open()
    defer { sqlite3_close(db) }

    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, "SELECT id, document FROM pages", -1, &statement, nil) == SQLITE_OK,
      let statement
    else {
      throw OldVaultSQLiteError.queryFailed("prepare: SELECT id, document FROM pages")
    }
    defer { sqlite3_finalize(statement) }

    var rows: [(id: String, document: Data)] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      guard let idText = sqlite3_column_text(statement, 0) else { continue }
      let id = String(cString: idText)
      guard let blob = sqlite3_column_blob(statement, 1) else { continue }
      let byteCount = Int(sqlite3_column_bytes(statement, 1))
      rows.append((id: id, document: Data(bytes: blob, count: byteCount)))
    }
    return rows
  }

  /// Every row in `supertag_schemas` — both built-ins/compiled-module
  /// definitions AND runtime user-created ones. Callers filter with
  /// `OldSupertagOwnershipResolver.isRuntimeUserCreated(_:)` on the decoded
  /// `OldSupertagDefinition` (see that type) rather than here, since
  /// ownership depends on the definition's own `isBuiltIn` flag and id
  /// shape, not anything visible at the SQL row level beyond
  /// `definition_json` itself.
  public func readSupertagSchemas() throws -> [OldVaultSupertagRow] {
    let db = try open()
    defer { sqlite3_close(db) }

    var statement: OpaquePointer?
    guard
      sqlite3_prepare_v2(
        db, "SELECT id, name, definition_json, deleted FROM supertag_schemas", -1, &statement, nil
      ) == SQLITE_OK,
      let statement
    else {
      throw OldVaultSQLiteError.queryFailed("prepare: SELECT ... FROM supertag_schemas")
    }
    defer { sqlite3_finalize(statement) }

    var rows: [OldVaultSupertagRow] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      guard let idText = sqlite3_column_text(statement, 0),
        let nameText = sqlite3_column_text(statement, 1),
        let jsonBlob = sqlite3_column_blob(statement, 2)
      else { continue }
      let jsonByteCount = Int(sqlite3_column_bytes(statement, 2))
      let deleted = sqlite3_column_int(statement, 3) != 0
      rows.append(
        OldVaultSupertagRow(
          id: String(cString: idText),
          name: String(cString: nameText),
          definitionJSON: Data(bytes: jsonBlob, count: jsonByteCount),
          deleted: deleted
        )
      )
    }
    return rows
  }

  private func open() throws -> OpaquePointer {
    var db: OpaquePointer?
    let result = sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil)
    guard result == SQLITE_OK, let db else {
      let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
      if let db { sqlite3_close(db) }
      throw OldVaultSQLiteError.cannotOpen(path: path, message: message)
    }
    return db
  }
}
