import EnchiridionCore
import Foundation

enum AssistantConversationSurface: Equatable {
  case app
  case carPlay
}

@MainActor
func makeAssistantConversationSession(
  assistant: FoundationModelAssistant?,
  surface: AssistantConversationSurface = .app
) -> AssistantConversationSession? {
  guard let assistant else { return nil }
  if #available(iOS 26.0, macOS 26.0, *) {
    let managesIOSAudioSession = surface != .carPlay
    return AssistantConversationSession(
      transcriber: OnDeviceSpeechTranscriber(
        managesIOSAudioSession: managesIOSAudioSession
      ),
      answerer: assistant,
      speaker: AppleSystemSpeechOutput(
        managesIOSAudioSession: managesIOSAudioSession
      ),
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
