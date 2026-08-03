import Foundation

/// Builds a bounded, prompt-free local read grant from the finalized Qwen
/// transcript. The remote model may only use the verbatim query, a locally
/// selected task scope, and a fixed 31-day calendar window.
public struct QwenTranscriptAuthorizationPolicy: QwenTranscriptAuthorizing {
  private let now: @Sendable () -> Date

  public init(now: @escaping @Sendable () -> Date = Date.init) {
    self.now = now
  }

  public func authorization(
    for transcript: String
  ) async -> AssistantTurnRetrievalAuthorization {
    do {
      let query = try AssistantApprovedQuery(originalQuery: transcript)
      let taskQuery = try AssistantApprovedQuery(
        originalQuery: "",
        approvedQueryTerms: [transcript]
      )
      let current = now()
      let calendarStart = current.addingTimeInterval(-24 * 60 * 60)
      let calendarEnd = calendarStart.addingTimeInterval(
        LibraryRepository.assistantMaximumCalendarDays
      )
      return AssistantTurnRetrievalAuthorization(
        noteSearch: try AssistantNoteSearchAuthorization(
          query: query,
          maximumResults: 5
        ),
        taskSearch: try AssistantTaskSearchAuthorization(
          scope: Self.taskScope(for: transcript),
          query: taskQuery,
          maximumResults: 5
        ),
        calendarSearch: try AssistantCalendarSearchAuthorization(
          query: query,
          start: calendarStart,
          end: calendarEnd,
          maximumResults: 10,
          includeOngoing: true
        )
      )
    } catch {
      return .none
    }
  }

  private static func taskScope(for transcript: String) -> AssistantTaskScope {
    let value = transcript.folding(
      options: [.caseInsensitive, .diacriticInsensitive],
      locale: .current
    )
    if value.contains("tomorrow") { return .tomorrow }
    if value.contains("today") { return .today }
    if value.contains("inbox") { return .inbox }
    if value.contains("upcoming") { return .upcoming }
    if value.contains("anytime") { return .anytime }
    if value.contains("someday") { return .someday }
    if value.contains("logbook") || value.contains("completed") { return .logbook }
    return .all
  }
}
