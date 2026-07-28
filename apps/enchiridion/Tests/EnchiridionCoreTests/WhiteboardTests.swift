import Foundation
import XCTest
@testable import EnchiridionCore

final class WhiteboardTests: XCTestCase {
  func testCanvasQueriesAreCappedAtThePageCardLimit() throws {
    let definition = LiveQueryDefinition(
      name: "Bounded canvas",
      source: .pages,
      viewKind: .canvas,
      limit: WhiteboardLimits.maximumPageCards + 1
    )

    XCTAssertEqual(definition.limit, WhiteboardLimits.maximumPageCards)
    XCTAssertThrowsError(
      try DomainQueryCodec.parse(
        "SELECT * FROM pages LIMIT \(WhiteboardLimits.maximumPageCards + 1) VIEW CANVAS"
      )
    )
  }

  func testCanvasQueryAndEveryElementKindRoundTripThroughGRDB() async throws {
    let fixture = try WhiteboardFixture()
    let page = try await fixture.repository.createFreePage(title: "Card")
    let view = LiveQueryDefinition(
      id: .init(rawValue: "view_canvas_roundtrip"),
      name: "Map",
      source: .pages,
      viewKind: .canvas
    )
    try await fixture.repository.saveView(view, now: Date(timeIntervalSince1970: 100))

    let rectangle = element("rectangle", .rectangle, x: 10, y: 20)
    let ellipse = element("ellipse", .ellipse, x: 300, y: 20)
    let elements: [WhiteboardElement] = [
      .init(
        id: .pageCard(page.id),
        kind: .page(page.id),
        bounds: .init(x: 10, y: 240, width: 240, height: 132)
      ),
      rectangle,
      ellipse,
      element("diamond", .diamond, x: 590, y: 20),
      element("text", .text("A plain label"), x: 10, y: 430),
      element("sticky", .sticky("A durable thought"), x: 300, y: 430),
      .init(
        id: .init(rawValue: "freehand"),
        kind: .freehand([.init(x: 20, y: 620), .init(x: 45, y: 640), .init(x: 80, y: 625)]),
        bounds: .init(x: 20, y: 620, width: 60, height: 20),
        style: .init(strokeColor: "#4338ca", strokeWidth: 3, roughness: 1.5)
      ),
      .init(
        id: .init(rawValue: "arrow"),
        kind: .arrow(
          .init(
            points: [.init(x: 230, y: 80), .init(x: 300, y: 80)],
            start: .init(elementID: rectangle.id, anchor: .init(x: 1, y: 0.5)),
            end: .init(elementID: ellipse.id, anchor: .init(x: 0, y: 0.5))
          )
        ),
        bounds: .init(x: 230, y: 79, width: 70, height: 2),
        style: .init(strokeStyle: .dashed)
      ),
    ]

    let inserted = try await fixture.repository.upsertWhiteboardElements(
      elements,
      in: view.id,
      expectedRevision: 0,
      now: Date(timeIntervalSince1970: 200)
    )
    let viewport = WhiteboardViewport(center: .init(x: 400, y: 300), zoom: 1.5)
    let viewportReceipt = try await fixture.repository.updateWhiteboardViewport(
      viewport,
      in: view.id,
      expectedRevision: inserted.after.revision,
      now: Date(timeIntervalSince1970: 300)
    )

    let reopened = try LibraryRepository(path: fixture.path)
    let persisted = try await reopened.whiteboardDocument(for: view.id)
    let parsedQuery = try DomainQueryCodec.parse(view.domainSQL, id: view.id, name: view.name)
    let cloudRecord = try await reopened.savedViewCloudRecord(id: view.id)

    XCTAssertEqual(parsedQuery.viewKind, .canvas)
    XCTAssertEqual(persisted, viewportReceipt.after)
    XCTAssertEqual(persisted?.viewport, viewport)
    XCTAssertEqual(persisted?.orderedElementIDs, elements.map(\.id))
    XCTAssertEqual(cloudRecord?.whiteboardDocument, persisted)
    let dirtyViews = try await reopened.dirtyViews()
    XCTAssertTrue(dirtyViews.contains { $0.id == view.id })
  }

