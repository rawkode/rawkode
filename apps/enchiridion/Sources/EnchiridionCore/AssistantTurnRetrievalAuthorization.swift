import Foundation

/// A local, immutable approval for the data an OpenAI Responses turn may read.
///
/// The application creates this before a request leaves the device. Remote tool
/// arguments can only select work already contained in this value; they cannot
/// expand its query, scope, dates, result caps, or source IDs.
public struct AssistantTurnRetrievalAuthorization: Equatable, Sendable {
  public let noteSearch: AssistantNoteSearchAuthorization?
  public let taskSearch: AssistantTaskSearchAuthorization?
  public let calendarSearch: AssistantCalendarSearchAuthorization?
  public let calendarBrief: AssistantCalendarBriefAuthorization?

  public init(
    noteSearch: AssistantNoteSearchAuthorization? = nil,
    taskSearch: AssistantTaskSearchAuthorization? = nil,
    calendarSearch: AssistantCalendarSearchAuthorization? = nil,
    calendarBrief: AssistantCalendarBriefAuthorization? = nil
  ) {
    self.noteSearch = noteSearch
    self.taskSearch = taskSearch
    self.calendarSearch = calendarSearch
    self.calendarBrief = calendarBrief
  }

  public static let none = AssistantTurnRetrievalAuthorization()

  var allowedTools: [AssistantLocalDataTool] {
    var result: [AssistantLocalDataTool] = []
    if calendarSearch != nil { result.append(.findCalendarEvents) }
    if calendarBrief != nil { result.append(.briefCalendarEvent) }
    if taskSearch != nil { result.append(.searchTasks) }
    if noteSearch != nil { result.append(.searchNotes) }
    return result
  }
}

public enum AssistantLocalDataTool: String, CaseIterable, Equatable, Hashable, Sendable {
  case findCalendarEvents
  case briefCalendarEvent
  case searchTasks
  case searchNotes
}

public enum AssistantTurnRetrievalAuthorizationError: Error, Equatable, Sendable {
  case invalidQuery
  case invalidResultLimit
  case invalidDateRange
  case invalidSourceID
}

/// Complete query strings or terms explicitly approved for one local search.
/// A model may choose only one of these values verbatim.
public struct AssistantApprovedQuery: Equatable, Sendable {
  public let originalQuery: String
  public let approvedQueryTerms: Set<String>

  public init(
    originalQuery: String,
    approvedQueryTerms: Set<String> = []
  ) throws {
    let original = try Self.normalize(originalQuery)
    let approved = try Set(approvedQueryTerms.map { try Self.normalize($0) }).union([original])
    self.originalQuery = original
    self.approvedQueryTerms = approved
  }

  func permits(_ candidate: String) -> Bool {
    guard let normalized = try? Self.normalize(candidate) else { return false }
    return approvedQueryTerms.contains(normalized)
  }

  private static func normalize(_ query: String) throws -> String {
    let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard normalized.count <= LibraryRepository.assistantMaximumQueryLength else {
      throw AssistantTurnRetrievalAuthorizationError.invalidQuery
    }
    return normalized
  }
}

public struct AssistantNoteSearchAuthorization: Equatable, Sendable {
  public let query: AssistantApprovedQuery
  public let maximumResults: Int

  public init(query: AssistantApprovedQuery, maximumResults: Int) throws {
    guard (1...LibraryRepository.assistantMaximumNoteResults).contains(maximumResults) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.query = query
    self.maximumResults = maximumResults
  }
}

public struct AssistantTaskSearchAuthorization: Equatable, Sendable {
  public let scope: AssistantTaskScope
  public let query: AssistantApprovedQuery
  public let maximumResults: Int

  public init(
    scope: AssistantTaskScope,
    query: AssistantApprovedQuery,
    maximumResults: Int
  ) throws {
    guard (1...10).contains(maximumResults) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.scope = scope
    self.query = query
    self.maximumResults = maximumResults
  }
}

public struct AssistantCalendarSearchAuthorization: Equatable, Sendable {
  public let query: AssistantApprovedQuery
  public let start: Date
  public let end: Date
  public let maximumResults: Int
  public let includeOngoing: Bool

  public init(
    query: AssistantApprovedQuery,
    start: Date,
    end: Date,
    maximumResults: Int,
    includeOngoing: Bool
  ) throws {
    guard end > start,
      end.timeIntervalSince(start) <= LibraryRepository.assistantMaximumCalendarDays
    else { throw AssistantTurnRetrievalAuthorizationError.invalidDateRange }
    guard (1...LibraryRepository.assistantMaximumCalendarResults).contains(maximumResults) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.query = query
    self.start = start
    self.end = end
    self.maximumResults = maximumResults
    self.includeOngoing = includeOngoing
  }
}

public struct AssistantCalendarBriefAuthorization: Equatable, Sendable {
  public let allowedSourceIDs: Set<String>
  public let maximumPeople: Int

  public init(allowedSourceIDs: Set<String>, maximumPeople: Int) throws {
    guard !allowedSourceIDs.isEmpty,
      allowedSourceIDs.allSatisfy(Self.isCanonicalCalendarSourceID)
    else { throw AssistantTurnRetrievalAuthorizationError.invalidSourceID }
    guard (1...8).contains(maximumPeople) else {
      throw AssistantTurnRetrievalAuthorizationError.invalidResultLimit
    }
    self.allowedSourceIDs = allowedSourceIDs
    self.maximumPeople = maximumPeople
  }

  private static func isCanonicalCalendarSourceID(_ value: String) -> Bool {
    let prefix = "calendar:"
    guard value.hasPrefix(prefix) else { return false }
    let encoded = String(value.dropFirst(prefix.count))
    guard !encoded.isEmpty, let data = Data(base64Encoded: encoded),
      !data.isEmpty, String(data: data, encoding: .utf8) != nil
    else { return false }
    return data.base64EncodedString() == encoded
  }
}
