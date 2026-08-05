import CryptoKit
import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class AssistantProviderSettingsTests: XCTestCase {
  func testFailedReplacementPreservesSavedCredential() async throws {
    let credentialStore = MemoryCredentialStore(credential: "old-placeholder")
    let validator = ImmediateCredentialValidator(
      error: OpenAIValidationError.invalidCredential(requestID: nil))
    let controller = makeController(credentialStore: credentialStore, validator: validator)
    await controller.refreshCredentialState()

    let succeeded = await controller.verifyAndSave(candidate: "new-placeholder")
    let snapshot = await credentialStore.snapshot()
    XCTAssertFalse(succeeded)
    XCTAssertEqual(snapshot.credential, "old-placeholder")
    XCTAssertEqual(snapshot.replaceCount, 0)
    XCTAssertEqual(controller.credentialState, .needsVerification)
  }

  func testReverifySavedKeyKeepsBindingAndRevisionWithoutExposingSecret() async {
    let credentialStore = MemoryCredentialStore(credential: "saved-placeholder", revision: "stable")
    let controller = makeController(
      credentialStore: credentialStore,
      validator: ImmediateCredentialValidator(result: validationResult())
    )
    await controller.refreshCredentialState()
    let succeeded = await controller.reverifySavedCredential()
    let snapshot = await credentialStore.snapshot()
    XCTAssertTrue(succeeded)
    XCTAssertEqual(snapshot.credential, "saved-placeholder")
    XCTAssertEqual(snapshot.replaceCount, 0)
    XCTAssertEqual(controller.credentialState, .savedAndVerified)
  }

  func testSuccessfulReplacementStoresOnlyAfterValidation() async throws {
    let credentialStore = MemoryCredentialStore(credential: "old-placeholder")
    let validator = ImmediateCredentialValidator(result: validationResult())
    let controller = makeController(credentialStore: credentialStore, validator: validator)

    let succeeded = await controller.verifyAndSave(candidate: "new-placeholder")
    let snapshot = await credentialStore.snapshot()
    XCTAssertTrue(succeeded)
    XCTAssertEqual(snapshot.credential, "new-placeholder")
    XCTAssertEqual(snapshot.replaceCount, 1)
    XCTAssertEqual(controller.credentialState, .savedAndVerified)
    XCTAssertEqual(controller.verifiedTextOptions.map(\.id), ["gpt-5.6-terra"])
    XCTAssertNil(controller.selectedTextModelID)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
  }

  func testConcurrentValidationsAreGenerationFenced() async {
    let credentialStore = MemoryCredentialStore()
    let validator = GatedCredentialValidator()
    let controller = makeController(credentialStore: credentialStore, validator: validator)

    let first = Task { await controller.verifyAndSave(candidate: "first-placeholder") }
    await validator.waitForRequestCount(1)
    let second = Task { await controller.verifyAndSave(candidate: "second-placeholder") }
    await validator.waitForRequestCount(2)

    await validator.resume(credential: "second-placeholder", with: .success(validationResult()))
    let secondSucceeded = await second.value
    XCTAssertTrue(secondSucceeded)
    await validator.resume(credential: "first-placeholder", with: .success(validationResult()))
    let firstSucceeded = await first.value
    XCTAssertFalse(firstSucceeded)

    let snapshot = await credentialStore.snapshot()
    XCTAssertEqual(snapshot.credential, "second-placeholder")
    XCTAssertEqual(snapshot.replaceCount, 1)
  }

  func testRefreshOvertakesSuspendedValidationAndReleasesVerifyingState() async {
    let credentialStore = MemoryCredentialStore()
    let validator = GatedCredentialValidator()
    let controller = makeController(credentialStore: credentialStore, validator: validator)

    let staleSave = Task { await controller.verifyAndSave(candidate: "stale-placeholder") }
    await validator.waitForRequestCount(1)
    XCTAssertTrue(controller.isValidating)

    await controller.refreshCredentialState()

    XCTAssertFalse(controller.isValidating)
    XCTAssertEqual(controller.credentialState, .notConfigured)
    await validator.resume(credential: "stale-placeholder", with: .success(validationResult()))
    let staleSaveSucceeded = await staleSave.value
    XCTAssertFalse(staleSaveSucceeded)
    let snapshot = await credentialStore.snapshot()
    XCTAssertNil(snapshot.credential)
    XCTAssertEqual(snapshot.replaceCount, 0)
    XCTAssertFalse(controller.isValidating)
  }

  func testRefreshOvertakesSuspendedKeychainReplacementAndReleasesVerifyingState() async {
    let credentialStore = GatedMutationCredentialStore()
    let controller = makeController(
      credentialStore: credentialStore,
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    let staleSave = Task { await controller.verifyAndSave(candidate: "stale-placeholder") }
    await credentialStore.waitForReplaceRequestCount(1)
    XCTAssertTrue(controller.isValidating)

    await controller.refreshCredentialState()

    XCTAssertFalse(controller.isValidating)
    XCTAssertEqual(controller.credentialState, .notConfigured)
    await credentialStore.resumeReplace(credential: "stale-placeholder")
    let staleSaveSucceeded = await staleSave.value
    XCTAssertFalse(staleSaveSucceeded)
    let snapshot = await credentialStore.snapshot()
    XCTAssertNil(snapshot.credential)
    XCTAssertEqual(snapshot.appliedReplaceCount, 0)
    XCTAssertFalse(controller.isValidating)
  }

  func testDeleteOvertakesSuspendedValidatedSaveAtMutationAuthority() async {
    let credentialStore = GatedMutationCredentialStore()
    let controller = makeController(
      credentialStore: credentialStore,
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    let staleSave = Task { await controller.verifyAndSave(candidate: "stale-placeholder") }
    await credentialStore.waitForReplaceRequestCount(1)

    let deleted = await controller.deleteCredential()
    XCTAssertTrue(deleted)
    await credentialStore.resumeReplace(credential: "stale-placeholder")
    let staleSaveSucceeded = await staleSave.value
    XCTAssertFalse(staleSaveSucceeded)

    let snapshot = await credentialStore.snapshot()
    XCTAssertNil(snapshot.credential)
    XCTAssertEqual(snapshot.latestGeneration, 2)
    XCTAssertEqual(snapshot.appliedReplaceCount, 0)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    XCTAssertEqual(controller.credentialState, .notConfigured)
    XCTAssertNil(controller.selectedTextModelID)
  }

  func testConcurrentSuspendedReplacementsStoreAndPublishOnlyNewest() async {
    let credentialStore = GatedMutationCredentialStore()
    let validator = CredentialAwareValidator()
    let controller = makeController(credentialStore: credentialStore, validator: validator)

    let first = Task { await controller.verifyAndSave(candidate: "first-placeholder") }
    await credentialStore.waitForReplaceRequestCount(1)
    let second = Task { await controller.verifyAndSave(candidate: "second-placeholder") }
    await credentialStore.waitForReplaceRequestCount(2)

    await credentialStore.resumeReplace(credential: "second-placeholder")
    let secondSucceeded = await second.value
    XCTAssertTrue(secondSucceeded)
    await credentialStore.resumeReplace(credential: "first-placeholder")
    let firstSucceeded = await first.value
    XCTAssertFalse(firstSucceeded)

    let snapshot = await credentialStore.snapshot()
    XCTAssertEqual(snapshot.credential, "second-placeholder")
    XCTAssertEqual(snapshot.latestGeneration, 2)
    XCTAssertEqual(snapshot.appliedReplaceCount, 1)
    XCTAssertEqual(controller.lastRequestID, "second-request")
    XCTAssertEqual(controller.verifiedTextOptions.map(\.id), ["gpt-5.6-terra"])
    XCTAssertEqual(controller.selectedTextModelID, "gpt-5.6-terra")
    XCTAssertEqual(controller.credentialState, .savedAndVerified)
  }

  func testReplacementNewerThanDeleteMayWriteAndUpdatesControllerState() async {
    let credentialStore = GatedMutationCredentialStore()
    let controller = makeController(
      credentialStore: credentialStore,
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    let staleSave = Task { await controller.verifyAndSave(candidate: "stale-placeholder") }
    await credentialStore.waitForReplaceRequestCount(1)
    let deleted = await controller.deleteCredential()
    XCTAssertTrue(deleted)

    let newerSave = Task { await controller.verifyAndSave(candidate: "newer-placeholder") }
    await credentialStore.waitForReplaceRequestCount(2)
    await credentialStore.resumeReplace(credential: "stale-placeholder")
    let staleSaveSucceeded = await staleSave.value
    XCTAssertFalse(staleSaveSucceeded)
    await credentialStore.resumeReplace(credential: "newer-placeholder")
    let newerSaveSucceeded = await newerSave.value
    XCTAssertTrue(newerSaveSucceeded)

    let snapshot = await credentialStore.snapshot()
    XCTAssertEqual(snapshot.credential, "newer-placeholder")
    XCTAssertEqual(snapshot.latestGeneration, 3)
    XCTAssertEqual(snapshot.appliedReplaceCount, 1)
    XCTAssertTrue(controller.hasSavedCredential)
    XCTAssertEqual(controller.credentialState, .savedAndVerified)
    XCTAssertTrue(controller.isCredentialStateResolved)
    XCTAssertEqual(controller.selectedTextModelID, "gpt-5.6-terra")
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
  }

  func testDeleteCancelsValidationIgnoresLateResultAndKeepsBlockedRequestedRoute() async {
    let credentialStore = MemoryCredentialStore()
    let validator = GatedCredentialValidator()
    let controller = makeController(credentialStore: credentialStore, validator: validator)

    let initial = Task { await controller.verifyAndSave(candidate: "initial-placeholder") }
    await validator.waitForRequestCount(1)
    await validator.resume(credential: "initial-placeholder", with: .success(validationResult()))
    let initialSucceeded = await initial.value
    XCTAssertTrue(initialSucceeded)
    controller.setTextConsent(true)
    controller.selectTextModel(id: "gpt-5.6-terra")
    controller.selectProvider(.openAI)

    let replacement = Task { await controller.verifyAndSave(candidate: "late-placeholder") }
    await validator.waitForRequestCount(2)
    let deleted = await controller.deleteCredential()
    XCTAssertTrue(deleted)
    await validator.resume(credential: "late-placeholder", with: .success(validationResult()))
    let replacementSucceeded = await replacement.value
    XCTAssertFalse(replacementSucceeded)

    let snapshot = await credentialStore.snapshot()
    XCTAssertNil(snapshot.credential)
    XCTAssertEqual(controller.selectedProvider, .openAI)
    XCTAssertFalse(controller.hasTextConsent)
    XCTAssertNil(controller.selectedTextModelID)
    XCTAssertEqual(controller.credentialState, .notConfigured)
  }

  func testRefreshAndPreferenceChangesNeverValidate() async {
    let credentialStore = MemoryCredentialStore(credential: "saved-placeholder")
    let validator = ImmediateCredentialValidator(result: validationResult())
    let defaults = makeDefaults()
    let preferences = AssistantProviderPreferencesStore(defaults: defaults)
    preferences.markVerified(
      validationResult().capabilities,
      binding: credentialBinding("saved-placeholder", revision: "saved-revision")
    )
    let controller = AssistantProviderSettingsController(
      preferences: preferences,
      credentialStore: credentialStore,
      validator: validator
    )

    await controller.refreshCredentialState()
    controller.setTextConsent(true)
    controller.selectTextModel(id: "gpt-5.6-terra")
    controller.selectProvider(.openAI)

    let requestCount = await validator.currentRequestCount()
    XCTAssertEqual(requestCount, 0)
  }

  func testNoCredentialKeepsRequestedOpenAIRouteBlockedAndClearsAuthority() async throws {
    let defaults = makeDefaults()
    let payload = AssistantProviderPreferencesPayload(
      selectedProvider: .openAI,
      verifiedCatalogVersion: OpenAIModelCatalog.version,
      verifiedTextModelIDs: ["gpt-5.6-terra"],
      selectedTextModelID: "gpt-5.6-terra",
      textConsentVersion: AssistantProviderPreferencesPayload.currentTextConsentVersion
    )
    defaults.set(
      try JSONEncoder().encode(payload),
      forKey: AssistantProviderPreferencesStore.defaultKey
    )
    let controller = AssistantProviderSettingsController(
      preferences: AssistantProviderPreferencesStore(defaults: defaults),
      credentialStore: MemoryCredentialStore(),
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    await controller.refreshCredentialState()

    XCTAssertEqual(controller.selectedProvider, .openAI)
    XCTAssertEqual(controller.credentialState, .notConfigured)
    XCTAssertFalse(controller.hasTextConsent)
    XCTAssertNil(controller.selectedTextModelID)
    XCTAssertFalse(controller.canSelectOpenAI)
  }

  func testOpenAIRequiresVerifiedCredentialConsentAndSelectedAvailableModel() async {
    let credentialStore = MemoryCredentialStore()
    let controller = makeController(
      credentialStore: credentialStore,
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    controller.selectProvider(.openAI)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    let verified = await controller.verifyAndSave(candidate: "credential-placeholder")
    XCTAssertTrue(verified)
    XCTAssertEqual(controller.selectedTextModelID, "gpt-5.6-terra")
    controller.selectProvider(.openAI)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    controller.setTextConsent(true)
    controller.selectTextModel(id: nil)
    controller.selectProvider(.openAI)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    XCTAssertFalse(controller.canSelectOpenAI)
    controller.selectTextModel(id: "not-in-catalog")
    XCTAssertNil(controller.selectedTextModelID)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    controller.selectProvider(.openAI)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    controller.selectTextModel(id: "gpt-5.6-terra")
    XCTAssertEqual(controller.selectedTextModelID, "gpt-5.6-terra")
    controller.selectProvider(.openAI)
    XCTAssertEqual(controller.selectedProvider, .openAI)
    controller.selectTextModel(id: nil)
    XCTAssertEqual(controller.selectedProvider, .openAI)
  }

  func testProviderPresentationUsesActiveRouteLabels() {
    XCTAssertEqual(AssistantProvider.appleOnDevice.futureSettingsTitle, "Apple On Device")
    XCTAssertEqual(
      AssistantProvider.openAI.futureSettingsTitle,
      "OpenAI"
    )
  }

  func testTextConsentV1IsInvalidatedAndOpenAIRouteFailsClosed() {
    let defaults = makeDefaults()
    let binding = credentialBinding("saved-placeholder", revision: "saved-revision")
    let payload = AssistantProviderPreferencesPayload(
      selectedProvider: .openAI,
      credentialRevision: binding.revision,
      credentialFingerprint: binding.fingerprint,
      verifiedCatalogVersion: OpenAIModelCatalog.version,
      verifiedTextModelIDs: ["gpt-5.6-terra"],
      selectedTextModelID: "gpt-5.6-terra",
      textConsentVersion: 1,
      textConsentCredentialRevision: binding.revision,
      textConsentCredentialFingerprint: binding.fingerprint
    )
    defaults.set(
      try! JSONEncoder().encode(payload),
      forKey: AssistantProviderPreferencesStore.defaultKey
    )

    let preferences = AssistantProviderPreferencesStore(defaults: defaults)

    XCTAssertFalse(preferences.hasCurrentTextConsent)
    XCTAssertEqual(preferences.selectedProvider, .openAI)
    XCTAssertEqual(preferences.textRouteSnapshot().authorizationFailure, .consentRequired)
  }

  func testTextConsentIsBoundToExactCredentialIdentity() {
    let preferences = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let firstBinding = credentialBinding("first-placeholder", revision: "first-revision")
    preferences.markVerified(
      validationResult().capabilities,
      binding: firstBinding,
      selectDefaultTextModel: true
    )
    preferences.setTextConsent(true)
    preferences.selectProvider(.openAI, hasSavedCredential: true)
    XCTAssertTrue(preferences.hasCurrentTextConsent)

    preferences.markVerified(
      validationResult().capabilities,
      binding: credentialBinding("second-placeholder", revision: "second-revision")
    )

    XCTAssertFalse(preferences.hasCurrentTextConsent)
    XCTAssertEqual(preferences.selectedProvider, .openAI)
    XCTAssertEqual(preferences.textRouteSnapshot().authorizationFailure, .consentRequired)
  }

  func testOpenAIRouteIsUnavailableUntilLaunchCredentialRefreshResolves() async {
    let defaults = makeDefaults()
    let binding = credentialBinding("saved-placeholder", revision: "saved-revision")
    let preferences = AssistantProviderPreferencesStore(defaults: defaults)
    preferences.markVerified(
      validationResult().capabilities,
      binding: binding,
      selectDefaultTextModel: true
    )
    preferences.setTextConsent(true)
    preferences.selectProvider(.openAI, hasSavedCredential: true)
    let controller = AssistantProviderSettingsController(
      preferences: preferences,
      credentialStore: FixedReadCredentialStore(outcome: .available(binding: binding)),
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    XCTAssertFalse(controller.isCredentialStateResolved)
    XCTAssertNotNil(controller.textRouteSnapshot().authorizationFailure)

    await controller.refreshCredentialState()

    XCTAssertTrue(controller.isCredentialStateResolved)
    XCTAssertNil(controller.textRouteSnapshot().authorizationFailure)
    XCTAssertEqual(controller.textRouteSnapshot().modelID, "gpt-5.6-terra")
  }

  func testExplicitRetrySnapshotKeepsOriginalAuthorizedModelWhenDefaultIsApple() async {
    let binding = credentialBinding("saved-placeholder", revision: "saved-revision")
    let preferences = AssistantProviderPreferencesStore(defaults: makeDefaults())
    preferences.markVerified(
      validationResult().capabilities,
      binding: binding,
      selectDefaultTextModel: true
    )
    preferences.setTextConsent(true)
    preferences.selectProvider(.openAI, hasSavedCredential: true)
    preferences.selectProvider(.appleOnDevice, hasSavedCredential: true)
    let controller = AssistantProviderSettingsController(
      preferences: preferences,
      credentialStore: FixedReadCredentialStore(outcome: .available(binding: binding)),
      validator: ImmediateCredentialValidator(result: validationResult())
    )
    await controller.refreshCredentialState()

    let retry = controller.textRouteSnapshot(
      for: AssistantConversationRoute(provider: .openAI, modelID: "gpt-5.6-terra")
    )

    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    XCTAssertEqual(retry.provider, .openAI)
    XCTAssertEqual(retry.modelID, "gpt-5.6-terra")
    XCTAssertEqual(retry.credentialBinding, binding)
    XCTAssertNil(retry.authorizationFailure)
  }

  func testPersistedInvalidModelKeepsRequestedOpenAIRouteButCannotAuthorize() throws {
    let defaults = makeDefaults()
    let payload = AssistantProviderPreferencesPayload(
      selectedProvider: .openAI,
      verifiedCatalogVersion: OpenAIModelCatalog.version,
      verifiedTextModelIDs: ["not-in-catalog"],
      selectedTextModelID: "not-in-catalog",
      textConsentVersion: AssistantProviderPreferencesPayload.currentTextConsentVersion
    )
    defaults.set(
      try JSONEncoder().encode(payload),
      forKey: AssistantProviderPreferencesStore.defaultKey
    )

    let preferences = AssistantProviderPreferencesStore(defaults: defaults)

    XCTAssertEqual(preferences.selectedProvider, .openAI)
    XCTAssertNil(preferences.selectedTextModelID)
    XCTAssertFalse(preferences.hasValidSelectedTextModel)
    XCTAssertFalse(preferences.canSelect(.openAI, hasSavedCredential: true))
  }

  func testVerificationCannotPromoteModelsOutsideShippedAllowlist() {
    let preferences = AssistantProviderPreferencesStore(defaults: makeDefaults())
    preferences.markVerified(
      .init(
        catalogVersion: OpenAIModelCatalog.version,
        textModelIDs: ["not-in-catalog", "gpt-5.6-terra"],
        realtimeModelIDs: ["not-realtime-catalog"]
      ),
      binding: credentialBinding("credential-placeholder"),
      selectDefaultTextModel: true
    )

    XCTAssertEqual(preferences.verifiedTextModelIDs, ["gpt-5.6-terra"])
    XCTAssertTrue(preferences.verifiedRealtimeModelIDs.isEmpty)
    XCTAssertEqual(preferences.selectedTextModelID, "gpt-5.6-terra")
  }

  func testReverificationRemovingSelectedModelKeepsOpenAIRouteBlockedAndRequiresFreshConsent() async
  {
    let credentialStore = MemoryCredentialStore()
    let validator = SequencedCredentialValidator(
      results: [
        validationResult(textModelIDs: ["gpt-5.6-terra"], requestID: "first-request"),
        validationResult(textModelIDs: ["gpt-5.6-luna"], requestID: "second-request"),
      ]
    )
    let controller = makeController(credentialStore: credentialStore, validator: validator)

    let firstSaveSucceeded = await controller.verifyAndSave(candidate: "first-placeholder")
    XCTAssertTrue(firstSaveSucceeded)
    controller.setTextConsent(true)
    controller.selectProvider(.openAI)
    XCTAssertEqual(controller.selectedProvider, .openAI)

    let secondSaveSucceeded = await controller.verifyAndSave(candidate: "second-placeholder")
    XCTAssertTrue(secondSaveSucceeded)

    XCTAssertEqual(controller.verifiedTextOptions.map(\.id), ["gpt-5.6-luna"])
    XCTAssertNil(controller.selectedTextModelID)
    XCTAssertEqual(controller.selectedProvider, .openAI)
    XCTAssertFalse(controller.canSelectOpenAI)
    controller.selectTextModel(id: "gpt-5.6-luna")
    XCTAssertFalse(controller.canSelectOpenAI)
    XCTAssertEqual(controller.selectedProvider, .openAI)
  }

  func testRateLimitExposesRetryCountdownWithoutReplacingCredential() async {
    let credentialStore = MemoryCredentialStore(credential: "saved-placeholder")
    let validator = ImmediateCredentialValidator(
      error: OpenAIValidationError.rateLimited(
        retryAfterSeconds: 30,
        requestID: "rate-limit-request-placeholder"
      )
    )
    let controller = makeController(credentialStore: credentialStore, validator: validator)

    let before = Date()
    let succeeded = await controller.verifyAndSave(candidate: "replacement-placeholder")

    XCTAssertFalse(succeeded)
    XCTAssertEqual(
      controller.error,
      .rateLimited(
        retryAfterSeconds: 30,
        requestID: "rate-limit-request-placeholder"
      )
    )
    XCTAssertTrue((30...31).contains(controller.retrySecondsRemaining(at: before) ?? 0))
    XCTAssertNil(controller.retrySecondsRemaining(at: before.addingTimeInterval(31)))
    let snapshot = await credentialStore.snapshot()
    XCTAssertEqual(snapshot.credential, "saved-placeholder")
    XCTAssertEqual(snapshot.replaceCount, 0)
  }

  func testMatchingCredentialIdentityRestoresVerifiedStateWithoutNetworkValidation() async {
    let defaults = makeDefaults()
    let preferences = AssistantProviderPreferencesStore(defaults: defaults)
    let binding = credentialBinding("saved-placeholder", revision: "saved-revision")
    preferences.markVerified(validationResult().capabilities, binding: binding)
    let validator = ImmediateCredentialValidator(result: validationResult())
    let controller = AssistantProviderSettingsController(
      preferences: AssistantProviderPreferencesStore(defaults: defaults),
      credentialStore: FixedReadCredentialStore(outcome: .available(binding: binding)),
      validator: validator
    )

    await controller.refreshCredentialState()

    XCTAssertTrue(controller.hasSavedCredential)
    XCTAssertEqual(controller.credentialState, .savedAndVerified)
    XCTAssertEqual(controller.verifiedTextOptions.map(\.id), ["gpt-5.6-terra"])
    let requestCount = await validator.currentRequestCount()
    XCTAssertEqual(requestCount, 0)
  }

  func testFirstSavedKeyActivatesOpenAIVoiceOnce() async {
    let controller = AssistantProviderSettingsController(
      preferences: AssistantProviderPreferencesStore(defaults: makeDefaults()),
      credentialStore: MemoryCredentialStore(),
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    let didVerify = await controller.verifyAndSave(candidate: "first-placeholder")
    XCTAssertTrue(didVerify)
    XCTAssertEqual(controller.selectedVoiceProvider, .openAIRealtime)
  }

  func testReverifyPreservesExplicitAppleAndQwenVoiceSelection() async {
    for selected in [AssistantVoiceProvider.appleOnDevice, .qwenRealtime] {
      let defaults = makeDefaults()
      let preferences = AssistantProviderPreferencesStore(defaults: defaults)
      preferences.selectVoiceProvider(selected, hasSavedCredential: true)
      let binding = credentialBinding("saved-placeholder", revision: "saved-revision")
      preferences.markVerified(validationResult().capabilities, binding: binding)
      let controller = AssistantProviderSettingsController(
        preferences: preferences,
        credentialStore: MemoryCredentialStore(credential: "saved-placeholder", revision: "saved-revision"),
        validator: ImmediateCredentialValidator(result: validationResult())
      )
      await controller.refreshCredentialState()
      let didReverify = await controller.reverifySavedCredential()
      XCTAssertTrue(didReverify)
      XCTAssertEqual(controller.selectedVoiceProvider, selected)
    }
  }

  func testCrashWindowNewKeychainRecordWithOldPreferencesFailsClosed() async {
    let defaults = makeDefaults()
    let preferences = AssistantProviderPreferencesStore(defaults: defaults)
    preferences.markVerified(
      validationResult().capabilities,
      binding: credentialBinding("old-placeholder", revision: "old-revision")
    )
    preferences.setTextConsent(true)
    preferences.selectTextModel(id: "gpt-5.6-terra")
    preferences.selectProvider(.openAI, hasSavedCredential: true)
    let newBinding = credentialBinding("new-placeholder", revision: "new-revision")
    let controller = AssistantProviderSettingsController(
      preferences: preferences,
      credentialStore: FixedReadCredentialStore(outcome: .available(binding: newBinding)),
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    await controller.refreshCredentialState()

    XCTAssertTrue(controller.hasSavedCredential)
    XCTAssertEqual(controller.credentialState, .needsVerification)
    XCTAssertTrue(controller.isCredentialStateResolved)
    XCTAssertEqual(controller.selectedProvider, .openAI)
    XCTAssertEqual(controller.selectedTextModelID, "gpt-5.6-terra")
    XCTAssertFalse(controller.canSelectOpenAI)
    XCTAssertNotNil(controller.textRouteSnapshot().authorizationFailure)
    let persisted = preferences.storedPayloadForTesting
    XCTAssertEqual(persisted.selectedProvider, .openAI)
    XCTAssertNil(persisted.credentialRevision)
    XCTAssertNil(persisted.credentialFingerprint)
    XCTAssertNil(persisted.verifiedCatalogVersion)
  }

  func testDifferentKeyWithSameRevisionFailsFingerprintBinding() async {
    let defaults = makeDefaults()
    let preferences = AssistantProviderPreferencesStore(defaults: defaults)
    preferences.markVerified(
      validationResult().capabilities,
      binding: credentialBinding("old-placeholder", revision: "shared-revision")
    )
    let controller = AssistantProviderSettingsController(
      preferences: preferences,
      credentialStore: FixedReadCredentialStore(
        outcome: .available(
          binding: credentialBinding("different-placeholder", revision: "shared-revision")
        )
      ),
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    await controller.refreshCredentialState()

    XCTAssertEqual(controller.credentialState, .needsVerification)
    XCTAssertTrue(controller.isCredentialStateResolved)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    XCTAssertFalse(controller.canSelectOpenAI)
  }

  func testMalformedCredentialRecordRequiresVerification() async {
    let defaults = makeDefaults()
    let preferences = AssistantProviderPreferencesStore(defaults: defaults)
    preferences.markVerified(
      validationResult().capabilities,
      binding: credentialBinding("saved-placeholder")
    )
    let controller = AssistantProviderSettingsController(
      preferences: preferences,
      credentialStore: FixedReadCredentialStore(outcome: .invalid),
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    await controller.refreshCredentialState()

    XCTAssertEqual(controller.credentialState, .needsVerification)
    XCTAssertTrue(controller.isCredentialStateResolved)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    XCTAssertFalse(controller.canSelectOpenAI)
    XCTAssertNil(preferences.storedPayloadForTesting.credentialFingerprint)
  }

  func testMissingCredentialPublishesNotConfiguredAndClearsPriorChoices() async {
    let defaults = makeDefaults()
    let preferences = AssistantProviderPreferencesStore(defaults: defaults)
    preferences.markVerified(
      validationResult().capabilities,
      binding: credentialBinding("saved-placeholder")
    )
    preferences.setTextConsent(true)
    preferences.selectTextModel(id: "gpt-5.6-terra")
    preferences.selectProvider(.openAI, hasSavedCredential: true)
    let controller = AssistantProviderSettingsController(
      preferences: preferences,
      credentialStore: FixedReadCredentialStore(outcome: .missing),
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    await controller.refreshCredentialState()

    XCTAssertEqual(controller.credentialState, .notConfigured)
    XCTAssertTrue(controller.isCredentialStateResolved)
    XCTAssertEqual(controller.selectedProvider, .openAI)
    XCTAssertFalse(controller.hasSavedCredential)
    XCTAssertFalse(controller.hasTextConsent)
    XCTAssertNil(controller.selectedTextModelID)
    XCTAssertFalse(controller.canSelectOpenAI)
  }

  func testRefreshStorageErrorKeepsRequestedOpenAIRouteBlocked() async {
    let defaults = makeDefaults()
    let preferences = AssistantProviderPreferencesStore(defaults: defaults)
    preferences.markVerified(
      validationResult().capabilities,
      binding: credentialBinding("saved-placeholder")
    )
    preferences.setTextConsent(true)
    preferences.selectTextModel(id: "gpt-5.6-terra")
    preferences.selectProvider(.openAI, hasSavedCredential: true)
    let controller = AssistantProviderSettingsController(
      preferences: preferences,
      credentialStore: FixedReadCredentialStore(error: .unavailable),
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    await controller.refreshCredentialState()

    XCTAssertEqual(controller.error, .credentialStorageUnavailable)
    XCTAssertEqual(controller.credentialState, .needsVerification)
    XCTAssertTrue(controller.isCredentialStateResolved)
    XCTAssertEqual(controller.selectedProvider, .openAI)
    XCTAssertEqual(preferences.storedPayloadForTesting.selectedProvider, .openAI)
    XCTAssertNil(preferences.storedPayloadForTesting.credentialFingerprint)
  }

  func testDelayedRefreshCannotOverwriteNewerValidatedSave() async {
    let store = GatedRefreshCredentialStore(
      credential: "old-placeholder",
      revision: "old-revision"
    )
    let controller = makeController(
      credentialStore: store,
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    let refresh = Task { await controller.refreshCredentialState() }
    await store.waitForReadRequest()
    let saved = await controller.verifyAndSave(candidate: "new-placeholder")
    XCTAssertTrue(saved)
    await store.resumeReadWithOriginalBinding()
    await refresh.value

    XCTAssertEqual(controller.credentialState, .savedAndVerified)
    XCTAssertTrue(controller.hasSavedCredential)
    XCTAssertEqual(controller.verifiedTextOptions.map(\.id), ["gpt-5.6-terra"])
    let savedSnapshot = await store.snapshot()
    XCTAssertEqual(savedSnapshot.credential, "new-placeholder")
  }

  func testDelayedRefreshCannotOverwriteNewerDelete() async {
    let store = GatedRefreshCredentialStore(
      credential: "old-placeholder",
      revision: "old-revision"
    )
    let controller = makeController(
      credentialStore: store,
      validator: ImmediateCredentialValidator(result: validationResult())
    )

    let refresh = Task { await controller.refreshCredentialState() }
    await store.waitForReadRequest()
    let deleted = await controller.deleteCredential()
    XCTAssertTrue(deleted)
    await store.resumeReadWithOriginalBinding()
    await refresh.value

    XCTAssertEqual(controller.credentialState, .notConfigured)
    XCTAssertFalse(controller.hasSavedCredential)
    XCTAssertEqual(controller.selectedProvider, .appleOnDevice)
    let deletedSnapshot = await store.snapshot()
    XCTAssertNil(deletedSnapshot.credential)
  }

  private func makeController(
    credentialStore: any OpenAICredentialPersisting,
    validator: any OpenAICredentialValidating
  ) -> AssistantProviderSettingsController {
    AssistantProviderSettingsController(
      preferences: AssistantProviderPreferencesStore(defaults: makeDefaults()),
      credentialStore: credentialStore,
      validator: validator
    )
  }

  private func makeDefaults() -> UserDefaults {
    let name = "AssistantProviderSettingsTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
  }

  private func validationResult(
    textModelIDs: Set<String> = ["gpt-5.6-terra"],
    requestID: String = "request-placeholder"
  ) -> OpenAIValidationResult {
    .init(
      capabilities: .init(
        catalogVersion: OpenAIModelCatalog.version,
        textModelIDs: textModelIDs,
        realtimeModelIDs: ["gpt-realtime-mini"]
      ),
      requestID: requestID
    )
  }
}

private actor MemoryCredentialStore: OpenAICredentialPersisting {
  private(set) var credential: String?
  private var revision: String?
  private(set) var replaceCount = 0
  private var latestGeneration: UInt64 = 0

  init(credential: String? = nil, revision: String? = nil) {
    self.credential = credential
    self.revision = credential == nil ? nil : (revision ?? "saved-revision")
  }

  func readBinding(generation: UInt64) async throws -> OpenAICredentialReadOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    guard let credential, let revision else { return .missing }
    return .available(binding: credentialBinding(credential, revision: revision))
  }

  func revalidateSavedCredential(generation: UInt64) async throws -> OpenAICredentialRevalidationOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    guard let credential, let revision else { return .missing }
    let binding = credentialBinding(credential, revision: revision)
    let result = OpenAIValidationResult(
      capabilities: .init(
        catalogVersion: OpenAIModelCatalog.version,
        textModelIDs: ["gpt-5.6-terra"],
        realtimeModelIDs: ["gpt-realtime-mini"]
      ),
      requestID: nil
    )
    guard generation == latestGeneration,
      self.credential == credential, self.revision == revision
    else { return .superseded }
    return .validated(result: result, binding: binding)
  }

  func replace(
    with credential: String,
    generation: UInt64
  ) async throws -> OpenAICredentialMutationOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    let wasMissing = self.credential == nil
    replaceCount += 1
    self.credential = credential
    let revision = "revision-\(generation)"
    self.revision = revision
    let binding = credentialBinding(credential, revision: revision)
    return wasMissing ? .inserted(binding: binding) : .replaced(binding: binding)
  }

  func deleteCredential(generation: UInt64) async throws -> OpenAICredentialMutationOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    credential = nil
    revision = nil
    return .deleted
  }

  func snapshot() -> (credential: String?, replaceCount: Int) {
    (credential, replaceCount)
  }
}

private actor FixedReadCredentialStore: OpenAICredentialPersisting {
  private let outcome: OpenAICredentialReadOutcome?
  private let error: OpenAICredentialStoreError?
  private var latestGeneration: UInt64 = 0

  init(outcome: OpenAICredentialReadOutcome) {
    self.outcome = outcome
    error = nil
  }

  init(error: OpenAICredentialStoreError) {
    outcome = nil
    self.error = error
  }

  func readBinding(generation: UInt64) async throws -> OpenAICredentialReadOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    if let error { throw error }
    return outcome!
  }

  func replace(
    with credential: String,
    generation: UInt64
  ) async throws -> OpenAICredentialMutationOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    return .inserted(binding: credentialBinding(credential, revision: "replacement-revision"))
  }

  func deleteCredential(generation: UInt64) async throws -> OpenAICredentialMutationOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    return .deleted
  }
}

private actor GatedRefreshCredentialStore: OpenAICredentialPersisting {
  private struct PendingRead {
    let originalBinding: OpenAICredentialBinding
    let continuation: CheckedContinuation<OpenAICredentialReadOutcome, Never>
  }

  private var credential: String?
  private var revision: String?
  private var latestGeneration: UInt64 = 0
  private var pendingRead: PendingRead?

  init(credential: String, revision: String) {
    self.credential = credential
    self.revision = revision
  }

  func readBinding(generation: UInt64) async throws -> OpenAICredentialReadOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    guard let credential, let revision else { return .missing }
    let originalBinding = credentialBinding(credential, revision: revision)
    return await withCheckedContinuation { continuation in
      pendingRead = PendingRead(
        originalBinding: originalBinding,
        continuation: continuation
      )
    }
  }

  func replace(
    with credential: String,
    generation: UInt64
  ) async throws -> OpenAICredentialMutationOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    let wasMissing = self.credential == nil
    let revision = "revision-\(generation)"
    self.credential = credential
    self.revision = revision
    let binding = credentialBinding(credential, revision: revision)
    return wasMissing ? .inserted(binding: binding) : .replaced(binding: binding)
  }

  func deleteCredential(generation: UInt64) async throws -> OpenAICredentialMutationOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    credential = nil
    revision = nil
    return .deleted
  }

  func waitForReadRequest() async {
    while pendingRead == nil { await Task.yield() }
  }

  func resumeReadWithOriginalBinding() {
    guard let pendingRead else { return }
    self.pendingRead = nil
    pendingRead.continuation.resume(returning: .available(binding: pendingRead.originalBinding))
  }

  func snapshot() -> (credential: String?, revision: String?) {
    (credential, revision)
  }
}

private actor ImmediateCredentialValidator: OpenAICredentialValidating {
  private(set) var requestCount = 0
  private let result: OpenAIValidationResult?
  private let error: Error?

  init(result: OpenAIValidationResult) {
    self.result = result
    error = nil
  }

  init(error: Error) {
    result = nil
    self.error = error
  }

  func validate(credential: String) async throws -> OpenAIValidationResult {
    requestCount += 1
    if let error { throw error }
    return result!
  }

  func currentRequestCount() -> Int { requestCount }
}

private actor SequencedCredentialValidator: OpenAICredentialValidating {
  private var results: [OpenAIValidationResult]

  init(results: [OpenAIValidationResult]) {
    self.results = results
  }

  func validate(credential: String) async throws -> OpenAIValidationResult {
    results.removeFirst()
  }
}

private actor CredentialAwareValidator: OpenAICredentialValidating {
  func validate(credential: String) async throws -> OpenAIValidationResult {
    let isSecond = credential == "second-placeholder"
    return .init(
      capabilities: .init(
        catalogVersion: OpenAIModelCatalog.version,
        textModelIDs: [isSecond ? "gpt-5.6-terra" : "gpt-5.6-luna"],
        realtimeModelIDs: []
      ),
      requestID: isSecond ? "second-request" : "first-request"
    )
  }
}

private actor GatedMutationCredentialStore: OpenAICredentialPersisting {
  private struct PendingReplace {
    let credential: String
    let continuation: CheckedContinuation<Void, Never>
  }

  private var credential: String?
  private var latestGeneration: UInt64 = 0
  private var pendingReplaces: [PendingReplace] = []
  private var totalReplaceRequestCount = 0
  private var appliedReplaceCount = 0

  func readBinding(generation: UInt64) async throws -> OpenAICredentialReadOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    guard let credential else { return .missing }
    return .available(binding: credentialBinding(credential, revision: "revision-\(generation)"))
  }

  func replace(
    with credential: String,
    generation: UInt64
  ) async throws -> OpenAICredentialMutationOutcome {
    totalReplaceRequestCount += 1
    await withCheckedContinuation { continuation in
      pendingReplaces.append(
        PendingReplace(
          credential: credential,
          continuation: continuation
        )
      )
    }
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    let wasMissing = self.credential == nil
    self.credential = credential
    appliedReplaceCount += 1
    let binding = credentialBinding(credential, revision: "revision-\(generation)")
    return wasMissing ? .inserted(binding: binding) : .replaced(binding: binding)
  }

  func deleteCredential(generation: UInt64) async throws -> OpenAICredentialMutationOutcome {
    guard generation > latestGeneration else { return .superseded }
    latestGeneration = generation
    credential = nil
    return .deleted
  }

  func waitForReplaceRequestCount(_ count: Int) async {
    while totalReplaceRequestCount < count { await Task.yield() }
  }

  func resumeReplace(credential: String) {
    guard let index = pendingReplaces.firstIndex(where: { $0.credential == credential }) else {
      return
    }
    let pending = pendingReplaces.remove(at: index)
    pending.continuation.resume()
  }

  func snapshot() -> (
    credential: String?, latestGeneration: UInt64, appliedReplaceCount: Int
  ) {
    (credential, latestGeneration, appliedReplaceCount)
  }
}

private func credentialBinding(
  _ credential: String,
  revision: String = "credential-revision"
) -> OpenAICredentialBinding {
  OpenAICredentialBinding(
    revision: revision,
    fingerprint: SHA256.hash(data: Data(credential.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  )
}

private actor GatedCredentialValidator: OpenAICredentialValidating {
  private struct Pending {
    let credential: String
    let continuation: CheckedContinuation<OpenAIValidationResult, Error>
  }

  private var pending: [Pending] = []
  private var totalRequestCount = 0

  func validate(credential: String) async throws -> OpenAIValidationResult {
    totalRequestCount += 1
    return try await withCheckedThrowingContinuation { continuation in
      pending.append(Pending(credential: credential, continuation: continuation))
    }
  }

  func waitForRequestCount(_ count: Int) async {
    while totalRequestCount < count { await Task.yield() }
  }

  func resume(
    credential: String,
    with result: Result<OpenAIValidationResult, Error>
  ) {
    guard let index = pending.firstIndex(where: { $0.credential == credential }) else { return }
    let continuation = pending.remove(at: index).continuation
    continuation.resume(with: result)
  }
}
