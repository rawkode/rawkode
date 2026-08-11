// GraphSQLExecutorTests.swift
// EnchiridionStoreTests
//
// The bounded query executor is the one piece of this task that's actually
// stronger than its server-side sibling (`workers/vault/src/sql-validator.ts`
// is lexical-only, by necessity — DO SQLite has no `sqlite3_set_authorizer`,
// see that file's own header). This suite exists to PROVE that claim, not
// just assert it: every "adversarial" test below constructs a query shaped
// to defeat a plausible *text-scanning* validator — obfuscated identifiers,
// nested subqueries, a WITH-prefixed data-modifying statement that a
// leading-token-only check would wave through — and confirms the real
// `sqlite3_set_authorizer` callback (installed in `GraphSQLExecutor.execute`)
// denies it anyway, because it operates on SQLite's resolved query plan,
// never on the query's text.
//
// Honesty note (also called out inline where it matters): a few classic
// "bypass" ideas — ATTACH, PRAGMA, CREATE TRIGGER as a bare statement — turn
// out to be structurally impossible to disguise as a SELECT/WITH statement
// in SQLite's own grammar, so they're caught by the cheap leading-token
// check before the authorizer even runs. Those are included as
// defense-in-depth tests, clearly labeled as such, not oversold as
// authorizer-specific proof. The real proof is
// `testWithPrefixedInsertIsDeniedByTheAuthorizerNotJustTheLeadingTokenCheck`
// and the identifier-obfuscation tests below it.

import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionStore

final class GraphSQLExecutorTests: XCTestCase {
  /// A store with exactly one written page, so positive-path tests have
  /// real data to assert against and negative-path tests have a real
  /// private table (`_local_nodes`) with real rows to attempt to reach.
  private func makeSeededStore() async throws -> LocalGraphStore {
    let store = try LocalGraphStore.openTemporary()
    let pageID = PageID.free(UUID(uuidString: "10000000-0000-0000-0000-000000000001")!)
    try await store.writeProjection(
      pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
      projection: .init(
        title: "Secret plans", plainText: "Secret plans body text", deletedAt: nil,
        isPinned: false, references: [], graphEdges: [], objectMetadata: .init()))
    return store
  }

  // MARK: - Positive path: the intended surface actually works

  func testSelectFromAllowlistedViewSucceeds() async throws {
    let store = try await makeSeededStore()
    let result = try store.query(sql: "SELECT node_id, title FROM graph_nodes")
    XCTAssertEqual(result.rows.count, 1)
    XCTAssertEqual(result.rows.first?.values.last, .text("Secret plans"))
  }

  func testCTEOverAnAllowlistedViewSucceeds() async throws {
    let store = try await makeSeededStore()
    let result = try store.query(
      sql: "WITH recent AS (SELECT * FROM graph_nodes) SELECT title FROM recent")
    XCTAssertEqual(result.rows.count, 1)
  }

  func testAggregateFunctionOverAnAllowlistedViewSucceeds() async throws {
    let store = try await makeSeededStore()
    // `count(node_id)`, not bare `count(*)` — see
    // `testBareCountStarOverAViewIsDeniedDueToASQLiteOptimizerQuirk` below
    // for why bare `count(*)`/`count(1)` is a real, documented exception,
    // discovered by this test suite.
    let result = try store.query(sql: "SELECT count(node_id) FROM graph_nodes")
    XCTAssertEqual(result.rows.first?.values.first, .integer(1))
  }

