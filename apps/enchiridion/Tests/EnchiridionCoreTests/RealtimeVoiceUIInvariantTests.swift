import Foundation
import Testing

struct RealtimeVoiceUIInvariantTests {
  @Test
  func lobbyStartsOnlyTheExplicitDebugDevelopmentRoute() throws {
    let source = try read("Sources/SharedUI/RealtimeVoiceSurface.swift")

    #expect(source.contains("OpenAIRealtimeVoiceConsentCopy.body"))
    #expect(source.contains("Personal development connection"))
    #expect(
      source.contains(
        "OpenAI Voice requires a backend connection in release builds"
      )
    )
    #expect(source.contains("RealtimeVoiceCoordinator(route: route)"))
    #expect(source.contains("RealtimeVoiceDevelopmentRoute.isEnabled"))
    #expect(!source.contains("URLSession"))
    #expect(!source.lowercased().contains("bearer"))
    #expect(source.contains("accessibilityReduceMotion"))
    #expect(source.contains("frame(width: 56, height: 56)"))
    #expect(source.contains("frame(width: 64, height: 64)"))
    #expect(source.contains("Button(\"Resume\""))
    #expect(source.contains("keyboardShortcut(\"m\", modifiers: [.command, .shift])"))
    #expect(source.contains("keyboardShortcut(\".\", modifiers: .command)"))
    #expect(source.contains("Button(\"Open Sound Settings\""))
    #expect(source.contains("ViewThatFits(in: .horizontal)"))
  }

  @Test
  func presentationAndAudioSafetyAreStructurallyPinned() throws {
    let conversation = try read("Sources/SharedUI/AssistantConversationView.swift")
    let runtime = try read("Sources/SharedUI/AssistantConversationRuntime.swift")

    #expect(conversation.contains(".fullScreenCover(item: $realtimeVoiceLobby)"))
    #expect(conversation.contains(".sheet(item: $realtimeVoiceLobby)"))
    #expect(conversation.contains("#if DEBUG"))
    #expect(conversation.contains("-ShowRealtimeVoiceLobby"))
    #expect(runtime.contains(".playAndRecord"))
    #expect(runtime.contains("mode: .voiceChat"))
    #expect(runtime.contains(".allowBluetoothHFP"))
    #expect(runtime.contains("MacVoiceDeviceChangeEventSource()"))
    #expect(runtime.contains("surface == .app"))
  }

  @Test
  func settingsKeepTextVoiceAndConsentSeparate() throws {
    let source = try read("Sources/SharedUI/AssistantProviderSettingsView.swift")

    #expect(source.contains("Default text provider"))
    #expect(source.contains("Default voice provider"))
    #expect(source.contains("Verified Realtime model"))
    #expect(source.contains("Official OpenAI voice"))
    #expect(source.contains("Revoke OpenAI Voice Consent"))
    #expect(source.contains("Personal development only"))
    #expect(source.contains("Backend required"))
    #expect(source.contains("RealtimeVoiceDevelopmentRoute.isEnabled"))
    #expect(source.contains("CarPlay and App Intents always use Apple On Device"))
    #expect(source.contains("use the saved key for a connection"))
    #expect(!source.contains("read the key"))
  }

  @Test
  func textConsentDisclosureMatchesTheDefaultRoute() throws {
    let source = try read("Sources/SharedUI/AssistantProviderSettingsView.swift")

    #expect(
      source.contains(
        "Enchiridion sends submitted text and bounded OpenAI text-chat history directly from this device to OpenAI."
      )
    )
    #expect(
      source.contains(
        "The default text route sends no notes, tasks, calendar events, local search results, or local-tool outputs."
      )
    )
    #expect(!source.contains("bounded matching task, note, or calendar context"))
  }

  @Test
  func carPlayAndAppIntentRemainAppleOnly() throws {
    let carPlayApp = try read("Sources/iOS/EnchiridioniOSApp.swift")
    let carPlayCoordinator = try read("Sources/iOS/CarPlayVoiceCoordinator.swift")
    let intent = try read("Sources/SharedUI/AssistantAppIntents.swift")
    let forbidden = ["openAIRealtime", "RealtimeVoice", "RealtimeCredential", "RealtimeWebRTC"]

    #expect(carPlayApp.contains("surface: .carPlay"))
    for token in forbidden {
      #expect(!carPlayCoordinator.contains(token))
      #expect(!intent.contains(token))
    }
  }

  @Test
  func microphonePurposeStringsNameTheConditionalOpenAITransfer() throws {
    let expected =
      "only after you explicitly select and consent to OpenAI Voice, sends live audio and transcripts directly to OpenAI"
    let project = try read("project.yml")
    let mobile = try read("Configuration/EnchiridionMobile-Info.plist")
    let mac = try read("Configuration/EnchiridionMac-Info.plist")

    #expect(project.components(separatedBy: expected).count == 3)
    #expect(mobile.contains(expected))
    #expect(mac.contains(expected))
  }

  private func read(_ relativePath: String) throws -> String {
    let testFile = URL(fileURLWithPath: #filePath)
    let appRoot = testFile
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    return try String(
      contentsOf: appRoot.appendingPathComponent(relativePath),
      encoding: .utf8
    )
  }
}
