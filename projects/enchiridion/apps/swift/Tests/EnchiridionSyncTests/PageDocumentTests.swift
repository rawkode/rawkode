// PageDocumentTests.swift
// EnchiridionSyncTests
//
// Tests for PageDocument.swift (Sources/EnchiridionSync/PageDocument.swift).
//
// NOTE on location: the P1 task description that produced this file
// suggested `Tests/EnchiridionCoreTests/PageDocumentTests.swift`, alongside
// GoldenIdsTests.swift. That assumed `PageDocument` would live in
// `EnchiridionCore`. It doesn't — see PageDocument.swift's header for the
// full reasoning (in short: `EnchiridionSync` already depends on
// `EnchiridionCore`, so the reverse would be circular, and `CRDTEngine`'s
// protocol deliberately has no read surface a projection function could be
// built on, so `PageDocument` talks to `Loro.LoroDoc` directly and must
// live where that import is available). This file lives in
// `EnchiridionSyncTests` instead, next to `LoroEngineTests.swift`, whose
// two-replica merge pattern (`testCreateApplyExportImportRoundTrip`,
// `testIncrementalUpdateExportOnlyContainsNewOps`) the merge test below
// reuses.

import Foundation
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionSync

final class PageDocumentTests: XCTestCase {
  private let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000B1")!)

  // MARK: - Create + basic shape

  func testCreateProducesAProjectableDocument() throws {
    let created = try PageDocument.create(
      id: pageID, kind: .free, title: "Grocery list", createdAt: Date(timeIntervalSince1970: 0))
    XCTAssertGreaterThan(created.document.count, 0)

    let projection = try PageDocument.projection(of: created.document)
    XCTAssertEqual(projection.title, "Grocery list")
    XCTAssertEqual(projection.plainText, "")
    XCTAssertNil(projection.deletedAt)
    XCTAssertFalse(projection.isPinned)
    XCTAssertTrue(projection.references.isEmpty)
    XCTAssertTrue(projection.graphEdges.isEmpty)
    XCTAssertTrue(projection.objectMetadata.supertagIDs.isEmpty)
  }

  func testCreateWithDailyKind() throws {
    let dailyPageID = PageID.daily(DayKey(rawValue: "2026-08-06"))
    let created = try PageDocument.create(
      id: dailyPageID, kind: .daily(DayKey(rawValue: "2026-08-06")), title: "", createdAt: Date())
    let projection = try PageDocument.projection(of: created.document)
    XCTAssertEqual(projection.title, "")
  }

  // MARK: - Text + marks

  func testInsertBodyTextAndApplyStrongMark() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Notes", createdAt: Date())
    let inserted = try PageDocument.insertText(
      .body, at: 0, text: "Hello, Enchiridion", in: created.document)
    XCTAssertEqual(inserted.projection.plainText, "Hello, Enchiridion")

