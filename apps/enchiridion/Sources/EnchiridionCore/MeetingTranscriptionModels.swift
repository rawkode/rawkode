import CryptoKit
import Foundation

private func canonicalMeetingDate(_ value: Date) -> Date {
  // `JSONEncoder.enchiridion` uses ISO-8601 seconds. Normalize before a value is
  // returned from a write so its later durable round-trip remains idempotent.
  Date(timeIntervalSince1970: floor(value.timeIntervalSince1970))
}

/// The durable, cloud-syncable transcript resource attached to a canonical Event page.
/// It deliberately contains text and semantic metadata only: recording bytes and file locations
/// are never part of a page document.
public struct MeetingTranscriptResource: Codable, Hashable, Sendable, Identifiable {
  public static let format = "enchiridion/meeting-transcript"
  public static let schemaVersion = 1
  public static let maximumResourceBytes = 8 * 1_024 * 1_024
  public static let maximumSegmentCount = 50_000
  public static let maximumDurationSeconds: TimeInterval = 12 * 60 * 60

  public var format: String
  public var schemaVersion: Int
  public var id: String
  public var eventPageID: PageID
  public var provenance: MeetingTranscriptProvenance
  public var transcriptState: MeetingProcessingState
  public var analysisState: MeetingProcessingState
  public var semanticState: MeetingProcessingState
  public var analysisReceipt: MeetingAnalysisReceipt?
  public var semanticReceipt: MeetingSemanticReceipt?
  /// Full bounded analysis is durable JSON in the Event resource, never an audio sidecar.
  public var analysis: MeetingAnalysis?
  public var segments: [MeetingTranscriptSegment]

  public init(
    eventPageID: PageID,
    id: String? = nil,
    provenance: MeetingTranscriptProvenance,
    transcriptState: MeetingProcessingState = .pending,
    analysisState: MeetingProcessingState = .pending,
    semanticState: MeetingProcessingState = .pending,
    analysisReceipt: MeetingAnalysisReceipt? = nil,
    semanticReceipt: MeetingSemanticReceipt? = nil,
    analysis: MeetingAnalysis? = nil,
    segments: [MeetingTranscriptSegment] = []
  ) {
    self.format = Self.format
    self.schemaVersion = Self.schemaVersion
    self.id = id ?? Self.resourceKey(for: eventPageID)
    self.eventPageID = eventPageID
    self.provenance = provenance
    self.transcriptState = transcriptState
    self.analysisState = analysisState
    self.semanticState = semanticState
    self.analysisReceipt = analysisReceipt
    self.semanticReceipt = semanticReceipt
    self.analysis = analysis
    self.segments = segments
  }

  public static func resourceKey(for eventPageID: PageID) -> String {
    let digest = SHA256.hash(data: Data("meeting-transcript-v1\u{0}\(eventPageID.rawValue)".utf8))
      .prefix(20).map { String(format: "%02x", $0) }.joined()
    return "meeting_transcript_\(digest)"
  }
}

public struct MeetingTranscriptProvenance: Codable, Hashable, Sendable {
  public var captureAlgorithm: String
  public var captureAlgorithmVersion: String
  public var transcriptionAlgorithm: String
  public var transcriptionAlgorithmVersion: String
  public var createdAt: Date

  public init(captureAlgorithm: String, captureAlgorithmVersion: String, transcriptionAlgorithm: String, transcriptionAlgorithmVersion: String, createdAt: Date = Date()) {
    self.captureAlgorithm = captureAlgorithm
    self.captureAlgorithmVersion = captureAlgorithmVersion
    self.transcriptionAlgorithm = transcriptionAlgorithm
    self.transcriptionAlgorithmVersion = transcriptionAlgorithmVersion
    self.createdAt = canonicalMeetingDate(createdAt)
  }
}

public enum MeetingProcessingState: String, Codable, Hashable, Sendable, CaseIterable {
  case pending, inProgress, complete, incomplete, resourceLimit, failed

  var rank: Int {
    switch self { case .pending: 0; case .inProgress: 1; case .complete, .incomplete, .resourceLimit, .failed: 2 }
  }

  static func monotonic(_ current: Self, _ incoming: Self) -> Self {
    guard incoming.rank >= current.rank else { return current }
    guard incoming.rank != current.rank else {
      return current.rawValue <= incoming.rawValue ? current : incoming
    }
    return incoming
  }
}