  func testRevisionedBatchMoveConnectionsCleanupAndNoOp() async throws {
    let fixture = try WhiteboardFixture()
    let view = try await fixture.canvasView(id: "view_mutations")
    let first = element("first", .rectangle, x: 10, y: 10)
    let second = element("second", .ellipse, x: 300, y: 10)
    let arrow = WhiteboardElement(
      id: .init(rawValue: "arrow"),
      kind: .arrow(.init(points: [.init(x: 230, y: 60), .init(x: 300, y: 60)])),
      bounds: .init(x: 230, y: 59, width: 70, height: 2)
    )
    let inserted = try await fixture.repository.upsertWhiteboardElements(
      [first, second, arrow], in: view.id, expectedRevision: 0)
    let connected = try await fixture.repository.connectWhiteboardArrow(
      arrow.id,
      start: .init(elementID: first.id, anchor: .init(x: 1, y: 0.5)),
      end: .init(elementID: second.id, anchor: .init(x: 0, y: 0.5)),
      in: view.id,
      expectedRevision: inserted.after.revision
    )
    let moved = try await fixture.repository.moveWhiteboardElements(
      [
        .init(elementID: first.id, deltaX: 40, deltaY: 25),
        .init(elementID: arrow.id, deltaX: 40, deltaY: 25),
      ],
      in: view.id,
      expectedRevision: connected.after.revision
    )
    XCTAssertEqual(moved.after.element(id: first.id)?.bounds.x, 50)
    guard case .arrow(let movedArrow) = moved.after.element(id: arrow.id)?.kind else {
      return XCTFail("Expected an arrow")
    }
    XCTAssertEqual(movedArrow.points.first, .init(x: 270, y: 85))

    let deleted = try await fixture.repository.deleteWhiteboardElements(
      [second.id], in: view.id, expectedRevision: moved.after.revision)
    guard case .arrow(let cleanedArrow) = deleted.after.element(id: arrow.id)?.kind else {
      return XCTFail("Expected an arrow")
    }
    XCTAssertNotNil(cleanedArrow.start)
    XCTAssertNil(cleanedArrow.end)

    let savedRecord = try await fixture.repository.savedViewCloudRecord(id: view.id)
    let savedGeneration = try XCTUnwrap(savedRecord?.dirtyGeneration)
    try await fixture.repository.markViewCloudSaved(
      id: view.id,
      sentGeneration: savedGeneration,
      systemFields: Data([1])
    )
    let noOp = try await fixture.repository.deleteWhiteboardElements(
      [], in: view.id, expectedRevision: deleted.after.revision)
    XCTAssertEqual(noOp.before.revision, noOp.after.revision)
    let dirtyViews = try await fixture.repository.dirtyViews()
    XCTAssertFalse(dirtyViews.contains { $0.id == view.id })

    do {
      _ = try await fixture.repository.moveWhiteboardElements(
        [.init(elementID: first.id, deltaX: 1, deltaY: 1)],
        in: view.id,
        expectedRevision: 0
      )
      XCTFail("Expected a stale-revision error")
    } catch let error as WhiteboardError {
      XCTAssertEqual(
        error,
        .staleRevision(expected: 0, actual: deleted.after.revision)
      )
    }
  }

  func testPageCardsSeedDeterministicallyRetainFilteredPlacementsAndRejectDuplicates() async throws {
    let fixture = try WhiteboardFixture()
    let view = try await fixture.canvasView(id: "view_cards")
    let pages = [
      try await fixture.repository.createFreePage(title: "Charlie"),
      try await fixture.repository.createFreePage(title: "Alpha"),
      try await fixture.repository.createFreePage(title: "Bravo"),
    ]
    let seeded = try await fixture.repository.ensureWhiteboardPageCards(
      pages.reversed().map(\.id), in: view.id, expectedRevision: 0)
    let cards = pageCards(in: seeded.after)
    let sortedIDs = pages.map(\.id).sorted { $0.rawValue < $1.rawValue }
    XCTAssertEqual(cards.map(\.pageID), sortedIDs)
    XCTAssertEqual(cards.map(\.bounds.x), [64, 352, 640])

    let alpha = try XCTUnwrap(cards.first)
    let moved = try await fixture.repository.moveWhiteboardElements(
      [.init(elementID: alpha.elementID, deltaX: 77, deltaY: 33)],
      in: view.id,
      expectedRevision: seeded.after.revision
    )
    let reconciled = try await fixture.repository.reconcileWhiteboardPageCards(
      [pages[1].id],
      in: view.id,
      expectedRevision: moved.after.revision
    )
    XCTAssertEqual(reconciled.after.revision, moved.after.revision)
    XCTAssertEqual(reconciled.after.element(id: alpha.elementID)?.bounds, moved.after.element(id: alpha.elementID)?.bounds)
    XCTAssertEqual(pageCards(in: reconciled.after).count, 3, "Filtered cards retain their placement")

    let reset = try await fixture.repository.resetWhiteboardPageCards(
      pages.map(\.id), in: view.id, expectedRevision: reconciled.after.revision)
    XCTAssertEqual(pageCards(in: reset.after).map(\.bounds.x), [64, 352, 640])

    let duplicate = WhiteboardElement(
      id: .init(rawValue: "duplicate-card"),
      kind: .page(sortedIDs[0]),
      bounds: .init(x: 900, y: 64, width: 240, height: 132)
    )
    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.upsertWhiteboardElements([duplicate], in: view.id)
    }

