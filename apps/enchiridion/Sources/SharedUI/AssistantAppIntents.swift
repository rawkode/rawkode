import AppIntents
import EnchiridionCore
import Foundation

struct AskEnchiridionIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Enchiridion"
  static let description = IntentDescription(
    "Asks Enchiridion's private on-device assistant without opening the app."
  )
  static let openAppWhenRun = false

  @Parameter(
    title: "Question",
    requestValueDialog: IntentDialog("What would you like to ask Enchiridion?")
  )
  var question: String

  static var parameterSummary: some ParameterSummary {
    Summary("Ask Enchiridion \(\.$question)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let normalizedQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedQuestion.isEmpty else { throw AskEnchiridionIntentError.emptyQuestion }

    let repository = try LibraryRepository(path: LibraryRepository.defaultLocalPath())
    let assistant = FoundationModelAssistant(repository: repository)
    let response = await assistant.respond(to: normalizedQuestion)
    return .result(dialog: IntentDialog(stringLiteral: response.answer))
  }
}

private enum AskEnchiridionIntentError: Error, CustomLocalizedStringResourceConvertible {
  case emptyQuestion

  var localizedStringResource: LocalizedStringResource {
    "Ask Enchiridion a question."
  }
}
