import Foundation
import Testing

struct RealtimeVoiceUIInvariantTests {
  @Test
  func lobbyStartsTheDirectBYOKRouteInEveryBuildConfiguration() throws {
    let source = try read("Sources/SharedUI/RealtimeVoiceSurface.swift")

    #expect(source.contains("only in the Authorization header"))
    #expect(source.contains("pinned OpenAI endpoint"))
    #expect(source.contains("never sends notes, tasks, calendars, or local tools"))
    #expect(source.contains("RealtimeVoiceCoordinator(route: route)"))
    #expect(source.contains("coordinator.start(initialLifecycleState: lifecycleState(for: scenePhase))"))
    #expect(source.contains(".task(id: routeID)"))
    #expect(source.contains("guard startedRouteID != routeID else { return }"))
    #expect(!source.contains("Send this voice conversation to OpenAI?"))
    #expect(!source.contains("OpenAIRealtimeVoiceConsentCopy"))
    #expect(source.contains("case .inactive: .inactive"))
    #expect(source.contains("case .background: .background"))
    #expect(!source.contains("RealtimeVoiceDevelopmentRoute"))
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
    #expect(source.contains("RealtimeVoiceRecoveryActions"))
  }

  @Test
  func pausingAudioIsExposedWithoutLiveInputControls() throws {
    let surface = try read("Sources/SharedUI/RealtimeVoiceSurface.swift")
    let runtime = try read("Sources/SharedUI/RealtimeVoiceRuntime.swift")

    #expect(surface.contains("case .pausing(let reason): \"Pausing audio: \\(reason.message)\""))
    #expect(surface.contains("if !isPausing {"))
    #expect(surface.contains("private var isPausing: Bool"))
    #expect(
      runtime.range(
        of: #"case\s+\.idle,[\s\S]*?\.pausing,[\s\S]*?:\s*return\s+false"#,
        options: .regularExpression
      ) != nil
    )
  }

  @Test
  func nativeBootstrapHasNoConfigurationGateOrAlternateCredentialRoute() throws {
    let bootstrap = try read("Sources/EnchiridionCore/RealtimeSessionBootstrap.swift")
    let transport = try read("Sources/SharedUI/RealtimeWebRTCVoiceTransport.swift")

    #expect(bootstrap.contains("public actor DirectBYOKBootstrap"))
    #expect(bootstrap.contains("request.setValue(\"Bearer \\(secret)\", forHTTPHeaderField: \"Authorization\")"))
    #expect(!bootstrap.contains("#if DEBUG"))
    #expect(!bootstrap.contains("developmentRouteDisabled"))
    #expect(!bootstrap.lowercased().contains("ephemeral-secret"))
    #expect(transport.contains("bootstrap: any RealtimeSessionBootstrap = DirectBYOKBootstrap()"))
    #expect(!transport.contains("RealtimeVoiceDevelopmentRoute"))
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
  func settingsUseSavedKeyAsTheSingleBYOKVoiceOptIn() throws {
    let source = try read("Sources/SharedUI/AssistantProviderSettingsView.swift")

    #expect(source.contains("Default text provider"))
    #expect(source.contains("Default voice provider"))
    #expect(source.contains("Verified Realtime model"))
    #expect(source.contains("Official OpenAI voice"))
    #expect(!source.contains("Review & Enable OpenAI Voice"))
    #expect(!source.contains("Use OpenAI Voice?"))
    #expect(source.contains("Saving or verifying this Platform key enables OpenAI Voice"))
    #expect(!source.contains("OpenAIRealtimeVoiceConsentCopy"))
    #expect(source.contains("Direct device BYOK"))
    #expect(source.contains("only in the Authorization header"))
    #expect(source.contains("pinned OpenAI endpoint"))
    #expect(source.contains("CarPlay and App Intents remain Apple On Device"))
    #expect(source.contains("App Intents remain Apple On Device"))
    #expect(!source.contains("Backend required"))
    #expect(!source.contains("Personal development only"))
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