  // MARK: - A genuine finding, not a workaround: bare COUNT(*) over a view
  //
  // Diagnosed empirically (Python's `sqlite3.Connection.set_authorizer`
  // exposes the identical C callback, used here purely to iterate fast —
  // this is standard SQLite C behavior, not a Python-specific quirk):
  // SQLite has a dedicated "count(*) optimization" that recognizes the
  // exact shape `SELECT count(*)` (and equivalently `count(1)`, or any
  // count of a constant) with no WHERE/GROUP BY/DISTINCT, and — even when
  // the FROM target is a view — answers it via a direct row-count on the
  // underlying table's rootpage rather than evaluating the view's SELECT
  // list. That bypass means the `SQLITE_READ` authorizer callback fires
  // for the PHYSICAL table with an EMPTY column name and NO view-name
  // attribution (`context`/zArg4 is NULL) — an event that is, at the
  // authorizer level, indistinguishable from a direct
  // `SELECT count(*) FROM _local_nodes` naming the physical table outright
  // (confirmed empirically: both produce the exact same
  // `(table, "", view=NULL)` tuple). `GraphSQLExecutor` therefore denies
  // both — correctly, per this codebase's fail-closed stance (mirroring
  // `sql-validator.ts`'s own stated philosophy: "prefer being annoying to
  // a legitimate query over being wrong about a dangerous one") — since
  // there is no reliable way to tell them apart without depending on
  // SQLite internals `sqlite3_test_control(SQLITE_TESTCTRL_OPTIMIZATIONS,
  // ...)` explicitly documents as unstable/testing-only, not something to
  // build a security boundary on.
  //
  // This is a real, previously-undiscovered gap in the PORT SOURCE: the
  // old app's `GraphSQLExecutor.swift` has this exact same code and ZERO
  // test coverage (confirmed: no `GraphSQLExecutorTests.swift` exists
  // anywhere in `apps/enchiridion/Tests`) — this bare-`count(*)`-over-a-
  // view denial has shipped, untested, in the old app the whole time.
  // Writing a genuinely adversarial suite here is what surfaced it.
  //
  // Workaround for callers (not a bug fix, because there is nothing unsafe
  // to fix — see above): use `count(<a real column>)` instead of bare
  // `count(*)`/`count(1)`, or add any `WHERE` clause — both defeat the
  // SQLite optimization and route the read through the view normally, as
  // the tests below demonstrate.
  func testBareCountStarOverAViewIsDeniedDueToASQLiteOptimizerQuirk() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(try store.query(sql: "SELECT count(*) FROM graph_nodes")) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
    XCTAssertThrowsError(try store.query(sql: "SELECT count(1) FROM graph_nodes")) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testCountStarWithAWhereClauseAvoidsTheOptimizerQuirkAndSucceeds() async throws {
    let store = try await makeSeededStore()
    let seededPageID = PageID.free(UUID(uuidString: "10000000-0000-0000-0000-000000000001")!)
    let result = try store.query(
      sql: "SELECT count(*) FROM graph_nodes WHERE node_id = :id",
      arguments: [":id": .text(seededPageID.rawValue)]
    )
    XCTAssertEqual(result.rows.first?.values.first, .integer(1))
  }

  // MARK: - Adversarial: direct physical-table access, every spelling

