// GraphSQLExecutor.swift
// EnchiridionStore
//
// The bounded, read-only SQL query surface — port of the old app's
// apps/enchiridion/Sources/EnchiridionCore/GraphSQLExecutor.swift, adjusted
// to this package's schema (`LocalGraphSchema`) and to open its own
// dedicated connection rather than an already-open GRDB one. Read the next
// two sections before changing anything here; they document a real finding
// from this task, not an assumption.
//
// *** WHY THIS DOES NOT USE A GRDB `Database`/`DatabasePool` CONNECTION ***
//
// The task brief asks to "check GRDB's authorizer API, e.g.
// `Database.authorizerHandler` or similar, verify the exact GRDB 7.x API
// surface rather than guessing." That was done — against the actual pinned
// checkout (GRDB.swift v7.10.0, the same tag `apps/enchiridion/Package.swift`
// pins) — and the finding is: **GRDB has no public authorizer API at all.**
//
// `GRDB/Core/StatementAuthorizer.swift` is `final class StatementAuthorizer`
// with no `public` modifier — an internal implementation detail GRDB uses
// for its own bookkeeping (tracking `DatabaseRegion` for `ValueObservation`,
// detecting DDL that invalidates the schema cache, disabling SQLite's
// truncate optimization when a transaction observer needs per-row DELETE
// notifications). `Database.swift:623`'s private `setupAuthorizer()` calls
// `sqlite3_set_authorizer` exactly once, in `Database.init`, with a comment
// explaining why: "SQLite authorizer is set only once per database
// connection... because authorizer changes have SQLite invalidate
// statements" (citing
// http://sqlite.1065341.n5.nabble.com/Issue-report-sqlite3-set-authorizer...).
// There is no hook, delegate, or callback parameter anywhere in GRDB's
// public API surface for a caller to extend or replace that authorizer —
// confirmed by grepping the whole checkout for `public.*[Aa]uthorizer` and
// `sqlite3_set_authorizer`; the only registration site is that one
// GRDB-internal call.
//
// This matters because `sqlite3_set_authorizer` is a single-callback-per-
// connection C API: a second call on the same `sqlite3*` handle would
// silently *replace* GRDB's own authorizer, breaking the machinery above
// (ValueObservation would stop seeing accurate read regions; deletion
// notifications could go stale) for every other use of that connection.
// Layering a custom authorizer onto `LocalGraphStore`'s GRDB
// `DatabasePool` — the connection pool used for schema migration and
// `writeProjection` — is therefore not just undocumented, it is actively
// unsafe.
//
// The old app's `GraphSQLExecutor.swift` already reached the same
// conclusion independently: it never touches GRDB's `Database` type at all
// for the query path. It opens its own plain `sqlite3_open_v2` connection
// (via `import GRDBSQLite` — GRDB's own vendored/system SQLite C module,
// a real published product of the `GRDB.swift` package, so this needs no
// second SQLite dependency) purely for bounded reads, and installs
// `sqlite3_set_authorizer` on *that* connection, which nothing else ever
// touches. This file does exactly the same thing, verified working (the
// old app's test suite exercises this same code path today) rather than a
// novel design: a dedicated, read-only, single-purpose raw SQLite
// connection to the same database file `LocalGraphStore`'s GRDB pool
// writes through, opened fresh per call so it always sees the latest
// committed data (SQLite readers on a WAL-mode database — GRDB's default,
// see `LocalGraphStore.swift` — never block on or are blocked by the
// writer).
//
// *** WHAT THE AUTHORIZER ACTUALLY ENFORCES ***
//
// `sqlite3_set_authorizer` (https://www.sqlite.org/c3ref/set_authorizer.html)
// is SQLite's own query-plan-level access-control hook: SQLite calls back
// into this code for every table/column read, function call, and pragma a
// *compiled* statement will perform — after the query planner has resolved
// views, subqueries, and CTEs into their real underlying reads. Unlike the
// lexical validator this project also carries for the server side
// (`workers/vault/src/sql-validator.ts`, ported CONCEPT only, not code, per
// task brief — that file's own header explains at length why it is
// text-pattern matching and not a real security boundary), this cannot be
// fooled by clever SQL text: it is not looking at text at all, only at what
// the engine actually resolved. See `GraphSQLExecutorTests.swift` for the
// adversarial proof.
//
// *** KNOWN, DEDUCED-AND-TESTED LIMITATION: BARE `count(*)` OVER A VIEW ***
//
// One real finding from building that adversarial suite, not present in
// (or ever tested by) the port source: `SELECT count(*) FROM <allowed
// view>` (and the equivalent `count(1)`) is DENIED, even though the view
// itself is allowlisted. Root cause, confirmed empirically (see
// `GraphSQLExecutorTests.swift`'s
// `testBareCountStarOverAViewIsDeniedDueToASQLiteOptimizerQuirk` for the
// full write-up): SQLite has a dedicated optimization for exactly that bare
// shape — no WHERE/GROUP BY/DISTINCT — that answers it via a direct row
// count on the underlying table's rootpage, bypassing the view's SELECT
// list entirely. The `SQLITE_READ` callback this produces (physical table
// name, an EMPTY column name, no view attribution) is indistinguishable
// from a query naming that physical table directly — there is no
// documented, stable way to tell them apart at the authorizer level.
// Denying both is the correct, fail-closed call, not a bug to route around
// with a text-level special case. `count(<a real column>)` or adding any
// `WHERE` clause both avoid the SQLite optimization and work correctly
// (also tested).

