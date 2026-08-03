import Foundation

/// A provider-neutral identity for one finalized user input. It is intentionally
/// local: remote item and response identifiers are correlations, never authority.
public struct RealtimeInputTurnID: RawRepresentable, Hashable, Codable, Sendable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}

public struct AssistantToolCallID: RawRepresentable, Hashable, Codable, Sendable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}

/// Provider-neutral wire-independent representation of a local read request.
/// Providers decode their own function-call frame into this compact value.
public struct AssistantLocalToolCall: Equatable, Sendable {
  public let name: AssistantLocalDataTool
  public let callID: AssistantToolCallID
  public let arguments: String

  public init(name: AssistantLocalDataTool, callID: AssistantToolCallID, arguments: String) {
    self.name = name
    self.callID = callID
    self.arguments = arguments
  }
}

/// The neutral local-data registry. The initial implementation delegates to the
/// already hardened executor so all byte caps and authorization checks remain
/// identical while providers stop depending on an OpenAI call type.
struct AssistantLocalToolExecutor {
  let repository: LibraryRepository

  func execute(
    _ call: AssistantLocalToolCall,
    now: Date,
    eligibleCalendarSourceIDs: Set<String>,
    authorization: AssistantTurnRetrievalAuthorization?
  ) async throws -> OpenAILocalToolResult {
    try await OpenAILocalToolExecutor(repository: repository).execute(
      OpenAILocalToolCall(name: call.name.rawValue, callID: call.callID.rawValue, arguments: call.arguments),
      now: now,
      eligibleCalendarSourceIDs: eligibleCalendarSourceIDs,
      authorization: authorization
    )
  }
}

public enum AssistantTaskMutationProposal: Hashable, Sendable {
  case create(callID: AssistantToolCallID, draft: TaskDraft)
  case update(
    callID: AssistantToolCallID,
    pageID: PageID,
    version: TaskPageVersion,
    patch: AssistantTaskMutationPatch
  )
  case complete(callID: AssistantToolCallID, pageID: PageID, version: TaskPageVersion)

  public var callID: AssistantToolCallID {
    switch self { case .create(let id, _), .update(let id, _, _, _), .complete(let id, _, _): id }
  }
}

/// A deliberately small mutation vocabulary. Omitted values preserve the
/// corresponding local field, so existing task metadata never needs to leave
/// the device merely to perform a confirmed edit.
public struct AssistantTaskMutationPatch: Codable, Equatable, Hashable, Sendable {
  public let title: String?
  public let notes: String?
  public let priority: TaskPriority?
  public let placement: TaskPlacement?
  public let estimatedMinutes: Int?

  public init(
    title: String? = nil,
    notes: String? = nil,
    priority: TaskPriority? = nil,
    placement: TaskPlacement? = nil,
    estimatedMinutes: Int? = nil
  ) {
    self.title = title
    self.notes = notes
    self.priority = priority
    self.placement = placement
    self.estimatedMinutes = estimatedMinutes
  }
}

public enum AssistantTaskMutationConfirmationState: Equatable, Sendable {
  case awaitingNativeConfirmation
  case confirmed
  case rejected
  case consumed
}

/// One-shot, immutable mutation proposals. A UI may render and confirm these,
/// but it cannot change their arguments after the model call was received.
public actor AssistantTaskMutationProposalLedger {
  private var proposals: [AssistantToolCallID: AssistantTaskMutationProposal] = [:]
  private var states: [AssistantToolCallID: AssistantTaskMutationConfirmationState] = [:]

  public init() {}

  public func record(_ proposal: AssistantTaskMutationProposal) -> Bool {
    guard proposals[proposal.callID] == nil else { return false }
    proposals[proposal.callID] = proposal
    states[proposal.callID] = .awaitingNativeConfirmation
    return true
  }

  public func proposal(for callID: AssistantToolCallID) -> AssistantTaskMutationProposal? { proposals[callID] }
  public func state(for callID: AssistantToolCallID) -> AssistantTaskMutationConfirmationState? { states[callID] }

  public func confirm(_ callID: AssistantToolCallID) -> Bool {
    guard states[callID] == .awaitingNativeConfirmation else { return false }
    states[callID] = .confirmed
    return true
  }

  public func reject(_ callID: AssistantToolCallID) -> Bool {
    guard states[callID] == .awaitingNativeConfirmation else { return false }
    states[callID] = .rejected
    return true
  }

  public func consumeConfirmed(_ callID: AssistantToolCallID) -> AssistantTaskMutationProposal? {
    guard states[callID] == .confirmed, let proposal = proposals[callID] else { return nil }
    states[callID] = .consumed
    return proposal
  }
}
