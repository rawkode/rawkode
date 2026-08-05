import CryptoKit
import Foundation

/// A recognizer is deliberately independent from meeting analysis.  In particular, a
/// recognizer receives no vault/page access and cannot create semantic entities.
public protocol MeetingTranscribing: Sendable {
  func transcribe(authority: MeetingAutomationAuthority) async throws -> AsyncThrowingStream<MeetingTranscriptUpdate, Error>
}

public enum MeetingTranscriptUpdate: Sendable, Equatable {
  case partial([MeetingTranscriptSegment])
  case final([MeetingTranscriptSegment])
}

public struct MeetingTranscriptSnapshot: Sendable, Equatable {
  public let resource: MeetingTranscriptResource
  public let hash: String

  public init(resource: MeetingTranscriptResource) {
    self.resource = resource
    hash = MeetingTranscriptHash.value(for: resource.segments)
  }
}

/// Persistence is intentionally the only mutation seam. Implementations must merge
/// monotonically (never regress states or remove previously persisted segments).
public protocol MeetingTranscriptPersisting: Sendable {
  func persist(_ snapshot: MeetingTranscriptSnapshot, authority: MeetingAutomationAuthority) async throws
}

public enum MeetingTranscriptHash {
  public static func value(for segments: [MeetingTranscriptSegment]) -> String {
    // Person assignments are user-owned annotations, not model input. Excluding
    // them keeps a post-call assignment or clear from invalidating the already
    // persisted analysis and semantic receipt.
    struct CanonicalSegment: Encodable {
      let id: String
      let startTime: TimeInterval
      let endTime: TimeInterval
      let text: String
      let speakerClusterID: String
    }
    let encoder = JSONEncoder.enchiridion
    encoder.outputFormatting = [.sortedKeys]
    let canonical = segments.sorted { ($0.startTime, $0.id) < ($1.startTime, $1.id) }.map {
      CanonicalSegment(
        id: $0.id,
        startTime: $0.startTime,
        endTime: $0.endTime,
        text: $0.text,
        speakerClusterID: $0.speakerClusterID
      )
    }
    let data = (try? encoder.encode(canonical)) ?? Data()
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

public enum MeetingSessionError: Error, Equatable, Sendable {
  case sessionAlreadyActive
  case staleAuthority
  case finalTranscriptRequired
}

/// Owns one Start-authorized transcription.  The authority is copied once here; no
/// setting/provider lookup occurs after start.  A generation guards delayed stream
/// callbacks and analysis can only receive the exact final transcript hash.
public actor MeetingTranscriptionSession {
  private let transcriber: any MeetingTranscribing
  private let persistence: any MeetingTranscriptPersisting
  private var generation: UInt64 = 0
  private var active: Active?

  public init(transcriber: any MeetingTranscribing, persistence: any MeetingTranscriptPersisting) {
    self.transcriber = transcriber
    self.persistence = persistence
  }

  @discardableResult
  public func start(authority: MeetingAutomationAuthority, resource: MeetingTranscriptResource) async throws -> UInt64 {
    guard active == nil else { throw MeetingSessionError.sessionAlreadyActive }
    guard authority.capabilities.mayWriteTranscriptResource, resource.eventPageID == authority.eventPageID else {
      throw MeetingSessionError.staleAuthority
    }
    generation &+= 1
    let capturedGeneration = generation
    // value copies freeze routes/expiry/capabilities at Start.
    let capturedAuthority = authority
    var initial = resource
    initial.transcriptState = .inProgress
    let state = Active(authority: capturedAuthority, resource: initial, didReceiveFinal: false)
    active = state
    try await persistIfCurrent(capturedGeneration)
    Task { [weak self, transcriber] in
      do {
        let stream = try await transcriber.transcribe(authority: capturedAuthority)
        for try await update in stream { await self?.accept(update, generation: capturedGeneration) }
      } catch {
        await self?.fail(generation: capturedGeneration)
      }
    }
    return capturedGeneration
  }

  public func cancel() async {
    generation &+= 1
    active = nil
  }

  public func finalSnapshot() throws -> (MeetingTranscriptSnapshot, MeetingAutomationCompletionAuthority) {
    guard let active, active.didReceiveFinal else { throw MeetingSessionError.finalTranscriptRequired }
    let snapshot = MeetingTranscriptSnapshot(resource: active.resource)
    guard let completion = active.authority.completion(transcriptHash: snapshot.hash) else { throw MeetingSessionError.staleAuthority }
    return (snapshot, completion)
  }

  private func accept(_ update: MeetingTranscriptUpdate, generation expected: UInt64) async {
    guard expected == generation, var state = active else { return }
    let incoming: [MeetingTranscriptSegment]
    switch update {
    case .partial(let segments): incoming = segments
    case .final(let segments): incoming = segments; state.didReceiveFinal = true
    }
    state.resource.segments = merged(state.resource.segments, incoming)
    state.resource.transcriptState = state.didReceiveFinal ? .complete : .inProgress
    active = state
    do { try await persistIfCurrent(expected) } catch { await fail(generation: expected) }
  }

  private func fail(generation expected: UInt64) async {
    guard expected == generation, var state = active else { return }
    state.resource.transcriptState = .monotonic(state.resource.transcriptState, .failed)
    active = state
    try? await persistIfCurrent(expected)
  }

  private func persistIfCurrent(_ expected: UInt64) async throws {
    guard expected == generation, let state = active else { return }
    let snapshot = MeetingTranscriptSnapshot(resource: state.resource)
    try await persistence.persist(snapshot, authority: state.authority)
  }

  private func merged(_ existing: [MeetingTranscriptSegment], _ incoming: [MeetingTranscriptSegment]) -> [MeetingTranscriptSegment] {
    var result = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })
    for segment in incoming { result[segment.id] = segment }
    return result.values.sorted { ($0.startTime, $0.id) < ($1.startTime, $1.id) }
  }

  private struct Active: Sendable {
    let authority: MeetingAutomationAuthority
    var resource: MeetingTranscriptResource
    var didReceiveFinal: Bool
  }
}
