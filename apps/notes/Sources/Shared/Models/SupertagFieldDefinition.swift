import Foundation

struct SupertagFieldDefinition: Identifiable, Equatable, Sendable {
    var id: UUID
    var supertagID: UUID
    var supertagName: String
    var supertagSlug: String
    var key: String
    var label: String
    var valueType: String
    var defaultValue: String?
    var isRequired: Bool
    var sortOrder: Int
    var createdAt: Date
    var updatedAt: Date
}