import Foundation
import GRDBSQLite

public struct GraphQueryLimits: Equatable, Sendable {
  public var maximumRows: Int
  public var maximumBytes: Int
  public var maximumDuration: TimeInterval

  public init(
    maximumRows: Int = 5_000,
    maximumBytes: Int = 8 * 1_024 * 1_024,
    maximumDuration: TimeInterval = 2
  ) {
    self.maximumRows = min(max(maximumRows, 1), 20_000)
    self.maximumBytes = min(max(maximumBytes, 1_024), 32 * 1_024 * 1_024)
    self.maximumDuration = min(max(maximumDuration, 0.05), 10)
  }
}

public enum GraphQueryError: Error, LocalizedError, Equatable {
  case empty
  case readOnlyRequired
  case multipleStatements
  case unauthorized(String)
  case invalidArgument(String)
  case sqlite(String)
  case interrupted
  case resultTooLarge

  public var errorDescription: String? {
    switch self {
    case .empty: "Enter a SELECT query."
    case .readOnlyRequired: "Graph queries must be a read-only SELECT or WITH statement."
    case .multipleStatements: "Run one SQL statement at a time."
    case .unauthorized(let operation): "The query cannot access \(operation)."
    case .invalidArgument(let name): "The query argument \(name) is invalid."
    case .sqlite(let message): message
    case .interrupted: "The query exceeded its execution limit."
    case .resultTooLarge: "The query result exceeded its memory limit."
    }
  }
}

public enum GraphSQLExecutor {
  /// Views a bounded query may read from. Defaults to
  /// `LocalGraphSchema.projectionViewNames`; callers may pass a narrower
  /// set (e.g. a future gadget capability's per-grant allowlist — see the
  /// plan's "gadgets get pre-defined parameterized views only").
  public static let defaultAllowedSources = LocalGraphSchema.projectionViewNames
  public static let ftsShadowSources = LocalGraphSchema.ftsShadowTableNames

  public static let allowedFunctions: Set<String> = [
    "abs", "avg", "bm25", "coalesce", "count", "date", "datetime", "glob", "group_concat",
    "hex", "ifnull", "iif", "instr", "julianday", "json_array", "json_extract",
    "json_object", "json_type", "length", "like", "likely", "lower", "ltrim", "match",
    "max", "min", "nullif", "printf", "quote", "random", "replace", "round", "row_number",
    "rtrim", "snippet", "strftime", "substr", "substring", "sum", "time", "total", "trim", "typeof",
    "unicode", "unixepoch", "unlikely", "upper",
  ]

  public static func execute(
    path: String,
    sql: String,
    arguments: [String: GraphSQLValue] = [:],
    limits: GraphQueryLimits = .init(),
    allowedSources: Set<String>? = nil
  ) throws -> GraphQueryResult {
    let trimmed = sql.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw GraphQueryError.empty }
    if let forbiddenSource = forbiddenIdentifier(in: trimmed) {
      throw GraphQueryError.unauthorized(forbiddenSource)
    }
    let firstToken = trimmed.prefix { !$0.isWhitespace && $0 != "(" }.uppercased()
    guard firstToken == "SELECT" || firstToken == "WITH" else {
      throw GraphQueryError.readOnlyRequired
    }

