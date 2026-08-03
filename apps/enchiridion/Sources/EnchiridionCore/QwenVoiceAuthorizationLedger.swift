import Foundation

/// Causally binds realtime tool authority to a locally finalized transcript.
/// Server identifiers are accepted only after they have been chained to the
/// current generation and input turn; a stale/replayed event therefore cannot
/// obtain access to another turn's local data.
public actor QwenVoiceAuthorizationLedger {
  public enum Failure: Error, Equatable, Sendable {
    case unknownTurn
    case staleGeneration
    case unboundItem
    case unboundResponse
    case duplicateCall
    case responseNotReady
  }

  private struct Turn: Sendable {
    let authorization: AssistantTurnRetrievalAuthorization
    var itemIDs: Set<String> = []
    var responseIDs: Set<String> = []
    var callIDs: Set<AssistantToolCallID> = []
    var terminalOutputs: Set<AssistantToolCallID> = []
    var retired = false
  }

  private var generation: UInt64 = 0
  private var turns: [RealtimeInputTurnID: Turn] = [:]
  private var itemTurn: [String: RealtimeInputTurnID] = [:]
  private var responseTurn: [String: RealtimeInputTurnID] = [:]

  public init() {}

  public func beginGeneration(_ value: UInt64) {
    generation = value
    turns.removeAll(); itemTurn.removeAll(); responseTurn.removeAll()
  }

  public func finalizeTranscript(
    generation value: UInt64,
    turnID: RealtimeInputTurnID,
    authorization: AssistantTurnRetrievalAuthorization
  ) throws {
    guard value == generation else { throw Failure.staleGeneration }
    // New speech invalidates authority from earlier inputs in this session.
    for key in turns.keys { turns[key]?.retired = true }
    turns[turnID] = Turn(authorization: authorization)
  }

  public func bindInputItem(
    generation value: UInt64, itemID: String, to turnID: RealtimeInputTurnID
  ) throws {
    guard value == generation else { throw Failure.staleGeneration }
    guard var turn = turns[turnID], !turn.retired, itemTurn[itemID] == nil else { throw Failure.unboundItem }
    turn.itemIDs.insert(itemID); turns[turnID] = turn; itemTurn[itemID] = turnID
  }

  public func bindResponse(
    generation value: UInt64, responseID: String, forItem itemID: String
  ) throws {
    guard value == generation else { throw Failure.staleGeneration }
    guard let turnID = itemTurn[itemID], var turn = turns[turnID], !turn.retired,
      responseTurn[responseID] == nil else { throw Failure.unboundItem }
    turn.responseIDs.insert(responseID); turns[turnID] = turn; responseTurn[responseID] = turnID
  }

  public func authorization(
    generation value: UInt64, responseID: String, callID: AssistantToolCallID
  ) throws -> AssistantTurnRetrievalAuthorization {
    guard value == generation else { throw Failure.staleGeneration }
    guard let turnID = responseTurn[responseID], var turn = turns[turnID], !turn.retired else { throw Failure.unboundResponse }
    guard turn.callIDs.insert(callID).inserted else { throw Failure.duplicateCall }
    turns[turnID] = turn
    return turn.authorization
  }

  /// A follow-up response is legal only after every call of its predecessor
  /// has a terminal output. This prevents arbitrary response.create chaining.
  public func recordTerminalOutput(
    generation value: UInt64, responseID: String, callID: AssistantToolCallID
  ) throws {
    guard value == generation else { throw Failure.staleGeneration }
    guard let turnID = responseTurn[responseID], var turn = turns[turnID], turn.callIDs.contains(callID) else { throw Failure.unboundResponse }
    turn.terminalOutputs.insert(callID); turns[turnID] = turn
  }

  public func bindFollowUpResponse(
    generation value: UInt64, responseID: String, after responseIDBefore: String
  ) throws {
    guard value == generation else { throw Failure.staleGeneration }
    guard let turnID = responseTurn[responseIDBefore], var turn = turns[turnID], !turn.retired,
      !turn.callIDs.isEmpty, turn.callIDs == turn.terminalOutputs, responseTurn[responseID] == nil
    else { throw Failure.responseNotReady }
    turn.responseIDs.insert(responseID); turns[turnID] = turn; responseTurn[responseID] = turnID
  }

  public func retire(generation value: UInt64, turnID: RealtimeInputTurnID? = nil) {
    guard value == generation else { return }
    if let turnID { turns[turnID]?.retired = true }
    else { for key in turns.keys { turns[key]?.retired = true } }
  }
}
