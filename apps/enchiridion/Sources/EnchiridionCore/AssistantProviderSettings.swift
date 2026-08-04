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

public enum AssistantVoiceProvider: String, Codable, CaseIterable, Sendable {
  case appleOnDevice
  case openAIRealtime
  case qwenRealtime

  public var title: String {
    switch self {
    case .appleOnDevice: "Apple On Device"
    case .openAIRealtime: "OpenAI Realtime"
    case .qwenRealtime: "Qwen Audio Realtime"
    }
  }
}

public enum OpenAIRealtimeVoice: String, Codable, CaseIterable, Identifiable, Sendable {
  case alloy
  case ash
  case ballad
  case coral
  case echo
  case sage
  case shimmer
  case verse
  case marin
  case cedar

  public var id: String { rawValue }
  public var title: String { rawValue.capitalized }
}

public enum OpenAIRealtimeVoiceCatalog {
  public static let version = 20_260_731
  public static let preferredDefault: OpenAIRealtimeVoice = .marin
  public static let preferredAlternative: OpenAIRealtimeVoice = .cedar
  public static let reviewed: [OpenAIRealtimeVoice] = [
    .marin, .cedar, .alloy, .ash, .ballad, .coral, .echo, .sage, .shimmer, .verse,
  ]

  public static func contains(_ id: String) -> Bool {
    OpenAIRealtimeVoice(rawValue: id) != nil
  }
}

public enum OpenAIVoiceAuthorizationFailure: String, Equatable, Sendable {
  case credentialVerificationRequired
  case modelSelectionRequired
  case modelUnavailable
  case voiceUnavailable
}

/// Frozen authority for one voice session. A settings change can only affect a
/// later session and cannot silently reroute an already authorized microphone.
public struct RealtimeVoiceRouteSnapshot: Equatable, Sendable {
  private enum Authority: Equatable, Sendable {
    case preferencesStore
  }

  public let provider: AssistantVoiceProvider
  public let modelID: String?
  public let voiceID: String?
  public let credentialBinding: OpenAICredentialBinding?
  public let modelCatalogVersion: Int?
  public let voiceCatalogVersion: Int?
  public let authorizationFailure: OpenAIVoiceAuthorizationFailure?
  private let authority: Authority?

  private init(
    provider: AssistantVoiceProvider,
    modelID: String? = nil,
    voiceID: String? = nil,
    credentialBinding: OpenAICredentialBinding? = nil,
    modelCatalogVersion: Int? = nil,
    voiceCatalogVersion: Int? = nil,
    authorizationFailure: OpenAIVoiceAuthorizationFailure? = nil,
    authority: Authority? = nil
  ) {
    self.provider = provider
    self.modelID = modelID
    self.voiceID = voiceID
    self.credentialBinding = credentialBinding
    self.modelCatalogVersion = modelCatalogVersion
    self.voiceCatalogVersion = voiceCatalogVersion
    self.authorizationFailure = authorizationFailure
    self.authority = authority
  }

  public static func appleOnDevice() -> Self {
    Self(provider: .appleOnDevice)
  }

  public static func failedOpenAIRealtime(
    modelID: String? = nil,
    voiceID: String? = nil,
    failure: OpenAIVoiceAuthorizationFailure
  ) -> Self {
    Self(
      provider: .openAIRealtime,
      modelID: modelID,
      voiceID: voiceID,
      authorizationFailure: failure
    )
  }

  fileprivate static func authorizedOpenAIRealtime(
    modelID: String,
    voiceID: String,
    credentialBinding: OpenAICredentialBinding
  ) -> Self {
    Self(
      provider: .openAIRealtime,
      modelID: modelID,
      voiceID: voiceID,
      credentialBinding: credentialBinding,
      modelCatalogVersion: OpenAIModelCatalog.version,
      voiceCatalogVersion: OpenAIRealtimeVoiceCatalog.version,
      authority: .preferencesStore
    )
  }

  public var isAuthorizedOpenAIRealtime: Bool {
    provider == .openAIRealtime
      && authorizationFailure == nil
      && authority == .preferencesStore
      && modelCatalogVersion == OpenAIModelCatalog.version
      && voiceCatalogVersion == OpenAIRealtimeVoiceCatalog.version
      && modelID.map({ modelID in
        OpenAIModelCatalog.realtimeOptions.contains(where: { $0.id == modelID })
      }) == true
      && voiceID.map(OpenAIRealtimeVoiceCatalog.contains) == true
      && credentialBinding != nil
  }

