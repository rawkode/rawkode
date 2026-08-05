import Foundation
import XCTest
@testable import EnchiridionCore

final class MeetingSemanticRepositoryTests: XCTestCase {
  func testApplyIsIdempotentAndUndoTrashesUnchangedCreatedEntity() async throws {
    let fixture = try await makeFixture()
    let plan = try await fixture.plan()

    let first = try await fixture.repository.applyMeetingSemanticPlan(plan, vaultID: .personal)
    let replay = try await fixture.repository.applyMeetingSemanticPlan(plan, vaultID: .personal)
    let undo = try await fixture.repository.undoMeetingSemanticPlan(
      operationID: plan.operationID,
      eventPageID: fixture.pageID,
      vaultID: .personal
    )

    XCTAssertEqual(first, replay)
    XCTAssertTrue(undo.removedNoteBlock)
    XCTAssertEqual(undo.trashedEntityIDs, [first.entityOutcomes[0].pageID])
    let entity = try await fixture.repository.page(id: first.entityOutcomes[0].pageID)
    XCTAssertNotNil(entity?.deletedAt)
  }

  func testWrongOperationIsRejectedWithoutChangingReceipt() async throws {
    let fixture = try await makeFixture()
    let plan = try await fixture.plan()
    let receipt = try await fixture.repository.applyMeetingSemanticPlan(plan, vaultID: .personal)

    do {
      _ = try await fixture.repository.undoMeetingSemanticPlan(
        operationID: "wrong",
        eventPageID: fixture.pageID,
        vaultID: .personal
      )
      XCTFail("Expected the unrelated operation to be rejected")
    } catch {
      XCTAssertEqual(error as? MeetingSemanticMutationError, .liveContextMismatch)
    }

    let resource = try await fixture.repository.meetingTranscript(
      resourceKey: fixture.resource.id,
      on: fixture.pageID
    )
    XCTAssertEqual(resource?.semanticReceipt, receipt)
  }

  func testReplayCreatesOnlyOneEntity() async throws {
    let fixture = try await makeFixture()
    let plan = try await fixture.plan()
    _ = try await fixture.repository.applyMeetingSemanticPlan(plan, vaultID: .personal)
    _ = try await fixture.repository.applyMeetingSemanticPlan(plan, vaultID: .personal)

    let projects = try await fixture.repository.pages(with: BuiltInSupertags.project)
    XCTAssertEqual(projects.filter { $0.title == "Atlas" }.count, 1)
  }

  func testDurableUndoDoesNotDependOnExpiredCaptureAuthority() async throws {
    let fixture = try await makeFixture()
    let plan = try await fixture.plan(expiresAt: .distantPast)
    _ = try await fixture.repository.applyMeetingSemanticPlan(
      plan,
      vaultID: .personal,
      now: .distantPast
    )

    let undo = try await fixture.repository.undoMeetingSemanticPlan(
      operationID: plan.operationID,
      eventPageID: fixture.pageID,
      vaultID: .personal,
      now: .distantFuture
    )

    XCTAssertTrue(undo.didChange)
  }

  func testUndoPreservesUserNoteAndModifiedCreatedEntity() async throws {
    let fixture = try await makeFixture(note: "User context that must survive.")
    let plan = try await fixture.plan()
    let receipt = try await fixture.repository.applyMeetingSemanticPlan(plan, vaultID: .personal)
    let entityID = try XCTUnwrap(receipt.entityOutcomes.first?.pageID)
    _ = try await fixture.repository.renamePage(pageID: entityID, title: "Atlas edited by user")

    let undo = try await fixture.repository.undoMeetingSemanticPlan(
      operationID: plan.operationID,
      eventPageID: fixture.pageID,
      vaultID: .personal
    )

    XCTAssertTrue(undo.removedNoteBlock)
    XCTAssertEqual(undo.preservedEntityIDs, [entityID])
    let entity = try await fixture.repository.page(id: entityID)
    XCTAssertEqual(entity?.title, "Atlas edited by user")
    XCTAssertNil(entity?.deletedAt)
    let note = try await fixture.eventBody()
    XCTAssertEqual(note, "User context that must survive.")
  }

  func testUndoRefusesEditedProvenanceBlockAndPreservesEntity() async throws {
    let fixture = try await makeFixture()
    let plan = try await fixture.plan()
    let receipt = try await fixture.repository.applyMeetingSemanticPlan(plan, vaultID: .personal)
    let entityID = try XCTUnwrap(receipt.entityOutcomes.first?.pageID)
    let loadedEventPage = try await fixture.repository.page(id: fixture.pageID)
    let eventPage = try XCTUnwrap(loadedEventPage)
    let richText = try PageDocument.richText(in: eventPage.document)
    let edited = String(richText.body.characters).replacingOccurrences(
      of: "Meeting entities",
      with: "Meeting entities edited"
    )
    _ = try await fixture.repository.persistRichTextEditor(
      pageID: fixture.pageID,
      title: eventPage.title,
      body: AttributedString(edited)
    )

    let undo = try await fixture.repository.undoMeetingSemanticPlan(
      operationID: plan.operationID,
      eventPageID: fixture.pageID,
      vaultID: .personal
    )

    XCTAssertFalse(undo.removedNoteBlock)
    XCTAssertEqual(undo.preservedEntityIDs, [entityID])
    let entity = try await fixture.repository.page(id: entityID)
    XCTAssertNil(entity?.deletedAt)
    let resource = try await fixture.repository.meetingTranscript(
      resourceKey: fixture.resource.id,
      on: fixture.pageID
    )
    XCTAssertEqual(resource?.semanticReceipt?.operationID, plan.operationID)
  }

