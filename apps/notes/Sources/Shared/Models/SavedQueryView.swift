import Foundation

struct SavedQueryView: Identifiable, Equatable, Sendable {
    var id: UUID
    var name: String
    var query: String
    var view: String
    var groupBy: String?
    var visibleColumns: [String] = []
    var sortColumn: String?
    var sortDescending = false
    var rowLimit: Int?
    var sortOrder: Int
    var createdAt: Date
    var updatedAt: Date

    var displaySettings: QueryViewDisplaySettings {
        QueryViewDisplaySettings(
            visibleColumns: visibleColumns,
            sortColumn: sortColumn,
            sortDescending: sortDescending,
            rowLimit: rowLimit
        )
    }
}
