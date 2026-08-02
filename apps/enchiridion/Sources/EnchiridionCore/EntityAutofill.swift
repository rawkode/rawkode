import Foundation

/// A stateless request for suggestions while creating one typed entity.
///
/// The request intentionally carries only the selected schema and the exact details the person
/// entered into the creation form. It has no access to pages, graph data, contacts, calendars,
/// assistant history, retrieval, tools, or any network-backed provider.
public struct EntityAutofillRequest: Hashable, Sendable {
  public let schema: SupertagDefinition
  /// The scalar and reference fields permitted for this creation form. Inherited fields retain
  /// their declaring schema in `propertyKey`.
  public let effectiveFields: [SupertagEffectiveField]
  public let userProvidedDetails: String

  public init(
    schema: SupertagDefinition,
    effectiveFields: [SupertagEffectiveField]? = nil,
    userProvidedDetails: String
  ) {
    self.schema = schema
    self.effectiveFields = effectiveFields ?? Self.directFields(for: schema)
    self.userProvidedDetails = userProvidedDetails
  }

  private static func directFields(for schema: SupertagDefinition) -> [SupertagEffectiveField] {
    schema.fields.map {
      .init(propertyKey: .init(supertagID: schema.id, fieldID: $0.id), definition: $0)
    }
  }
}

/// An editable, in-memory proposal. Persisting it is deliberately the responsibility of a
/// separate confirmed creation mutation.
public struct EntityAutofillProposal: Hashable, Sendable {
  public var title: String?
  public var properties: [SupertagPropertyKey: [SupertagValue]]

  public init(
    title: String? = nil,
    properties: [SupertagPropertyKey: [SupertagValue]] = [:]
  ) {
    self.title = title
    self.properties = properties
  }
}

/// A raw proposal is useful at the boundary between an untrusted model response and local
/// validation. It must be validated before reaching a creation form or persistence mutation.
public struct EntityAutofillRawProposal: Hashable, Sendable {
  public var title: String?
  public var properties: [SupertagPropertyKey: [SupertagValue]]

  public init(
    title: String? = nil,
    properties: [SupertagPropertyKey: [SupertagValue]] = [:]
  ) {
    self.title = title
    self.properties = properties
  }
}

public enum EntityAutofillResult: Hashable, Sendable {
  case proposal(EntityAutofillProposal)
  /// The form remains fully manual. No fallback provider is attempted.
  case unavailable(AssistantAvailability)
  case failed(String)
}

/// Produces an unpersisted entity proposal. Implementations must treat every request as a new,
/// isolated interaction and must not add local or remote context to it.
public protocol EntityAutofillProviding: Sendable {
  func propose(_ request: EntityAutofillRequest) async -> EntityAutofillResult
}

public enum EntityAutofillValidationError: Error, Equatable, Sendable {
  case titleTooLong
  case unknownField
  case deletedField
  case crossSchemaField
  case entityReference
  case multipleValues
  case invalidValue
}

/// Local validation shared by suggestion handling and the later confirmed creation mutation.
/// It allows only the supplied live scalar fields, retaining inherited fields' original owners.
public enum EntityAutofillProposalValidator {
  public static let maximumTitleLength = 300
  public static let maximumScalarLength = 4_000

