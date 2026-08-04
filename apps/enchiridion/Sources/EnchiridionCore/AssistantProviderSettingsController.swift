import Foundation
import Observation

public enum AssistantProviderSettingsError: Equatable, Sendable {
  case passcodeRequired
  case credentialRejected(requestID: String?)
  case permissionDenied(requestID: String?)
  case rateLimited(retryAfterSeconds: Int?, requestID: String?)
  case redirectBlocked
  case networkUnavailable
  case timedOut
  case invalidResponse(requestID: String?)
  case serviceUnavailable(requestID: String?)
  case credentialStorageUnavailable

  public var title: String {
    switch self {
    case .passcodeRequired: "Device passcode required"
    case .credentialRejected: "Key not accepted"
    case .permissionDenied: "Project access denied"
    case .rateLimited: "Rate limit reached"
    case .redirectBlocked: "Unexpected redirect blocked"
    case .networkUnavailable: "Network unavailable"
    case .timedOut: "Verification timed out"
    case .invalidResponse: "Unexpected verification response"
    case .serviceUnavailable: "OpenAI unavailable"
    case .credentialStorageUnavailable: "Keychain unavailable"
    }
  }

  public var detail: String {
    switch self {
    case .passcodeRequired:
      "Set a device passcode before saving this key."
    case .credentialRejected:
      "Check the key and its project, then try again."
    case .permissionDenied:
      "This key cannot list models for its OpenAI project."
    case .rateLimited(let seconds, _):
      if let seconds { "Try again in \(seconds) seconds." } else { "Wait, then try again." }
    case .redirectBlocked:
      "Enchiridion only verifies against OpenAI's exact models endpoint."
    case .networkUnavailable:
      "Reconnect to the internet, then try again."
    case .timedOut:
      "The verification request did not finish in time."
    case .invalidResponse:
      "OpenAI returned data Enchiridion could not verify."
    case .serviceUnavailable:
      "OpenAI could not complete verification. Try again later."
    case .credentialStorageUnavailable:
      "The key could not be changed in this device's Keychain."
    }
  }

  public var requestID: String? {
    switch self {
    case .credentialRejected(let id), .permissionDenied(let id), .rateLimited(_, let id),
      .invalidResponse(let id), .serviceUnavailable(let id):
      id
    default:
      nil
    }
  }
}

public protocol OpenAICredentialPersisting: Sendable {
  func readBinding(generation: UInt64) async throws -> OpenAICredentialReadOutcome
  func revalidateSavedCredential(generation: UInt64) async throws -> OpenAICredentialRevalidationOutcome
  func replace(
    with credential: String,
    generation: UInt64
  ) async throws -> OpenAICredentialMutationOutcome
  func deleteCredential(generation: UInt64) async throws -> OpenAICredentialMutationOutcome
}

public extension OpenAICredentialPersisting {
  func revalidateSavedCredential(generation: UInt64) async throws -> OpenAICredentialRevalidationOutcome {
    // Test doubles and alternate stores must opt in explicitly before they can
    // revalidate. The production Keychain actor supplies the secure path.
    .superseded
  }
}

extension OpenAICredentialStore: OpenAICredentialPersisting {}

public protocol OpenAICredentialValidating: Sendable {
  func validate(credential: String) async throws -> OpenAIValidationResult
}

extension OpenAIModelsValidator: OpenAICredentialValidating {}

@MainActor
@Observable
public final class AssistantProviderSettingsController {
  public private(set) var hasSavedCredential = false
  public private(set) var credentialState: OpenAICredentialState = .notConfigured
  public private(set) var isValidating = false
  public private(set) var error: AssistantProviderSettingsError?
  public private(set) var lastRequestID: String?
  public private(set) var retryUntil: Date?
  public private(set) var selectedProvider: AssistantProvider
  public private(set) var selectedTextModelID: String?
  public private(set) var verifiedTextOptions: [OpenAIModelOption]
  public private(set) var hasTextConsent: Bool
  public private(set) var selectedVoiceProvider: AssistantVoiceProvider
  public private(set) var selectedRealtimeModelID: String?
  public private(set) var selectedRealtimeVoice: OpenAIRealtimeVoice?
  public private(set) var verifiedRealtimeOptions: [OpenAIModelOption]
  public private(set) var isCredentialStateResolved = false

