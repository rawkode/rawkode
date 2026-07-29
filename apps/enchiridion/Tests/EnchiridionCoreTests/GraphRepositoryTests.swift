import Foundation
import XCTest
@testable import EnchiridionCore

final class GraphRepositoryTests: XCTestCase {
  func testGraphProjectionExposesTypedFactsThroughReadOnlySQLite() async throws {
    let fixture = try GraphRepositoryFixture(testCase: self)
    let project = try await fixture.repository.createTaggedPage(
      title: "Graph launch",
      supertagID: BuiltInSupertags.project
    )
    try await fixture.repository.setProperty(
      pageID: project.id,
      key: ProjectFields.status,
      values: [.select("active")]
    )

    let result = try fixture.repository.runGraphSQL(
      """
      SELECT node.node_id, node.title, fact.text_value AS status
      FROM graph_nodes node
      JOIN graph_facts fact ON fact.node_id = node.node_id
      WHERE fact.predicate_id = :predicate
      """,
      arguments: [
        "predicate": .text(
          PredicateID.property(
            tagID: BuiltInSupertags.project,
            fieldID: ProjectFields.status.fieldID
          ).rawValue
        )
      ]
    )

    XCTAssertEqual(result.rows.count, 1)
    XCTAssertEqual(result.value(column: "node_id", in: result.rows[0]), .text(project.id.rawValue))
    XCTAssertEqual(result.value(column: "status", in: result.rows[0]), .text("active"))
    let facts = try await fixture.repository.graphFacts(for: project.id)
    XCTAssertEqual(facts.first?.value, .select("active"))
  }

  func testSQLAuthorizerHidesPhysicalTablesAndRejectsWritesAndMultipleStatements() throws {
    let fixture = try GraphRepositoryFixture(testCase: self)

    XCTAssertThrowsError(try fixture.repository.runGraphSQL("SELECT * FROM pages")) { error in
      guard case .unauthorized = error as? GraphQueryError else {
        return XCTFail("Expected an authorization error, got \(error)")
      }
    }
    XCTAssertThrowsError(try fixture.repository.runGraphSQL("DELETE FROM graph_nodes")) { error in
      XCTAssertEqual(error as? GraphQueryError, .readOnlyRequired)
    }
    XCTAssertThrowsError(
      try fixture.repository.runGraphSQL("SELECT * FROM graph_nodes; SELECT * FROM graph_tags")
    ) { error in
      XCTAssertEqual(error as? GraphQueryError, .multipleStatements)
    }
  }

  func testMultipleInheritanceClosureIsQueryVisibleAndCyclesRollback() async throws {
    let fixture = try GraphRepositoryFixture(testCase: self)
    let company = try await fixture.repository.createTaggedPage(
      title: "Acme",
      supertagID: BuiltInSupertags.company
    )
    let effective = try await fixture.repository.effectiveTagIDs(for: company.id)
    XCTAssertTrue(effective.isSuperset(of: [BuiltInSupertags.company, BuiltInSupertags.organization]))

    let parent = SupertagDefinition.draft(name: "Parent")
    var child = SupertagDefinition.draft(name: "Child")
    child.parentIDs = [parent.id]
    try await fixture.repository.saveSupertag(parent)
    try await fixture.repository.saveSupertag(child)
    var cyclicParent = parent
    cyclicParent.parentIDs = [child.id]

    await XCTAssertThrowsErrorAsync(try await fixture.repository.saveSupertag(cyclicParent)) { error in
      guard case .inheritanceCycle = error as? GraphModelError else {
        return XCTFail("Expected an inheritance cycle, got \(error)")
      }
    }
    let persisted = try await fixture.repository.supertags().first { $0.id == parent.id }
    XCTAssertEqual(persisted?.parentIDs, [])
  }

  func testCanonicalEdgeDrivesPropertyAdapterInverseBacklinkAndCardinality() async throws {
    let fixture = try GraphRepositoryFixture(testCase: self)
    let task = try await fixture.repository.createTaggedPage(
      title: "Ship graph",
      supertagID: BuiltInSupertags.task
    )
    let firstProject = try await fixture.repository.createTaggedPage(
      title: "Graph V2",
      supertagID: BuiltInSupertags.project
    )
    let secondProject = try await fixture.repository.createTaggedPage(
      title: "Other",
      supertagID: BuiltInSupertags.project
    )

    let edge = try await fixture.repository.createEdge(
      relationID: BuiltInRelations.taskProject,
      from: task.id,
      to: firstProject.id
    )
    let reloadedTask = try await fixture.repository.page(id: task.id)
    XCTAssertEqual(
      reloadedTask?.objectMetadata.properties[TaskFields.project],
      [.page(firstProject.id)]
    )
    let outgoingEdges = try await fixture.repository.outgoingEdges(from: task.id)
    let backlinks = try await fixture.repository.graphBacklinks(to: firstProject.id)
    XCTAssertEqual(outgoingEdges, [edge])
    XCTAssertEqual(backlinks.map(\.edge), [edge])

    try await fixture.repository.setProperty(
      pageID: task.id,
      key: TaskFields.project,
      values: [.page(firstProject.id)]
    )
    let stableOutgoingEdges = try await fixture.repository.outgoingEdges(from: task.id)
    XCTAssertEqual(stableOutgoingEdges, [edge])

    let inverse = try fixture.repository.runGraphSQL(
      "SELECT from_node_id, to_node_id, relationship_name FROM graph_edges WHERE edge_id = :edge AND direction = 'inverse'",
      arguments: ["edge": .text(edge.id.rawValue)]
    )
    XCTAssertEqual(inverse.value(column: "from_node_id", in: inverse.rows[0]), .text(firstProject.id.rawValue))
    XCTAssertEqual(inverse.value(column: "relationship_name", in: inverse.rows[0]), .text("tasks"))

    await XCTAssertThrowsErrorAsync(
      try await fixture.repository.createEdge(
        relationID: BuiltInRelations.taskProject,
        from: task.id,
        to: secondProject.id
      )
    ) { error in
      XCTAssertEqual(error as? GraphModelError, .cardinalityViolation(BuiltInRelations.taskProject))
    }
  }