  func testUndoNeverDeletesReusedEntity() async throws {
    let fixture = try await makeFixture()
    let existing = try await fixture.repository.createTaggedPage(
      title: "Atlas",
      supertagID: BuiltInSupertags.project
    )
    let plan = try await fixture.plan()
    let receipt = try await fixture.repository.applyMeetingSemanticPlan(plan, vaultID: .personal)

    XCTAssertEqual(receipt.entityOutcomes.first?.pageID, existing.id)
    XCTAssertEqual(receipt.entityOutcomes.first?.disposition, .reused)
    let undo = try await fixture.repository.undoMeetingSemanticPlan(
      operationID: plan.operationID,
      eventPageID: fixture.pageID,
      vaultID: .personal
    )

    XCTAssertTrue(undo.removedNoteBlock)
    XCTAssertTrue(undo.trashedEntityIDs.isEmpty)
    let retained = try await fixture.repository.page(id: existing.id)
    XCTAssertNil(retained?.deletedAt)
  }
}

private struct MeetingSemanticRepositoryFixture {
  let repository: LibraryRepository
  let event: CalendarEventSnapshot
  let pageID: PageID
  let resource: MeetingTranscriptResource

  func plan(expiresAt: Date = .distantFuture) async throws -> MeetingSemanticMutationPlan {
    let definitions = try await repository.supertags()
    let project = try XCTUnwrap(definitions.first { $0.id == BuiltInSupertags.project })
    let authority = MeetingAutomationAuthority(
      vaultID: .personal,
      eventPageID: pageID,
      occurrenceKey: "meeting-semantic-test",
      transcriptionRoute: .init(route: .onDevice, cloudReadiness: .notRequired),
      analysisRoute: .init(route: .onDevice),
      issuedAt: .distantPast,
      expiresAt: expiresAt,
      allowedSupertags: [
        .init(
          supertagID: BuiltInSupertags.project,
          schemaFingerprint: MeetingSemanticSchemaFingerprint.value(for: project)
        ),
      ]
    )
    let completion = try XCTUnwrap(authority.completion(
      transcriptHash: MeetingTranscriptSnapshot(resource: resource).hash,
      completedAt: min(Date(), expiresAt)
    ))
    return .init(
      operationID: "meeting-semantic-test-operation",
      authority: completion,
      analysisHash: "analysis-hash",
      proposals: [
        .init(
          id: "atlas",
          supertagID: BuiltInSupertags.project,
          title: "Atlas",
          transcriptSegmentIDs: ["segment-1"],
          entityID: .init(rawValue: "meeting_entity_test")
        ),
      ]
    )
  }

  func eventBody() async throws -> String {
    let loadedPage = try await repository.page(id: pageID)
    let page = try XCTUnwrap(loadedPage)
    return String(try PageDocument.richText(in: page.document).body.characters)
  }
}

private func makeFixture(note: String = "") async throws -> MeetingSemanticRepositoryFixture {
  let path = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent(UUID().uuidString)
    .appendingPathExtension("sqlite")
  let repository = try LibraryRepository(path: path.path)
  let start = Date()
  let event = CalendarEventSnapshot(
    identity: .init(
      provider: "test",
      externalIdentifier: UUID().uuidString,
      occurrenceStart: start
    ),
    title: "Meeting",
    startDate: start,
    endDate: start.addingTimeInterval(3_600),
    isAllDay: false,
    location: nil,
    notes: nil,
    url: nil,
    calendarTitle: "Tests"
  )
  let pageID = PageID.calendarOccurrence(event.identity)
  let resource = MeetingTranscriptResource(
    eventPageID: pageID,
    provenance: .init(
      captureAlgorithm: "test",
      captureAlgorithmVersion: "1",
      transcriptionAlgorithm: "test",
      transcriptionAlgorithmVersion: "1"
    ),
    transcriptState: .complete,
    segments: [
      .init(
        id: "segment-1",
        startTime: 0,
        endTime: 1,
        text: "Discuss Atlas.",
        speakerClusterID: "speaker-1"
      ),
    ]
  )
  _ = try await repository.upsertMeetingTranscript(resource, for: event)
  if !note.isEmpty {
    let loadedPage = try await repository.page(id: pageID)
    let page = try XCTUnwrap(loadedPage)
    _ = try await repository.persistRichTextEditor(
      pageID: pageID,
      title: page.title,
      body: AttributedString(note)
    )
  }
  return .init(repository: repository, event: event, pageID: pageID, resource: resource)
}
