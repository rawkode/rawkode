import Foundation

struct DocumentBacklink: Identifiable, Equatable, Sendable {
    var id: String { "\(entityID.uuidString):\(documentID.uuidString)" }

    var entityID: UUID
    var entityName: String
    var documentID: UUID
    var documentTitle: String
    var documentKind: NoteDocumentKind
    var documentDate: String?
}

struct EntityRelationship: Identifiable, Equatable, Sendable {
    var id: String { "\(sourceEntityID.uuidString):\(property):\(targetEntityID.uuidString)" }

    var sourceEntityID: UUID
    var sourceName: String
    var property: String
    var targetEntityID: UUID
    var targetName: String
    var updatedAt: Date
}

struct DocumentContext: Equatable, Sendable {
    static let empty = DocumentContext(
        backlinks: [],
        outgoingRelationships: [],
        incomingRelationships: []
    )

    var backlinks: [DocumentBacklink]
    var outgoingRelationships: [EntityRelationship]
    var incomingRelationships: [EntityRelationship]

    var isEmpty: Bool {
        backlinks.isEmpty && outgoingRelationships.isEmpty && incomingRelationships.isEmpty
    }

    var relationshipCount: Int {
        outgoingRelationships.count + incomingRelationships.count
    }
}
