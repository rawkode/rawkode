import EnchiridionCore
import Foundation

#if os(iOS)
  import AVFoundation

  @MainActor
  protocol HandheldConversationAudioSessionBacking: AnyObject {
    func setCategory(
      _ category: AVAudioSession.Category,
      mode: AVAudioSession.Mode,
      options: AVAudioSession.CategoryOptions
    ) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
  }

  @MainActor
  private final class SystemHandheldConversationAudioSessionBackend:
    HandheldConversationAudioSessionBacking
  {
    private let audioSession: AVAudioSession

    init(audioSession: AVAudioSession = .sharedInstance()) {
      self.audioSession = audioSession
    }

    func setCategory(
      _ category: AVAudioSession.Category,
      mode: AVAudioSession.Mode,
      options: AVAudioSession.CategoryOptions
    ) throws {
      try audioSession.setCategory(category, mode: mode, options: options)
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
      try audioSession.setActive(active, options: options)
    }
  }

  @MainActor
  final class HandheldConversationAudioSessionController:
    AssistantConversationAudioSessionControlling
  {
    private let backend: any HandheldConversationAudioSessionBacking
    private var isActive = false

    init(
      backend: any HandheldConversationAudioSessionBacking =
        SystemHandheldConversationAudioSessionBackend()
    ) {
      self.backend = backend
    }

    func activate() async throws {
      guard !isActive else { return }
      try backend.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.defaultToSpeaker, .allowBluetoothHFP]
      )
      try backend.setActive(true, options: [])
      isActive = true
    }

    func deactivate() async {
      guard isActive else { return }
      isActive = false
      try? backend.setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
#endif

enum AssistantConversationSurface: Equatable {
  case app
  case carPlay
}

@MainActor
func makeAssistantConversationSession(
  assistant: FoundationModelAssistant?,
  voicePreferences: AssistantVoicePreferences,
  surface: AssistantConversationSurface = .app
) -> AssistantConversationSession? {
  guard let assistant else { return nil }
  if #available(iOS 26.0, macOS 26.0, *) {
    #if os(iOS)
      let audioSessionController: (any AssistantConversationAudioSessionControlling)? =
        surface == .app ? HandheldConversationAudioSessionController() : nil
    #else
      let audioSessionController: (any AssistantConversationAudioSessionControlling)? = nil
    #endif
    return AssistantConversationSession(
      transcriber: OnDeviceSpeechTranscriber(),
      answerer: assistant,
      speaker: AppleSystemSpeechOutput(
        voicePreferences: voicePreferences
      ),
      audioSessionController: audioSessionController,
      speaksResponses: true
    )
  }
  return AssistantConversationSession(answerer: assistant)
}

func assistantUnavailabilityMessage(
  assistant: FoundationModelAssistant?,
  repositoryError: String?
) -> String? {
  if let repositoryError { return "Your local library could not be opened: \(repositoryError)" }
  guard assistant != nil else { return "Your local library is unavailable." }
  let availability = FoundationModelAssistant.availability()
  return availability == .available ? nil : availability.message
}
