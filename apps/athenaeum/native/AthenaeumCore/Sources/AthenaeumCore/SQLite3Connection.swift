import Foundation
#if canImport(SQLite3)
import SQLite3
#endif

// Raw `sqlite3` C API wrapper, not GRDB.
//
// The task brief for this stage suggested "GRDB, per new-notes' validated precedent... or justify
// a different choice." That premise doesn't hold once checked: new-notes' actual native package
// (`apps/new-notes/apps/native/Package.swift` + `Sources/DailyNotesCore/SQLiteStore.swift`, 4400+
// lines) has **no GRDB dependency at all** — it links `sqlite3` directly
// (`linkerSettings: [.linkedLibrary("sqlite3")]`) and drives the C API by hand through its own
// `SQLiteConnection` wrapper (`import SQLite3`, `sqlite3_open`/`sqlite3_prepare_v2`/
// `sqlite3_bind_*`/`sqlite3_step`). So "new-notes' validated precedent" *is* raw `sqlite3`, not
// GRDB — this file follows the actually-validated precedent, cited by inspecting new-notes' real
// source rather than trusting the brief's premise. This also keeps `AthenaeumCore` consistent
// with `AthenaeumRPC`/`AthenaeumDomain`'s own stated discipline of minimizing external
// dependencies (their Package.swift doc comments cite watchOS-buildability; this package already
// isn't watchOS-buildable because of `automerge-swift`, but a dependency-light SQLite layer still
// keeps the actual Automerge dependency the *only* non-Apple-provided one in this package).
//
// Deliberately much smaller than new-notes' `SQLiteConnection`: this stage's `LocalWorkspaceStore`
// only needs open/exec/prepare/bind/step/column/transaction, not new-notes' full
// migration-with-forensic-backup/journal-reuse-detection apparatus (that machinery answers
// problems — multi-year schema evolution, crash-safety journaling — this stage's "even if just
// one v1 migration for Phase 2's scope" explicitly doesn't ask for yet).

enum SQLite3Error: Error, Sendable, Equatable, CustomStringConvertible {
    case openFailed(String)
    case prepareFailed(String)
    case stepFailed(String)
    case bindFailed(String)

    var description: String {
        switch self {
        case .openFailed(let message): return "SQLite open failed: \(message)"
        case .prepareFailed(let message): return "SQLite prepare failed: \(message)"
        case .stepFailed(let message): return "SQLite step failed: \(message)"
        case .bindFailed(let message): return "SQLite bind failed: \(message)"
        }
    }
}

/// One bound parameter value — the small subset of SQLite storage classes `LocalWorkspaceStore`'s
/// schema actually uses (TEXT, INTEGER, BLOB, NULL; no REAL column in this stage's schema).
enum SQLiteValue {
    case text(String)
    case int(Int64)
    case blob(Data)
    case null
}

/// A single SQLite connection plus the minimal statement-lifecycle helpers `LocalWorkspaceStore`
/// needs. Not `Sendable` (wraps a raw `OpaquePointer`) — safe only because every instance is
/// owned and exclusively used by exactly one actor (`LocalWorkspaceStore`), matching new-notes'
/// own `SQLiteConnection`/`SQLiteStore` split ("The only owner of the SQLite connection. All
/// local state transitions are actor-isolated.").
final class SQLite3Connection {
    private var db: OpaquePointer?

    init(path: String) throws {
        var handle: OpaquePointer?
        let result = sqlite3_open_v2(
            path,
            &handle,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
            nil
        )
        guard result == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error opening \(path)"
            if let handle { sqlite3_close(handle) }
            throw SQLite3Error.openFailed(message)
        }
        self.db = handle
        // Foreign keys off by default in SQLite; this schema relies on application-level
        // referential checks (`LocalWorkspaceStore.upsertPage` requires the node to already exist,
        // mirroring `notes-service-live.ts`'s own `nodesRepository.get` check), so this is a
        // deliberate no-op rather than a gap — noted so a future stage doesn't assume FKs are
        // silently enforcing anything.
        try exec("PRAGMA journal_mode = WAL;")
        try exec("PRAGMA foreign_keys = OFF;")
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    private var lastErrorMessage: String {
        guard let db else { return "no connection" }
        return String(cString: sqlite3_errmsg(db))
    }

    func exec(_ sql: String) throws {
        guard let db else { throw SQLite3Error.stepFailed("connection closed") }
        var errorPointer: UnsafeMutablePointer<Int8>?
        let result = sqlite3_exec(db, sql, nil, nil, &errorPointer)
        if result != SQLITE_OK {
            let message = errorPointer.map { String(cString: $0) } ?? lastErrorMessage
            sqlite3_free(errorPointer)
            throw SQLite3Error.stepFailed("\(message) (sql: \(sql))")
        }
    }