  #if DEBUG || ENCHIRIDION_TESTING
    func replacingAuthorityVersionsForTesting(
      modelCatalogVersion: Int?,
      voiceCatalogVersion: Int?,
    ) -> Self {
      Self(
        provider: provider,
        modelID: modelID,
        voiceID: voiceID,
        credentialBinding: credentialBinding,
        modelCatalogVersion: modelCatalogVersion,
        voiceCatalogVersion: voiceCatalogVersion,
        authorizationFailure: authorizationFailure,
        authority: authority
      )
    }

    func removingAuthorityForTesting() -> Self {
      Self(
        provider: provider,
        modelID: modelID,
        voiceID: voiceID,
        credentialBinding: credentialBinding,
        modelCatalogVersion: modelCatalogVersion,
        voiceCatalogVersion: voiceCatalogVersion,
        authorizationFailure: authorizationFailure
      )
    }
  #endif
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
  public static let version = 20_260_804
  public static let preferredDefaultTextModelID = "gpt-5.6-terra"
  public static let preferredDefaultRealtimeModelID = "gpt-realtime-mini"

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
      id: "gpt-realtime-mini",
      title: "Efficient voice",
      detail: "Lower-cost OpenAI Realtime voice model.",
      capability: .realtime
    ),
    .init(
      id: "gpt-realtime",
      title: "Highest-capability voice",
      detail: "Full-capability OpenAI Realtime voice model.",
      capability: .realtime
    ),
  ]

  public static var textOptions: [OpenAIModelOption] {
    shipped.filter { $0.capability == .text }
  }

  public static var realtimeOptions: [OpenAIModelOption] {
    shipped.filter { $0.capability == .realtime }
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
  public var selectedVoiceProvider: AssistantVoiceProvider
  public var selectedRealtimeModelID: String?
  public var selectedRealtimeVoiceID: String?
  // Retained solely to decode payloads written by builds that required a
  // second voice-consent grant. Saving a verified Platform key is now the
  // complete voice opt-in, so new payloads deliberately omit these fields.
  public var voiceConsentVersion: Int?
  public var voiceConsentCredentialRevision: String?
  public var voiceConsentCredentialFingerprint: String?
  public var voiceConsentModelCatalogVersion: Int?
  public var voiceConsentVoiceCatalogVersion: Int?
  public var voiceConsentModelID: String?
  public var voiceConsentVoiceID: String?

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
    selectedVoiceProvider: AssistantVoiceProvider = .appleOnDevice,
    selectedRealtimeModelID: String? = nil,
    selectedRealtimeVoiceID: String? = OpenAIRealtimeVoiceCatalog.preferredDefault.id,
    voiceConsentVersion: Int? = nil,
    voiceConsentCredentialRevision: String? = nil,
    voiceConsentCredentialFingerprint: String? = nil,
    voiceConsentModelCatalogVersion: Int? = nil,
    voiceConsentVoiceCatalogVersion: Int? = nil,
    voiceConsentModelID: String? = nil,
    voiceConsentVoiceID: String? = nil
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
    self.selectedVoiceProvider = selectedVoiceProvider
    self.selectedRealtimeModelID = selectedRealtimeModelID
    self.selectedRealtimeVoiceID = selectedRealtimeVoiceID
    self.voiceConsentVersion = voiceConsentVersion
    self.voiceConsentCredentialRevision = voiceConsentCredentialRevision
    self.voiceConsentCredentialFingerprint = voiceConsentCredentialFingerprint
    self.voiceConsentModelCatalogVersion = voiceConsentModelCatalogVersion
    self.voiceConsentVoiceCatalogVersion = voiceConsentVoiceCatalogVersion
    self.voiceConsentModelID = voiceConsentModelID
    self.voiceConsentVoiceID = voiceConsentVoiceID
  }

  public static let defaults = AssistantProviderPreferencesPayload()

  private enum CodingKeys: String, CodingKey {
    case version
    case selectedProvider
    case credentialRevision
    case credentialFingerprint
    case verifiedCatalogVersion
    case verifiedTextModelIDs
    case verifiedRealtimeModelIDs
    case selectedTextModelID
    case textConsentVersion
    case textConsentCredentialRevision
    case textConsentCredentialFingerprint
    case selectedVoiceProvider
    case selectedRealtimeModelID
    case selectedRealtimeVoiceID
    case voiceConsentVersion
    case voiceConsentCredentialRevision
    case voiceConsentCredentialFingerprint
    case voiceConsentModelCatalogVersion
    case voiceConsentVoiceCatalogVersion
    case voiceConsentModelID
    case voiceConsentVoiceID
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    version = try container.decodeIfPresent(Int.self, forKey: .version) ?? Self.currentVersion
    selectedProvider =
      try container.decodeIfPresent(AssistantProvider.self, forKey: .selectedProvider)
      ?? .appleOnDevice
    credentialRevision = try container.decodeIfPresent(
      String.self, forKey: .credentialRevision)
    credentialFingerprint = try container.decodeIfPresent(
      String.self, forKey: .credentialFingerprint)
    verifiedCatalogVersion = try container.decodeIfPresent(
      Int.self, forKey: .verifiedCatalogVersion)
    verifiedTextModelIDs =
      try container.decodeIfPresent([String].self, forKey: .verifiedTextModelIDs) ?? []
    verifiedRealtimeModelIDs =
      try container.decodeIfPresent([String].self, forKey: .verifiedRealtimeModelIDs) ?? []
    selectedTextModelID = try container.decodeIfPresent(String.self, forKey: .selectedTextModelID)
    textConsentVersion = try container.decodeIfPresent(Int.self, forKey: .textConsentVersion)
    textConsentCredentialRevision = try container.decodeIfPresent(
      String.self, forKey: .textConsentCredentialRevision)
    textConsentCredentialFingerprint = try container.decodeIfPresent(
      String.self, forKey: .textConsentCredentialFingerprint)
    selectedVoiceProvider =
      try container.decodeIfPresent(AssistantVoiceProvider.self, forKey: .selectedVoiceProvider)
      ?? .appleOnDevice
    selectedRealtimeModelID = try container.decodeIfPresent(
      String.self, forKey: .selectedRealtimeModelID)
    selectedRealtimeVoiceID = container.contains(.selectedRealtimeVoiceID)
      ? try container.decodeIfPresent(String.self, forKey: .selectedRealtimeVoiceID)
      : OpenAIRealtimeVoiceCatalog.preferredDefault.id
    voiceConsentVersion = try container.decodeIfPresent(Int.self, forKey: .voiceConsentVersion)
    voiceConsentCredentialRevision = try container.decodeIfPresent(
      String.self, forKey: .voiceConsentCredentialRevision)
    voiceConsentCredentialFingerprint = try container.decodeIfPresent(
      String.self, forKey: .voiceConsentCredentialFingerprint)
    voiceConsentModelCatalogVersion = try container.decodeIfPresent(
      Int.self, forKey: .voiceConsentModelCatalogVersion)
    voiceConsentVoiceCatalogVersion = try container.decodeIfPresent(
      Int.self, forKey: .voiceConsentVoiceCatalogVersion)
    voiceConsentModelID = try container.decodeIfPresent(String.self, forKey: .voiceConsentModelID)
    voiceConsentVoiceID = try container.decodeIfPresent(String.self, forKey: .voiceConsentVoiceID)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(version, forKey: .version)
    try container.encode(selectedProvider, forKey: .selectedProvider)
    try container.encodeIfPresent(credentialRevision, forKey: .credentialRevision)
    try container.encodeIfPresent(credentialFingerprint, forKey: .credentialFingerprint)
    try container.encodeIfPresent(verifiedCatalogVersion, forKey: .verifiedCatalogVersion)
    try container.encode(verifiedTextModelIDs, forKey: .verifiedTextModelIDs)
    try container.encode(verifiedRealtimeModelIDs, forKey: .verifiedRealtimeModelIDs)
    try container.encodeIfPresent(selectedTextModelID, forKey: .selectedTextModelID)
    try container.encodeIfPresent(textConsentVersion, forKey: .textConsentVersion)
    try container.encodeIfPresent(
      textConsentCredentialRevision, forKey: .textConsentCredentialRevision)
    try container.encodeIfPresent(
      textConsentCredentialFingerprint, forKey: .textConsentCredentialFingerprint)
    try container.encode(selectedVoiceProvider, forKey: .selectedVoiceProvider)
    try container.encodeIfPresent(selectedRealtimeModelID, forKey: .selectedRealtimeModelID)
    try container.encodeIfPresent(selectedRealtimeVoiceID, forKey: .selectedRealtimeVoiceID)
    try container.encodeIfPresent(voiceConsentVersion, forKey: .voiceConsentVersion)
    try container.encodeIfPresent(
      voiceConsentCredentialRevision, forKey: .voiceConsentCredentialRevision)
    try container.encodeIfPresent(
      voiceConsentCredentialFingerprint, forKey: .voiceConsentCredentialFingerprint)
    try container.encodeIfPresent(
      voiceConsentModelCatalogVersion, forKey: .voiceConsentModelCatalogVersion)
    try container.encodeIfPresent(
      voiceConsentVoiceCatalogVersion, forKey: .voiceConsentVoiceCatalogVersion)
    try container.encodeIfPresent(voiceConsentModelID, forKey: .voiceConsentModelID)
    try container.encodeIfPresent(voiceConsentVoiceID, forKey: .voiceConsentVoiceID)
  }
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
  public var selectedVoiceProvider: AssistantVoiceProvider { payload.selectedVoiceProvider }
  public var selectedRealtimeModelID: String? { payload.selectedRealtimeModelID }
  public var selectedRealtimeVoice: OpenAIRealtimeVoice? {
    payload.selectedRealtimeVoiceID.flatMap(OpenAIRealtimeVoice.init(rawValue:))
  }
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

  public var verifiedRealtimeOptions: [OpenAIModelOption] {
    OpenAIModelCatalog.realtimeOptions.filter { verifiedRealtimeModelIDs.contains($0.id) }
  }

  public var hasValidSelectedTextModel: Bool {
    guard let selectedTextModelID = payload.selectedTextModelID else { return false }
    return wasVerifiedForCurrentCatalog
      && verifiedTextModelIDs.contains(selectedTextModelID)
      && OpenAIModelCatalog.textOptions.contains { $0.id == selectedTextModelID }
  }

  public var hasValidSelectedRealtimeModel: Bool {
    guard let selectedRealtimeModelID = payload.selectedRealtimeModelID else { return false }
    return wasVerifiedForCurrentCatalog
      && verifiedRealtimeModelIDs.contains(selectedRealtimeModelID)
      && OpenAIModelCatalog.realtimeOptions.contains { $0.id == selectedRealtimeModelID }
  }

  public var hasValidSelectedRealtimeVoice: Bool {
    guard let selectedRealtimeVoiceID = payload.selectedRealtimeVoiceID else { return false }
    return OpenAIRealtimeVoiceCatalog.contains(selectedRealtimeVoiceID)
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

  public func canSelectVoiceProvider(
    _ provider: AssistantVoiceProvider,
    hasSavedCredential: Bool
  ) -> Bool {
    switch provider {
    case .appleOnDevice:
      true
    case .openAIRealtime:
      hasSavedCredential
        && wasVerifiedForCurrentCatalog
        && hasValidSelectedRealtimeModel
        && hasValidSelectedRealtimeVoice
    case .qwenRealtime:
      // Qwen is independently configured and validated. Runtime checks its
      // frozen route and fails closed if it becomes unavailable.
      true
    }
  }

  public func selectVoiceProvider(
    _ provider: AssistantVoiceProvider,
    hasSavedCredential: Bool
  ) {
    payload.selectedVoiceProvider =
      canSelectVoiceProvider(provider, hasSavedCredential: hasSavedCredential)
      ? provider : .appleOnDevice
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

  public func selectRealtimeModel(id: String?) {
    guard
      let id,
      verifiedRealtimeModelIDs.contains(id),
      OpenAIModelCatalog.realtimeOptions.contains(where: { $0.id == id })
    else {
      payload.selectedRealtimeModelID = nil
      persist()
      return
    }
    payload.selectedRealtimeModelID = id
    persist()
  }

  public func selectRealtimeVoice(id: String?) {
    guard let id, OpenAIRealtimeVoiceCatalog.contains(id) else {
      payload.selectedRealtimeVoiceID = nil
      persist()
      return
    }
    payload.selectedRealtimeVoiceID = id
    persist()
  }

  public func markVerified(
    _ capabilities: OpenAIVerifiedCapabilities,
    binding: OpenAICredentialBinding,
    selectDefaultTextModel: Bool = false
  ) {
    guard capabilities.catalogVersion == OpenAIModelCatalog.version else { return }
    let previousSelection = payload.selectedTextModelID
    let previousRealtimeSelection = payload.selectedRealtimeModelID
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
    if let previousRealtimeSelection,
      verifiedRealtimeModelIDs.contains(previousRealtimeSelection)
    {
      payload.selectedRealtimeModelID = previousRealtimeSelection
    } else if selectDefaultTextModel,
      verifiedRealtimeModelIDs.contains(OpenAIModelCatalog.preferredDefaultRealtimeModelID)
    {
      payload.selectedRealtimeModelID = OpenAIModelCatalog.preferredDefaultRealtimeModelID
    } else {
      payload.selectedRealtimeModelID = nil
    }
    if !hasValidSelectedRealtimeVoice {
      payload.selectedRealtimeVoiceID = OpenAIRealtimeVoiceCatalog.preferredDefault.id
    }
    persist()
  }

  public func markNeedsVerification() {
    let selectedProvider = payload.selectedProvider
    let selectedVoiceProvider = payload.selectedVoiceProvider
    payload.credentialRevision = nil
    payload.credentialFingerprint = nil
    payload.verifiedCatalogVersion = nil
    payload.verifiedTextModelIDs = []
    payload.verifiedRealtimeModelIDs = []
    payload.selectedTextModelID = nil
    payload.selectedRealtimeModelID = nil
    payload.selectedProvider = selectedProvider
    payload.selectedVoiceProvider = selectedVoiceProvider
    persist()
  }

  public func reconcileCredentialPresence(_ hasSavedCredential: Bool) {
    guard !hasSavedCredential else { return }
    resetAfterCredentialDeletion()
  }

  public func resetAfterCredentialDeletion() {
    let selectedProvider = payload.selectedProvider
    let selectedVoiceProvider = payload.selectedVoiceProvider
    payload = .defaults
    payload.selectedProvider = selectedProvider
    payload.selectedVoiceProvider = selectedVoiceProvider
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

  public func voiceRouteSnapshot() -> RealtimeVoiceRouteSnapshot {
    guard payload.selectedVoiceProvider == .openAIRealtime else {
      return .appleOnDevice()
    }
    guard wasVerifiedForCurrentCatalog,
      let revision = payload.credentialRevision,
      let fingerprint = payload.credentialFingerprint
    else {
      return .failedOpenAIRealtime(
        modelID: payload.selectedRealtimeModelID,
        voiceID: payload.selectedRealtimeVoiceID,
        failure: .credentialVerificationRequired
      )
    }
    guard let modelID = payload.selectedRealtimeModelID else {
      return .failedOpenAIRealtime(
        voiceID: payload.selectedRealtimeVoiceID,
        failure: .modelSelectionRequired
      )
    }
    guard verifiedRealtimeModelIDs.contains(modelID),
      OpenAIModelCatalog.realtimeOptions.contains(where: { $0.id == modelID })
    else {
      return .failedOpenAIRealtime(
        modelID: modelID,
        voiceID: payload.selectedRealtimeVoiceID,
        failure: .modelUnavailable
      )
    }
    guard let voiceID = payload.selectedRealtimeVoiceID,
      OpenAIRealtimeVoiceCatalog.contains(voiceID)
    else {
      return .failedOpenAIRealtime(
        modelID: modelID,
        failure: .voiceUnavailable
      )
    }
    return .authorizedOpenAIRealtime(
      modelID: modelID,
      voiceID: voiceID,
      credentialBinding: OpenAICredentialBinding(
        revision: revision,
        fingerprint: fingerprint
      )
    )
  }

  var storedPayloadForTesting: AssistantProviderPreferencesPayload { payload }

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
    if let selected = payload.selectedRealtimeModelID,
      !payload.verifiedRealtimeModelIDs.contains(selected)
    {
      payload.selectedRealtimeModelID = nil
    }
    if let selected = payload.selectedRealtimeVoiceID,
      !OpenAIRealtimeVoiceCatalog.contains(selected)
    {
      payload.selectedRealtimeVoiceID = nil
    }
    persist()
  }

  private func persist() {
    guard let data = try? encoder.encode(payload) else { return }
    defaults.set(data, forKey: key)
  }
}
