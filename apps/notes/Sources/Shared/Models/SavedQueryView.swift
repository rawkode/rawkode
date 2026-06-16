import Foundation

struct SavedQueryView: Identifiable, Equatable, Sendable {
    var id: UUID
    var name: String
    var query: String
    var view: String
    var groupBy: String?
    var createdAt: Date
    var updatedAt: Date
}
