import EnchiridionCore
import Foundation

@MainActor
func makeAssistantConversationSession(
  assistant: FoundationModelAssistant?
) -> AssistantConversationSession? {
  guard let assistant else { return nil }
  if #available(iOS 26.0, macOS 26.0, *) {
    return AssistantConversationSession(
      transcriber: OnDeviceSpeechTranscriber(),
      answerer: assistant
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