  private let preferences: AssistantProviderPreferencesStore
  private let credentialStore: any OpenAICredentialPersisting
  private let validator: any OpenAICredentialValidating
  private var generation: UInt64 = 0
  private var validationTask: Task<OpenAIValidationResult, Error>?

  public init(
    preferences: AssistantProviderPreferencesStore = AssistantProviderPreferencesStore(),
    credentialStore: any OpenAICredentialPersisting = OpenAICredentialStore(),
    validator: any OpenAICredentialValidating = OpenAIModelsValidator()
  ) {
    self.preferences = preferences
    self.credentialStore = credentialStore
    self.validator = validator
    selectedProvider = preferences.selectedProvider
    selectedTextModelID = preferences.selectedTextModelID
    verifiedTextOptions = preferences.verifiedTextOptions
    hasTextConsent = preferences.hasCurrentTextConsent
    selectedVoiceProvider = preferences.selectedVoiceProvider
    selectedRealtimeModelID = preferences.selectedRealtimeModelID
    selectedRealtimeVoice = preferences.selectedRealtimeVoice
    verifiedRealtimeOptions = preferences.verifiedRealtimeOptions
  }

  public var canSelectOpenAI: Bool {
    preferences.canSelect(.openAI, hasSavedCredential: hasSavedCredential)
  }

  public var canSelectOpenAIRealtimeVoice: Bool {
    preferences.canSelectVoiceProvider(
      .openAIRealtime,
      hasSavedCredential: hasSavedCredential
    )
  }

  public func retrySecondsRemaining(at date: Date = Date()) -> Int? {
    guard let retryUntil else { return nil }
    let interval = retryUntil.timeIntervalSince(date)
    guard interval > 0 else { return nil }
    return Int(interval.rounded(.up))
  }

  public func refreshCredentialState() async {
    generation += 1
    let operationGeneration = generation
    validationTask?.cancel()
    validationTask = nil
    isValidating = false
    isCredentialStateResolved = false
    do {
      let outcome = try await credentialStore.readBinding(generation: operationGeneration)
      guard operationGeneration == generation else { return }
      switch outcome {
      case .available(let binding):
        hasSavedCredential = true
        if preferences.credentialBindingMatches(binding) {
          credentialState = preferences.credentialState(matching: binding)
        } else {
          persistAndPublishVerificationFallback(hasSavedCredential: true)
          isCredentialStateResolved = true
          return
        }
      case .missing:
        persistAndPublishMissingCredentialFallback()
        isCredentialStateResolved = true
        return
      case .invalid:
        persistAndPublishVerificationFallback(hasSavedCredential: true)
        isCredentialStateResolved = true
        return
      case .superseded:
        return
      }
      error = nil
      synchronizePreferences()
      isCredentialStateResolved = true
    } catch {
      guard operationGeneration == generation else { return }
      persistAndPublishVerificationFallback(hasSavedCredential: false)
      self.error = .credentialStorageUnavailable
      isCredentialStateResolved = true
    }
  }

