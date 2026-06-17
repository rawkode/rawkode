import Foundation

enum SupertagFieldValueType: String, CaseIterable, Identifiable, Equatable, Sendable {
    case text
    case number
    case date
    case entity
    case boolean

    var id: String { rawValue }

    var label: String {
        switch self {
        case .text:
            "Text"
        case .number:
            "Number"
        case .date:
            "Date"
        case .entity:
            "Entity"
        case .boolean:
            "Boolean"
        }
    }

    var systemImage: String {
        switch self {
        case .text:
            "textformat"
        case .number:
            "number"
        case .date:
            "calendar"
        case .entity:
            "at"
        case .boolean:
            "checkmark.square"
        }
    }

    var defaultValuePlaceholder: String {
        switch self {
        case .text:
            "Optional text"
        case .number:
            "Optional number"
        case .date:
            "YYYY-MM-DD"
        case .entity:
            "[[Entity Name]]"
        case .boolean:
            "true or false"
        }
    }

    init(normalizing rawValue: String) throws {
        let normalized = rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "text", "string":
            self = .text
        case "number", "numeric":
            self = .number
        case "date":
            self = .date
        case "entity", "reference":
            self = .entity
        case "boolean", "bool", "checkbox":
            self = .boolean
        default:
            throw SQLiteNotesError.validationFailed("Supertag field type must be text, number, date, entity, or boolean.")
        }
    }
}

struct SupertagFieldDefinition: Identifiable, Equatable, Sendable {
    var id: UUID
    var supertagID: UUID
    var supertagName: String
    var supertagSlug: String
    var key: String
    var label: String
    var valueType: SupertagFieldValueType
    var defaultValue: String?
    var isRequired: Bool
    var sortOrder: Int
    var createdAt: Date
    var updatedAt: Date
}

struct SupertagSchema: Identifiable, Equatable, Sendable {
    var id: UUID
    var name: String
    var slug: String
    var fields: [SupertagFieldDefinition]
    var createdAt: Date
    var updatedAt: Date

    var fieldCount: Int {
        fields.count
    }

    var requiredFieldCount: Int {
        fields.filter(\.isRequired).count
    }
}

struct SupertagSchemaImpactPreview: Equatable, Sendable {
    var supertagName: String
    var fieldLabel: String
    var currentFieldKey: String?
    var proposedFieldKey: String
    var currentValueType: SupertagFieldValueType?
    var proposedValueType: SupertagFieldValueType
    var currentDefaultValue: String?
    var proposedDefaultValue: String?
    var currentIsRequired: Bool?
    var proposedIsRequired: Bool
    var taggedEntityCount: Int
    var storedValueCount: Int
    var missingValueCount: Int
    var renamedValueCount: Int
    var defaultBackfillCount: Int
    var requiredMissingValueCount: Int
    var incompatibleValueCount: Int
    var keyConflictCount: Int
    var sharedKeyConflictCount: Int

    var blockingIssueCount: Int {
        requiredMissingValueCount + incompatibleValueCount + keyConflictCount + sharedKeyConflictCount
    }

    var hasBlockingIssues: Bool {
        blockingIssueCount > 0
    }

    var isEditingExistingField: Bool {
        currentFieldKey != nil
    }

    var hasSchemaChange: Bool {
        currentFieldKey != proposedFieldKey
            || currentValueType != proposedValueType
            || currentDefaultValue != proposedDefaultValue
            || currentIsRequired != proposedIsRequired
    }

    var needsSaveConfirmation: Bool {
        (isEditingExistingField || taggedEntityCount > 0)
            && hasSchemaChange
            && (taggedEntityCount > 0 || storedValueCount > 0 || defaultBackfillCount > 0)
    }
}