    let marked = try PageDocument.mark(
      .body, range: 0..<5, style: PageDocument.strongMark, value: .bool(true), in: inserted.document)
    // Marking doesn't change the plain text content.
    XCTAssertEqual(marked.projection.plainText, "Hello, Enchiridion")
  }

  func testDeleteText() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let inserted = try PageDocument.insertText(.body, at: 0, text: "abcdef", in: created.document)
    let deleted = try PageDocument.deleteText(.body, at: 2, length: 2, in: inserted.document)
    XCTAssertEqual(deleted.projection.plainText, "abef")
  }

  func testPageReferenceMarkIsExtractedAsAReference() throws {
    let targetID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000B2")!)
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let inserted = try PageDocument.insertText(
      .body, at: 0, text: "See Project Alpha for details", in: created.document)

    // "Project Alpha" occupies unicode scalars [4, 17).
    let referenced = try PageDocument.addPageReferenceMark(
      to: targetID, label: "Project Alpha", range: 4..<17, in: inserted.document)

    XCTAssertEqual(referenced.projection.plainText, "See Project Alpha for details")
    XCTAssertEqual(referenced.projection.references.count, 1)
    let reference = try XCTUnwrap(referenced.projection.references.first)
    XCTAssertEqual(reference.sourcePageID, pageID)
    XCTAssertEqual(reference.targetPageID, targetID)
    XCTAssertEqual(reference.fallbackLabel, "Project Alpha")
  }

  // MARK: - Formatting marks (`PageDocumentProjection.formattingMarks`)

  func testOverlappingBoldAndItalicMarksProduceSeparateRuns() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let inserted = try PageDocument.insertText(
      .body, at: 0, text: "Hello, Enchiridion", in: created.document)

    // Bold covers [0, 10); italic covers [5, 18) — they overlap over
    // [5, 10). Both marks must round-trip as their own full-range run,
    // never one merged/ambiguous run.
    let bolded = try PageDocument.mark(
      .body, range: 0..<10, style: PageDocument.strongMark, value: .bool(true), in: inserted.document)
    let marked = try PageDocument.mark(
      .body, range: 5..<18, style: PageDocument.emphasisMark, value: .bool(true), in: bolded.document)

    let formattingMarks = marked.projection.formattingMarks
    XCTAssertEqual(formattingMarks.count, 2)
    let bold = try XCTUnwrap(formattingMarks.first { $0.style == .bold })
    XCTAssertEqual(bold.range, 0..<10)
    let italic = try XCTUnwrap(formattingMarks.first { $0.style == .italic })
    XCTAssertEqual(italic.range, 5..<18)
  }

  func testAdjacentNonOverlappingMarksProduceSeparateRuns() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let inserted = try PageDocument.insertText(
      .body, at: 0, text: "BoldItalicText", in: created.document)

    // Bold covers [0, 4); italic covers [4, 10) — touching but not
    // overlapping. Must stay two distinct runs, not merge into one
    // multi-style run (formatting marks are single-style by design).
    let bolded = try PageDocument.mark(
      .body, range: 0..<4, style: PageDocument.strongMark, value: .bool(true), in: inserted.document)
    let marked = try PageDocument.mark(
      .body, range: 4..<10, style: PageDocument.emphasisMark, value: .bool(true), in: bolded.document)

    let formattingMarks = marked.projection.formattingMarks
    XCTAssertEqual(formattingMarks.count, 2)
    let bold = try XCTUnwrap(formattingMarks.first { $0.style == .bold })
    XCTAssertEqual(bold.range, 0..<4)
    let italic = try XCTUnwrap(formattingMarks.first { $0.style == .italic })
    XCTAssertEqual(italic.range, 4..<10)
  }

  func testMarkSpanningEntireTextProducesOneFullRangeRun() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let inserted = try PageDocument.insertText(
      .body, at: 0, text: "Strikethrough me", in: created.document)
    let fullRange = 0..<UInt32(inserted.projection.plainText.unicodeScalars.count)

    let marked = try PageDocument.mark(
      .body, range: fullRange, style: PageDocument.strikethroughMark, value: .bool(true),
      in: inserted.document)

    let formattingMarks = marked.projection.formattingMarks
    XCTAssertEqual(formattingMarks.count, 1)
    let run = try XCTUnwrap(formattingMarks.first)
    XCTAssertEqual(run.style, .strikethrough)
    XCTAssertEqual(run.range, 0..<marked.projection.plainText.unicodeScalars.count)
  }

  func testNoMarksProducesEmptyFormattingMarksArrayNotNil() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let inserted = try PageDocument.insertText(
      .body, at: 0, text: "Plain text, no marks.", in: created.document)

    // `formattingMarks` is non-Optional ([FormattingMarkRun], never
    // [FormattingMarkRun]?), so an unformatted page reports an empty
    // array rather than requiring callers to unwrap/default it.
    XCTAssertEqual(inserted.projection.formattingMarks, [])
    XCTAssertTrue(inserted.projection.formattingMarks.isEmpty)

    // Same guarantee holds for a page with no body text at all.
    let emptyBodyProjection = try PageDocument.projection(of: created.document)
    XCTAssertEqual(emptyBodyProjection.formattingMarks, [])
  }

  func testUnmarkingRemovesTheFormattingRun() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let inserted = try PageDocument.insertText(.body, at: 0, text: "abcdef", in: created.document)
    let bolded = try PageDocument.mark(
      .body, range: 0..<6, style: PageDocument.strongMark, value: .bool(true), in: inserted.document)
    XCTAssertEqual(bolded.projection.formattingMarks, [FormattingMarkRun(style: .bold, range: 0..<6)])

    let unmarked = try PageDocument.mark(
      .body, range: 0..<6, style: PageDocument.strongMark, value: nil, in: bolded.document)
    XCTAssertEqual(unmarked.projection.formattingMarks, [])
  }

  // MARK: - Supertags

  func testAddAndRemoveSupertag() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let tagID = SupertagID(rawValue: "task")

    let tagged = try PageDocument.addSupertag(tagID, in: created.document)
    XCTAssertEqual(tagged.projection.objectMetadata.supertagIDs, [tagID])

    let untagged = try PageDocument.removeSupertag(tagID, in: tagged.document)
    XCTAssertTrue(untagged.projection.objectMetadata.supertagIDs.isEmpty)
  }

  func testRemoveSupertagAlsoClearsItsProperties() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let tagID = SupertagID(rawValue: "task")
    let key = SupertagPropertyKey(supertagID: tagID, fieldID: SupertagFieldID(rawValue: "priority"))

    let withProperty = try PageDocument.setProperty(
      key: key, values: [.select("high")], in: created.document)
    XCTAssertEqual(withProperty.projection.objectMetadata.properties[key], [.select("high")])

    let untagged = try PageDocument.removeSupertag(tagID, in: withProperty.document)
    XCTAssertTrue(untagged.projection.objectMetadata.properties.isEmpty)
    XCTAssertTrue(untagged.projection.objectMetadata.supertagIDs.isEmpty)
  }

  // MARK: - Property/edge duality (task's core requirement)

  func testPlainPropertyValueIsStoredAsAValueNotAnEdge() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let key = SupertagPropertyKey(
      supertagID: SupertagID(rawValue: "task"), fieldID: SupertagFieldID(rawValue: "priority"))

    let result = try PageDocument.setProperty(key: key, values: [.select("urgent")], in: created.document)

    XCTAssertEqual(result.projection.objectMetadata.properties[key], [.select("urgent")])
    XCTAssertTrue(result.projection.graphEdges.isEmpty, "a plain value must not create a graph edge")
    XCTAssertEqual(result.projection.objectMetadata.supertagIDs, [SupertagID(rawValue: "task")])
  }

  func testEntityReferencePropertyValueIsStoredAsAnEdgeNotAValue() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let projectID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000B3")!)
    let key = SupertagPropertyKey(
      supertagID: SupertagID(rawValue: "task"), fieldID: SupertagFieldID(rawValue: "project"))

    let result = try PageDocument.setProperty(key: key, values: [.page(projectID)], in: created.document)

    // The doc-level mechanism: this must land in `edges`, not `values`.
    XCTAssertEqual(result.projection.graphEdges.count, 1)
    let edge = try XCTUnwrap(result.projection.graphEdges.first)
    XCTAssertEqual(edge.sourceNodeID, pageID)
    XCTAssertEqual(edge.targetNodeID, projectID)
    XCTAssertEqual(edge.relationID, BuiltInRelations.relationID(for: key))
    XCTAssertEqual(edge.relationID.rawValue, "property-relation:task:project")

    // The projection still folds the edge back into `properties` for
    // callers that just want "the current field value" without caring
    // whether it's backed by a value or an edge underneath.
    XCTAssertEqual(result.projection.objectMetadata.properties[key], [.page(projectID)])
  }

  func testReplacingAnEntityReferencePropertyReplacesItsEdges() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let firstTarget = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000B4")!)
    let secondTarget = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000B5")!)
    let key = SupertagPropertyKey(
      supertagID: SupertagID(rawValue: "task"), fieldID: SupertagFieldID(rawValue: "project"))

    let first = try PageDocument.setProperty(key: key, values: [.page(firstTarget)], in: created.document)
    XCTAssertEqual(first.projection.graphEdges.map(\.targetNodeID), [firstTarget])

    let second = try PageDocument.setProperty(key: key, values: [.page(secondTarget)], in: first.document)
    XCTAssertEqual(second.projection.graphEdges.map(\.targetNodeID), [secondTarget])

    let cleared = try PageDocument.setProperty(key: key, values: [], in: second.document)
    XCTAssertTrue(cleared.projection.graphEdges.isEmpty)
    XCTAssertNil(cleared.projection.objectMetadata.properties[key])
  }

  func testSetPropertiesBatchAppliesBothPlainAndRelationshipFields() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let tagID = SupertagID(rawValue: "task")
    let priorityKey = SupertagPropertyKey(supertagID: tagID, fieldID: SupertagFieldID(rawValue: "priority"))
    let projectKey = SupertagPropertyKey(supertagID: tagID, fieldID: SupertagFieldID(rawValue: "project"))
    let projectID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000B6")!)

    let result = try PageDocument.setProperties(
      [priorityKey: [.select("low")], projectKey: [.page(projectID)]],
      ensuring: tagID,
      in: created.document
    )

    XCTAssertEqual(result.projection.objectMetadata.properties[priorityKey], [.select("low")])
    XCTAssertEqual(result.projection.objectMetadata.properties[projectKey], [.page(projectID)])
    XCTAssertEqual(result.projection.graphEdges.count, 1)
    XCTAssertEqual(result.projection.objectMetadata.supertagIDs, [tagID])
  }

  // MARK: - Pin / delete flags

  func testSetPinnedAndSetDeleted() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let pinned = try PageDocument.setPinned(true, in: created.document)
    XCTAssertTrue(pinned.projection.isPinned)

    let deletedAt = Date(timeIntervalSince1970: 1_700_000_000)
    let deleted = try PageDocument.setDeleted(deletedAt, in: pinned.document)
    XCTAssertNotNil(deleted.projection.deletedAt)
    XCTAssertEqual(
      deleted.projection.deletedAt?.timeIntervalSince1970 ?? -1,
      deletedAt.timeIntervalSince1970,
      accuracy: 0.001
    )
    // isPinned is independent of deletedAt.
    XCTAssertTrue(deleted.projection.isPinned)

    let restored = try PageDocument.setDeleted(nil, in: deleted.document)
    XCTAssertNil(restored.projection.deletedAt)
  }

  // MARK: - Size limits

  func testChangeExceedingMaximumChangeBytesThrows() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    // Comfortably over the 1 MiB per-change limit; ASCII text is 1 byte per
    // unicode scalar in Loro's `LoroText`, so this is >1 MiB of change.
    let oversized = String(repeating: "a", count: PageDocument.maximumChangeBytes + 1024)

    XCTAssertThrowsError(
      try PageDocument.insertText(.body, at: 0, text: oversized, in: created.document)
    ) { error in
      guard case PageDocumentError.changeTooLarge = error else {
        return XCTFail("expected .changeTooLarge, got \(error)")
      }
    }
  }

  func testOversizedSnapshotBytesThrowsDocumentTooLarge() throws {
    // Exercises the whole-document 20 MiB guard directly (via a synthetic
    // oversized byte blob) rather than growing a real document to that
    // size through thousands of 1 MiB-capped changes, which would make
    // this test slow without exercising any additional code path — both
    // limits share the same `loadedDocument`/`export` size checks.
    let oversized = Data(repeating: 0, count: PageDocument.maximumDocumentBytes + 1)
    XCTAssertThrowsError(try PageDocument.projection(of: oversized)) { error in
      guard case PageDocumentError.documentTooLarge = error else {
        return XCTFail("expected .documentTooLarge, got \(error)")
      }
    }
  }

  func testChangeWithinLimitSucceeds() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let text = String(repeating: "a", count: 1024)
    let result = try PageDocument.insertText(.body, at: 0, text: text, in: created.document)
    XCTAssertEqual(result.projection.plainText.count, 1024)
  }

  // MARK: - Version tokens

  func testVersionMatchesReflectsSnapshotIdentity() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let version = try PageDocument.currentVersion(of: created.document)
    XCTAssertTrue(try PageDocument.versionMatches(version, in: created.document))

    let edited = try PageDocument.insertText(.body, at: 0, text: "x", in: created.document)
    XCTAssertFalse(try PageDocument.versionMatches(version, in: edited.document))
  }

  // MARK: - Two-replica merge (convergence)

  func testTwoReplicaMergeConverges() throws {
    let created = try PageDocument.create(
      id: pageID, kind: .free, title: "Shared page", createdAt: Date(timeIntervalSince1970: 0))

    // Replica A: appends body text.
    let replicaA = try PageDocument.insertText(.body, at: 0, text: "From A", in: created.document)

    // Replica B starts from the SAME shared ancestor (`created.document`,
    // not replica A's state) and adds a supertag independently — this
    // mirrors two devices editing offline from the same synced base.
    let replicaB = try PageDocument.addSupertag(SupertagID(rawValue: "task"), in: created.document)

    // Merge B into A, and A into B — both directions must converge to the
    // same logical state (real Loro CRDT merge, not the sync protocol's
    // vault-meta LWW simplification — see PageDocument.merge's doc
    // comment).
    let mergedIntoA = try PageDocument.merge(local: replicaA.document, remote: replicaB.document)
    let mergedIntoB = try PageDocument.merge(local: replicaB.document, remote: replicaA.document)

    XCTAssertEqual(mergedIntoA.projection.plainText, "From A")
    XCTAssertEqual(mergedIntoA.projection.objectMetadata.supertagIDs, [SupertagID(rawValue: "task")])

    XCTAssertEqual(mergedIntoA.projection.plainText, mergedIntoB.projection.plainText)
    XCTAssertEqual(
      mergedIntoA.projection.objectMetadata.supertagIDs,
      mergedIntoB.projection.objectMetadata.supertagIDs
    )
    XCTAssertEqual(mergedIntoA.projection.title, mergedIntoB.projection.title)
  }

  func testTwoReplicaMergeConvergesForRelationshipEdges() throws {
    let created = try PageDocument.create(id: pageID, kind: .free, title: "", createdAt: Date())
    let targetID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-0000000000B7")!)
    let key = SupertagPropertyKey(
      supertagID: SupertagID(rawValue: "task"), fieldID: SupertagFieldID(rawValue: "project"))

    let replicaA = try PageDocument.setProperty(key: key, values: [.page(targetID)], in: created.document)
    let replicaB = try PageDocument.insertText(.body, at: 0, text: "note from B", in: created.document)

    let merged = try PageDocument.merge(local: replicaA.document, remote: replicaB.document)

    XCTAssertEqual(merged.projection.plainText, "note from B")
    XCTAssertEqual(merged.projection.graphEdges.map(\.targetNodeID), [targetID])
  }
}