  @discardableResult
  public func verifyAndSave(candidate: String) async -> Bool {
    let candidate = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !candidate.isEmpty else {
      error = .credentialRejected(requestID: nil)
      return false
    }

    generation += 1
    let operationGeneration = generation
    validationTask?.cancel()
    error = nil
    lastRequestID = nil
    retryUntil = nil
    isValidating = true

    let task = Task { try await validator.validate(credential: candidate) }
    validationTask = task

    do {
      let result = try await task.value
      guard operationGeneration == generation else { return false }
      let mutation = try await credentialStore.replace(
        with: candidate,
        generation: operationGeneration
      )
      guard operationGeneration == generation else { return false }
      let binding: OpenAICredentialBinding
      let shouldSelectDefaultTextModel: Bool
      switch mutation {
      case .inserted(let storedBinding):
        binding = storedBinding
        shouldSelectDefaultTextModel = true
      case .replaced(let storedBinding):
        binding = storedBinding
        shouldSelectDefaultTextModel = false
      case .deleted, .superseded:
        return false
      }
      preferences.markVerified(
        result.capabilities,
        binding: binding,
        selectPreferredTextModel: shouldSelectDefaultTextModel,
        // First explicit save is the user's single OpenAI Voice opt-in. A key
        // replacement and saved-key recheck must never override Apple.
        activateOpenAIVoice: {
          if case .inserted = mutation { return true }
          return false
        }()
      )
      hasSavedCredential = true
      credentialState = .savedAndVerified
      synchronizePreferences()
      lastRequestID = result.requestID
      retryUntil = nil
      isValidating = false
      validationTask = nil
      isCredentialStateResolved = true
      return true
    } catch is CancellationError {
      guard operationGeneration == generation else { return false }
      isValidating = false
      validationTask = nil
      return false
    } catch {
      guard operationGeneration == generation else { return false }
      let mappedError = map(error)
      self.error = mappedError
      if case .rateLimited(let seconds, _) = mappedError, let seconds {
        retryUntil = Date().addingTimeInterval(TimeInterval(seconds))
      } else {
        retryUntil = nil
      }
      isValidating = false
      validationTask = nil
      return false
    }
  }

  /// Rechecks the existing Keychain credential. Neither this controller nor
  /// SwiftUI receives the credential string.
  @discardableResult
  public func reverifySavedCredential() async -> Bool {
    guard hasSavedCredential else { return false }
    generation += 1
    let operationGeneration = generation
    validationTask?.cancel()
    validationTask = nil
    error = nil
    lastRequestID = nil
    retryUntil = nil
    isValidating = true
    do {
      let outcome = try await credentialStore.revalidateSavedCredential(generation: operationGeneration)
      guard operationGeneration == generation else { return false }
      guard case let .validated(result, binding) = outcome else {
        isValidating = false
        switch outcome {
        case .missing: persistAndPublishMissingCredentialFallback()
        case .invalid: persistAndPublishVerificationFallback(hasSavedCredential: true)
        case .superseded, .validated: break
        }
        return false
      }
      preferences.markVerified(result.capabilities, binding: binding)
      hasSavedCredential = true
      credentialState = .savedAndVerified
      synchronizePreferences()
      lastRequestID = result.requestID
      isValidating = false
      isCredentialStateResolved = true
      return true
    } catch is CancellationError {
      guard operationGeneration == generation else { return false }
      isValidating = false
      return false
    } catch {
      guard operationGeneration == generation else { return false }
      self.error = map(error)
      isValidating = false
      return false
    }
  }

  public func deleteCredential() async -> Bool {
    generation += 1
    let operationGeneration = generation
    validationTask?.cancel()
    validationTask = nil
    isValidating = false
    error = nil
    lastRequestID = nil
    retryUntil = nil

    do {
      let mutation = try await credentialStore.deleteCredential(generation: operationGeneration)
      guard mutation == .deleted, operationGeneration == generation else { return false }
      preferences.resetAfterCredentialDeletion()
      hasSavedCredential = false
      credentialState = .notConfigured
      synchronizePreferences()
      isCredentialStateResolved = true
      return true
    } catch {
      guard operationGeneration == generation else { return false }
      self.error = .credentialStorageUnavailable
      return false
    }
  }

  public func selectProvider(_ provider: AssistantProvider) {
    preferences.selectProvider(provider, hasSavedCredential: hasSavedCredential)
    synchronizePreferences()
  }

  public func selectVoiceProvider(_ provider: AssistantVoiceProvider) {
    preferences.selectVoiceProvider(provider, hasSavedCredential: hasSavedCredential)
    synchronizePreferences()
  }

  @discardableResult
  public func authorizeOpenAIVoiceAndSelect() -> Bool {
    guard credentialState == .savedAndVerified else { return false }
    let succeeded = preferences.authorizeOpenAIVoiceAndSelect()
    synchronizePreferences()
    return succeeded
  }

  public func setTextConsent(_ isGranted: Bool) {
    guard credentialState == .savedAndVerified else { return }
    preferences.setTextConsent(isGranted)
    synchronizePreferences()
  }

