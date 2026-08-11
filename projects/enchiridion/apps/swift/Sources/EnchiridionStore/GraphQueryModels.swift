// GraphQueryModels.swift
// EnchiridionStore
//
// Result-shape types for the bounded SQL query surface, ported (concept and
// near-verbatim shape) from the old app's
// apps/enchiridion/Sources/EnchiridionCore/GraphQueryModels.swift
// (`GraphSQLValue`/`GraphQueryColumn`/`GraphQueryRow`/`GraphQueryResult`
// only — the saved-query/builder types that live alongside them there
// belong to a later UI task, not this one).

import Foundation

/// One column value out of a bounded query result row. Mirrors SQLite's own
/// four storage classes exactly (plus NULL) so `GraphSQLExecutor` never has
/// to guess or coerce a type — see `columnValue(_:index:)` there.
public enum GraphSQLValue: Codable, Hashable, Sendable {
  case null
  case integer(Int64)
  case real(Double)
  case text(String)
  case blob(Data)
}

public struct GraphQueryColumn: Codable, Hashable, Sendable, Identifiable {
  public var name: String
  public var id: String { name }
  public init(name: String) { self.name = name }
}

public struct GraphQueryRow: Codable, Hashable, Sendable, Identifiable {
  public var values: [GraphSQLValue]
  public var id: Int
  public init(id: Int, values: [GraphSQLValue]) {
    self.id = id
    self.values = values
  }
}

public struct GraphQueryResult: Codable, Hashable, Sendable {
  public var columns: [GraphQueryColumn]
  public var rows: [GraphQueryRow]
  public var wasTruncated: Bool
  public var elapsed: TimeInterval

  public init(
    columns: [GraphQueryColumn],
    rows: [GraphQueryRow],
    wasTruncated: Bool,
    elapsed: TimeInterval
  ) {
    self.columns = columns
    self.rows = rows
    self.wasTruncated = wasTruncated
    self.elapsed = elapsed
  }
}
