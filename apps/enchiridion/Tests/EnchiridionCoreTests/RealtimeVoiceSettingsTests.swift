import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class RealtimeVoiceSettingsTests: XCTestCase {
  func testExistingVersionThreePayloadMigratesWithoutChangingTextPreferences() throws {
    let defaults = makeDefaults()
    let legacyV3: [String: Any] = [
      "version": 3,
      "selectedProvider": "openAI",
      "verifiedTextModelIDs": ["gpt-5.6-terra"],
      "verifiedRealtimeModelIDs": ["gpt-realtime-mini"],
      "selectedTextModelID": "gpt-5.6-terra",
    ]
    defaults.set(
      try JSONSerialization.data(withJSONObject: legacyV3),
      forKey: AssistantProviderPreferencesStore.defaultKey
    )

    let store = AssistantProviderPreferencesStore(defaults: defaults)

    XCTAssertEqual(store.selectedProvider, .openAI)
    XCTAssertEqual(store.selectedTextModelID, "gpt-5.6-terra")
    XCTAssertEqual(store.selectedVoiceProvider, .appleOnDevice)
    XCTAssertEqual(store.selectedRealtimeVoice, .marin)
    XCTAssertFalse(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: false))
  }

  func testBuild2026080303PayloadDecodesLegacyVoiceConsentWithoutResettingVoiceSelection() throws {
    let defaults = makeDefaults()
    let legacyPayload: [String: Any] = [
      "version": 3,
      "selectedVoiceProvider": "openAIRealtime",
      "credentialRevision": "revision-1",
      "credentialFingerprint": "fp-1",
      "verifiedCatalogVersion": OpenAIModelCatalog.version,
      "verifiedRealtimeModelIDs": ["gpt-realtime-mini"],
      "selectedRealtimeModelID": "gpt-realtime-mini",
      "selectedRealtimeVoiceID": "marin",
      "voiceConsentVersion": 2,
      "voiceConsentCredentialRevision": "revision-1",
      "voiceConsentCredentialFingerprint": "fp-1",
      "voiceConsentModelCatalogVersion": OpenAIModelCatalog.version,
      "voiceConsentVoiceCatalogVersion": OpenAIRealtimeVoiceCatalog.version,
      "voiceConsentModelID": "gpt-realtime-mini",
      "voiceConsentVoiceID": "marin",
    ]
    defaults.set(
      try JSONSerialization.data(withJSONObject: legacyPayload),
      forKey: AssistantProviderPreferencesStore.defaultKey
    )

    let store = AssistantProviderPreferencesStore(defaults: defaults)

    XCTAssertEqual(store.selectedVoiceProvider, .openAIRealtime)
    XCTAssertEqual(store.selectedRealtimeModelID, "gpt-realtime-mini")
    XCTAssertEqual(store.selectedRealtimeVoice, .marin)
    XCTAssertTrue(store.voiceRouteSnapshot().isAuthorizedOpenAIRealtime)
    XCTAssertEqual(store.storedPayloadForTesting.voiceConsentVersion, 2)
  }

  func testLegacyVoiceConsentFieldsRoundTripLosslesslyWithoutAuthorizingVoice() throws {
    let binding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    let withLegacyFields = AssistantProviderPreferencesPayload(
      selectedProvider: .openAI,
      credentialRevision: binding.revision,
      credentialFingerprint: binding.fingerprint,
      verifiedCatalogVersion: OpenAIModelCatalog.version,
      verifiedTextModelIDs: ["gpt-5.6-terra"],
      verifiedRealtimeModelIDs: ["gpt-realtime-mini"],
      selectedTextModelID: "gpt-5.6-terra",
      selectedVoiceProvider: .openAIRealtime,
      selectedRealtimeModelID: "gpt-realtime-mini",
      selectedRealtimeVoiceID: "marin",
      voiceConsentVersion: 2,
      voiceConsentCredentialRevision: binding.revision,
      voiceConsentCredentialFingerprint: binding.fingerprint,
      voiceConsentModelCatalogVersion: OpenAIModelCatalog.version,
      voiceConsentVoiceCatalogVersion: OpenAIRealtimeVoiceCatalog.version,
      voiceConsentModelID: "gpt-realtime-mini",
      voiceConsentVoiceID: "marin"
    )
    let withoutLegacyFields = AssistantProviderPreferencesPayload(
      selectedProvider: .openAI,
      credentialRevision: binding.revision,
      credentialFingerprint: binding.fingerprint,
      verifiedCatalogVersion: OpenAIModelCatalog.version,
      verifiedTextModelIDs: ["gpt-5.6-terra"],
      verifiedRealtimeModelIDs: ["gpt-realtime-mini"],
      selectedTextModelID: "gpt-5.6-terra",
      selectedVoiceProvider: .openAIRealtime,
      selectedRealtimeModelID: "gpt-realtime-mini",
      selectedRealtimeVoiceID: "marin"
    )

    for payload in [withLegacyFields, withoutLegacyFields] {
      let encoded = try JSONEncoder().encode(payload)
      let decoded = try JSONDecoder().decode(AssistantProviderPreferencesPayload.self, from: encoded)
      XCTAssertEqual(decoded, payload)
      XCTAssertEqual(decoded.version, 3)
      XCTAssertEqual(decoded.credentialRevision, binding.revision)
      XCTAssertEqual(decoded.credentialFingerprint, binding.fingerprint)
      XCTAssertEqual(decoded.selectedVoiceProvider, .openAIRealtime)
      XCTAssertEqual(decoded.selectedRealtimeModelID, "gpt-realtime-mini")
      XCTAssertEqual(decoded.selectedRealtimeVoiceID, "marin")
      XCTAssertEqual(decoded.voiceConsentVersion, payload.voiceConsentVersion)
      XCTAssertEqual(decoded.voiceConsentCredentialRevision, payload.voiceConsentCredentialRevision)
      XCTAssertEqual(decoded.voiceConsentCredentialFingerprint, payload.voiceConsentCredentialFingerprint)
      XCTAssertEqual(decoded.voiceConsentModelCatalogVersion, payload.voiceConsentModelCatalogVersion)
      XCTAssertEqual(decoded.voiceConsentVoiceCatalogVersion, payload.voiceConsentVoiceCatalogVersion)
      XCTAssertEqual(decoded.voiceConsentModelID, payload.voiceConsentModelID)
      XCTAssertEqual(decoded.voiceConsentVoiceID, payload.voiceConsentVoiceID)
    }
  }

  func testVerifiedCredentialModelAndVoiceAuthorizeTheRealtimeRoute() {
    let store = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let firstBinding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    store.markVerified(
      capabilities(realtime: ["gpt-realtime-mini", "gpt-realtime"]),
      binding: firstBinding,
      selectDefaultTextModel: true
    )
    store.selectRealtimeVoice(id: "marin")
    XCTAssertEqual(store.selectedRealtimeModelID, "gpt-realtime-mini")
    XCTAssertTrue(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: true))

    store.selectRealtimeVoice(id: "cedar")
    XCTAssertTrue(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: true))

    store.selectRealtimeModel(id: "gpt-realtime")
    XCTAssertTrue(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: true))

    store.markVerified(
      capabilities(realtime: ["gpt-realtime"]),
      binding: OpenAICredentialBinding(revision: "revision-2", fingerprint: "fp-2")
    )
    XCTAssertTrue(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: true))
  }

  func testRealtimeRouteStartsFromSavedVerifiedBYOKAndFreezesAuthority() throws {
    let store = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let binding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    store.markVerified(
      capabilities(realtime: ["gpt-realtime-mini"]),
      binding: binding,
      selectDefaultTextModel: true
    )

    store.selectVoiceProvider(.openAIRealtime, hasSavedCredential: true)
    let route = store.voiceRouteSnapshot()

    XCTAssertTrue(route.isAuthorizedOpenAIRealtime)
    XCTAssertEqual(route.modelID, "gpt-realtime-mini")
    XCTAssertEqual(route.voiceID, "marin")
    XCTAssertEqual(route.credentialBinding, binding)
    XCTAssertEqual(route.modelCatalogVersion, OpenAIModelCatalog.version)
    XCTAssertEqual(route.voiceCatalogVersion, OpenAIRealtimeVoiceCatalog.version)
    store.selectRealtimeVoice(id: "cedar")
    XCTAssertEqual(route.voiceID, "marin", "Existing route snapshot must remain immutable")
    XCTAssertTrue(store.voiceRouteSnapshot().isAuthorizedOpenAIRealtime)
    XCTAssertEqual(store.voiceRouteSnapshot().voiceID, "cedar")
  }

  func testRealtimeRouteAuthorityRejectsForgeryAndMissingOrStaleVersions() throws {
    let authorized = try makeAuthorizedRealtimeVoiceRoute()
    XCTAssertTrue(authorized.isAuthorizedOpenAIRealtime)
    XCTAssertNoThrow(try RealtimeVoiceConfiguration(route: authorized))

    let forged = authorized.removingAuthorityForTesting()
    XCTAssertFalse(forged.isAuthorizedOpenAIRealtime)
    XCTAssertThrowsError(try RealtimeVoiceConfiguration(route: forged))

    let missingVersions = authorized.replacingAuthorityVersionsForTesting(
      modelCatalogVersion: nil,
      voiceCatalogVersion: nil
    )
    XCTAssertFalse(missingVersions.isAuthorizedOpenAIRealtime)
    XCTAssertThrowsError(try RealtimeVoiceConfiguration(route: missingVersions))

    let staleVersions = authorized.replacingAuthorityVersionsForTesting(
      modelCatalogVersion: OpenAIModelCatalog.version - 1,
      voiceCatalogVersion: OpenAIRealtimeVoiceCatalog.version - 1
    )
    XCTAssertFalse(staleVersions.isAuthorizedOpenAIRealtime)
    XCTAssertThrowsError(try RealtimeVoiceConfiguration(route: staleVersions))

    let failed = RealtimeVoiceRouteSnapshot.failedOpenAIRealtime(
      modelID: OpenAIModelCatalog.preferredDefaultRealtimeModelID,
      voiceID: OpenAIRealtimeVoiceCatalog.preferredDefault.id,
      failure: .credentialVerificationRequired
    )
    XCTAssertEqual(failed.authorizationFailure, .credentialVerificationRequired)
    XCTAssertFalse(failed.isAuthorizedOpenAIRealtime)
  }

  func testRealtimeCatalogRejectsArbitraryModelsAndVoices() {
    XCTAssertEqual(
      OpenAIModelCatalog.realtimeOptions.map(\.id),
      ["gpt-realtime-mini", "gpt-realtime"]
    )
    XCTAssertEqual(OpenAIRealtimeVoiceCatalog.reviewed.first, .marin)
    XCTAssertEqual(OpenAIRealtimeVoiceCatalog.reviewed.dropFirst().first, .cedar)
    XCTAssertEqual(Set(OpenAIRealtimeVoiceCatalog.reviewed), Set(OpenAIRealtimeVoice.allCases))

    let store = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let binding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    store.markVerified(
      capabilities(realtime: ["gpt-realtime-mini", "made-up-realtime"]),
      binding: binding,
      selectDefaultTextModel: true
    )
    XCTAssertEqual(store.verifiedRealtimeModelIDs, ["gpt-realtime-mini"])
    store.selectRealtimeVoice(id: "made-up-voice")
    XCTAssertNil(store.selectedRealtimeVoice)
  }

  private func capabilities(realtime: Set<String>) -> OpenAIVerifiedCapabilities {
    OpenAIVerifiedCapabilities(
      catalogVersion: OpenAIModelCatalog.version,
      textModelIDs: ["gpt-5.6-terra"],
      realtimeModelIDs: realtime
    )
  }

  private func makeDefaults() -> UserDefaults {
    let suite = "RealtimeVoiceSettingsTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return defaults
  }
}
