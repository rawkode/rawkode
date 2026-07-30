import Foundation

public enum AssistantProvider: String, Codable, CaseIterable, Sendable {
  case appleOnDevice
  case openAI

  public var title: String {
    switch self {
    case .appleOnDevice: "Apple On Device"
    case .openAI: "OpenAI"
    }
  }

  public var futureSettingsTitle: String {
    title
  }
}

public enum OpenAITextAuthorizationFailure: String, Equatable, Sendable {
  case consentRequired
  case credentialVerificationRequired
  case modelSelectionRequired
  case modelUnavailable
}

public struct AssistantTextRouteSnapshot: Equatable, Sendable {
  public let provider: AssistantProvider
  public let modelID: String?
  public let credentialBinding: OpenAICredentialBinding?
  public let authorizationFailure: OpenAITextAuthorizationFailure?

  public init(
    provider: AssistantProvider,
    modelID: String? = nil,
    credentialBinding: OpenAICredentialBinding? = nil,
    authorizationFailure: OpenAITextAuthorizationFailure? = nil
  ) {
    self.provider = provider
    self.modelID = modelID
    self.credentialBinding = credentialBinding
    self.authorizationFailure = authorizationFailure
  }
}

public enum OpenAICredentialState: String, Equatable, Sendable {
  case notConfigured
  case savedAndVerified
  case needsVerification

  public var title: String {
    switch self {
    case .notConfigured: "Not configured"
    case .savedAndVerified: "Saved and verified"
    case .needsVerification: "Needs verification"
    }
  }
}

public enum OpenAIModelCapability: String, Codable, Sendable {
  case text
  case realtime
}

public struct OpenAIModelOption: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let title: String
  public let detail: String
  public let capability: OpenAIModelCapability

  public init(
    id: String,
    title: String,
    detail: String,
    capability: OpenAIModelCapability
  ) {
    self.id = id
    self.title = title
    self.detail = detail
    self.capability = capability
  }
}

public struct OpenAIVerifiedCapabilities: Equatable, Sendable {
  public let catalogVersion: Int
  public let textModelIDs: Set<String>
  public let realtimeModelIDs: Set<String>

  public init(
    catalogVersion: Int,
    textModelIDs: Set<String>,
    realtimeModelIDs: Set<String>
  ) {
    self.catalogVersion = catalogVersion
    self.textModelIDs = textModelIDs
    self.realtimeModelIDs = realtimeModelIDs
  }
}

public enum OpenAIModelCatalog {
  // Increment whenever model capability claims are reviewed and changed.
  public static let version = 20_260_730
  public static let preferredDefaultTextModelID = "gpt-5.6-terra"

  public static let shipped: [OpenAIModelOption] = [
    .init(
      id: "gpt-5.6-luna",
      title: "Economy",
      detail: "Lower-cost text tier for focused requests.",
      capability: .text
    ),
    .init(
      id: "gpt-5.6-terra",
      title: "Balanced",
      detail: "Balances capability and API cost.",
      capability: .text
    ),
    .init(
      id: "gpt-5.6-sol",
      title: "Best",
      detail: "Frontier text tier with the highest API cost in this catalog.",
      capability: .text
    ),
    .init(
      id: "gpt-realtime-2.1-mini",
      title: "Efficient voice",
      detail: "Reserved for a future Realtime implementation.",
      capability: .realtime
    ),
    .init(
      id: "gpt-realtime-2.1",
      title: "Highest-capability voice",
      detail: "Reserved for a future Realtime implementation.",
      capability: .realtime
    ),
  ]

  public static var textOptions: [OpenAIModelOption] {
    shipped.filter { $0.capability == .text }
  }