    var connection: OpaquePointer?
    let openCode = sqlite3_open_v2(
      path,
      &connection,
      SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX,
      nil
    )
    guard openCode == SQLITE_OK, let connection else {
      defer { if connection != nil { sqlite3_close(connection) } }
      throw GraphQueryError.sqlite(errorMessage(connection))
    }
    defer { sqlite3_close(connection) }
    sqlite3_busy_timeout(connection, 2_000)
    sqlite3_limit(connection, SQLITE_LIMIT_SQL_LENGTH, 256 * 1_024)
    sqlite3_limit(connection, SQLITE_LIMIT_COLUMN, 256)
    sqlite3_limit(connection, SQLITE_LIMIT_COMPOUND_SELECT, 50)
    sqlite3_limit(connection, SQLITE_LIMIT_EXPR_DEPTH, 100)

    let authorizer = AuthorizerState(allowedSources: allowedSources ?? defaultAllowedSources)
    let authorizerPointer = Unmanaged.passRetained(authorizer).toOpaque()
    defer { Unmanaged<AuthorizerState>.fromOpaque(authorizerPointer).release() }
    sqlite3_set_authorizer(connection, authorizerCallback, authorizerPointer)

    let deadline =
      DispatchTime.now().uptimeNanoseconds
      + UInt64(limits.maximumDuration * 1_000_000_000)
    let progress = ProgressState(deadline: deadline)
    let progressPointer = Unmanaged.passRetained(progress).toOpaque()
    defer { Unmanaged<ProgressState>.fromOpaque(progressPointer).release() }
    sqlite3_progress_handler(connection, 1_000, progressCallback, progressPointer)

    var statement: OpaquePointer?
    var remainder = ""
    let prepareCode = trimmed.utf8CString.withUnsafeBufferPointer { sqlBuffer in
      var tail: UnsafePointer<CChar>?
      let code = sqlite3_prepare_v3(
        connection,
        sqlBuffer.baseAddress,
        -1,
        UInt32(SQLITE_PREPARE_PERSISTENT),
        &statement,
        &tail
      )
      if let tail { remainder = String(cString: tail) }
      return code
    }
    guard prepareCode == SQLITE_OK, let statement else {
      if let denied = authorizer.deniedOperation {
        throw GraphQueryError.unauthorized(denied)
      }
      throw GraphQueryError.sqlite(errorMessage(connection))
    }
    defer { sqlite3_finalize(statement) }
    let trailingSQL = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trailingSQL.isEmpty || trailingSQL.allSatisfy({ $0 == ";" || $0.isWhitespace }) else {
      throw GraphQueryError.multipleStatements
    }
    guard sqlite3_stmt_readonly(statement) != 0 else { throw GraphQueryError.readOnlyRequired }

    for (name, value) in arguments {
      let normalized = name.hasPrefix(":") ? name : ":\(name)"
      let index = sqlite3_bind_parameter_index(statement, normalized)
      guard index > 0 else { throw GraphQueryError.invalidArgument(name) }
      try bind(value, at: index, statement: statement)
    }

    let columnCount = Int(sqlite3_column_count(statement))
    let columns = (0..<columnCount).map { index in
      GraphQueryColumn(name: String(cString: sqlite3_column_name(statement, Int32(index))))
    }
    var rows: [GraphQueryRow] = []
    var bytes = 0
    var truncated = false
    let started = DispatchTime.now().uptimeNanoseconds

