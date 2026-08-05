import Foundation
import XCTest

@testable import EnchiridionCore

final class MeetingSemanticMutationCoordinatorTests: XCTestCase {
  func testRetryUsesStableOperationAndEntityIDs() async throws {
    let snapshot = transcript()
    let authority = makeAuthority()
    let completion = try XCTUnwrap(authority.completion(transcriptHash: snapshot.hash, completedAt: Date(timeIntervalSince1970: 110)))
    let analysis = try MeetingAnalysis(
      transcriptHash: snapshot.hash, summary: "Summary", decisions: [], actionItems: [],
      entityProposals: [.init(id: "atlas", superTagID: .init(rawValue: "project"), title: " Atlas ", transcriptSegmentIDs: ["s1"])]
    )
    let persistence = Spy(context: .init(vaultID: .personal, eventPageID: authority.eventPageID, sessionID: authority.sessionID, transcriptHash: snapshot.hash, allowedSupertags: authority.allowedSupertags))
    let coordinator = MeetingSemanticMutationCoordinator(persistence: persistence, now: { Date(timeIntervalSince1970: 120) })

    _ = try await coordinator.apply(.init(completion: completion, analysis: analysis, snapshot: snapshot))
    _ = try await coordinator.apply(.init(completion: completion, analysis: analysis, snapshot: snapshot))

    let plans = await persistence.plans
    XCTAssertEqual(plans.count, 2)
    XCTAssertEqual(plans[0].operationID, plans[1].operationID)
    XCTAssertEqual(plans[0].proposals[0].entityID, plans[1].proposals[0].entityID)
    XCTAssertEqual(plans[0].proposals[0].title, "Atlas")
  }

  func testSchemaDriftAndUnknownTagAreDeniedBeforeWrites() async throws {
    let snapshot = transcript()
    let authority = makeAuthority()
    let completion = try XCTUnwrap(authority.completion(transcriptHash: snapshot.hash, completedAt: Date(timeIntervalSince1970: 110)))
    let analysis = try MeetingAnalysis(transcriptHash: snapshot.hash, summary: "", decisions: [], actionItems: [], entityProposals: [
      .init(id: "bad", superTagID: .init(rawValue: "not-allowed"), title: "Bad", transcriptSegmentIDs: ["s1"]),
    ])
    let persistence = Spy(context: .init(vaultID: .personal, eventPageID: authority.eventPageID, sessionID: authority.sessionID, transcriptHash: snapshot.hash, allowedSupertags: authority.allowedSupertags))
    let coordinator = MeetingSemanticMutationCoordinator(persistence: persistence, now: { Date(timeIntervalSince1970: 120) })

    do { _ = try await coordinator.apply(.init(completion: completion, analysis: analysis, snapshot: snapshot)); XCTFail("Expected denial") }
    catch let error as MeetingSemanticMutationError { XCTAssertEqual(error, .unknownSupertag) }
    let plans = await persistence.plans
    XCTAssertTrue(plans.isEmpty)
  }

  private func makeAuthority() -> MeetingAutomationAuthority {
    .init(
      vaultID: .personal, eventPageID: .init(rawValue: "event_meeting"), occurrenceKey: "occurrence",
      sessionID: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
      transcriptionRoute: .init(route: .onDevice, cloudReadiness: .notRequired), analysisRoute: .init(route: .onDevice),
      issuedAt: Date(timeIntervalSince1970: 100), expiresAt: Date(timeIntervalSince1970: 200),
      allowedSupertags: [.init(supertagID: .init(rawValue: "project"), schemaFingerprint: "v1")]
    )
  }

  private func transcript() -> MeetingTranscriptSnapshot {
    .init(resource: .init(eventPageID: .init(rawValue: "event_meeting"), provenance: .init(captureAlgorithm: "test", captureAlgorithmVersion: "1", transcriptionAlgorithm: "test", transcriptionAlgorithmVersion: "1"), segments: [.init(id: "s1", startTime: 0, endTime: 1, text: "Atlas", speakerClusterID: "speaker_1")]))
  }
}

private actor Spy: MeetingSemanticMutationPersisting {
  let context: MeetingSemanticLiveContext
  var plans: [MeetingSemanticMutationPlan] = []
  init(context: MeetingSemanticLiveContext) { self.context = context }
  func liveContext(for _: MeetingAutomationAuthority) async throws -> MeetingSemanticLiveContext { context }
  func applyAtomically(_ plan: MeetingSemanticMutationPlan) async throws -> MeetingSemanticReceipt {
    plans.append(plan)
    return .init(algorithm: "test", algorithmVersion: "1", operationID: plan.operationID)
  }
  func undoAtomically(operationID _: String, authority _: MeetingAutomationAuthority) async throws -> MeetingSemanticUndoResult { .init(removedNoteBlock: true) }
}