  public static func intersect(availableModelIDs: Set<String>) -> OpenAIVerifiedCapabilities {
    OpenAIVerifiedCapabilities(
      catalogVersion: version,
      textModelIDs: Set(
        shipped.lazy
          .filter { $0.capability == .text && availableModelIDs.contains($0.id) }
          .map(\.id)
      ),
      realtimeModelIDs: Set(
        shipped.lazy
          .filter { $0.capability == .realtime && availableModelIDs.contains($0.id) }
          .map(\.id)
      )
    )
  }
}

public struct AssistantProviderPreferencesPayload: Codable, Equatable, Sendable {
  public static let currentVersion = 3
  public static let currentTextConsentVersion = 2
  public static let currentVoiceConsentVersion = 1

  public var version: Int
  public var selectedProvider: AssistantProvider
  public var credentialRevision: String?
  public var credentialFingerprint: String?
  public var verifiedCatalogVersion: Int?
  public var verifiedTextModelIDs: [String]
  public var verifiedRealtimeModelIDs: [String]
  public var selectedTextModelID: String?
  public var textConsentVersion: Int?
  public var textConsentCredentialRevision: String?
  public var textConsentCredentialFingerprint: String?
  public var voiceConsentVersion: Int?

  public init(
    version: Int = currentVersion,
    selectedProvider: AssistantProvider = .appleOnDevice,
    credentialRevision: String? = nil,
    credentialFingerprint: String? = nil,
    verifiedCatalogVersion: Int? = nil,
    verifiedTextModelIDs: [String] = [],
    verifiedRealtimeModelIDs: [String] = [],
    selectedTextModelID: String? = nil,
    textConsentVersion: Int? = nil,
    textConsentCredentialRevision: String? = nil,
    textConsentCredentialFingerprint: String? = nil,
    voiceConsentVersion: Int? = nil
  ) {
    self.version = version
    self.selectedProvider = selectedProvider
    self.credentialRevision = credentialRevision
    self.credentialFingerprint = credentialFingerprint
    self.verifiedCatalogVersion = verifiedCatalogVersion
    self.verifiedTextModelIDs = verifiedTextModelIDs
    self.verifiedRealtimeModelIDs = verifiedRealtimeModelIDs
    self.selectedTextModelID = selectedTextModelID
    self.textConsentVersion = textConsentVersion
    self.textConsentCredentialRevision = textConsentCredentialRevision
    self.textConsentCredentialFingerprint = textConsentCredentialFingerprint
    self.voiceConsentVersion = voiceConsentVersion
  }

  public static let defaults = AssistantProviderPreferencesPayload()
}

@MainActor
public final class AssistantProviderPreferencesStore {
  public static let defaultKey = "assistant.provider.preferences.v1"

  private let defaults: UserDefaults
  private let key: String
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private var payload: AssistantProviderPreferencesPayload

  public init(defaults: UserDefaults = .standard, key: String = defaultKey) {
    self.defaults = defaults
    self.key = key
    payload = Self.load(from: defaults, key: key, decoder: decoder)
    reconcileCatalogVersion()
  }

  public var selectedProvider: AssistantProvider { payload.selectedProvider }
  public var selectedTextModelID: String? { payload.selectedTextModelID }
  public var hasCurrentTextConsent: Bool {
    payload.textConsentVersion == AssistantProviderPreferencesPayload.currentTextConsentVersion
      && payload.textConsentCredentialRevision == payload.credentialRevision
      && payload.textConsentCredentialFingerprint == payload.credentialFingerprint
      && payload.credentialRevision != nil
      && payload.credentialFingerprint != nil
  }
  public var wasVerifiedForCurrentCatalog: Bool {
    payload.credentialRevision != nil
      && payload.credentialFingerprint != nil
      && payload.verifiedCatalogVersion == OpenAIModelCatalog.version
  }
  public var verifiedTextModelIDs: Set<String> { Set(payload.verifiedTextModelIDs) }
  public var verifiedRealtimeModelIDs: Set<String> { Set(payload.verifiedRealtimeModelIDs) }

  public var verifiedTextOptions: [OpenAIModelOption] {
    OpenAIModelCatalog.textOptions.filter { verifiedTextModelIDs.contains($0.id) }
  }

