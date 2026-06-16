import Foundation

struct EntityReference: Equatable, Sendable {
    var id: UUID
    var label: String
    var supertags: [String]
}