  func testDirectPhysicalTableAccessIsDenied() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(try store.query(sql: "SELECT * FROM _local_nodes")) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testDirectPhysicalTableAccessWithDoubleQuotedIdentifierIsDenied() async throws {
    let store = try await makeSeededStore()
    // A lexical validator has to explicitly know SQLite accepts `"..."` as
    // a quoted identifier (not just a string literal, which standard SQL
    // would say) — the authorizer needs no such enumeration: SQLite itself
    // resolves the quoting and reports the plain table name either way.
    XCTAssertThrowsError(try store.query(sql: "SELECT * FROM \"_local_nodes\"")) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testDirectPhysicalTableAccessWithBacktickIdentifierIsDenied() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(try store.query(sql: "SELECT * FROM `_local_nodes`")) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testDirectPhysicalTableAccessWithBracketIdentifierIsDenied() async throws {
    let store = try await makeSeededStore()
    // MS-SQL-style `[...]` quoting — SQLite accepts it for compatibility.
    // Easy for a hand-rolled tokenizer to forget entirely.
    XCTAssertThrowsError(try store.query(sql: "SELECT * FROM [_local_nodes]")) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testDirectPhysicalTableAccessWithSchemaQualifierIsDenied() async throws {
    let store = try await makeSeededStore()
    // `main.` is the implicit schema name DO/on-device SQLite always has.
    // SQLite's authorizer reports just the bare table name regardless of
    // how it was qualified in the query text.
    XCTAssertThrowsError(try store.query(sql: "SELECT * FROM main._local_nodes")) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testDirectPhysicalTableAccessWithCommentObfuscationIsDenied() async throws {
    let store = try await makeSeededStore()
    // `/**/` is whitespace to SQLite's real parser but can slip past a
    // naive `FROM\s+(\w+)`-shaped regex that doesn't tokenize comments out
    // first. The authorizer only ever sees the fully-parsed table name.
    XCTAssertThrowsError(try store.query(sql: "SELECT * FROM/**/_local_nodes")) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testDirectPhysicalTableAccessThroughDeeplyNestedSubqueryIsDenied() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(
      try store.query(sql: "SELECT * FROM (((SELECT * FROM _local_nodes)))")
    ) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testDirectPhysicalTableAccessViaScalarSubqueryInSelectListIsDenied() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(
      try store.query(sql: "SELECT (SELECT count(*) FROM _local_nodes) FROM graph_nodes")
    ) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_nodes"))
    }
  }

  func testDirectPhysicalTableAccessInsideRecursiveCTESecondArmIsDenied() async throws {
    let store = try await makeSeededStore()
    // A recursive CTE's base case can look innocuous (reads the allowed
    // view) while its recursive step reads something else entirely — a
    // validator whose CTE handling only inspects the first UNION arm could
    // plausibly miss this. The authorizer inspects every read the compiled
    // statement performs, regardless of which arm it came from.
    XCTAssertThrowsError(
      try store.query(
        sql: """
          WITH RECURSIVE walk(id) AS (
            SELECT node_id FROM graph_nodes
            UNION ALL
            SELECT source_node_id FROM _local_edges
          )
          SELECT * FROM walk
          """)
    ) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("_local_edges"))
    }
  }

  // MARK: - Adversarial: a WITH-prefixed write, not just a disguised read
  //
  // This is the strongest single proof in this file. SQLite's grammar
  // allows a `WITH` clause to prefix INSERT/UPDATE/DELETE, not just SELECT
  // — so a validator that only checks "does the statement start with
  // SELECT or WITH" and stops there would wave this through. It is not a
  // hypothetical: `GraphSQLExecutor`'s own leading-token pre-check
  // (`firstToken == "SELECT" || firstToken == "WITH"`) says nothing about
  // what follows the WITH clause's closing paren, and passes this query.
  // What actually stops it is the real authorizer denying `SQLITE_INSERT`
  // during `sqlite3_prepare_v3` — independent of, and strictly downstream
  // of, that leading-token check.