  public var hasValidSelectedTextModel: Bool {
    guard let selectedTextModelID = payload.selectedTextModelID else { return false }
    return wasVerifiedForCurrentCatalog
      && verifiedTextModelIDs.contains(selectedTextModelID)
      && OpenAIModelCatalog.textOptions.contains { $0.id == selectedTextModelID }
  }

  public func credentialState(matching binding: OpenAICredentialBinding) -> OpenAICredentialState {
    credentialBindingMatches(binding) && wasVerifiedForCurrentCatalog
      ? .savedAndVerified : .needsVerification
  }

  public func credentialBindingMatches(_ binding: OpenAICredentialBinding) -> Bool {
    payload.credentialRevision == binding.revision
      && payload.credentialFingerprint == binding.fingerprint
  }

  public func canSelect(_ provider: AssistantProvider, hasSavedCredential: Bool) -> Bool {
    switch provider {
    case .appleOnDevice:
      true
    case .openAI:
      hasSavedCredential
        && wasVerifiedForCurrentCatalog
        && hasCurrentTextConsent
        && hasValidSelectedTextModel
    }
  }

  public func selectProvider(_ provider: AssistantProvider, hasSavedCredential: Bool) {
    payload.selectedProvider =
      canSelect(provider, hasSavedCredential: hasSavedCredential) ? provider : .appleOnDevice
    persist()
  }

  public func setTextConsent(_ isGranted: Bool) {
    payload.textConsentVersion =
      isGranted
      ? AssistantProviderPreferencesPayload.currentTextConsentVersion : nil
    payload.textConsentCredentialRevision = isGranted ? payload.credentialRevision : nil
    payload.textConsentCredentialFingerprint = isGranted ? payload.credentialFingerprint : nil
    persist()
  }

  public func selectTextModel(id: String?) {
    guard
      let id,
      verifiedTextModelIDs.contains(id),
      OpenAIModelCatalog.textOptions.contains(where: { $0.id == id })
    else {
      payload.selectedTextModelID = nil
      persist()
      return
    }
    payload.selectedTextModelID = id
    persist()
  }

  public func markVerified(
    _ capabilities: OpenAIVerifiedCapabilities,
    binding: OpenAICredentialBinding,
    selectDefaultTextModel: Bool = false
  ) {
    guard capabilities.catalogVersion == OpenAIModelCatalog.version else { return }
    let previousSelection = payload.selectedTextModelID
    let shippedTextIDs = Set(OpenAIModelCatalog.textOptions.map(\.id))
    let shippedRealtimeIDs = Set(
      OpenAIModelCatalog.shipped.lazy.filter { $0.capability == .realtime }.map(\.id)
    )
    let verifiedTextModelIDs = capabilities.textModelIDs.intersection(shippedTextIDs)
    let verifiedRealtimeModelIDs = capabilities.realtimeModelIDs.intersection(shippedRealtimeIDs)
    payload.credentialRevision = binding.revision
    payload.credentialFingerprint = binding.fingerprint
    payload.verifiedCatalogVersion = capabilities.catalogVersion
    payload.verifiedTextModelIDs = verifiedTextModelIDs.sorted()
    payload.verifiedRealtimeModelIDs = verifiedRealtimeModelIDs.sorted()

    if let previousSelection, verifiedTextModelIDs.contains(previousSelection) {
      payload.selectedTextModelID = previousSelection
    } else if selectDefaultTextModel,
      verifiedTextModelIDs.contains(OpenAIModelCatalog.preferredDefaultTextModelID)
    {
      payload.selectedTextModelID = OpenAIModelCatalog.preferredDefaultTextModelID
    } else {
      payload.selectedTextModelID = nil
    }
    persist()
  }