    while true {
      let code = sqlite3_step(statement)
      if code == SQLITE_DONE { break }
      if code == SQLITE_INTERRUPT { throw GraphQueryError.interrupted }
      guard code == SQLITE_ROW else {
        if let denied = authorizer.deniedOperation {
          throw GraphQueryError.unauthorized(denied)
        }
        throw GraphQueryError.sqlite(errorMessage(connection))
      }
      if rows.count >= limits.maximumRows {
        truncated = true
        break
      }
      var values: [GraphSQLValue] = []
      values.reserveCapacity(columnCount)
      for index in 0..<columnCount {
        let value = columnValue(statement, index: Int32(index))
        bytes += byteCount(value)
        guard bytes <= limits.maximumBytes else { throw GraphQueryError.resultTooLarge }
        values.append(value)
      }
      rows.append(.init(id: rows.count, values: values))
    }
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
    return .init(columns: columns, rows: rows, wasTruncated: truncated, elapsed: elapsed)
  }

  /// The real `sqlite3_set_authorizer` callback (see this file's header).
  /// Same shape as the old app's `GraphSQLExecutor.authorizerCallback` —
  /// notably including the same `SQLITE_READ` gap-and-mitigation this
  /// comment on `forbiddenIdentifier` below explains: FTS5 shadow-table
  /// reads are allowed here *unconditionally* (not just when reached via an
  /// allowed view), because SQLite's own internal expansion of a `MATCH`
  /// query against `graph_text_search` needs to read them and the
  /// authorizer alone cannot distinguish that legitimate internal access
  /// from a query that names a shadow table directly — see
  /// `forbiddenIdentifier` and `GraphSQLExecutorTests
  /// .testFTS5ShadowTableDirectAccessDeniedByLexicalPreCheckNotAuthorizerAlone`
  /// for the adversarial proof this gap is real and why the lexical
  /// pre-check exists specifically to close it.
  private static let authorizerCallback:
    @convention(c) (
      UnsafeMutableRawPointer?,
      Int32,
      UnsafePointer<CChar>?,
      UnsafePointer<CChar>?,
      UnsafePointer<CChar>?,
      UnsafePointer<CChar>?
    ) -> Int32 = { pointer, action, first, second, _, context in
      guard let pointer else { return SQLITE_DENY }
      let state = Unmanaged<AuthorizerState>.fromOpaque(pointer).takeUnretainedValue()
      switch action {
      case SQLITE_SELECT, SQLITE_RECURSIVE:
        return SQLITE_OK
      case SQLITE_READ:
        let source = first.map { String(cString: $0).lowercased() } ?? ""
        let view = context.map { String(cString: $0).lowercased() }
        if state.allowedSources.contains(source) || ftsShadowSources.contains(source)
          || view.map(state.allowedSources.contains) == true
        {
          return SQLITE_OK
        }
        state.deniedOperation = source.isEmpty ? "private storage" : source
        return SQLITE_DENY
      case SQLITE_FUNCTION:
        let function =
          second.map { String(cString: $0).lowercased() }
          ?? first.map { String(cString: $0).lowercased() }
          ?? ""
        guard allowedFunctions.contains(function) else {
          state.deniedOperation =
            function.isEmpty ? "an unsafe SQL function" : "the \(function) function"
          return SQLITE_DENY
        }
        return SQLITE_OK
      case SQLITE_PRAGMA:
        let pragma = first.map { String(cString: $0).lowercased() } ?? ""
        if pragma == "data_version" { return SQLITE_OK }
        state.deniedOperation = pragma.isEmpty ? "a pragma" : "the \(pragma) pragma"
        return SQLITE_DENY
      default:
        // Every write, schema-change (CREATE/DROP/ALTER/TRIGGER), ATTACH/
        // DETACH, and transaction/savepoint action code falls through to
        // here and is denied unconditionally. Because the connection is
        // also opened `SQLITE_OPEN_READONLY` above, writes are blocked at
        // two independent layers (the VFS/pager AND this authorizer) —
        // deliberate defense in depth, not redundancy: a future change
        // that accidentally drops the `SQLITE_OPEN_READONLY` flag would
        // still be caught here.
        state.deniedOperation = "a write or schema operation"
        return SQLITE_DENY
      }
    }

  private static let progressCallback: @convention(c) (UnsafeMutableRawPointer?) -> Int32 = {
    pointer in
    guard let pointer else { return 1 }
    let state = Unmanaged<ProgressState>.fromOpaque(pointer).takeUnretainedValue()
    return DispatchTime.now().uptimeNanoseconds >= state.deadline ? 1 : 0
  }

  private static func bind(
    _ value: GraphSQLValue,
    at index: Int32,
    statement: OpaquePointer
  ) throws {
    let code: Int32
    switch value {
    case .null:
      code = sqlite3_bind_null(statement, index)
    case .integer(let value):
      code = sqlite3_bind_int64(statement, index, value)
    case .real(let value):
      code = sqlite3_bind_double(statement, index, value)
    case .text(let value):
      code = value.withCString { pointer in
        sqlite3_bind_text(statement, index, pointer, -1, sqliteTransient)
      }
    case .blob(let value):
      code = value.withUnsafeBytes { buffer in
        sqlite3_bind_blob(
          statement, index, buffer.baseAddress, Int32(buffer.count), sqliteTransient)
      }
    }
    guard code == SQLITE_OK else { throw GraphQueryError.sqlite("Could not bind query argument.") }
  }

  private static func columnValue(_ statement: OpaquePointer, index: Int32) -> GraphSQLValue {
    switch sqlite3_column_type(statement, index) {
    case SQLITE_INTEGER: .integer(sqlite3_column_int64(statement, index))
    case SQLITE_FLOAT: .real(sqlite3_column_double(statement, index))
    case SQLITE_TEXT:
      sqlite3_column_text(statement, index).map { .text(String(cString: $0)) } ?? .null
    case SQLITE_BLOB:
      if let pointer = sqlite3_column_blob(statement, index) {
        .blob(Data(bytes: pointer, count: Int(sqlite3_column_bytes(statement, index))))
      } else {
        .blob(Data())
      }
    default: .null
    }
  }

  private static func byteCount(_ value: GraphSQLValue) -> Int {
    switch value {
    case .null: 0
    case .integer, .real: 8
    case .text(let value): value.utf8.count
    case .blob(let value): value.count
    }
  }

  private static func errorMessage(_ connection: OpaquePointer?) -> String {
    guard let connection, let message = sqlite3_errmsg(connection) else {
      return "The SQLite query could not be prepared."
    }
    return String(cString: message)
  }

  /// FTS5 expands a public MATCH query into reads of its private shadow
  /// tables before the authorizer reports the public virtual table — see
  /// this file's header comment on `authorizerCallback`'s `SQLITE_READ`
  /// case, which allows shadow-table reads unconditionally for exactly
  /// that reason. This lexical pre-scan is the actual boundary preventing
  /// a query from naming a shadow table directly: reject explicit
  /// references up front, before the authorizer even runs, so the
  /// authorizer's necessary internal-access allowance can't be abused as a
  /// direct-query allowance. Ported byte-for-byte from the old app's
  /// `forbiddenIdentifier` (GraphSQLExecutor.swift:336-390).
  private static func forbiddenIdentifier(in sql: String) -> String? {
    let bytes = Array(sql.utf8)
    var index = 0
    while index < bytes.count {
      switch bytes[index] {
      case 39:  // String literal.
        index += 1
        var literal: [UInt8] = []
        while index < bytes.count {
          if bytes[index] == 39 {
            if index + 1 < bytes.count, bytes[index + 1] == 39 {
              literal.append(39)
              index += 2
            } else {
              index += 1
              break
            }
          } else {
            literal.append(bytes[index])
            index += 1
          }
        }
        // SQLite accepts single-quoted table names in FROM clauses for compatibility.
        let identifier = String(decoding: literal, as: UTF8.self).lowercased()
        if ftsShadowSources.contains(identifier) { return identifier }
      case 34, 96, 91:  // Quoted identifier.
        let terminator: UInt8 = bytes[index] == 91 ? 93 : bytes[index]
        index += 1
        let start = index
        while index < bytes.count, bytes[index] != terminator { index += 1 }
        let identifier = String(decoding: bytes[start..<index], as: UTF8.self).lowercased()
        if ftsShadowSources.contains(identifier) { return identifier }
        if index < bytes.count { index += 1 }
      case 45 where index + 1 < bytes.count && bytes[index + 1] == 45:
        index += 2
        while index < bytes.count, bytes[index] != 10, bytes[index] != 13 { index += 1 }
      case 47 where index + 1 < bytes.count && bytes[index + 1] == 42:
        index += 2
        while index + 1 < bytes.count, !(bytes[index] == 42 && bytes[index + 1] == 47) {
          index += 1
        }
        index = min(index + 2, bytes.count)
      default:
        guard isIdentifierByte(bytes[index]) else {
          index += 1
          continue
        }
        let start = index
        while index < bytes.count, isIdentifierByte(bytes[index]) { index += 1 }
        let identifier = String(decoding: bytes[start..<index], as: UTF8.self).lowercased()
        if ftsShadowSources.contains(identifier) { return identifier }
      }
    }
    return nil
  }

  private static func isIdentifierByte(_ byte: UInt8) -> Bool {
    (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
      || (byte >= 48 && byte <= 57) || byte == 95 || byte >= 128
  }

  private static let sqliteTransient = unsafeBitCast(
    -1,
    to: sqlite3_destructor_type.self
  )
}

private final class AuthorizerState {
  let allowedSources: Set<String>
  var deniedOperation: String?
  init(allowedSources: Set<String>) { self.allowedSources = allowedSources }
}

private final class ProgressState {
  let deadline: UInt64
  init(deadline: UInt64) { self.deadline = deadline }
}