  public static func validate(
    _ rawProposal: EntityAutofillRawProposal,
    for schema: SupertagDefinition,
    effectiveFields: [SupertagEffectiveField]? = nil
  ) throws -> EntityAutofillProposal {
    let title = try validatedTitle(rawProposal.title)
    let allowedFields = effectiveFields ?? EntityAutofillRequest(
      schema: schema,
      userProvidedDetails: ""
    ).effectiveFields
    let fields = Dictionary(uniqueKeysWithValues: allowedFields.map { ($0.propertyKey, $0.definition) })
    var properties: [SupertagPropertyKey: [SupertagValue]] = [:]

    for (key, values) in rawProposal.properties {
      guard let field = fields[key] else {
        if key.supertagID != schema.id {
          throw EntityAutofillValidationError.crossSchemaField
        }
        throw EntityAutofillValidationError.unknownField
      }
      guard !field.isDeleted else {
        throw EntityAutofillValidationError.deletedField
      }
      guard field.type != .entityReference else {
        throw EntityAutofillValidationError.entityReference
      }
      guard field.allowsMultiple || values.count <= 1 else {
        throw EntityAutofillValidationError.multipleValues
      }
      guard !values.isEmpty else {
        throw EntityAutofillValidationError.invalidValue
      }
      properties[key] = try values.map { try validated($0, for: field) }
    }

    return EntityAutofillProposal(title: title, properties: properties)
  }

  private static func validatedTitle(_ title: String?) throws -> String? {
    guard let title else { return nil }
    let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard normalized.count <= maximumTitleLength else {
      throw EntityAutofillValidationError.titleTooLong
    }
    return normalized.isEmpty ? nil : normalized
  }

  private static func validated(
    _ value: SupertagValue,
    for field: SupertagFieldDefinition
  ) throws -> SupertagValue {
    switch (field.type, value) {
    case (.text, .text(let text)):
      return .text(try normalizedNonemptyScalar(text))
    case (.number, .number(let number)) where number.isFinite:
      return .number(number)
    case (.boolean, .boolean(let boolean)):
      return .boolean(boolean)
    case (.date, .date(let date)):
      return .date(date)
    case (.dateTime, .dateTime(let date)):
      return .dateTime(date)
    case (.select, .select(let option)) where field.options.contains(where: { $0.id == option }):
      return .select(option)
    case (.url, .url(let value)):
      let normalized = try normalizedNonemptyScalar(value)
      guard let url = URL(string: normalized),
        let scheme = url.scheme?.lowercased(),
        ["http", "https"].contains(scheme),
        url.host != nil
      else { throw EntityAutofillValidationError.invalidValue }
      return .url(normalized)
    case (.email, .email(let value)):
      do {
        return .email(try PersonEmail.normalize(value))
      } catch {
        throw EntityAutofillValidationError.invalidValue
      }
    case (.phone, .phone(let value)):
      let normalized = try normalizedNonemptyScalar(value)
      let digits = normalized.unicodeScalars.filter(CharacterSet.decimalDigits.contains)
      guard digits.count >= 3 else { throw EntityAutofillValidationError.invalidValue }
      return .phone(normalized)
    case (.entityReference, _), (_, .page):
      throw EntityAutofillValidationError.entityReference
    default:
      throw EntityAutofillValidationError.invalidValue
    }
  }

  private static func normalizedNonemptyScalar(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty,
      normalized.count <= maximumScalarLength,
      !normalized.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else { throw EntityAutofillValidationError.invalidValue }
    return normalized
  }
}

/// The exact, bounded model input shape. This type has no members for any local context.
struct EntityAutofillModelInput: Hashable, Sendable {
  struct Field: Hashable, Sendable {
    var supertagID: String
    var id: String
    var name: String
    var type: SupertagFieldType
    var allowsMultiple: Bool
    var options: [String]
  }

  var schemaID: String
  var schemaName: String
  var fields: [Field]
  var userProvidedDetails: String

  init(request: EntityAutofillRequest) {
    schemaID = request.schema.id.rawValue
    schemaName = request.schema.name
    fields = request.effectiveFields.compactMap { effectiveField in
      let field = effectiveField.definition
      guard !field.isDeleted, field.type != .entityReference else { return nil }
      return Field(
        supertagID: effectiveField.propertyKey.supertagID.rawValue,
        id: field.id.rawValue,
        name: field.name,
        type: field.type,
        allowsMultiple: field.allowsMultiple,
        options: field.options.map(\.id)
      )
    }
    userProvidedDetails = request.userProvidedDetails
  }
}
