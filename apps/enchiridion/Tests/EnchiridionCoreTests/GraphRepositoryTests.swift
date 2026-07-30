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
    XCTAssertThrowsError(
      try fixture.repository.runGraphSQL("SELECT * FROM 'graph_text_search_content'")
    ) { error in
      guard case .unauthorized = error as? GraphQueryError else {
        return XCTFail("Expected an authorization error, got \(error)")
      }
    }
  }

  func testDecodedAndCompiledGraphQueriesEnforceResourceBounds() throws {
    var traversal = GraphTraversal()
    traversal.minimumDepth = -100
    traversal.maximumDepth = 10_000
    let decodedTraversal = try JSONDecoder.enchiridion.decode(
      GraphTraversal.self,
      from: JSONEncoder.enchiridion.encode(traversal)
    )
    XCTAssertEqual(decodedTraversal.minimumDepth, 1)
    XCTAssertEqual(decodedTraversal.maximumDepth, GraphTraversal.maximumAllowedDepth)

    var definition = GraphQueryDefinition(expression: .traversal(traversal))
    definition.limit = 100_000
    let decodedDefinition = try JSONDecoder.enchiridion.decode(
      GraphQueryDefinition.self,
      from: JSONEncoder.enchiridion.encode(definition)
    )
    XCTAssertEqual(decodedDefinition.limit, GraphQueryDefinition.maximumAllowedLimit)

    let compiled = GraphQueryCompiler.compile(definition)
    XCTAssertTrue(compiled.sql.contains("walk.depth < 8"))
    XCTAssertTrue(compiled.sql.contains("LIMIT 5000"))
    XCTAssertTrue(compiled.sql.contains("SELECT node.node_id, 0"))
    XCTAssertFalse(compiled.sql.contains("FROM graph_nodes seed"))
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

  func testEventReferencePropertiesRoundTripThroughCanonicalEdges() async throws {
    let fixture = try GraphRepositoryFixture(testCase: self)
    let event = try await fixture.repository.createTaggedPage(
      title: "Graph review",
      supertagID: BuiltInSupertags.event
    )
    let organizer = try await fixture.repository.createTaggedPage(
      title: "Ada",
      supertagID: BuiltInSupertags.person
    )
    let attendee = try await fixture.repository.createTaggedPage(
      title: "Grace",
      supertagID: BuiltInSupertags.person
    )
    let place = try await fixture.repository.createTaggedPage(
      title: "Studio",
      supertagID: BuiltInSupertags.place
    )
    let properties: [(String, [SupertagValue])] = [
      ("organizer", [.page(organizer.id)]),
      ("attendees", [.page(organizer.id), .page(attendee.id)]),
      ("place", [.page(place.id)]),
    ]

    for (fieldID, values) in properties {
      try await fixture.repository.setProperty(
        pageID: event.id,
        key: .init(
          supertagID: BuiltInSupertags.event,
          fieldID: .init(rawValue: fieldID)
        ),
        values: values
      )
    }

    let reloadedPage = try await fixture.repository.page(id: event.id)
    let reloaded = try XCTUnwrap(reloadedPage)
    for (fieldID, values) in properties {
      let key = SupertagPropertyKey(
        supertagID: BuiltInSupertags.event,
        fieldID: .init(rawValue: fieldID)
      )
      let reloadedValues = reloaded.objectMetadata.properties[key]
      if values.count > 1 {
        XCTAssertEqual(Set(reloadedValues ?? []), Set(values))
      } else {
        XCTAssertEqual(reloadedValues, values)
      }
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

  func testChangingRelationSourceConstraintProjectsAnIssueForExistingEdge() async throws {
    let fixture = try GraphRepositoryFixture(testCase: self)
    let task = try await fixture.repository.createTaggedPage(
      title: "Prepare launch",
      supertagID: BuiltInSupertags.task
    )
    let project = try await fixture.repository.createTaggedPage(
      title: "Launch",
      supertagID: BuiltInSupertags.project
    )
    var relation = RelationDefinition(
      id: .random(),
      sourceTagIDs: [BuiltInSupertags.task],
      targetTagIDs: [BuiltInSupertags.project],
      forwardName: "Contributes to",
      inverseName: "Contributions"
    )
    try await fixture.repository.saveRelationDefinition(relation)
    let edge = try await fixture.repository.createEdge(
      relationID: relation.id,
      from: task.id,
      to: project.id
    )

    relation.sourceTagIDs = [BuiltInSupertags.person]
    try await fixture.repository.saveRelationDefinition(relation)

    let issues = try await fixture.repository.graphIssues()
    XCTAssertTrue(issues.contains {
      $0.kind == .invalidSourceType && $0.edgeID == edge.id && $0.relationID == relation.id
    })
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

    XCTAssertEqual(try reopened.runGraphQuery(sql).columns.map(\.name), ["count"])
    try await reopened.deleteGraphQuery(builder.id)
    let remainingQueries = try await reopened.savedGraphQueries()
    XCTAssertEqual(remainingQueries, [sql])
  }

  func testGraphMetadataCloudRoundTripPreservesDirtyLocalChangesAndTombstones() async throws {
    let source = try GraphRepositoryFixture(testCase: self)
    var relation = RelationDefinition(
      id: .random(),
      forwardName: "Mentors",
      inverseName: "Mentored by"
    )
    var query = SavedGraphQuery(
      name: "Mentorship",
      source: .sql("SELECT node_id, title FROM graph_nodes")
    )
    try await source.repository.saveRelationDefinition(
      relation,
      now: Date(timeIntervalSince1970: 10)
    )
    try await source.repository.saveGraphQuery(query, now: Date(timeIntervalSince1970: 10))

    let loadedRelationRecord = try await source.repository.relationDefinitionCloudRecord(
      id: relation.id
    )
    let loadedQueryRecord = try await source.repository.savedGraphQueryCloudRecord(id: query.id)
    let relationRecord = try XCTUnwrap(loadedRelationRecord)
    let queryRecord = try XCTUnwrap(loadedQueryRecord)

    relation.forwardName = "Coaches"
    query.name = "Coaching"
    try await source.repository.saveRelationDefinition(
      relation,
      now: Date(timeIntervalSince1970: 20)
    )
    try await source.repository.saveGraphQuery(query, now: Date(timeIntervalSince1970: 20))
    let relationStillDirty = try await source.repository.markRelationDefinitionCloudSaved(
      id: relation.id,
      sentGeneration: relationRecord.dirtyGeneration,
      systemFields: Data([1])
    )
    let queryStillDirty = try await source.repository.markGraphQueryCloudSaved(
      id: query.id,
      sentGeneration: queryRecord.dirtyGeneration,
      systemFields: Data([2])
    )
    XCTAssertTrue(relationStillDirty)
    XCTAssertTrue(queryStillDirty)

    let target = try GraphRepositoryFixture(testCase: self)
    let relationNeedsUpload = try await target.repository.mergeCloudRelationDefinition(
      id: relationRecord.definition.id,
      definition: relationRecord.definition,
      isDeleted: relationRecord.definition.isDeleted,
      modifiedAt: relationRecord.modifiedAt,
      dirtyGeneration: relationRecord.dirtyGeneration,
      systemFields: Data([3])
    )
    let queryNeedsUpload = try await target.repository.mergeCloudGraphQuery(
      id: queryRecord.query.id,
      query: queryRecord.query,
      isDeleted: queryRecord.isDeleted,
      sortOrder: queryRecord.sortOrder,
      modifiedAt: queryRecord.modifiedAt,
      dirtyGeneration: queryRecord.dirtyGeneration,
      systemFields: Data([4])
    )
    let dirtyRelations = try await target.repository.dirtyRelationDefinitions()
    let dirtyQueries = try await target.repository.dirtyGraphQueries()
    let targetRelations = try await target.repository.relationDefinitions()
    let targetQueries = try await target.repository.savedGraphQueries()
    XCTAssertFalse(relationNeedsUpload)
    XCTAssertFalse(queryNeedsUpload)
    XCTAssertTrue(dirtyRelations.isEmpty)
    XCTAssertTrue(dirtyQueries.isEmpty)
    XCTAssertTrue(targetRelations.contains {
      $0.id == relationRecord.definition.id
    })
    XCTAssertEqual(targetQueries, [queryRecord.query])

    let relationDeletionNeedsUpload = try await target.repository.applyCloudRelationDefinitionRecordDeletion(
      id: relationRecord.definition.id
    )
    let queryDeletionNeedsUpload = try await target.repository.applyCloudGraphQueryRecordDeletion(
      id: queryRecord.query.id
    )
    let remainingRelations = try await target.repository.relationDefinitions()
    let remainingQueries = try await target.repository.savedGraphQueries()
    XCTAssertFalse(relationDeletionNeedsUpload)
    XCTAssertFalse(queryDeletionNeedsUpload)
    XCTAssertFalse(remainingRelations.contains {
      $0.id == relationRecord.definition.id
    })
    XCTAssertTrue(remainingQueries.isEmpty)

    try await target.repository.markAllCloudDataForZoneRecovery()
    let recoveredRelations = try await target.repository.dirtyRelationDefinitions()
    let recoveredQueries = try await target.repository.dirtyGraphQueries()
    XCTAssertEqual(
      recoveredRelations.map(\.definition.id),
      [relationRecord.definition.id]
    )
    XCTAssertEqual(
      recoveredQueries.map(\.query.id),
      [queryRecord.query.id]
    )
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
