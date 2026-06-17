import Foundation

struct EntityReference: Equatable, Sendable {
    var id: UUID
    var label: String
    var supertags: [String]
    var properties: [String: String] = [:]
}

struct EntityDetail: Identifiable, Equatable, Sendable {
    var id: UUID
    var name: String
    var supertags: [String]
    var properties: [String: String]
    var backlinks: [DocumentBacklink]
    var outgoingRelationships: [EntityRelationship]
    var incomingRelationships: [EntityRelationship]
    var updatedAt: Date

    var relationshipCount: Int {
        outgoingRelationships.count + incomingRelationships.count
    }

    var sortedProperties: [(key: String, value: String)] {
        properties
            .map { ($0.key, $0.value) }
            .sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
    }
}