  func testWithPrefixedInsertIsDeniedByTheAuthorizerNotJustTheLeadingTokenCheck() async throws {
    let store = try await makeSeededStore()
    let sql = """
      WITH bait AS (SELECT 1)
      INSERT INTO _local_nodes (node_id, title, plain_text, kind, created_at, modified_at, is_pinned)
      VALUES ('evil', 'evil', 'evil', 'free', 0, 0, 0)
      """
    XCTAssertThrowsError(try store.query(sql: sql)) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("a write or schema operation"))
    }
    // And, just as importantly: the write did not happen.
    let node = try await store.node(for: PageID(rawValue: "evil"))
    XCTAssertNil(node)
  }

  // MARK: - Adversarial: disallowed functions and pragmas

  func testDisallowedFunctionIsDenied() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(try store.query(sql: "SELECT randomblob(16) FROM graph_nodes")) { error in
      guard case .unauthorized = error as? GraphQueryError else {
        return XCTFail("expected .unauthorized, got \(error)")
      }
    }
  }

  func testPragmaOtherThanDataVersionIsDenied() async throws {
    let store = try await makeSeededStore()
    // Caught by the leading-token pre-check (PRAGMA can't follow SELECT/
    // WITH in SQLite's grammar, so it can only ever be the whole
    // statement) — defense-in-depth, not an authorizer-specific proof.
    // The authorizer's own SQLITE_PRAGMA case (see GraphSQLExecutor.swift)
    // independently denies every pragma except `data_version` too, should
    // that pre-check ever be loosened.
    XCTAssertThrowsError(try store.query(sql: "PRAGMA table_info(_local_nodes)")) { error in
      XCTAssertEqual(error as? GraphQueryError, .readOnlyRequired)
    }
  }

  func testAttachDatabaseIsDenied() async throws {
    let store = try await makeSeededStore()
    // Same honesty note as the PRAGMA test above: ATTACH cannot be
    // disguised as following a SELECT/WITH in SQLite's grammar, so this is
    // caught by the leading-token check. The authorizer's own default case
    // (GraphSQLExecutor.swift's `authorizerCallback`) denies SQLITE_ATTACH
    // unconditionally regardless, as defense in depth.
    XCTAssertThrowsError(try store.query(sql: "ATTACH DATABASE ':memory:' AS evil")) { error in
      XCTAssertEqual(error as? GraphQueryError, .readOnlyRequired)
    }
  }

  func testCreateTriggerAsLeadingStatementIsDenied() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(
      try store.query(
        sql: """
          CREATE TRIGGER evil AFTER INSERT ON _local_nodes BEGIN SELECT 1; END
          """)
    ) { error in
      XCTAssertEqual(error as? GraphQueryError, .readOnlyRequired)
    }
  }

  // MARK: - Adversarial: FTS5 shadow tables
  //
  // See GraphSQLExecutor.swift's header on `authorizerCallback`'s
  // `SQLITE_READ` case: the real authorizer, ALONE, actually ALLOWS shadow-
  // table reads unconditionally (`ftsShadowSources.contains(source)`
  // short-circuits before the allowlist/view check) — because SQLite's own
  // internal expansion of a `graph_text_search MATCH` query needs to read
  // them, and the authorizer cannot distinguish that legitimate internal
  // access from a query naming the shadow table directly. This is a real,
  // documented, deliberate gap in the pure-authorizer boundary — it's why
  // `GraphSQLExecutor.execute` also runs a small lexical pre-check
  // (`forbiddenIdentifier`) before the authorizer ever gets involved. These
  // tests confirm that hybrid actually closes the gap, and the comment
  // above explains WHY a "real authorizer" claim doesn't mean "no lexical
  // code anywhere" — one narrow, unavoidable exception, clearly isolated.

  func testDirectFTSShadowTableAccessIsDenied() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(
      try store.query(sql: "SELECT * FROM graph_text_search_content")
    ) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("graph_text_search_content"))
    }
  }

  func testDirectFTSShadowTableAccessWithQuotingIsDenied() async throws {
    let store = try await makeSeededStore()
    XCTAssertThrowsError(
      try store.query(sql: "SELECT * FROM \"graph_text_search_data\"")
    ) { error in
      XCTAssertEqual(error as? GraphQueryError, .unauthorized("graph_text_search_data"))
    }
  }

  func testLegitimateFTS5MatchQueryStillWorks() async throws {
    // The positive-path counterpart to the two tests above: the hybrid
    // guard must not be so broad it breaks the actual public surface.
    let store = try await makeSeededStore()
    let result = try store.query(
      sql: "SELECT node_id FROM graph_text_search WHERE graph_text_search MATCH 'Secret'")
    XCTAssertEqual(result.rows.count, 1)
  }

  // MARK: - Row/byte/time limits (not the authorizer, but the same bounded
  // surface — included for completeness of "bounded" query executor tests).

  func testRowLimitTruncatesRatherThanErroring() async throws {
    let store = try LocalGraphStore.openTemporary()
    for index in 0..<5 {
      let pageID = PageID.free(UUID(uuidString: "20000000-0000-0000-0000-00000000000\(index)")!)
      try await store.writeProjection(
        pageID: pageID, kind: .free, createdAt: Date(), modifiedAt: Date(),
        projection: .init(
          title: "Page \(index)", plainText: "", deletedAt: nil, isPinned: false, references: [],
          graphEdges: [], objectMetadata: .init()))
    }
    let result = try store.query(
      sql: "SELECT node_id FROM graph_nodes", limits: GraphQueryLimits(maximumRows: 2))
    XCTAssertEqual(result.rows.count, 2)
    XCTAssertTrue(result.wasTruncated)
  }
}
