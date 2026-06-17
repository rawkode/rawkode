import Foundation

struct NotesVaultSnapshot: Codable, Equatable, Sendable {
    static let currentVersion = 1

    var version: Int
    var exportedAt: Date
    var documents: [Document]
    var entities: [Entity]
    var supertags: [Supertag]
    var entitySupertags: [EntitySupertag]
    var entityProperties: [EntityProperty]
    var supertagFieldDefinitions: [SupertagField]
    var savedQueryViews: [SavedView]

    init(
        version: Int = Self.currentVersion,
        exportedAt: Date = .now,
        documents: [Document] = [],
        entities: [Entity] = [],
        supertags: [Supertag] = [],
        entitySupertags: [EntitySupertag] = [],
        entityProperties: [EntityProperty] = [],
        supertagFieldDefinitions: [SupertagField] = [],
        savedQueryViews: [SavedView] = []
    ) {
        self.version = version
        self.exportedAt = exportedAt
        self.documents = documents
        self.entities = entities
        self.supertags = supertags
        self.entitySupertags = entitySupertags
        self.entityProperties = entityProperties
        self.supertagFieldDefinitions = supertagFieldDefinitions
        self.savedQueryViews = savedQueryViews
    }

    struct Document: Codable, Equatable, Sendable {
        var id: UUID
        var kind: NoteDocumentKind
        var date: String?
        var title: String
        var tiptapJSON: String
        var plainText: String
        var createdAt: Date
        var updatedAt: Date
    }

    struct Entity: Codable, Equatable, Sendable {
        var id: UUID
        var name: String
        var createdAt: Date
        var updatedAt: Date
    }

    struct Supertag: Codable, Equatable, Sendable {
        var id: UUID
        var name: String
        var slug: String
        var createdAt: Date
        var updatedAt: Date
    }

    struct EntitySupertag: Codable, Equatable, Sendable {
        var entityID: UUID
        var supertagID: UUID
        var createdAt: Date
    }

    struct EntityProperty: Codable, Equatable, Sendable {
        var entityID: UUID
        var key: String
        var value: String
        var valueEntityID: UUID?
        var updatedAt: Date
    }

    struct SupertagField: Codable, Equatable, Sendable {
        var id: UUID
        var supertagID: UUID
        var key: String
        var label: String
        var valueType: String
        var defaultValue: String?
        var isRequired: Bool
        var sortOrder: Int
        var createdAt: Date
        var updatedAt: Date
    }

    struct SavedView: Codable, Equatable, Sendable {
        var id: UUID
        var name: String
        var query: String
        var view: String
        var groupBy: String?
        var visibleColumns: [String]?
        var sortColumn: String?
        var sortDescending: Bool?
        var rowLimit: Int?
        var sortOrder: Int?
        var createdAt: Date
        var updatedAt: Date
    }
}
