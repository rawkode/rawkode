import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// An on-device-only entity autofill provider. Each call creates a new language-model session;
/// no transcript, tool, repository, cloud fallback, or provider settings are involved.
public actor FoundationModelEntityAutofill: EntityAutofillProviding {
  private let availabilityProvider: @Sendable (Locale) -> AssistantAvailability
  private let generator: (any EntityAutofillGenerating)?

  public init() {
    availabilityProvider = Self.availability(for:)
    generator = nil
  }

  init(
    availabilityProvider: @escaping @Sendable (Locale) -> AssistantAvailability,
    generator: (any EntityAutofillGenerating)? = nil
  ) {
    self.availabilityProvider = availabilityProvider
    self.generator = generator
  }

  public nonisolated static func availability(for locale: Locale = .current) -> AssistantAvailability {
#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      let model = SystemLanguageModel.default
      guard model.supportsLocale(locale) else { return .unsupportedLanguage }
      switch model.availability {
      case .available:
        return .available
      case .unavailable(.deviceNotEligible):
        return .deviceNotEligible
      case .unavailable(.appleIntelligenceNotEnabled):
        return .appleIntelligenceNotEnabled
      case .unavailable(.modelNotReady):
        return .modelNotReady
      @unknown default:
        return .modelNotReady
      }
    }
#endif
    return .unsupportedOperatingSystem
  }

  public func propose(_ request: EntityAutofillRequest) async -> EntityAutofillResult {
    let availability = availabilityProvider(.current)
    guard availability == .available else { return .unavailable(availability) }
    guard !request.userProvidedDetails.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return .failed("Add details before asking for suggestions.")
    }

    do {
      let rawProposal: EntityAutofillRawProposal
      if let generator {
        rawProposal = try await generator.generate(EntityAutofillModelInput(request: request))
      } else {
        rawProposal = try await Self.generateWithFoundationModel(request: request)
      }
      return .proposal(
        try EntityAutofillProposalValidator.validate(
          rawProposal,
          for: request.schema,
          effectiveFields: request.effectiveFields
        )
      )
    } catch is CancellationError {
      return .failed("Suggestions were cancelled.")
    } catch is EntityAutofillValidationError {
      return .failed("The on-device model returned unsupported details. Review the form manually.")
    } catch {
      return .failed("The on-device model couldn't suggest details. You can still complete the form manually.")
    }
  }

  private static func generateWithFoundationModel(
    request: EntityAutofillRequest
  ) async throws -> EntityAutofillRawProposal {
#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      let input = EntityAutofillModelInput(request: request)
      // A session is intentionally created for this one request only. It has no tools and no
      // previous messages, so the sole model input is `EntityAutofillModelInput`.
      let session = LanguageModelSession(
        model: SystemLanguageModel.default,
        instructions: """
          Extract an optional title and scalar property values for one new Enchiridion entity.
          Use only the provided details and the supplied field list. Do not infer relationships,
          pages, people, organizations, calendar events, or any information not present in the
          details. Omit fields when the details do not support a confident value. Select values
          must use an exact supplied option ID. Dates must be ISO 8601 with an explicit offset.
          """
      )
      let response = try await session.respond(
        to: EntityAutofillPromptSerializer.serialize(input),
        generating: FoundationEntityAutofillOutput.self,
        options: GenerationOptions(temperature: 0, maximumResponseTokens: 700)
      )
      return try response.content.rawProposal(for: request.effectiveFields)
    }
#endif
    throw EntityAutofillGenerationError.unavailable
  }
}

protocol EntityAutofillGenerating: Sendable {
  func generate(_ input: EntityAutofillModelInput) async throws -> EntityAutofillRawProposal
}

private enum EntityAutofillGenerationError: Error {
  case unavailable
}

enum EntityAutofillPromptSerializer {
  static func serialize(_ input: EntityAutofillModelInput) -> String {
    let fields = input.fields.map { field in
      let options = field.options.isEmpty ? "" : ", options: \(field.options.joined(separator: ","))"
      return "- supertagID: \(field.supertagID), fieldID: \(field.id), name: \(field.name), type: \(field.type.rawValue), multiple: \(field.allowsMultiple)\(options)"
    }.joined(separator: "\n")

    return """
      Entity schema ID: \(input.schemaID)
      Entity schema name: \(input.schemaName)
      Allowed scalar fields:
      \(fields.isEmpty ? "(none)" : fields)
      User-provided details, exact text:
      \(input.userProvidedDetails)
      """
  }
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
@Generable(description: "A draft for one typed entity, based only on the supplied details")
private struct FoundationEntityAutofillOutput {
  @Guide(description: "A concise entity title, or an empty string when absent")
  var title: String
  @Guide(description: "Only properties from the supplied scalar field list")
  var properties: [FoundationEntityAutofillProperty]

  func rawProposal(for effectiveFields: [SupertagEffectiveField]) throws -> EntityAutofillRawProposal {
    let fields = Dictionary(uniqueKeysWithValues: effectiveFields.map {
      ($0.propertyKey, $0.definition)
    })
    var proposedProperties: [SupertagPropertyKey: [SupertagValue]] = [:]
    for property in self.properties {
      let fieldID = SupertagFieldID(rawValue: property.fieldID)
      let key = SupertagPropertyKey(supertagID: SupertagID(rawValue: property.supertagID), fieldID: fieldID)
      let field = fields[key]
      let value = try property.value(for: field?.type)
      proposedProperties[key, default: []].append(value)
    }
    return EntityAutofillRawProposal(title: title, properties: proposedProperties)
  }
}

@available(iOS 26.0, macOS 26.0, *)
@Generable(description: "One scalar entity property")
private struct FoundationEntityAutofillProperty {
  @Guide(description: "The exact schema ID supplied in the prompt")
  var supertagID: String
  @Guide(description: "The exact field ID supplied in the prompt")
  var fieldID: String
  @Guide(description: "The scalar value encoded as text, ISO 8601 for dates")
  var value: String

  func value(for fieldType: SupertagFieldType?) throws -> SupertagValue {
    switch fieldType {
    case .text:
      return .text(value)
    case .number:
      guard let number = Double(value) else { throw EntityAutofillGenerationError.unavailable }
      return .number(number)
    case .boolean:
      guard let boolean = Bool(value.lowercased()) else { throw EntityAutofillGenerationError.unavailable }
      return .boolean(boolean)
    case .date:
      guard let date = ISO8601DateFormatter().date(from: value) else {
        throw EntityAutofillGenerationError.unavailable
      }
      return .date(date)
    case .dateTime:
      guard let date = ISO8601DateFormatter().date(from: value) else {
        throw EntityAutofillGenerationError.unavailable
      }
      return .dateTime(date)
    case .select:
      return .select(value)
    case .url:
      return .url(value)
    case .email:
      return .email(value)
    case .phone:
      return .phone(value)
    case .entityReference, .none:
      return .text(value)
    }
  }
}
#endif
