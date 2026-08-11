// AssistantTaskMutationApplierTests.swift
// EnchiridionSyncTests
//
// Tests for Sources/EnchiridionSync/AssistantTaskMutationApplier.swift —
// the real apply-to-graph step for a CONFIRMED
// `AssistantTaskMutationProposal`, exercised against the real
// `PageDocument`/Loro machinery (no mocking — `PageDocument` is already
// snapshot-in/snapshot-out pure functions, same posture
// PageDocumentTests.swift takes).

import Foundation
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionSync

final class AssistantTaskMutationApplierTests: XCTestCase {
  private func callID(_ raw: String = "call_1") -> AssistantToolCallID {
    AssistantToolCallID(rawValue: raw)
  }

  // MARK: - Create

  func testApplyCreateTagsPageAsTaskAndSetsFields() throws {
    let draft = AssistantTaskDraft(
      title: "Buy milk", notes: "2%", priority: .high, placement: .anytime,
      estimatedMinutes: 15)
    let proposal = AssistantTaskMutationProposal.create(callID: callID(), draft: draft)

    let result = try AssistantTaskMutationApplier.apply(proposal, existingSnapshot: nil)

    XCTAssertEqual(result.projection.title, "Buy milk")
    XCTAssertFalse(result.pageID.rawValue.isEmpty)
    XCTAssertTrue(
      result.projection.objectMetadata.supertagIDs.contains(
        AssistantTaskMutationApplier.taskSupertagID))

    let notesKey = SupertagPropertyKey(
      supertagID: AssistantTaskMutationApplier.taskSupertagID, fieldID: SupertagFieldID(rawValue: "notes"))
    XCTAssertEqual(result.projection.objectMetadata.properties[notesKey], [.text("2%")])

    let priorityKey = SupertagPropertyKey(
      supertagID: AssistantTaskMutationApplier.taskSupertagID,
      fieldID: SupertagFieldID(rawValue: "priority"))
    XCTAssertEqual(result.projection.objectMetadata.properties[priorityKey], [.select("high")])

    let placementKey = SupertagPropertyKey(
      supertagID: AssistantTaskMutationApplier.taskSupertagID,
      fieldID: SupertagFieldID(rawValue: "placement"))
    XCTAssertEqual(result.projection.objectMetadata.properties[placementKey], [.select("anytime")])

    let estimatedMinutesKey = SupertagPropertyKey(
      supertagID: AssistantTaskMutationApplier.taskSupertagID,
      fieldID: SupertagFieldID(rawValue: "estimated-minutes"))
    XCTAssertEqual(result.projection.objectMetadata.properties[estimatedMinutesKey], [.number(15)])
  }

  func testApplyCreateWithMinimalDraftStillTagsTask() throws {
    let proposal = AssistantTaskMutationProposal.create(
      callID: callID(), draft: AssistantTaskDraft(title: "Just a title"))
    let result = try AssistantTaskMutationApplier.apply(proposal, existingSnapshot: nil)
    XCTAssertEqual(result.projection.title, "Just a title")
    XCTAssertTrue(
      result.projection.objectMetadata.supertagIDs.contains(
        AssistantTaskMutationApplier.taskSupertagID))
  }

  // MARK: - Update

  func testApplyUpdateChangesTitleNotesAndPriority() throws {
    let created = try AssistantTaskMutationApplier.apply(
      .create(callID: callID("c0"), draft: AssistantTaskDraft(title: "Original")),
      existingSnapshot: nil)

    let currentVersion = try PageDocument.currentVersion(of: created.document)
    let patch = AssistantTaskMutationPatch(
      title: "Updated title", notes: "updated notes", priority: .urgent)
    let updateProposal = AssistantTaskMutationProposal.update(
      callID: callID("c1"), pageID: created.pageID,
      version: AssistantPageVersionToken(encoded: currentVersion.encoded), patch: patch)

    let updated = try AssistantTaskMutationApplier.apply(
      updateProposal, existingSnapshot: created.document)

    XCTAssertEqual(updated.projection.title, "Updated title")
    let notesKey = SupertagPropertyKey(
      supertagID: AssistantTaskMutationApplier.taskSupertagID, fieldID: SupertagFieldID(rawValue: "notes"))
    XCTAssertEqual(updated.projection.objectMetadata.properties[notesKey], [.text("updated notes")])
    let priorityKey = SupertagPropertyKey(
      supertagID: AssistantTaskMutationApplier.taskSupertagID,
      fieldID: SupertagFieldID(rawValue: "priority"))
    XCTAssertEqual(updated.projection.objectMetadata.properties[priorityKey], [.select("urgent")])
  }

