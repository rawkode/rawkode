// LocalGraphSchemaTests.swift
// EnchiridionStoreTests
//
// Schema creation: `LocalGraphSchema.migrator` must apply cleanly to a
// fresh database, every public view name in the documented contract
// (`apps/enchiridion/Documentation/GraphDataModel.md`) must exist and be
// queryable (empty result is fine — existence + zero rows, not an error,
// is the assertion), and re-opening an already-migrated database must be a
// no-op (GRDB's migrator idempotency), matching
// `LocalGraphStore.init(path:)`'s real startup path.

import GRDB
import XCTest

@testable import EnchiridionStore

final class LocalGraphSchemaTests: XCTestCase {
  func testMigratorAppliesCleanlyToAFreshDatabase() throws {
    let database = try DatabaseQueue()
    XCTAssertNoThrow(try LocalGraphSchema.migrator.migrate(database))
  }

  func testEveryDocumentedPublicViewExistsAndIsQueryable() throws {
    let database = try DatabaseQueue()
    try LocalGraphSchema.migrator.migrate(database)

    for viewName in LocalGraphSchema.projectionViewNames {
      try database.read { db in
        // `LIMIT 0` — existence/shape check, not a data assertion.
        XCTAssertNoThrow(
          try Row.fetchAll(db, sql: "SELECT * FROM \(viewName) LIMIT 0"),
          "expected \(viewName) to exist and be queryable"
        )
      }
    }
  }

  func testPhysicalTablesAreNotInThePublicViewAllowlist() throws {
    // The physical/private tables backing the views must never collide
    // with a public view name — otherwise the authorizer's allowlist
    // check (which only compares bare names) would accidentally permit
    // direct physical-table access. This is a schema-shape guard, not the
    // authorizer test itself (see GraphSQLExecutorTests.swift for that).
    let physicalTableNames: Set<String> = [
      "_local_nodes", "_local_tags", "_local_tag_parents", "_local_tag_closure",
      "_local_node_tags", "_local_facts", "_local_relation_definitions",
      "_local_edges", "_local_issues",
      // Task #78 — a page's raw CRDT snapshot bytes must never be a
      // bounded-SQL-reachable name either; see this table's migration
      // comment (LocalGraphSchema.swift, "v3-page-document-snapshots").
      "_local_page_snapshots",
    ]
    XCTAssertTrue(physicalTableNames.isDisjoint(with: LocalGraphSchema.projectionViewNames))
  }

  /// Task #78: the snapshot table's own DDL must exist after migration —
  /// a direct assertion distinct from `testEveryDocumentedPublicViewExistsAndIsQueryable`
  /// above, since this table is deliberately NOT a public view.
  func testPageSnapshotsTableExistsAfterMigration() throws {
    let database = try DatabaseQueue()
    try LocalGraphSchema.migrator.migrate(database)

    try database.read { db in
      XCTAssertNoThrow(
        try Row.fetchAll(db, sql: "SELECT page_id, snapshot, version, updated_at FROM _local_page_snapshots LIMIT 0"))
    }
  }

  func testMigratingTwiceIsANoOp() throws {
    let database = try DatabaseQueue()
    try LocalGraphSchema.migrator.migrate(database)
    XCTAssertNoThrow(try LocalGraphSchema.migrator.migrate(database))
  }

  func testFTSShadowTableNamesAreNotInThePublicViewAllowlist() throws {
    XCTAssertTrue(
      LocalGraphSchema.ftsShadowTableNames.isDisjoint(with: LocalGraphSchema.projectionViewNames))
  }
}
