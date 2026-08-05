import CryptoKit
import Foundation

public enum MeetingSemanticSchemaFingerprint {
  public static func value(for definition: SupertagDefinition) -> String {
    let encoder = JSONEncoder.enchiridion
    encoder.outputFormatting = [.sortedKeys]
    let data = (try? encoder.encode(definition)) ?? Data()
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

public enum MeetingSemanticDocumentHash {
  public static func value(for document: Data) -> String {
    SHA256.hash(data: document).map { String(format: "%02x", $0) }.joined()
  }
}

public enum MeetingSemanticTextHash {
  public static func value(for text: String) -> String {
    MeetingSemanticDocumentHash.value(for: Data(text.utf8))
  }
}

/// The only input shape accepted from meeting analysis. This deliberately has no
/// commands, arbitrary properties, relation IDs, or page IDs supplied by a
/// model. The coordinator derives all durable identifiers itself.
public struct MeetingSemanticMutationRequest: Sendable {
  public let completion: MeetingAutomationCompletionAuthority
  public let analysis: MeetingAnalysis
  public let snapshot: MeetingTranscriptSnapshot

  public init(
    completion: MeetingAutomationCompletionAuthority,
    analysis: MeetingAnalysis,
    snapshot: MeetingTranscriptSnapshot
  ) {
    self.completion = completion
    self.analysis = analysis
    self.snapshot = snapshot
  }
}

public struct MeetingSemanticLiveContext: Sendable, Equatable {
  public let vaultID: VaultID
  public let eventPageID: PageID
  public let sessionID: UUID
  public let transcriptHash: String
  public let allowedSupertags: [MeetingAllowedSupertagSnapshot]

  public init(
    vaultID: VaultID,
    eventPageID: PageID,
    sessionID: UUID,
    transcriptHash: String,
    allowedSupertags: [MeetingAllowedSupertagSnapshot]
  ) {
    self.vaultID = vaultID; self.eventPageID = eventPageID; self.sessionID = sessionID
    self.transcriptHash = transcriptHash; self.allowedSupertags = allowedSupertags
  }
}

public struct MeetingSemanticPreparedProposal: Sendable, Hashable, Identifiable {
  public let id: String
  public let supertagID: SupertagID
  public let title: String
  public let transcriptSegmentIDs: [String]
  /// Stable across retries and replicas for this exact event/transcript/proposal.
  public let entityID: PageID

  public init(id: String, supertagID: SupertagID, title: String, transcriptSegmentIDs: [String], entityID: PageID) {
    self.id = id; self.supertagID = supertagID; self.title = title
    self.transcriptSegmentIDs = transcriptSegmentIDs; self.entityID = entityID
  }
}

public struct MeetingSemanticMutationPlan: Sendable {
  public let operationID: String
  public let authority: MeetingAutomationCompletionAuthority
  public let analysisHash: String
  public let proposals: [MeetingSemanticPreparedProposal]

  public init(operationID: String, authority: MeetingAutomationCompletionAuthority, analysisHash: String, proposals: [MeetingSemanticPreparedProposal]) {
    self.operationID = operationID; self.authority = authority; self.analysisHash = analysisHash; self.proposals = proposals
  }
}

public struct MeetingSemanticUndoResult: Sendable, Equatable {
  public let removedNoteBlock: Bool
  public let trashedEntityIDs: [PageID]
  public let preservedEntityIDs: [PageID]
  public init(removedNoteBlock: Bool, trashedEntityIDs: [PageID] = [], preservedEntityIDs: [PageID] = []) {
    self.removedNoteBlock = removedNoteBlock; self.trashedEntityIDs = trashedEntityIDs; self.preservedEntityIDs = preservedEntityIDs
  }
  public var didChange: Bool { removedNoteBlock || !trashedEntityIDs.isEmpty }
}

/// Repository-facing seam. The implementing store must do live-schema
/// revalidation and apply the entire plan, event-note block, resource receipt,
/// and graph changes in one transaction. It must treat a matching operation ID
/// as an idempotent replay and perform conditional undo only for data still
/// owned solely by that receipt.
public protocol MeetingSemanticMutationPersisting: Sendable {
  func liveContext(for authority: MeetingAutomationAuthority) async throws -> MeetingSemanticLiveContext
  func applyAtomically(_ plan: MeetingSemanticMutationPlan) async throws -> MeetingSemanticReceipt
  func undoAtomically(operationID: String, authority: MeetingAutomationAuthority) async throws -> MeetingSemanticUndoResult
}

/// Production adapter for a vault repository. Keeping the vault identifier at
/// this boundary prevents a plan captured for one vault from being replayed in
/// another open vault.
public actor LibraryMeetingSemanticStore: MeetingSemanticMutationPersisting {
  private let repository: LibraryRepository
  private let vaultID: VaultID

  public init(repository: LibraryRepository, vaultID: VaultID) {
    self.repository = repository; self.vaultID = vaultID
  }

  public func liveContext(for authority: MeetingAutomationAuthority) async throws -> MeetingSemanticLiveContext {
    try await repository.meetingSemanticLiveContext(authority: authority, vaultID: vaultID)
  }

  public func applyAtomically(_ plan: MeetingSemanticMutationPlan) async throws -> MeetingSemanticReceipt {
    try await repository.applyMeetingSemanticPlan(plan, vaultID: vaultID)
  }

  public func undoAtomically(operationID: String, authority: MeetingAutomationAuthority) async throws -> MeetingSemanticUndoResult {
    try await repository.undoMeetingSemanticPlan(operationID: operationID, authority: authority, vaultID: vaultID)
  }
}

public enum MeetingSemanticMutationError: Error, Equatable, LocalizedError, Sendable {
  case capabilityDenied
  case expired
  case transcriptMismatch
  case analysisMismatch
  case liveContextMismatch
  case schemaDrift
  case unknownSupertag
  case malformedProposal
  case forbiddenSegment
  case capExceeded

  public var errorDescription: String? {
    switch self {
    case .capabilityDenied: "This meeting was not authorized to create linked entities."
    case .expired: "The meeting automation authority has expired."
    case .transcriptMismatch: "The transcript changed before semantic entities could be written."
    case .analysisMismatch: "The analysis does not belong to this transcript."
    case .liveContextMismatch: "The meeting no longer matches its captured authority."
    case .schemaDrift: "The allowed Super Tag schema changed during the meeting."
    case .unknownSupertag: "The analysis requested a Super Tag that was not authorized at meeting start."
    case .malformedProposal: "The meeting analysis contained an invalid entity proposal."
    case .forbiddenSegment: "The analysis cited a transcript segment that does not exist."
    case .capExceeded: "The meeting analysis exceeded its entity creation limit."
    }
  }
}

/// Validates the narrow start-derived authority immediately before the durable
/// transaction. This is independent from `AssistantToolAuthorization`: analysis
/// cannot gain generic assistant write powers by using this coordinator.
public actor MeetingSemanticMutationCoordinator {
  private let persistence: any MeetingSemanticMutationPersisting
  private let now: @Sendable () -> Date

  public init(
    persistence: any MeetingSemanticMutationPersisting,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.persistence = persistence; self.now = now
  }

  @discardableResult
  public func apply(_ request: MeetingSemanticMutationRequest) async throws -> MeetingSemanticReceipt {
    let authority = request.completion.authority
    guard authority.capabilities.mayCreateLinkedEntities,
      authority.capabilities.mayWriteEventNote,
      authority.capabilities.mayWriteTranscriptResource
    else { throw MeetingSemanticMutationError.capabilityDenied }
    guard now() >= authority.issuedAt, now() <= authority.expiresAt else {
      throw MeetingSemanticMutationError.expired
    }
    guard request.completion.transcriptHash == request.snapshot.hash else {
      throw MeetingSemanticMutationError.transcriptMismatch
    }
    guard request.analysis.transcriptHash == request.completion.transcriptHash else {
      throw MeetingSemanticMutationError.analysisMismatch
    }

    let live = try await persistence.liveContext(for: authority)
    try validate(live: live, authority: authority, transcriptHash: request.snapshot.hash)
    let analysisHash = Self.digest(data: try JSONEncoder.enchiridion.encode(request.analysis))
    let prepared = try Self.prepare(
      request.analysis.entityProposals,
      snapshot: request.snapshot,
      authority: authority
    )
    let operationID = Self.operationID(
      eventPageID: authority.eventPageID,
      transcriptHash: request.snapshot.hash,
      analysisHash: analysisHash
    )
    return try await persistence.applyAtomically(.init(
      operationID: operationID,
      authority: request.completion,
      analysisHash: analysisHash,
      proposals: prepared
    ))
  }

  /// Undo is intentionally conditional in the persistence layer: it must not
  /// delete reused entities or content subsequently edited by the user.
  public func undo(
    operationID: String,
    authority: MeetingAutomationAuthority
  ) async throws -> MeetingSemanticUndoResult {
    guard authority.capabilities.mayWriteEventNote else {
      throw MeetingSemanticMutationError.capabilityDenied
    }
    return try await persistence.undoAtomically(operationID: operationID, authority: authority)
  }

  private func validate(
    live: MeetingSemanticLiveContext,
    authority: MeetingAutomationAuthority,
    transcriptHash: String
  ) throws {
    guard live.vaultID == authority.vaultID,
      live.eventPageID == authority.eventPageID,
      live.sessionID == authority.sessionID,
      live.transcriptHash == transcriptHash
    else { throw MeetingSemanticMutationError.liveContextMismatch }
    guard live.allowedSupertags == authority.allowedSupertags else {
      throw MeetingSemanticMutationError.schemaDrift
    }
  }

  private static func prepare(
    _ raw: [MeetingSemanticEntityProposal],
    snapshot: MeetingTranscriptSnapshot,
    authority: MeetingAutomationAuthority
  ) throws -> [MeetingSemanticPreparedProposal] {
    guard raw.count <= authority.capabilities.maximumTotalEntities,
      authority.capabilities.maximumEntitiesPerTag >= 0,
      authority.capabilities.maximumTotalEntities >= 0
    else { throw MeetingSemanticMutationError.capExceeded }

    let allowed = Set(authority.allowedSupertags.map(\.supertagID))
    let segmentIDs = Set(snapshot.resource.segments.map(\.id))
    var seenProposalIDs = Set<String>()
    var tagCounts: [SupertagID: Int] = [:]
    var result: [MeetingSemanticPreparedProposal] = []
    for proposal in raw.sorted(by: { $0.id < $1.id }) {
      let tag = SupertagID(rawValue: proposal.superTagID.rawValue)
      let title = canonicalTitle(proposal.title)
      guard !proposal.id.isEmpty, !title.isEmpty, title.count <= 2_000,
        seenProposalIDs.insert(proposal.id).inserted
      else { throw MeetingSemanticMutationError.malformedProposal }
      guard allowed.contains(tag) else { throw MeetingSemanticMutationError.unknownSupertag }
      let uniqueSegments = Array(Set(proposal.transcriptSegmentIDs)).sorted()
      guard !uniqueSegments.isEmpty, uniqueSegments.allSatisfy(segmentIDs.contains) else {
        throw MeetingSemanticMutationError.forbiddenSegment
      }
      tagCounts[tag, default: 0] += 1
      guard tagCounts[tag, default: 0] <= authority.capabilities.maximumEntitiesPerTag else {
        throw MeetingSemanticMutationError.capExceeded
      }
      let entityInput = "v1\u{0}\(authority.eventPageID.rawValue)\u{0}\(snapshot.hash)\u{0}\(proposal.id)"
      let entityID = PageID(rawValue: "meeting_entity_\(digest(entityInput).prefix(40))")
      result.append(.init(id: proposal.id, supertagID: tag, title: title, transcriptSegmentIDs: uniqueSegments, entityID: entityID))
    }
    return result
  }

  private static func canonicalTitle(_ value: String) -> String {
    value.precomposedStringWithCanonicalMapping
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
  }

  private static func operationID(eventPageID: PageID, transcriptHash: String, analysisHash: String) -> String {
    let input = "v1\u{0}\(eventPageID.rawValue)\u{0}\(transcriptHash)\u{0}\(analysisHash)"
    return "meeting_semantic_\(digest(input))"
  }

  private static func digest(_ input: String) -> String {
    digest(data: Data(input.utf8))
  }

  private static func digest(data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
