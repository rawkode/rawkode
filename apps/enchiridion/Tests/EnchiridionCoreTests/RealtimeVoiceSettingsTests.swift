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
      "verifiedRealtimeModelIDs": ["gpt-realtime-2.1-mini"],
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
      "verifiedRealtimeModelIDs": ["gpt-realtime-2.1-mini"],
      "selectedRealtimeModelID": "gpt-realtime-2.1-mini",
      "selectedRealtimeVoiceID": "marin",
      "voiceConsentVersion": 2,
      "voiceConsentCredentialRevision": "revision-1",
      "voiceConsentCredentialFingerprint": "fp-1",
      "voiceConsentModelCatalogVersion": OpenAIModelCatalog.version,
      "voiceConsentVoiceCatalogVersion": OpenAIRealtimeVoiceCatalog.version,
      "voiceConsentModelID": "gpt-realtime-2.1-mini",
      "voiceConsentVoiceID": "marin",
    ]
    defaults.set(
      try JSONSerialization.data(withJSONObject: legacyPayload),
      forKey: AssistantProviderPreferencesStore.defaultKey
    )

    let store = AssistantProviderPreferencesStore(defaults: defaults)

    XCTAssertEqual(store.selectedVoiceProvider, .openAIRealtime)
    XCTAssertEqual(store.selectedRealtimeModelID, "gpt-realtime-2.1-mini")
    XCTAssertEqual(store.selectedRealtimeVoice, .marin)
    XCTAssertTrue(store.voiceRouteSnapshot().isAuthorizedOpenAIRealtime)
    XCTAssertEqual(store.storedPayloadForTesting.voiceConsentVersion, 2)
  }

  func testVerifiedCredentialModelAndVoiceAuthorizeTheRealtimeRoute() {
    let store = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let firstBinding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    store.markVerified(
      capabilities(realtime: ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"]),
      binding: firstBinding,
      selectDefaultTextModel: true
    )
    store.selectRealtimeVoice(id: "marin")
    XCTAssertEqual(store.selectedRealtimeModelID, "gpt-realtime-2.1-mini")
    XCTAssertTrue(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: true))

    store.selectRealtimeVoice(id: "cedar")
    XCTAssertTrue(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: true))

    store.selectRealtimeModel(id: "gpt-realtime-2.1")
    XCTAssertTrue(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: true))

    store.markVerified(
      capabilities(realtime: ["gpt-realtime-2.1"]),
      binding: OpenAICredentialBinding(revision: "revision-2", fingerprint: "fp-2")
    )
    XCTAssertTrue(store.canSelectVoiceProvider(.openAIRealtime, hasSavedCredential: true))
  }

  func testRealtimeRouteStartsFromSavedVerifiedBYOKAndFreezesAuthority() throws {
    let store = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let binding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    store.markVerified(
      capabilities(realtime: ["gpt-realtime-2.1-mini"]),
      binding: binding,
      selectDefaultTextModel: true
    )

    store.selectVoiceProvider(.openAIRealtime, hasSavedCredential: true)
    let route = store.voiceRouteSnapshot()

    XCTAssertTrue(route.isAuthorizedOpenAIRealtime)
    XCTAssertEqual(route.modelID, "gpt-realtime-2.1-mini")
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
      ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"]
    )
    XCTAssertEqual(OpenAIRealtimeVoiceCatalog.reviewed.first, .marin)
    XCTAssertEqual(OpenAIRealtimeVoiceCatalog.reviewed.dropFirst().first, .cedar)
    XCTAssertEqual(Set(OpenAIRealtimeVoiceCatalog.reviewed), Set(OpenAIRealtimeVoice.allCases))

    let store = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let binding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    store.markVerified(
      capabilities(realtime: ["gpt-realtime-2.1-mini", "made-up-realtime"]),
      binding: binding,
      selectDefaultTextModel: true
    )
    XCTAssertEqual(store.verifiedRealtimeModelIDs, ["gpt-realtime-2.1-mini"])
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
