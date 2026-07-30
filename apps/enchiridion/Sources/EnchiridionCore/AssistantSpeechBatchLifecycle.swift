import Foundation

/// Retains a complete synthesizer batch and fences terminal callbacks by both
/// batch and utterance identity. It intentionally does not own completion or
/// audio-session policy so callers can keep those concerns actor-isolated.
public struct AssistantSpeechBatchLifecycle<Utterance: AnyObject> {
  public private(set) var batchID: UUID?
  public private(set) var utteranceCount = 0

  private var utterances: [Utterance] = []
  private var terminalUtterance: Utterance?

  public init() {}

  public var isActive: Bool { batchID != nil }

  @discardableResult
  public mutating func begin(_ utterances: [Utterance], id: UUID = UUID()) -> UUID? {
    guard let terminalUtterance = utterances.last else {
      clear()
      return nil
    }
    batchID = id
    self.utterances = utterances
    self.terminalUtterance = terminalUtterance
    utteranceCount = utterances.count
    return id
  }

  public func contains(_ utterance: Utterance) -> Bool {
    utterances.contains { $0 === utterance }
  }

  /// Returns and clears the batch only when its terminal utterance finishes.
  public mutating func finish(_ utterance: Utterance) -> UUID? {
    guard utterance === terminalUtterance else { return nil }
    return takeBatchID()
  }

  /// Returns and clears the active batch. An expected identifier fences delayed
  /// cancellation from any newer batch, and repeated cancellation is a no-op.
  public mutating func cancel(batchID expectedBatchID: UUID? = nil) -> UUID? {
    if let expectedBatchID, batchID != expectedBatchID { return nil }
    return takeBatchID()
  }

  private mutating func takeBatchID() -> UUID? {
    let activeBatchID = batchID
    clear()
    return activeBatchID
  }

  private mutating func clear() {
    batchID = nil
    utterances = []
    terminalUtterance = nil
    utteranceCount = 0
  }
}
