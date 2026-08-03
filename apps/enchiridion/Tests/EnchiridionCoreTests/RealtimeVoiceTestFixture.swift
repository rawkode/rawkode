import Foundation

@testable import EnchiridionCore

@MainActor
func makeAuthorizedRealtimeVoiceRoute(
  modelID: String = OpenAIModelCatalog.preferredDefaultRealtimeModelID,
  voiceID: String = OpenAIRealtimeVoiceCatalog.preferredDefault.id,
  binding: OpenAICredentialBinding = OpenAICredentialBinding(
    revision: "fixture-revision",
    fingerprint: "fixture-fingerprint"
  )
) throws -> RealtimeVoiceRouteSnapshot {
  let suiteName = "RealtimeVoiceTestFixture.\(UUID().uuidString)"
  guard let defaults = UserDefaults(suiteName: suiteName) else {
    throw CocoaError(.fileNoSuchFile)
  }
  defer { defaults.removePersistentDomain(forName: suiteName) }
  let key = "preferences"
  let payload = AssistantProviderPreferencesPayload(
    credentialRevision: binding.revision,
    credentialFingerprint: binding.fingerprint,
    verifiedCatalogVersion: OpenAIModelCatalog.version,
    verifiedRealtimeModelIDs: [modelID],
    selectedVoiceProvider: .openAIRealtime,
    selectedRealtimeModelID: modelID,
    selectedRealtimeVoiceID: voiceID
  )
  defaults.set(try JSONEncoder().encode(payload), forKey: key)
  return AssistantProviderPreferencesStore(defaults: defaults, key: key).voiceRouteSnapshot()
}