  public func markNeedsVerification() {
    let selectedProvider = payload.selectedProvider
    payload.credentialRevision = nil
    payload.credentialFingerprint = nil
    payload.verifiedCatalogVersion = nil
    payload.verifiedTextModelIDs = []
    payload.verifiedRealtimeModelIDs = []
    payload.selectedTextModelID = nil
    payload.selectedProvider = selectedProvider
    persist()
  }

  public func reconcileCredentialPresence(_ hasSavedCredential: Bool) {
    guard !hasSavedCredential else { return }
    resetAfterCredentialDeletion()
  }

  public func resetAfterCredentialDeletion() {
    let selectedProvider = payload.selectedProvider
    payload = .defaults
    payload.selectedProvider = selectedProvider
    persist()
  }

  public func textRouteSnapshot(
    for routeOverride: AssistantConversationRoute? = nil
  ) -> AssistantTextRouteSnapshot {
    let requestedProvider =
      routeOverride?.provider
      ?? (payload.selectedProvider == .openAI ? .openAI : .appleOnDevice)
    guard requestedProvider == .openAI else {
      return AssistantTextRouteSnapshot(provider: .appleOnDevice)
    }
    let requestedModelID = routeOverride?.modelID ?? payload.selectedTextModelID
    guard hasCurrentTextConsent else {
      return AssistantTextRouteSnapshot(
        provider: .openAI,
        modelID: requestedModelID,
        authorizationFailure: .consentRequired
      )
    }
    guard wasVerifiedForCurrentCatalog,
      let revision = payload.credentialRevision,
      let fingerprint = payload.credentialFingerprint
    else {
      return AssistantTextRouteSnapshot(
        provider: .openAI,
        modelID: requestedModelID,
        authorizationFailure: .credentialVerificationRequired
      )
    }
    guard let modelID = requestedModelID else {
      return AssistantTextRouteSnapshot(
        provider: .openAI,
        authorizationFailure: .modelSelectionRequired
      )
    }
    guard verifiedTextModelIDs.contains(modelID),
      OpenAIModelCatalog.textOptions.contains(where: { $0.id == modelID })
    else {
      return AssistantTextRouteSnapshot(
        provider: .openAI,
        modelID: modelID,
        authorizationFailure: .modelUnavailable
      )
    }
    return AssistantTextRouteSnapshot(
      provider: .openAI,
      modelID: modelID,
      credentialBinding: OpenAICredentialBinding(
        revision: revision,
        fingerprint: fingerprint
      )
    )
  }

  public var storedPayloadForTesting: AssistantProviderPreferencesPayload { payload }

  private static func load(
    from defaults: UserDefaults,
    key: String,
    decoder: JSONDecoder
  ) -> AssistantProviderPreferencesPayload {
    guard
      let data = defaults.data(forKey: key),
      let payload = try? decoder.decode(AssistantProviderPreferencesPayload.self, from: data),
      payload.version == AssistantProviderPreferencesPayload.currentVersion
    else {
      return .defaults
    }
    return payload
  }

  private func reconcileCatalogVersion() {
    guard
      payload.verifiedCatalogVersion == nil
        || payload.verifiedCatalogVersion == OpenAIModelCatalog.version
    else {
      markNeedsVerification()
      return
    }

    let shippedTextIDs = Set(OpenAIModelCatalog.textOptions.map(\.id))
    let shippedRealtimeIDs = Set(
      OpenAIModelCatalog.shipped.lazy.filter { $0.capability == .realtime }.map(\.id)
    )
    payload.verifiedTextModelIDs = payload.verifiedTextModelIDs.filter(shippedTextIDs.contains)
    payload.verifiedRealtimeModelIDs = payload.verifiedRealtimeModelIDs.filter(
      shippedRealtimeIDs.contains)
    if let selected = payload.selectedTextModelID,
      !payload.verifiedTextModelIDs.contains(selected)
    {
      payload.selectedTextModelID = nil
    }
    persist()
  }

  private func persist() {
    guard let data = try? encoder.encode(payload) else { return }
    defaults.set(data, forKey: key)
  }
}