public struct MeetingTranscriptSegment: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var startTime: TimeInterval
  public var endTime: TimeInterval
  public var text: String
  public var speakerClusterID: String
  public var speakerPageID: PageID?
  /// A monotonic user-edit generation. `speakerPageID == nil` with a non-nil
  /// revision is an explicit return to the generic diarization label, rather
  /// than fresh diarization attempting to erase a prior assignment.
  public var speakerAssignmentRevision: UInt64?
  /// Breaks ties deterministically when two devices edit the same generation.
  public var speakerAssignmentOperationID: String?

  public init(
    id: String,
    startTime: TimeInterval,
    endTime: TimeInterval,
    text: String,
    speakerClusterID: String,
    speakerPageID: PageID? = nil,
    speakerAssignmentRevision: UInt64? = nil,
    speakerAssignmentOperationID: String? = nil
  ) {
    self.id = id; self.startTime = startTime; self.endTime = endTime; self.text = text
    self.speakerClusterID = speakerClusterID; self.speakerPageID = speakerPageID
    self.speakerAssignmentRevision = speakerAssignmentRevision
    self.speakerAssignmentOperationID = speakerAssignmentOperationID
  }
}

public struct MeetingAnalysisReceipt: Codable, Hashable, Sendable {
  public var algorithm: String
  public var algorithmVersion: String
  public var completedAt: Date?
  public init(algorithm: String, algorithmVersion: String, completedAt: Date? = nil) {
    self.algorithm = algorithm
    self.algorithmVersion = algorithmVersion
    self.completedAt = completedAt.map(canonicalMeetingDate)
  }
}

public struct MeetingSemanticReceipt: Codable, Hashable, Sendable {
  public var algorithm: String
  public var algorithmVersion: String
  public var completedAt: Date?
  public var operationID: String?
  public var transcriptHash: String?
  public var analysisHash: String?
  public var noteBlockHash: String?
  public var entityOutcomes: [MeetingSemanticEntityOutcome]

  public init(
    algorithm: String,
    algorithmVersion: String,
    completedAt: Date? = nil,
    operationID: String? = nil,
    transcriptHash: String? = nil,
    analysisHash: String? = nil,
    noteBlockHash: String? = nil,
    entityOutcomes: [MeetingSemanticEntityOutcome] = []
  ) {
    self.algorithm = algorithm; self.algorithmVersion = algorithmVersion
    self.completedAt = completedAt.map(canonicalMeetingDate)
    self.operationID = operationID; self.transcriptHash = transcriptHash; self.analysisHash = analysisHash; self.noteBlockHash = noteBlockHash
    self.entityOutcomes = entityOutcomes
  }

  private enum CodingKeys: String, CodingKey { case algorithm, algorithmVersion, completedAt, operationID, transcriptHash, analysisHash, noteBlockHash, entityOutcomes }
  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    algorithm = try values.decode(String.self, forKey: .algorithm)
    algorithmVersion = try values.decode(String.self, forKey: .algorithmVersion)
    completedAt = try values.decodeIfPresent(Date.self, forKey: .completedAt)
    operationID = try values.decodeIfPresent(String.self, forKey: .operationID)
    transcriptHash = try values.decodeIfPresent(String.self, forKey: .transcriptHash)
    analysisHash = try values.decodeIfPresent(String.self, forKey: .analysisHash)
    noteBlockHash = try values.decodeIfPresent(String.self, forKey: .noteBlockHash)
    entityOutcomes = try values.decodeIfPresent([MeetingSemanticEntityOutcome].self, forKey: .entityOutcomes) ?? []
  }
}

public struct MeetingSemanticEntityOutcome: Codable, Hashable, Sendable, Identifiable {
  public enum Disposition: String, Codable, Hashable, Sendable { case created, reused, updated }
  public var proposalID: String
  public var pageID: PageID
  public var disposition: Disposition
  /// SHA-256 of the created page document immediately after automation writes it.
  /// Absence means older receipts cannot prove exclusive ownership for deletion.
  public var createdDocumentHash: String?
  public var id: String { proposalID }
  public init(proposalID: String, pageID: PageID, disposition: Disposition, createdDocumentHash: String? = nil) {
    self.proposalID = proposalID; self.pageID = pageID; self.disposition = disposition; self.createdDocumentHash = createdDocumentHash
  }
}

public enum MeetingTranscriptError: Error, Equatable, LocalizedError {
  case invalidResource
  case resourceLimit
  case changeTooLarge
  public var errorDescription: String? {
    switch self { case .invalidResource: "The meeting transcript resource is invalid."; case .resourceLimit: "The meeting transcript reached its storage limit."; case .changeTooLarge: "The transcript update is too large to sync safely." }
  }
}

public struct MeetingTranscriptWriteReceipt: Hashable, Sendable {
  public var pageID: PageID
  public var resourceKey: String
  public var heads: AutomergeHeads
  public var changed: Bool
  public init(pageID: PageID, resourceKey: String, heads: AutomergeHeads, changed: Bool) { self.pageID = pageID; self.resourceKey = resourceKey; self.heads = heads; self.changed = changed }
}
