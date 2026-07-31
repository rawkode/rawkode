import Foundation
import Testing

struct AssistantPremiumVoiceUIInvariantTests {
  @Test
  func automaticVoicePreferenceNamesItsQualityOrderAndEffectiveFallback() throws {
    let settings = try read("Sources/SharedUI/AssistantVoiceSettingsView.swift")

    #expect(settings.contains("title: \"Best Available\""))
    #expect(
      settings.contains(
        "subtitle: \"Prefers Premium, then Enhanced, then Basic for your language.\""
      )
    )
    #expect(settings.contains("\"Premium is installed and selected.\""))
    #expect(
      settings.contains(
        "\"Premium is not installed for \\(voice.localizedLocaleName). Using Enhanced.\""))
    #expect(
      settings.contains(
        "\"Premium and Enhanced are not installed for \\(voice.localizedLocaleName). Using Basic.\""
      )
    )
    #expect(settings.contains("if preferences.preference == .automatic,"))
  }

  @Test
  func explicitAndUnavailableSelectionsUseTruthfulCauseNeutralCopy() throws {
    let settings = try read("Sources/SharedUI/AssistantVoiceSettingsView.swift")

    #expect(
      settings.contains(
        "Your selected voice is unavailable right now. Best Available is being used until it becomes available again."
      )
    )
    #expect(!settings.contains("selected voice is not installed"))
    #expect(!settings.contains("until that exact voice returns"))
    #expect(settings.contains("if preferences.preference == .automatic,"))
  }

  @Test
  func installedVoiceChangesRefreshThePersistedPickerWithoutChangingCredentialCustody() throws {
    let preferences = try read("Sources/SharedUI/AssistantVoicePreferences.swift")

    #expect(preferences.contains("protocol AssistantSystemVoiceCatalog"))
    #expect(preferences.contains("voiceCatalog: any AssistantSystemVoiceCatalog"))
    #expect(
      preferences.contains(
        "AVSpeechSynthesizer.availableVoicesDidChangeNotification"
      )
    )
    #expect(preferences.contains("store.save(preference)"))
    #expect(preferences.contains("lhs.quality.rawValue > rhs.quality.rawValue"))
    #expect(preferences.contains("func isPreferredLanguage("))
    #expect(preferences.contains("func isPreferredLocale("))
    #expect(!preferences.contains("OpenAICredential"))
    #expect(!preferences.contains("URLSession"))
  }

  @Test
  func everyLocalSpeechSurfaceUsesTheGenerationFencedCoordinator() throws {
    let output = try read("Sources/SharedUI/AppleSystemSpeechOutput.swift")
    let runtime = try read("Sources/SharedUI/AssistantConversationRuntime.swift")
    let preferences = try read("Sources/SharedUI/AssistantVoicePreferences.swift")

    #expect(output.contains("acquireConversationSpeech("))
    #expect(output.contains("releaseConversationSpeech("))
    #expect(runtime.contains("speechOwner: surface == .carPlay ? .carPlay : .assistant"))
    #expect(preferences.contains("let lease = speechCoordinator.acquire("))
    #expect(preferences.contains("owner: .preview"))
    #expect(preferences.contains("isConversationSpeechActive"))
    #expect(output.contains("voice.identifier, privacy: .private"))
    #expect(output.contains("voice.name, privacy: .private"))
  }

  private func read(_ relativePath: String) throws -> String {
    let testFile = URL(fileURLWithPath: #filePath)
    let appRoot =
      testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    return try String(
      contentsOf: appRoot.appendingPathComponent(relativePath),
      encoding: .utf8
    )
  }
}
