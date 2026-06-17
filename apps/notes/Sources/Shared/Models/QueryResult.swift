import Foundation

struct QueryResult: Equatable, Sendable {
    var columns: [String]
    var rows: [[String: String]]
}

struct QueryResultBoardGroup: Equatable, Sendable {
    var title: String
    var column: String?
    var rows: [[String: String]]
}

struct QueryResultSecondaryValue: Equatable, Sendable {
    var column: String
    var value: String
}

func normalizedQueryViewMode(_ value: String) -> String {
    switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "list":
        "list"
    case "board":
        "board"
    default:
        "table"
    }
}

func queryPrimaryValue(row: [String: String], columns: [String]) -> String {
    row["name"]
        ?? row["title"]
        ?? row["date"]
        ?? columns.compactMap { row[$0] }.first { !$0.isEmpty }
        ?? "Untitled"
}

func querySecondaryValues(
    row: [String: String],
    columns: [String],
    excluding excludedColumns: [String?] = [],
    limit: Int = 4
) -> [QueryResultSecondaryValue] {
    let primary = queryPrimaryValue(row: row, columns: columns)
    let excluded = Set(excludedColumns.compactMap { $0 })

    return columns.compactMap { column in
        guard !excluded.contains(column) else {
            return nil
        }

        let value = row[column] ?? ""
        guard !value.isEmpty, value != primary else {
            return nil
        }

        return QueryResultSecondaryValue(column: column, value: value)
    }
    .prefix(limit)
    .map { $0 }
}

func queryDocumentID(row: [String: String], columns: [String]) -> UUID? {
    guard !columns.contains(queryDocumentIDMetadataKey),
          let value = row[queryDocumentIDMetadataKey] else {
        return nil
    }

    return UUID(uuidString: value)
}

func queryEntityID(row: [String: String], columns: [String]) -> UUID? {
    guard !columns.contains(queryEntityIDMetadataKey),
          let value = row[queryEntityIDMetadataKey] else {
        return nil
    }

    return UUID(uuidString: value)
}

func queryResultBoardGroups(result: QueryResult, groupBy rawGroupBy: String?) -> [QueryResultBoardGroup] {
    guard !result.rows.isEmpty else {
        return []
    }

    let groupColumn = queryResultBoardGroupColumn(columns: result.columns, groupBy: rawGroupBy)
    guard let groupColumn else {
        return [
            QueryResultBoardGroup(title: "Items", column: nil, rows: result.rows),
        ]
    }

    var groups: [QueryResultBoardGroup] = []
    var groupIndices: [String: Int] = [:]

    for row in result.rows {
        let value = row[groupColumn] ?? ""
        let title = value.isEmpty ? "No \(groupColumn)" : value
        if let index = groupIndices[title] {
            groups[index].rows.append(row)
        } else {
            groupIndices[title] = groups.count
            groups.append(QueryResultBoardGroup(title: title, column: groupColumn, rows: [row]))
        }
    }

    return groups
}

private func queryResultBoardGroupColumn(columns: [String], groupBy rawGroupBy: String?) -> String? {
    let groupBy = rawGroupBy?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !groupBy.isEmpty {
        return columns.contains(groupBy) ? groupBy : nil
    }

    let preferredColumns = ["status", "lane", "stage", "state", "date", "supertags"]
    return preferredColumns.first { columns.contains($0) }
}