    func userVersion() throws -> Int {
        var version = 0
        try query("PRAGMA user_version;", []) { statement in
            version = Int(sqlite3_column_int(statement, 0))
        }
        return version
    }

    func setUserVersion(_ version: Int) throws {
        try exec("PRAGMA user_version = \(version);")
    }

    /// Runs `body` inside `BEGIN IMMEDIATE`/`COMMIT`, rolling back on any thrown error — the same
    /// atomicity discipline new-notes' `SQLiteConnection.transaction` uses, so a partially-applied
    /// multi-statement write (e.g. `upsertPage` writing both the `pages` reference row and the
    /// `pageDocs` blob together) can never be observed half-committed.
    @discardableResult
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE;")
        do {
            let result = try body()
            try exec("COMMIT;")
            return result
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    /// Executes `sql` once with `params` bound in order, ignoring any result rows (an INSERT/
    /// UPDATE/DELETE statement).
    func run(_ sql: String, _ params: [SQLiteValue] = []) throws {
        let statement = try prepare(sql, params)
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        guard result == SQLITE_DONE else {
            throw SQLite3Error.stepFailed("\(lastErrorMessage) (sql: \(sql))")
        }
    }

    /// Executes `sql` once with `params` bound in order, calling `map` once per result row in
    /// row order.
    @discardableResult
    func query<T>(_ sql: String, _ params: [SQLiteValue] = [], map: (OpaquePointer) throws -> T) throws -> [T] {
        let statement = try prepare(sql, params)
        defer { sqlite3_finalize(statement) }
        var results: [T] = []
        while true {
            let stepResult = sqlite3_step(statement)
            if stepResult == SQLITE_DONE { break }
            guard stepResult == SQLITE_ROW else {
                throw SQLite3Error.stepFailed("\(lastErrorMessage) (sql: \(sql))")
            }
            results.append(try map(statement))
        }
        return results
    }

    private func prepare(_ sql: String, _ params: [SQLiteValue]) throws -> OpaquePointer {
        guard let db else { throw SQLite3Error.prepareFailed("connection closed") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLite3Error.prepareFailed("\(lastErrorMessage) (sql: \(sql))")
        }
        for (index, param) in params.enumerated() {
            let position = Int32(index + 1)
            let bindResult: Int32
            switch param {
            case .text(let value):
                bindResult = sqlite3_bind_text(statement, position, value, -1, SQLITE_TRANSIENT)
            case .int(let value):
                bindResult = sqlite3_bind_int64(statement, position, value)
            case .blob(let value):
                bindResult = value.withUnsafeBytes { rawBuffer -> Int32 in
                    sqlite3_bind_blob(statement, position, rawBuffer.baseAddress, Int32(value.count), SQLITE_TRANSIENT)
                }
            case .null:
                bindResult = sqlite3_bind_null(statement, position)
            }
            guard bindResult == SQLITE_OK else {
                sqlite3_finalize(statement)
                throw SQLite3Error.bindFailed(lastErrorMessage)
            }
        }
        return statement
    }
}

// `SQLITE_TRANSIENT` isn't imported from the C header (it's a macro, `(sqlite3_destructor_type)-1`)
// — every raw-sqlite3 Swift wrapper (including new-notes' own) redefines it locally.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// MARK: - Column readers

func columnText(_ statement: OpaquePointer, _ index: Int32) -> String {
    guard let cString = sqlite3_column_text(statement, index) else { return "" }
    return String(cString: cString)
}

func columnOptionalText(_ statement: OpaquePointer, _ index: Int32) -> String? {
    sqlite3_column_type(statement, index) == SQLITE_NULL ? nil : columnText(statement, index)
}

func columnInt(_ statement: OpaquePointer, _ index: Int32) -> Int {
    Int(sqlite3_column_int64(statement, index))
}

func columnBool(_ statement: OpaquePointer, _ index: Int32) -> Bool {
    sqlite3_column_int64(statement, index) != 0
}

func columnBlob(_ statement: OpaquePointer, _ index: Int32) -> Data {
    guard let pointer = sqlite3_column_blob(statement, index) else { return Data() }
    let count = Int(sqlite3_column_bytes(statement, index))
    return Data(bytes: pointer, count: count)
}

func columnOptionalInt(_ statement: OpaquePointer, _ index: Int32) -> Int? {
    sqlite3_column_type(statement, index) == SQLITE_NULL ? nil : columnInt(statement, index)
}