  func testApplyUpdateWithStaleVersionThrowsStaleVersion() throws {
    let created = try AssistantTaskMutationApplier.apply(
      .create(callID: callID("c0"), draft: AssistantTaskDraft(title: "Original")),
      existingSnapshot: nil)

    // A version token that does not match the current document's version
    // vector (empty bytes never equal a real encoded version vector).
    let staleVersion = AssistantPageVersionToken(encoded: Data())
    let patch = AssistantTaskMutationPatch(title: "Should not apply")
    let updateProposal = AssistantTaskMutationProposal.update(
      callID: callID("c1"), pageID: created.pageID, version: staleVersion, patch: patch)

    XCTAssertThrowsError(
      try AssistantTaskMutationApplier.apply(updateProposal, existingSnapshot: created.document)
    ) { error in
      XCTAssertEqual(error as? AssistantTaskMutationApplyError, .staleVersion)
    }
  }

  func testApplyUpdateWithoutExistingSnapshotThrowsMissingSnapshot() {
    let patch = AssistantTaskMutationPatch(title: "New title")
    let updateProposal = AssistantTaskMutationProposal.update(
      callID: callID(), pageID: PageID.free(),
      version: AssistantPageVersionToken(encoded: Data()), patch: patch)

    XCTAssertThrowsError(
      try AssistantTaskMutationApplier.apply(updateProposal, existingSnapshot: nil)
    ) { error in
      XCTAssertEqual(error as? AssistantTaskMutationApplyError, .missingExistingSnapshot)
    }
  }

  // MARK: - Complete

  func testApplyCompleteSetsStatusDoneAndCompletedAt() throws {
    let created = try AssistantTaskMutationApplier.apply(
      .create(callID: callID("c0"), draft: AssistantTaskDraft(title: "Finish report")),
      existingSnapshot: nil)

    let currentVersion = try PageDocument.currentVersion(of: created.document)
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let completeProposal = AssistantTaskMutationProposal.complete(
      callID: callID("c1"), pageID: created.pageID,
      version: AssistantPageVersionToken(encoded: currentVersion.encoded))

    let completed = try AssistantTaskMutationApplier.apply(
      completeProposal, existingSnapshot: created.document, now: now)

    let statusKey = SupertagPropertyKey(
      supertagID: AssistantTaskMutationApplier.taskSupertagID, fieldID: SupertagFieldID(rawValue: "status"))
    XCTAssertEqual(completed.projection.objectMetadata.properties[statusKey], [.select("done")])

    let completedAtKey = SupertagPropertyKey(
      supertagID: AssistantTaskMutationApplier.taskSupertagID,
      fieldID: SupertagFieldID(rawValue: "completed-at"))
    XCTAssertEqual(completed.projection.objectMetadata.properties[completedAtKey], [.dateTime(now)])
  }

  func testApplyCompleteWithStaleVersionThrowsStaleVersion() throws {
    let created = try AssistantTaskMutationApplier.apply(
      .create(callID: callID("c0"), draft: AssistantTaskDraft(title: "Finish report")),
      existingSnapshot: nil)

    let completeProposal = AssistantTaskMutationProposal.complete(
      callID: callID("c1"), pageID: created.pageID,
      version: AssistantPageVersionToken(encoded: Data()))

    XCTAssertThrowsError(
      try AssistantTaskMutationApplier.apply(completeProposal, existingSnapshot: created.document)
    ) { error in
      XCTAssertEqual(error as? AssistantTaskMutationApplyError, .staleVersion)
    }
  }
}
