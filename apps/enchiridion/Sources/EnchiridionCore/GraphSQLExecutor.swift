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

enum GraphSQLExecutor {
  private static let allowedSources: Set<String> = [
    "graph_nodes",
    "graph_tags",
    "graph_tag_parents",
    "graph_tag_closure",
    "graph_node_tags",
    "graph_facts",
    "graph_relation_definitions",
    "graph_edges",
    "graph_issues",
    "graph_text_search",
    "graph_workouts_v1",
    "graph_workout_exercises_v1",
    "graph_workout_sets_v1",
    "graph_workout_splits_v1",
  ]

  private static let ftsShadowSources: Set<String> = [
    "graph_text_search_config",
    "graph_text_search_content",
    "graph_text_search_data",
    "graph_text_search_docsize",
    "graph_text_search_idx",
  ]

  private static let allowedFunctions: Set<String> = [
    "abs", "avg", "bm25", "coalesce", "count", "date", "datetime", "glob", "group_concat",
    "hex", "ifnull", "iif", "instr", "julianday", "json_array", "json_extract",
    "json_object", "json_type", "length", "like", "likely", "lower", "ltrim", "match",
    "max", "min", "nullif", "printf", "quote", "random", "replace", "round", "row_number",
    "rtrim", "snippet", "strftime", "substr", "substring", "sum", "time", "total", "trim", "typeof",
    "unicode", "unixepoch", "unlikely", "upper",
  ]

  static func execute(
    path: String,
    sql: String,
    arguments: [String: GraphSQLValue] = [:],
    limits: GraphQueryLimits = .init()
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

    let authorizer = AuthorizerState()
    let authorizerPointer = Unmanaged.passRetained(authorizer).toOpaque()
    defer { Unmanaged<AuthorizerState>.fromOpaque(authorizerPointer).release() }
    sqlite3_set_authorizer(connection, authorizerCallback, authorizerPointer)

    let deadline = DispatchTime.now().uptimeNanoseconds
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

  private static let authorizerCallback: @convention(c) (
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
      if allowedSources.contains(source) || ftsShadowSources.contains(source)
        || view.map(allowedSources.contains) == true
      {
        return SQLITE_OK
      }
      state.deniedOperation = source.isEmpty ? "private storage" : source
      return SQLITE_DENY
    case SQLITE_FUNCTION:
      let function = second.map { String(cString: $0).lowercased() }
        ?? first.map { String(cString: $0).lowercased() }
        ?? ""
      guard allowedFunctions.contains(function) else {
        state.deniedOperation = function.isEmpty ? "an unsafe SQL function" : "the \(function) function"
        return SQLITE_DENY
      }
      return SQLITE_OK
    case SQLITE_PRAGMA:
      let pragma = first.map { String(cString: $0).lowercased() } ?? ""
      if pragma == "data_version" { return SQLITE_OK }
      state.deniedOperation = pragma.isEmpty ? "a pragma" : "the \(pragma) pragma"
      return SQLITE_DENY
    default:
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
        sqlite3_bind_blob(statement, index, buffer.baseAddress, Int32(buffer.count), sqliteTransient)
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

  /// FTS5 expands a public MATCH query into reads of its private shadow tables before the
  /// authorizer reports the public virtual table. Reject explicit references up front so those
  /// internal reads can be authorized without exposing the shadow schema to query authors.
  private static func forbiddenIdentifier(in sql: String) -> String? {
    let bytes = Array(sql.utf8)
    var index = 0
    while index < bytes.count {
      switch bytes[index] {
      case 39: // String literal.
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
      case 34, 96, 91: // Quoted identifier.
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
  var deniedOperation: String?
}

private final class ProgressState {
  let deadline: UInt64
  init(deadline: UInt64) { self.deadline = deadline }
}
