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
    XCTAssertFalse(store.hasCurrentVoiceConsent)
  }

  func testVoiceConsentBindsCredentialCatalogModelAndVoice() {
    let store = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let firstBinding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    store.markVerified(
      capabilities(realtime: ["gpt-realtime-2.1-mini", "gpt-realtime-2.1"]),
      binding: firstBinding,
      selectDefaultTextModel: true
    )
    store.selectRealtimeVoice(id: "marin")
    store.setVoiceConsent(true)

    XCTAssertTrue(store.hasCurrentVoiceConsent)
    XCTAssertEqual(store.selectedRealtimeModelID, "gpt-realtime-2.1-mini")

    store.selectRealtimeVoice(id: "cedar")
    XCTAssertFalse(store.hasCurrentVoiceConsent)
    store.setVoiceConsent(true)
    XCTAssertTrue(store.hasCurrentVoiceConsent)

    store.selectRealtimeModel(id: "gpt-realtime-2.1")
    XCTAssertFalse(store.hasCurrentVoiceConsent)
    store.setVoiceConsent(true)
    XCTAssertTrue(store.hasCurrentVoiceConsent)

    store.markVerified(
      capabilities(realtime: ["gpt-realtime-2.1"]),
      binding: OpenAICredentialBinding(revision: "revision-2", fingerprint: "fp-2")
    )
    XCTAssertFalse(store.hasCurrentVoiceConsent)
  }

  func testRealtimeRouteFailsClosedUntilExactConsentThenFreezesAuthority() throws {
    let store = AssistantProviderPreferencesStore(defaults: makeDefaults())
    let binding = OpenAICredentialBinding(revision: "revision-1", fingerprint: "fp-1")
    store.markVerified(
      capabilities(realtime: ["gpt-realtime-2.1-mini"]),
      binding: binding,
      selectDefaultTextModel: true
    )

    store.selectVoiceProvider(.openAIRealtime, hasSavedCredential: true)
    XCTAssertEqual(store.selectedVoiceProvider, .appleOnDevice)

    store.setVoiceConsent(true)
    store.selectVoiceProvider(.openAIRealtime, hasSavedCredential: true)
    let route = store.voiceRouteSnapshot()

    XCTAssertTrue(route.isAuthorizedOpenAIRealtime)
    XCTAssertEqual(route.modelID, "gpt-realtime-2.1-mini")
    XCTAssertEqual(route.voiceID, "marin")
    XCTAssertEqual(route.credentialBinding, binding)
    XCTAssertEqual(route.modelCatalogVersion, OpenAIModelCatalog.version)
    XCTAssertEqual(route.voiceCatalogVersion, OpenAIRealtimeVoiceCatalog.version)
    XCTAssertEqual(
      route.consentVersion,
      AssistantProviderPreferencesPayload.currentVoiceConsentVersion
    )

    store.selectRealtimeVoice(id: "cedar")
    XCTAssertEqual(route.voiceID, "marin", "Existing route snapshot must remain immutable")
    XCTAssertEqual(store.voiceRouteSnapshot().authorizationFailure, .consentRequired)
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
      voiceCatalogVersion: nil,
      consentVersion: nil
    )
    XCTAssertFalse(missingVersions.isAuthorizedOpenAIRealtime)
    XCTAssertThrowsError(try RealtimeVoiceConfiguration(route: missingVersions))

    let staleVersions = authorized.replacingAuthorityVersionsForTesting(
      modelCatalogVersion: OpenAIModelCatalog.version - 1,
      voiceCatalogVersion: OpenAIRealtimeVoiceCatalog.version - 1,
      consentVersion: OpenAIRealtimeVoiceConsentCopy.version - 1
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

  func testConsentCopyStatesDirectDeviceNoLocalDataRetentionBillingAndAppleBoundaries() {
    let copy = OpenAIRealtimeVoiceConsentCopy.body
    XCTAssertTrue(copy.contains("live microphone audio"))
    XCTAssertTrue(copy.contains("does not send notes, tasks, calendars"))
    XCTAssertTrue(copy.contains("Keychain"))
    XCTAssertTrue(copy.contains("differs from OpenAI's recommended backend key custody"))
    XCTAssertTrue(copy.contains("not used to train"))
    XCTAssertTrue(copy.contains("no application-state retention"))
    XCTAssertTrue(copy.contains("up to 30 days"))
    XCTAssertTrue(copy.contains("billed separately from ChatGPT"))
    XCTAssertTrue(copy.contains("CarPlay and App Intents always use Apple On Device"))
    XCTAssertEqual(OpenAIRealtimeVoiceConsentCopy.startActionTitle, "Start OpenAI Voice")
    XCTAssertEqual(OpenAIRealtimeVoiceConsentCopy.keepAppleActionTitle, "Keep Apple")
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
