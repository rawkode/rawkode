import Foundation

struct QueryResult: Equatable, Sendable {
    var columns: [String]
    var rows: [[String: String]]
}

struct QueryValidationDiagnostic: Equatable, Sendable {
    enum Severity: String, Sendable {
        case error
        case warning
    }

    var severity: Severity
    var message: String
}

struct QueryValidationReport: Equatable, Sendable {
    var diagnostics: [QueryValidationDiagnostic] = []
    var columns: [String] = []
    var rowCount: Int?

    var hasErrors: Bool {
        diagnostics.contains { $0.severity == .error }
    }

    var errorSummary: String {
        diagnostics
            .filter { $0.severity == .error }
            .map(\.message)
            .joined(separator: "\n")
    }
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

struct QueryViewDisplaySettings: Equatable, Sendable, Codable {
    var visibleColumns: [String] = []
    var sortColumn: String?
    var sortDescending = false
    var rowLimit: Int?

    var sortDirection: String {
        sortDescending ? "desc" : "asc"
    }

    var hasDisplaySettings: Bool {
        !visibleColumns.isEmpty || sortColumn != nil || rowLimit != nil
    }
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

func queryDisplayedResult(
    result: QueryResult,
    settings: QueryViewDisplaySettings
) -> QueryResult {
    QueryResult(
        columns: queryDisplayColumns(result: result, settings: settings),
        rows: queryDisplayRows(result: result, settings: settings)
    )
}

func queryDisplayColumns(
    result: QueryResult,
    settings: QueryViewDisplaySettings
) -> [String] {
    let requestedColumns = settings.visibleColumns.filter { result.columns.contains($0) }
    return requestedColumns.isEmpty ? result.columns : requestedColumns
}

func queryDisplayRows(
    result: QueryResult,
    settings: QueryViewDisplaySettings
) -> [[String: String]] {
    var rows = result.rows

    if let sortColumn = settings.sortColumn, result.columns.contains(sortColumn) {
        rows.sort { left, right in
            let comparison = queryCompareDisplayValues(left[sortColumn] ?? "", right[sortColumn] ?? "")
            return settings.sortDescending ? comparison == .orderedDescending : comparison == .orderedAscending
        }
    }

    if let rowLimit = settings.rowLimit, rowLimit > 0, rows.count > rowLimit {
        rows = Array(rows.prefix(rowLimit))
    }

    return rows
}

func queryViewDisplayDiagnostics(
    result: QueryResult,
    view: String,
    groupBy rawGroupBy: String?,
    settings: QueryViewDisplaySettings
) -> [QueryValidationDiagnostic] {
    var diagnostics: [QueryValidationDiagnostic] = []
    let columns = Set(result.columns)
    let mode = normalizedQueryViewMode(view)
    let groupBy = rawGroupBy?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

    if mode == "board" {
        if !groupBy.isEmpty, !columns.contains(groupBy) {
            diagnostics.append(
                QueryValidationDiagnostic(
                    severity: .error,
                    message: "Board group field '\(groupBy)' is not returned by the query."
                )
            )
        } else if groupBy.isEmpty, queryResultBoardGroupColumn(columns: result.columns, groupBy: nil) == nil {
            diagnostics.append(
                QueryValidationDiagnostic(
                    severity: .warning,
                    message: "Board view will use a single Items column because no groupable field is returned."
                )
            )
        }
    }

    for column in settings.visibleColumns where !columns.contains(column) {
        diagnostics.append(
            QueryValidationDiagnostic(
                severity: .error,
                message: "Visible column '\(column)' is not returned by the query."
            )
        )
    }

    if let sortColumn = settings.sortColumn, !columns.contains(sortColumn) {
        diagnostics.append(
            QueryValidationDiagnostic(
                severity: .error,
                message: "Sort field '\(sortColumn)' is not returned by the query."
            )
        )
    }

    return diagnostics
}

private func queryCompareDisplayValues(_ left: String, _ right: String) -> ComparisonResult {
    let leftTrimmed = left.trimmingCharacters(in: .whitespacesAndNewlines)
    let rightTrimmed = right.trimmingCharacters(in: .whitespacesAndNewlines)

    if let leftNumber = Double(leftTrimmed), let rightNumber = Double(rightTrimmed) {
        if leftNumber < rightNumber {
            return .orderedAscending
        }
        if leftNumber > rightNumber {
            return .orderedDescending
        }
        return .orderedSame
    }

    return leftTrimmed.localizedStandardCompare(rightTrimmed)
}
