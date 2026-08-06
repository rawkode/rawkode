// DecodeReencodeTests.swift
// EnchiridionImporterTests
//
// Round-trips SMALL SYNTHETIC old-app pages (built via `SyntheticOldVault.swift`
// against the real `Automerge.Document` API — never a real user's data)
// through `OldPageDocumentDecoder.decode` -> `PageReencoder.reencode`, then
// asserts the resulting NEW `EnchiridionSync.PageDocument` projection
// matches the original content, per the task brief's four required
// synthetic pages: a plain note, a page with marks + a page reference, a
// built-in supertag (`task`) with typed properties including an
// entityReference, and a runtime user-created supertag.
import Automerge
import EnchiridionCore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionImporter

final class DecodeReencodeTests: XCTestCase {

  // MARK: - Plain note

  func testPlainNoteRoundTrips() throws {
    let document = SyntheticOldPageBuilder.create(
      id: "page_note1", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Grocery list",
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    SyntheticOldPageBuilder.setBody(document, text: "Milk, eggs, bread.")

    let decoded = try OldPageDocumentDecoder.decode(document.save())
    XCTAssertEqual(decoded.title, "Grocery list")
    XCTAssertEqual(decoded.body, "Milk, eggs, bread.")
    XCTAssertTrue(decoded.marks.isEmpty)
    XCTAssertTrue(decoded.supertagIDs.isEmpty)
    XCTAssertEqual(decoded.originalPageID, PageID(rawValue: "page_note1"))

    let reencoded = try PageReencoder.reencode(decoded)
    // `.free` kind, no deterministic scheme applies -> old id carried
    // forward, proving idempotent re-run mapping for random pages.
    XCTAssertEqual(reencoded.pageID, PageID(rawValue: "page_note1"))

    let projection = try PageDocument.projection(of: reencoded.document)
    XCTAssertEqual(projection.title, "Grocery list")
    XCTAssertEqual(projection.plainText, "Milk, eggs, bread.")
    XCTAssertTrue(projection.objectMetadata.supertagIDs.isEmpty)
  }

  // MARK: - Marks + page reference

  func testMarksAndPageReferenceRoundTrip() throws {
    let document = SyntheticOldPageBuilder.create(
      id: "page_marked1", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Formatted",
      createdAt: Date(timeIntervalSince1970: 1_700_000_100)
    )
    let body = "Hello World Link"
    SyntheticOldPageBuilder.setBody(document, text: body)
    // "Hello" = [0,5), "World" = [6,11), "Link" = [12,16).
    SyntheticOldPageBuilder.markBody(document, name: "strong", start: 0, end: 5)
    SyntheticOldPageBuilder.markBody(document, name: "em", start: 6, end: 11)
    SyntheticOldPageBuilder.markPageReference(
      document, targetPageID: "page_target1", label: "Link", start: 12, end: 16
    )

    let decoded = try OldPageDocumentDecoder.decode(document.save())
    XCTAssertEqual(decoded.body, body)
    XCTAssertEqual(decoded.marks.count, 3)

    let styles = decoded.marks.compactMap { mark -> LoroEngine.MarkStyle? in
      if case .style(let style) = mark.kind { return style }
      return nil
    }
    XCTAssertEqual(Set(styles), [.bold, .italic])

    let pageRefs = decoded.marks.compactMap { mark -> (PageID, String)? in
      if case .pageReference(let pageID, let label) = mark.kind { return (pageID, label) }
      return nil
    }
    XCTAssertEqual(pageRefs.count, 1)
    XCTAssertEqual(pageRefs.first?.0, PageID(rawValue: "page_target1"))
    XCTAssertEqual(pageRefs.first?.1, "Link")

    let reencoded = try PageReencoder.reencode(decoded)
    let projection = try PageDocument.projection(of: reencoded.document)
    XCTAssertEqual(projection.plainText, body)
    XCTAssertEqual(projection.references.count, 1)
    XCTAssertEqual(projection.references.first?.targetPageID, PageID(rawValue: "page_target1"))
    XCTAssertEqual(projection.references.first?.fallbackLabel, "Link")

    let boldRuns = projection.formattingMarks.filter { $0.style == .bold }
    XCTAssertTrue(boldRuns.contains { $0.range == 0..<5 })
    let italicRuns = projection.formattingMarks.filter { $0.style == .italic }
    XCTAssertTrue(italicRuns.contains { $0.range == 6..<11 })
  }

  // MARK: - Page reference to a daily page re-derives the NEW id scheme

  func testPageReferenceToDailyPageRederivesNewIDScheme() throws {
    let document = SyntheticOldPageBuilder.create(
      id: "page_marked2", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Meeting notes",
      createdAt: Date(timeIntervalSince1970: 1_700_000_150)
    )
    let body = "See yesterday"
    SyntheticOldPageBuilder.setBody(document, text: body)
    // "yesterday" = [4,13). Old app wrote daily-page reference targets as
    // `daily_<YYYY-MM-DD>` (underscore) — PageModels.swift's
    // `PageID.daily(_:)`, pre-rename.
    SyntheticOldPageBuilder.markPageReference(
      document, targetPageID: "daily_2024-03-15", label: "yesterday", start: 4, end: 13
    )

    let decoded = try OldPageDocumentDecoder.decode(document.save())
    let pageRefs = decoded.marks.compactMap { mark -> (PageID, String)? in
      if case .pageReference(let pageID, let label) = mark.kind { return (pageID, label) }
      return nil
    }
    XCTAssertEqual(pageRefs.count, 1)
    // Decoder reads the old payload verbatim — no re-derivation happens
    // here, only in `PageReencoder`.
    XCTAssertEqual(pageRefs.first?.0, PageID(rawValue: "daily_2024-03-15"))

    let reencoded = try PageReencoder.reencode(decoded)
    let projection = try PageDocument.projection(of: reencoded.document)
    XCTAssertEqual(projection.references.count, 1)
    // The re-encoded reference must resolve to the NEW `daily:YYYY-MM-DD`
    // format (colon separator) — matching the target daily page's own
    // re-derived identity — not the stale OLD `daily_YYYY-MM-DD` format.
    XCTAssertEqual(projection.references.first?.targetPageID, PageID.daily(DayKey(rawValue: "2024-03-15")))
    XCTAssertEqual(projection.references.first?.targetPageID.rawValue, "daily:2024-03-15")
    XCTAssertNotEqual(projection.references.first?.targetPageID, PageID(rawValue: "daily_2024-03-15"))
    XCTAssertEqual(projection.references.first?.fallbackLabel, "yesterday")
  }

  // MARK: - Built-in supertag with typed properties + entityReference

  func testBuiltInTaskWithTypedPropertiesRoundTrips() throws {
    let projectDocument = SyntheticOldPageBuilder.create(
      id: "page_project1", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Migrate infra",
      createdAt: Date(timeIntervalSince1970: 1_700_000_200)
    )
    SyntheticOldPageBuilder.addSupertag(projectDocument, "project")

    let taskDocument = SyntheticOldPageBuilder.create(
      id: "page_task1", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Write migration plan",
      createdAt: Date(timeIntervalSince1970: 1_700_000_300)
    )
    SyntheticOldPageBuilder.addSupertag(taskDocument, "task")
    SyntheticOldPageBuilder.setScalarProperty(
      taskDocument, supertagID: "task", fieldID: "status", jsonValues: [SyntheticSupertagValue.select("to-do")]
    )
    SyntheticOldPageBuilder.setScalarProperty(
      taskDocument, supertagID: "task", fieldID: "notes", jsonValues: [SyntheticSupertagValue.text("Draft first.")]
    )
    // Old app's NAMED relation id for task.project (GraphOntology.swift) —
    // exercises `OldBuiltInRelations.propertyKey(for:)`'s named-case
    // branch, not just the synthetic fallback.
    SyntheticOldPageBuilder.addEdge(
      taskDocument, edgeID: "edge_1", relationID: "task.project", sourcePageID: "page_task1",
      targetPageID: "page_project1", createdAt: Date(timeIntervalSince1970: 1_700_000_301)
    )

    let decoded = try OldPageDocumentDecoder.decode(taskDocument.save())
    XCTAssertEqual(decoded.supertagIDs, [SupertagID(rawValue: "task")])

    let statusKey = SupertagPropertyKey(supertagID: .init(rawValue: "task"), fieldID: .init(rawValue: "status"))
    XCTAssertEqual(decoded.properties[statusKey], [.select("to-do")])

    let projectKey = SupertagPropertyKey(supertagID: .init(rawValue: "task"), fieldID: .init(rawValue: "project"))
    XCTAssertEqual(decoded.properties[projectKey], [.page(PageID(rawValue: "page_project1"))])

    let reencoded = try PageReencoder.reencode(decoded)
    let projection = try PageDocument.projection(of: reencoded.document)
    XCTAssertTrue(projection.objectMetadata.supertagIDs.contains(SupertagID(rawValue: "task")))
    XCTAssertEqual(projection.objectMetadata.properties[statusKey], [.select("to-do")])
    XCTAssertEqual(projection.objectMetadata.properties[projectKey], [.page(PageID(rawValue: "page_project1"))])

    // entityReference values become edges automatically, per
    // `PageDocument.setProperty`'s documented duality — assert a real edge
    // exists in the re-encoded doc, not just that the property reads back.
    XCTAssertTrue(
      projection.graphEdges.contains {
        $0.sourceNodeID == reencoded.pageID && $0.targetNodeID == PageID(rawValue: "page_project1")
      }
    )
  }

  // MARK: - Runtime user-created supertag

  func testRuntimeUserCreatedSupertagPageRoundTrips() throws {
    let document = SyntheticOldPageBuilder.create(
      id: "page_custom1", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Sourdough #4",
      createdAt: Date(timeIntervalSince1970: 1_700_000_400)
    )
    let runtimeTagID = "tag-3f9ad9c2-1111-4a11-9a11-111111111111"
    SyntheticOldPageBuilder.addSupertag(document, runtimeTagID)
    SyntheticOldPageBuilder.setScalarProperty(
      document, supertagID: runtimeTagID, fieldID: "hydration",
      jsonValues: [SyntheticSupertagValue.number(78.5)]
    )

    let decoded = try OldPageDocumentDecoder.decode(document.save())
    XCTAssertEqual(decoded.supertagIDs, [SupertagID(rawValue: runtimeTagID)])
    let hydrationKey = SupertagPropertyKey(
      supertagID: .init(rawValue: runtimeTagID), fieldID: .init(rawValue: "hydration")
    )
    XCTAssertEqual(decoded.properties[hydrationKey], [.number(78.5)])

    let reencoded = try PageReencoder.reencode(decoded)
    let projection = try PageDocument.projection(of: reencoded.document)
    XCTAssertTrue(projection.objectMetadata.supertagIDs.contains(SupertagID(rawValue: runtimeTagID)))
    XCTAssertEqual(projection.objectMetadata.properties[hydrationKey], [.number(78.5)])
  }

  // MARK: - Soft-deleted / pinned pages carry through

  func testDeletedAndPinnedFlagsRoundTrip() throws {
    let document = SyntheticOldPageBuilder.create(
      id: "page_trashed1", kind: SyntheticOldPageBuilder.freeKindJSON, title: "Old draft",
      createdAt: Date(timeIntervalSince1970: 1_700_000_500)
    )
    SyntheticOldPageBuilder.setPinned(document, true)
    let deletedAt = Date(timeIntervalSince1970: 1_700_000_600)
    SyntheticOldPageBuilder.setDeleted(document, deletedAt)

    let decoded = try OldPageDocumentDecoder.decode(document.save())
    XCTAssertTrue(decoded.isPinned)
    XCTAssertNotNil(decoded.deletedAt)

    let reencoded = try PageReencoder.reencode(decoded)
    let projection = try PageDocument.projection(of: reencoded.document)
    XCTAssertTrue(projection.isPinned)
    XCTAssertNotNil(projection.deletedAt)
  }
}