    let tooMany = (0...WhiteboardLimits.maximumPageCards).map {
      PageID(rawValue: "page_limit_\($0)")
    }
    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.ensureWhiteboardPageCards(tooMany, in: view.id)
    }
  }

  func testDuplicateViewCopiesCanvasIndependentlyAndDeleteCleansTombstone() async throws {
    let fixture = try WhiteboardFixture()
    let source = try await fixture.canvasView(id: "view_source")
    let shape = element("shape", .diamond, x: 50, y: 60)
    _ = try await fixture.repository.upsertWhiteboardElements([shape], in: source.id)
    var duplicate = source
    duplicate.id = .init(rawValue: "view_duplicate")
    duplicate.name = "Map Copy"

    try await fixture.repository.duplicateView(
      duplicate,
      from: source.id,
      now: Date(timeIntervalSince1970: 300)
    )
    let loadedSourceDocument = try await fixture.repository.whiteboardDocument(for: source.id)
    let loadedDuplicateDocument = try await fixture.repository.whiteboardDocument(for: duplicate.id)
    let sourceDocument = try XCTUnwrap(loadedSourceDocument)
    let duplicateDocument = try XCTUnwrap(loadedDuplicateDocument)
    XCTAssertEqual(duplicateDocument.elements, sourceDocument.elements)
    XCTAssertEqual(duplicateDocument.revision, 0)

    _ = try await fixture.repository.moveWhiteboardElements(
      [.init(elementID: shape.id, deltaX: 100, deltaY: 0)],
      in: duplicate.id,
      expectedRevision: 0
    )
    let unchangedSource = try await fixture.repository.whiteboardDocument(for: source.id)
    XCTAssertEqual(unchangedSource, sourceDocument, "Duplicate mutations must not affect the source")

    try await fixture.repository.deleteView(source.id)
    let deletedDocument = try await fixture.repository.whiteboardDocument(for: source.id)
    let tombstone = try await fixture.repository.savedViewCloudRecord(id: source.id)
    let survivingDuplicate = try await fixture.repository.whiteboardDocument(for: duplicate.id)
    XCTAssertNil(deletedDocument)
    XCTAssertEqual(tombstone?.whiteboardDocument, .empty)
    XCTAssertNotNil(survivingDuplicate)
  }

  func testCloudRoundTripAndLegacyRecordPreservesAndReuploadsCanvas() async throws {
    let sourceFixture = try WhiteboardFixture()
    let sourceView = try await sourceFixture.canvasView(id: "view_cloud")
    _ = try await sourceFixture.repository.upsertWhiteboardElements(
      [element("cloud-shape", .rectangle, x: 42, y: 84)],
      in: sourceView.id,
      now: Date(timeIntervalSince1970: 200)
    )
    let loadedOutbound = try await sourceFixture.repository.savedViewCloudRecord(id: sourceView.id)
    let outbound = try XCTUnwrap(loadedOutbound)

    let targetFixture = try WhiteboardFixture()
    let needsUpload = try await targetFixture.repository.mergeCloudView(
      id: outbound.id,
      definition: outbound.definition,
      isDeleted: false,
      sortOrder: outbound.sortOrder,
      modifiedAt: outbound.modifiedAt,
      dirtyGeneration: outbound.dirtyGeneration,
      systemFields: Data([4]),
      whiteboardDocument: outbound.whiteboardDocument
    )
    XCTAssertFalse(needsUpload)
    let receivedDocument = try await targetFixture.repository.whiteboardDocument(for: outbound.id)
    XCTAssertEqual(receivedDocument, outbound.whiteboardDocument)

    try await targetFixture.repository.markViewCloudSaved(
      id: outbound.id,
      sentGeneration: outbound.dirtyGeneration,
      systemFields: Data([5])
    )
    let legacyNeedsUpload = try await targetFixture.repository.mergeCloudView(
      id: outbound.id,
      definition: outbound.definition,
      isDeleted: false,
      sortOrder: outbound.sortOrder,
      modifiedAt: outbound.modifiedAt.addingTimeInterval(100),
      dirtyGeneration: outbound.dirtyGeneration + 1,
      systemFields: Data([6]),
      whiteboardDocument: nil
    )
    XCTAssertTrue(legacyNeedsUpload)
    let preservedDocument = try await targetFixture.repository.whiteboardDocument(for: outbound.id)
    let dirtyViews = try await targetFixture.repository.dirtyViews()
    XCTAssertEqual(preservedDocument, outbound.whiteboardDocument)
    XCTAssertTrue(dirtyViews.contains { $0.id == outbound.id })
  }

  func testValidationBoundsBatchLimitsAndFitMetadata() async throws {
    let fixture = try WhiteboardFixture()
    let view = try await fixture.canvasView(id: "view_bounds")
    let invalid = WhiteboardElement(
      id: .init(rawValue: "invalid"),
      kind: .rectangle,
      bounds: .init(x: .infinity, y: 0, width: 100, height: 100)
    )
    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.upsertWhiteboardElements([invalid], in: view.id)
    }
    let emptyDocument = try await fixture.repository.whiteboardDocument(for: view.id)
    XCTAssertEqual(emptyDocument, .empty)

    let tooMany = (0...WhiteboardLimits.maximumElementsPerMutation).map {
      element("batch-\($0)", .rectangle, x: Double($0), y: 0)
    }
    await XCTAssertThrowsErrorAsync {
      try await fixture.repository.upsertWhiteboardElements(tooMany, in: view.id)
    }

    _ = try await fixture.repository.upsertWhiteboardElements(
      [
        element("top-left", .rectangle, x: 100, y: 200),
        element("bottom-right", .ellipse, x: 500, y: 600),
      ],
      in: view.id
    )
    let fit = try await fixture.repository.whiteboardFitMetadata(
      for: view.id,
      viewportSize: .init(width: 1_000, height: 800),
      padding: 50
    )
    XCTAssertEqual(fit.contentBounds, .init(x: 100, y: 200, width: 620, height: 520))
    XCTAssertEqual(fit.viewport.center, .init(x: 410, y: 460))
    XCTAssertGreaterThanOrEqual(fit.viewport.zoom, WhiteboardLimits.minimumZoom)
    XCTAssertLessThanOrEqual(fit.viewport.zoom, WhiteboardLimits.maximumZoom)
  }

  private func element(
    _ id: String,
    _ kind: WhiteboardElementKind,
    x: Double,
    y: Double
  ) -> WhiteboardElement {
    .init(
      id: .init(rawValue: id),
      kind: kind,
      bounds: .init(x: x, y: y, width: 220, height: 120)
    )
  }

  private func pageCards(
    in document: WhiteboardDocument
  ) -> [(elementID: WhiteboardElementID, pageID: PageID, bounds: WhiteboardBounds)] {
    document.elements.compactMap { element in
      guard case .page(let pageID) = element.kind else { return nil }
      return (element.id, pageID, element.bounds)
    }
  }
}

private final class WhiteboardFixture {
  let path: String
  let repository: LibraryRepository

  init() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-whiteboard-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    path = directory.appendingPathComponent("library.sqlite").path
    repository = try LibraryRepository(path: path)
  }

  func canvasView(id: String) async throws -> LiveQueryDefinition {
    let view = LiveQueryDefinition(
      id: .init(rawValue: id),
      name: "Canvas",
      source: .pages,
      viewKind: .canvas
    )
    try await repository.saveView(view)
    return view
  }

  deinit {
    try? FileManager.default.removeItem(at: URL(fileURLWithPath: path).deletingLastPathComponent())
  }
}

private func XCTAssertThrowsErrorAsync<T>(
  _ expression: () async throws -> T,
  file: StaticString = #filePath,
  line: UInt = #line
) async {
  do {
    _ = try await expression()
    XCTFail("Expected expression to throw", file: file, line: line)
  } catch {}
}