  func testConcurrentMaxOneEdgesArePreservedFlaggedAndExplicitlyResolved() async throws {
    let fixture = try GraphRepositoryFixture(testCase: self)
    let task = try await fixture.repository.createTaggedPage(
      title: "Concurrent task",
      supertagID: BuiltInSupertags.task
    )
    let firstProject = try await fixture.repository.createTaggedPage(
      title: "First",
      supertagID: BuiltInSupertags.project
    )
    let secondProject = try await fixture.repository.createTaggedPage(
      title: "Second",
      supertagID: BuiltInSupertags.project
    )
    let firstEdge = KnowledgeEdge(
      relationID: BuiltInRelations.taskProject,
      sourceNodeID: task.id,
      targetNodeID: firstProject.id
    )
    let secondEdge = KnowledgeEdge(
      relationID: BuiltInRelations.taskProject,
      sourceNodeID: task.id,
      targetNodeID: secondProject.id
    )
    let first = try PageDocument.upsertEdge(firstEdge, in: task.document)
    let second = try PageDocument.upsertEdge(secondEdge, in: task.document)
    let mergedDocument = try PageDocument.merge(
      local: first.document,
      remote: second.document,
      pageID: task.id
    )
    _ = try await fixture.repository.mergeCloudPage(
      pageID: task.id,
      kind: task.kind,
      remoteDocument: mergedDocument.document,
      systemFields: Data([1])
    )

    let conflictedEdges = try await fixture.repository.outgoingEdges(from: task.id)
    let conflictIssues = try await fixture.repository.graphIssues()
    XCTAssertEqual(conflictedEdges.count, 2)
    XCTAssertEqual(conflictIssues.filter { $0.kind == .cardinalityViolation }.count, 2)

    try await fixture.repository.resolveCardinalityConflict(
      relationID: BuiltInRelations.taskProject,
      keeping: firstEdge.id
    )
    let resolvedEdges = try await fixture.repository.outgoingEdges(from: task.id)
    let resolvedIssues = try await fixture.repository.graphIssues()
    XCTAssertEqual(resolvedEdges, [firstEdge])
    XCTAssertTrue(resolvedIssues.isEmpty)
  }

  func testVisualQueryCompilerTraversesMultipleHopsAndSQLCanUseFTS() async throws {
    let fixture = try GraphRepositoryFixture(testCase: self)
    let area = try await fixture.repository.createTaggedPage(
      title: "Product",
      supertagID: BuiltInSupertags.area
    )
    let project = try await fixture.repository.createTaggedPage(
      title: "Knowledge graph",
      supertagID: BuiltInSupertags.project
    )
    let task = try await fixture.repository.createTaggedPage(
      title: "Model backlinks",
      supertagID: BuiltInSupertags.task
    )
    _ = try await fixture.repository.createEdge(
      relationID: BuiltInRelations.projectArea,
      from: project.id,
      to: area.id
    )
    _ = try await fixture.repository.createEdge(
      relationID: BuiltInRelations.taskProject,
      from: task.id,
      to: project.id
    )

    let query = GraphQueryDefinition(
      expression: .and([
        .tag(BuiltInSupertags.task),
        .traversal(.init(maximumDepth: 2, targetTagID: BuiltInSupertags.area)),
      ])
    )
    let result = try fixture.repository.runGraphQuery(query)
    XCTAssertEqual(result.rows.compactMap { result.value(column: "node_id", in: $0) }, [.text(task.id.rawValue)])

    let search = try fixture.repository.runGraphSQL(
      "SELECT node_id, title FROM graph_text_search WHERE graph_text_search MATCH :term",
      arguments: ["term": .text("backlinks")]
    )
    XCTAssertEqual(search.value(column: "node_id", in: search.rows[0]), .text(task.id.rawValue))
  }

  func testBuilderAndSQLSavedQueriesRoundTrip() async throws {
    let fixture = try GraphRepositoryFixture(testCase: self)
    let builder = SavedGraphQuery(
      name: "Tasks",
      source: .builder(.init(expression: .tag(BuiltInSupertags.task)))
    )
    let sql = SavedGraphQuery(
      name: "Counts",
      source: .sql("SELECT COUNT(*) AS count FROM graph_nodes"),
      presentation: .init(kind: .table)
    )

    try await fixture.repository.saveGraphQuery(builder)
    try await fixture.repository.saveGraphQuery(sql)
    let reopened = try LibraryRepository(path: fixture.path)

    let savedQueries = try await reopened.savedGraphQueries()
    XCTAssertEqual(Set(savedQueries), Set([builder, sql]))
  }
}

private struct GraphRepositoryFixture {
  let path: String
  let repository: LibraryRepository

  init(testCase: XCTestCase) throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("GraphRepositoryTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    testCase.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    path = directory.appendingPathComponent("graph.sqlite").path
    repository = try LibraryRepository(path: path)
  }
}

private func XCTAssertThrowsErrorAsync<T>(
  _ expression: @autoclosure () async throws -> T,
  _ errorHandler: (Error) -> Void = { _ in }
) async {
  do {
    _ = try await expression()
    XCTFail("Expected expression to throw")
  } catch {
    errorHandler(error)
  }
}