  public func selectTextModel(id: String?) {
    preferences.selectTextModel(id: id)
    synchronizePreferences()
  }

  public func selectRealtimeModel(id: String?) {
    preferences.selectRealtimeModel(id: id)
    synchronizePreferences()
  }

  public func selectRealtimeVoice(id: String?) {
    preferences.selectRealtimeVoice(id: id)
    synchronizePreferences()
  }

  @discardableResult
  public func authorizeOpenAITextAndSelect(modelID: String) -> Bool {
    guard credentialState == .savedAndVerified,
      verifiedTextOptions.contains(where: { $0.id == modelID })
    else { return false }
    preferences.selectTextModel(id: modelID)
    preferences.setTextConsent(true)
    preferences.selectProvider(.openAI, hasSavedCredential: hasSavedCredential)
    synchronizePreferences()
    return selectedProvider == .openAI && hasTextConsent
  }

  public func clearError() {
    error = nil
  }

  public func textRouteSnapshot(
    for routeOverride: AssistantConversationRoute? = nil
  ) -> AssistantTextRouteSnapshot {
    let requestsOpenAI =
      routeOverride?.provider == .openAI
      || (routeOverride == nil && selectedProvider == .openAI)
    if requestsOpenAI, !isCredentialStateResolved {
      return AssistantTextRouteSnapshot(
        provider: .openAI,
        modelID: routeOverride?.modelID ?? selectedTextModelID,
        authorizationFailure: .credentialVerificationRequired
      )
    }
    return preferences.textRouteSnapshot(for: routeOverride)
  }

  public func voiceRouteSnapshot() -> RealtimeVoiceRouteSnapshot {
    if selectedVoiceProvider == .openAIRealtime, !isCredentialStateResolved {
      return .failedOpenAIRealtime(
        modelID: selectedRealtimeModelID,
        voiceID: selectedRealtimeVoice?.id,
        failure: .credentialVerificationRequired
      )
    }
    return preferences.voiceRouteSnapshot()
  }

  private func synchronizePreferences() {
    // Once explicitly selected, an OpenAI route remains visible even if its
    // credential, text consent, or model later needs recovery. Inference fails
    // closed instead of silently crossing back to Apple.
    selectedProvider = preferences.selectedProvider
    selectedTextModelID = preferences.selectedTextModelID
    verifiedTextOptions = preferences.verifiedTextOptions
    hasTextConsent = preferences.hasCurrentTextConsent
    selectedVoiceProvider = preferences.selectedVoiceProvider
    selectedRealtimeModelID = preferences.selectedRealtimeModelID
    selectedRealtimeVoice = preferences.selectedRealtimeVoice
    verifiedRealtimeOptions = preferences.verifiedRealtimeOptions
  }

  private func persistAndPublishVerificationFallback(hasSavedCredential: Bool) {
    preferences.markNeedsVerification()
    self.hasSavedCredential = hasSavedCredential
    credentialState = .needsVerification
    synchronizePreferences()
  }

  private func persistAndPublishMissingCredentialFallback() {
    preferences.resetAfterCredentialDeletion()
    hasSavedCredential = false
    credentialState = .notConfigured
    synchronizePreferences()
  }

  private func map(_ error: Error) -> AssistantProviderSettingsError {
    if let error = error as? OpenAICredentialStoreError {
      return error == .passcodeRequired ? .passcodeRequired : .credentialStorageUnavailable
    }
    guard let error = error as? OpenAIValidationError else {
      return .serviceUnavailable(requestID: nil)
    }
    return switch error {
    case .invalidCredential(let id): .credentialRejected(requestID: id)
    case .forbidden(let id): .permissionDenied(requestID: id)
    case .rateLimited(let seconds, let id):
      .rateLimited(retryAfterSeconds: seconds, requestID: id)
    case .redirectBlocked: .redirectBlocked
    case .networkUnavailable: .networkUnavailable
    case .timedOut: .timedOut
    case .invalidResponse(let id): .invalidResponse(requestID: id)
    case .serviceUnavailable(let id): .serviceUnavailable(requestID: id)
    case .transportFailure: .serviceUnavailable(requestID: nil)
    }
  }
}
