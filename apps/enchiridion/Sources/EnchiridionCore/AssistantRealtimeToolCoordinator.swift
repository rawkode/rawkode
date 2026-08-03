import Foundation

public struct AssistantRealtimeToolCall: Equatable, Sendable {
  public let name: String
  public let callID: AssistantToolCallID
  public let arguments: String

  public init(name: String, callID: AssistantToolCallID, arguments: String) {
    self.name = name
    self.callID = callID
    self.arguments = arguments
  }
}

public struct AssistantToolTerminalOutput: Equatable, Sendable {
  public let callID: AssistantToolCallID
  public let json: String

  public init(callID: AssistantToolCallID, json: String) {
    self.callID = callID
    self.json = json
  }
}

public enum AssistantRealtimeToolDisposition: Equatable, Sendable {
  case terminal(AssistantToolTerminalOutput)
  case confirmation(AssistantTaskMutationProposal)
}

public enum AssistantRealtimeToolError: Error, Equatable, Sendable {
  case invalidCall
  case oversizedArguments
  case replayedCall
}

/// Session-scoped provider-neutral tool execution. Callers supply the immutable
/// per-turn read authorization; mutating calls never execute until confirm.
public actor AssistantRealtimeToolCoordinator {
  public static let maximumArgumentsBytes = 16 * 1_024
  public static let maximumTerminalBytes = 64 * 1_024

  private let repository: LibraryRepository
  private let mutations: TaskMutationCoordinator
  private let proposals: AssistantTaskMutationProposalLedger
  private var eligibleCalendarSourceIDs: Set<String> = []
  private var eligibleTaskVersions: [PageID: TaskPageVersion] = [:]
  private var receivedCallIDs: Set<AssistantToolCallID> = []

  public init(
    repository: LibraryRepository,
    mutations: TaskMutationCoordinator,
    proposals: AssistantTaskMutationProposalLedger = .init()
  ) {
    self.repository = repository
    self.mutations = mutations
    self.proposals = proposals
  }

  public func beginInputTurn() {
    eligibleCalendarSourceIDs.removeAll()
    eligibleTaskVersions.removeAll()
    receivedCallIDs.removeAll()
  }

  public func receive(
    _ call: AssistantRealtimeToolCall,
    authorization: AssistantTurnRetrievalAuthorization,
    now: Date = Date()
  ) async throws -> AssistantRealtimeToolDisposition {
    guard receivedCallIDs.insert(call.callID).inserted else { throw AssistantRealtimeToolError.replayedCall }
    let decoded = try Self.decode(call)
    switch decoded {
    case .read(let tool):
      let effectiveAuthorization = try authorizationForRead(
        tool,
        base: authorization
      )
      let result = try await AssistantLocalToolExecutor(repository: repository).execute(
        tool,
        now: now,
        eligibleCalendarSourceIDs: eligibleCalendarSourceIDs,
        authorization: effectiveAuthorization
      )
      eligibleCalendarSourceIDs.formUnion(result.eligibleCalendarSourceIDs)
      if tool.name == .searchTasks {
        try await recordEligibleTaskVersions(from: result.sources)
      }
      return .terminal(
        try Self.terminal(
          call.callID,
          status: "success",
          payload: result.output,
          taskVersions: tool.name == .searchTasks ? eligibleTaskVersions : [:]
        )
      )
    case .mutation(let proposal):
      switch proposal {
      case .create:
        break
      case .update(_, let pageID, let version, _),
        .complete(_, let pageID, let version):
        guard eligibleTaskVersions[pageID] == version else {
          throw AssistantRealtimeToolError.invalidCall
        }
      }
      guard await proposals.record(proposal) else { throw AssistantRealtimeToolError.replayedCall }
      return .confirmation(proposal)
    }
  }

  public func confirm(_ callID: AssistantToolCallID, now: Date = Date()) async -> AssistantToolTerminalOutput {
    guard await proposals.confirm(callID), let proposal = await proposals.consumeConfirmed(callID) else {
      return Self.safeTerminal(callID, status: "rejected")
    }
    switch proposal {
    case .create(_, let draft):
      switch await mutations.create(draft, now: now) {
      case .success(let value): return Self.safeTerminal(callID, status: "success", pageID: value.value.id.rawValue)
      case .failure: return Self.safeTerminal(callID, status: "failed")
      }
    case .update(_, let pageID, let version, let patch):
      guard let page = try? await repository.page(id: pageID), var data = page.taskData else {
        return Self.safeTerminal(callID, status: "failed")
      }
      if let priority = patch.priority { data.priority = priority }
      if let placement = patch.placement { data.placement = placement }
      if let estimatedMinutes = patch.estimatedMinutes {
        data.estimatedMinutes = max(1, min(estimatedMinutes, 24 * 60))
      }
      switch await mutations.update(
        pageID: pageID,
        data: data,
        title: patch.title,
        notes: patch.notes,
        expectedVersion: version,
        now: now
      ) {
      case .success: return Self.safeTerminal(callID, status: "success", pageID: pageID.rawValue)
      case .failure(let failure): return Self.safeTerminal(callID, status: failure.reason == .clarificationStale ? "conflict" : "failed")
      }
    case .complete(_, let pageID, let version):
      switch await mutations.complete(pageID, expectedVersion: version, now: now) {
      case .success: return Self.safeTerminal(callID, status: "success", pageID: pageID.rawValue)
      case .failure(let failure): return Self.safeTerminal(callID, status: failure.reason == .clarificationStale ? "conflict" : "failed")
      }
    }
  }

  public func reject(_ callID: AssistantToolCallID) async -> AssistantToolTerminalOutput {
    _ = await proposals.reject(callID)
    return Self.safeTerminal(callID, status: "rejected")
  }

  private enum Decoded { case read(AssistantLocalToolCall); case mutation(AssistantTaskMutationProposal) }

  private static func decode(_ call: AssistantRealtimeToolCall) throws -> Decoded {
    guard call.arguments.utf8.count <= maximumArgumentsBytes else { throw AssistantRealtimeToolError.oversizedArguments }
    guard let data = call.arguments.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { throw AssistantRealtimeToolError.invalidCall }
    if let name = AssistantLocalDataTool(rawValue: call.name) {
      let expected: Set<String>
      switch name {
      case .findCalendarEvents: expected = ["query", "start", "end", "limit", "includeOngoing"]
      case .briefCalendarEvent: expected = ["sourceID", "peopleLimit"]
      case .searchTasks: expected = ["scope", "query", "limit"]
      case .searchNotes: expected = ["query", "limit"]
      }
      guard Set(object.keys) == expected else { throw AssistantRealtimeToolError.invalidCall }
      return .read(.init(name: name, callID: call.callID, arguments: call.arguments))
    }
    let decoder = JSONDecoder()
    switch call.name {
    case "create_task":
      guard Set(object.keys) == ["title", "notes", "data"],
        let taskData = object["data"] as? [String: Any],
        Set(taskData.keys) == [
          "state", "placement", "scheduleGranularity", "priority", "tags",
          "estimatedMinutes",
        ],
        let value = try? decoder.decode(CreateArguments.self, from: data),
        !value.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else { throw AssistantRealtimeToolError.invalidCall }
      return .mutation(.create(callID: call.callID, draft: TaskDraft(title: value.title, notes: value.notes, data: value.data)))
    case "update_task":
      guard Set(object.keys) == ["pageID", "version", "patch"],
        strictVersion(object["version"]),
        let patchObject = object["patch"] as? [String: Any],
        Set(patchObject.keys) == [
          "title", "notes", "priority", "placement", "estimatedMinutes",
        ],
        let value = try? decoder.decode(UpdateArguments.self, from: data),
        value.version.id == value.pageID,
        value.patch.title != nil || value.patch.notes != nil
          || value.patch.priority != nil || value.patch.placement != nil
          || value.patch.estimatedMinutes != nil
      else { throw AssistantRealtimeToolError.invalidCall }
      return .mutation(
        .update(
          callID: call.callID,
          pageID: value.pageID,
          version: value.version,
          patch: value.patch
        )
      )
    case "complete_task":
      guard Set(object.keys) == ["pageID", "version"],
        strictVersion(object["version"]),
        let value = try? decoder.decode(CompleteArguments.self, from: data),
        value.version.id == value.pageID
      else { throw AssistantRealtimeToolError.invalidCall }
      return .mutation(.complete(callID: call.callID, pageID: value.pageID, version: value.version))
    default: throw AssistantRealtimeToolError.invalidCall
    }
  }

  private struct CreateArguments: Decodable { let title: String; let notes: String; let data: TaskData }
  private struct UpdateArguments: Decodable {
    let pageID: PageID
    let version: TaskPageVersion
    let patch: AssistantTaskMutationPatch
  }
  private struct CompleteArguments: Decodable { let pageID: PageID; let version: TaskPageVersion }

  private static func strictVersion(_ value: Any?) -> Bool {
    guard let version = value as? [String: Any],
      Set(version.keys) == ["id", "heads", "dirtyGeneration"],
      let heads = version["heads"] as? [String: Any],
      Set(heads.keys) == ["values"]
    else { return false }
    return true
  }

  private func authorizationForRead(
    _ call: AssistantLocalToolCall,
    base: AssistantTurnRetrievalAuthorization
  ) throws -> AssistantTurnRetrievalAuthorization {
    guard call.name == .briefCalendarEvent, base.calendarBrief == nil else {
      return base
    }
    guard !eligibleCalendarSourceIDs.isEmpty else { return base }
    return AssistantTurnRetrievalAuthorization(
      noteSearch: base.noteSearch,
      taskSearch: base.taskSearch,
      calendarSearch: base.calendarSearch,
      calendarBrief: try AssistantCalendarBriefAuthorization(
        allowedSourceIDs: eligibleCalendarSourceIDs,
        maximumPeople: 8
      )
    )
  }

  private func recordEligibleTaskVersions(from sources: [AssistantSource]) async throws {
    for source in sources where source.id.hasPrefix("task:") {
      let rawID = String(source.id.dropFirst("task:".count))
      let pageID = PageID(rawValue: rawID)
      guard let page = try await repository.page(id: pageID), page.taskData != nil else {
        continue
      }
      eligibleTaskVersions[pageID] = TaskPageVersion(page)
    }
  }

  private static func terminal(
    _ callID: AssistantToolCallID,
    status: String,
    payload: String? = nil,
    pageID: String? = nil,
    taskVersions: [PageID: TaskPageVersion] = [:]
  ) throws -> AssistantToolTerminalOutput {
    var object: [String: Any] = ["status": status]
    if let payload { object["result"] = try JSONSerialization.jsonObject(with: Data(payload.utf8)) }
    if let pageID { object["pageID"] = pageID }
    if !taskVersions.isEmpty {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.sortedKeys]
      object["taskVersions"] = try taskVersions
        .sorted { $0.key.rawValue < $1.key.rawValue }
        .map { pageID, version in
          [
            "pageID": pageID.rawValue,
            "version": try JSONSerialization.jsonObject(
              with: encoder.encode(version)
            ),
          ] as [String: Any]
        }
    }
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    guard data.count <= maximumTerminalBytes else { throw AssistantRealtimeToolError.invalidCall }
    return .init(callID: callID, json: String(decoding: data, as: UTF8.self))
  }

  private static func safeTerminal(_ callID: AssistantToolCallID, status: String, pageID: String? = nil) -> AssistantToolTerminalOutput {
    (try? terminal(callID, status: status, pageID: pageID)) ?? .init(callID: callID, json: #"{"status":"failed"}"#)
  }
}
