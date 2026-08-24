import XCTest
@testable import AthenaeumDomain

/// Same pattern as `EntityDecodingTests`: every RPC input/output schema decoded against a
/// TS-encoder-produced fixture, plus a round-trip through this package's own `Codable`.
final class RPCDecodingTests: XCTestCase {
    // MARK: - rpc.ts (nodes)

    func testCreateNodeInputWithoutId() throws {
        let input = try decodeFixture(CreateNodeInput.self, "CreateNodeInput")
        XCTAssertNil(input.id)
        XCTAssertEqual(input.title, "New node")
        try assertRoundTrips(input)
    }

    func testCreateNodeInputWithId() throws {
        let input = try decodeFixture(CreateNodeInput.self, "CreateNodeInputWithId")
        XCTAssertEqual(input.id?.rawValue, "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60")
        try assertRoundTrips(input)
    }

    func testCreateNodeOutput() throws {
        let output = try decodeFixture(CreateNodeOutput.self, "CreateNodeOutput")
        XCTAssertEqual(output.node.title, "Daily note — 2026-08-20")
        try assertRoundTrips(output)
    }

    func testGetNodeInputOutput() throws {
        try assertRoundTrips(try decodeFixture(GetNodeInput.self, "GetNodeInput"))
        try assertRoundTrips(try decodeFixture(GetNodeOutput.self, "GetNodeOutput"))
    }

    func testListNodesInputOutput() throws {
        try assertRoundTrips(try decodeFixture(ListNodesInput.self, "ListNodesInput"))
        let output = try decodeFixture(ListNodesOutput.self, "ListNodesOutput")
        XCTAssertEqual(output.nodes.count, 2)
        try assertRoundTrips(output)
    }

    func testNodesChangedEvent() throws {
        let event = try decodeFixture(NodesChangedEvent.self, "NodesChangedEvent")
        XCTAssertEqual(event.nodes.count, 1)
        try assertRoundTrips(event)
    }

    // MARK: - graph-rpc.ts

    func testCreateTagInputOutput() throws {
        try assertRoundTrips(try decodeFixture(CreateTagInput.self, "CreateTagInput"))
        let output = try decodeFixture(CreateTagOutput.self, "CreateTagOutput")
        XCTAssertEqual(output.tag.name, "Project")
        try assertRoundTrips(output)
    }

    func testAddFactInputOutput() throws {
        let input = try decodeFixture(AddFactInput.self, "AddFactInput")
        XCTAssertNil(input.id)
        XCTAssertEqual(input.value, .string("todo"))
        try assertRoundTrips(input)
        try assertRoundTrips(try decodeFixture(AddFactOutput.self, "AddFactOutput"))
    }

    func testCreateRelationDefinitionInputOutput() throws {
        let input = try decodeFixture(CreateRelationDefinitionInput.self, "CreateRelationDefinitionInput")
        XCTAssertEqual(input.cardinality, .manyToMany)
        try assertRoundTrips(input)
        try assertRoundTrips(try decodeFixture(CreateRelationDefinitionOutput.self, "CreateRelationDefinitionOutput"))
    }

    func testCreateEdgeInputOutput() throws {
        try assertRoundTrips(try decodeFixture(CreateEdgeInput.self, "CreateEdgeInput"))
        try assertRoundTrips(try decodeFixture(CreateEdgeOutput.self, "CreateEdgeOutput"))
    }

    func testRunViewInputOutput() throws {
        let input = try decodeFixture(RunViewInput.self, "RunViewInput")
        XCTAssertEqual(input.viewName, .graphNodes)
        XCTAssertEqual(input.viewSpec.rowLimit, 25)
        try assertRoundTrips(input)

        let output = try decodeFixture(RunViewOutput.self, "RunViewOutput")
        XCTAssertEqual(output.rows.count, 2)
        try assertRoundTrips(output)
    }

    func testListBacklinksInputOutput() throws {
        try assertRoundTrips(try decodeFixture(ListBacklinksInput.self, "ListBacklinksInput"))
        let output = try decodeFixture(ListBacklinksOutput.self, "ListBacklinksOutput")
        XCTAssertEqual(output.edges.count, 1)
        try assertRoundTrips(output)
    }

    func testListGraphIssuesInputOutput() throws {
        try assertRoundTrips(try decodeFixture(ListGraphIssuesInput.self, "ListGraphIssuesInput"))
        try assertRoundTrips(try decodeFixture(ListGraphIssuesOutput.self, "ListGraphIssuesOutput"))
    }

    func testListTagClosureInputOutput() throws {
        try assertRoundTrips(try decodeFixture(ListTagClosureInput.self, "ListTagClosureInput"))
        let output = try decodeFixture(ListTagClosureOutput.self, "ListTagClosureOutput")
        XCTAssertEqual(output.entries.first?.ancestorId, output.entries.first?.descendantId)
        try assertRoundTrips(output)
    }

    func testListTagsInputOutput() throws {
        try assertRoundTrips(try decodeFixture(ListTagsInput.self, "ListTagsInput"))
        try assertRoundTrips(try decodeFixture(ListTagsOutput.self, "ListTagsOutput"))
    }

    func testAssignTagInputOutput() throws {
        try assertRoundTrips(try decodeFixture(AssignTagInput.self, "AssignTagInput"))
        try assertRoundTrips(try decodeFixture(AssignTagOutput.self, "AssignTagOutput"))
    }

    // MARK: - search-rpc.ts

    func testSearchNodesInputOutput() throws {
        let input = try decodeFixture(SearchNodesInput.self, "SearchNodesInput")
        XCTAssertEqual(input.limit, 10)
        try assertRoundTrips(input)
        let output = try decodeFixture(SearchNodesOutput.self, "SearchNodesOutput")
        XCTAssertEqual(output.results.first?.snippet, "...daily standup notes...")
        try assertRoundTrips(output)
    }

    // MARK: - page-rpc.ts

    func testCreatePageInputOutput() throws {
        try assertRoundTrips(try decodeFixture(CreatePageInput.self, "CreatePageInput"))
        let output = try decodeFixture(CreatePageOutput.self, "CreatePageOutput")
        XCTAssertEqual(output.text, "")
        try assertRoundTrips(output)
    }

    func testGetPageTextInputOutput() throws {
        try assertRoundTrips(try decodeFixture(GetPageTextInput.self, "GetPageTextInput"))
        let output = try decodeFixture(GetPageTextOutput.self, "GetPageTextOutput")
        XCTAssertEqual(output.text, "Hello, world!")
        try assertRoundTrips(output)
    }

    func testApplyPageEditInputOutput() throws {
        let input = try decodeFixture(ApplyPageEditInput.self, "ApplyPageEditInput")
        XCTAssertEqual(input.index, 5)
        XCTAssertEqual(input.insertText, ", world")
        try assertRoundTrips(input)
        try assertRoundTrips(try decodeFixture(ApplyPageEditOutput.self, "ApplyPageEditOutput"))
    }

    // MARK: - sync-rpc.ts (structured feed + epoch)

    func testSyncFeedInputWithoutCursor() throws {
        let input = try decodeFixture(SyncFeedInput.self, "SyncFeedInput")
        XCTAssertNil(input.knownEpoch)
        XCTAssertNil(input.afterCounter)
        XCTAssertEqual(input.limit, 100)
        try assertRoundTrips(input)
    }

    func testSyncFeedInputWithCursor() throws {
        let input = try decodeFixture(SyncFeedInput.self, "SyncFeedInputWithCursor")
        XCTAssertEqual(input.knownEpoch?.rawValue, "epoch-abc123")
        XCTAssertEqual(input.afterCounter, 41)
        try assertRoundTrips(input)
    }

    func testSyncFeedOutput() throws {
        let output = try decodeFixture(SyncFeedOutput.self, "SyncFeedOutput")
        XCTAssertFalse(output.epochMismatch)
        XCTAssertEqual(output.entries.count, 1)
        XCTAssertEqual(output.nextAfterCounter, 42)
        try assertRoundTrips(output)
    }

    func testRotateEpochInputOutput() throws {
        try assertRoundTrips(try decodeFixture(RotateEpochInput.self, "RotateEpochInput"))
        let output = try decodeFixture(RotateEpochOutput.self, "RotateEpochOutput")
        XCTAssertEqual(output.epoch.rawValue, "epoch-def456")
        try assertRoundTrips(output)
    }

    // MARK: - sync-rpc.ts (Automerge prose sync — binary fields, see SyncRPC.swift header)

    func testStartPageSyncInputOutput() throws {
        try assertRoundTrips(try decodeFixture(StartPageSyncInput.self, "StartPageSyncInput"))
        let output = try decodeFixture(StartPageSyncOutput.self, "StartPageSyncOutput")
        XCTAssertEqual(output.message, Data([1, 2, 3, 4, 250, 251, 252, 253, 254, 255, 0]))
        try assertRoundTrips(output)
    }

    func testPageSyncMessageInputOutput() throws {
        let input = try decodeFixture(PageSyncMessageInput.self, "PageSyncMessageInput")
        XCTAssertEqual(input.ordinal, 3)
        XCTAssertEqual(input.message, Data([1, 2, 3, 4, 250, 251, 252, 253, 254, 255, 0]))
        try assertRoundTrips(input)

        let output = try decodeFixture(PageSyncMessageOutput.self, "PageSyncMessageOutput")
        XCTAssertFalse(output.converged)
        XCTAssertNotNil(output.message)
        try assertRoundTrips(output)
    }

    func testPageSyncMessageOutputConverged() throws {
        let output = try decodeFixture(PageSyncMessageOutput.self, "PageSyncMessageOutputConverged")
        XCTAssertTrue(output.converged)
        XCTAssertNil(output.message)
        try assertRoundTrips(output)
    }

    // MARK: - today-brief-rpc.ts (privacy-safe calendar projection)

    func testGetTodayBriefInputOutput() throws {
        let input = try decodeFixture(GetTodayBriefInput.self, "GetTodayBriefInput")
        XCTAssertEqual(input.localDate.rawValue, "2026-11-01")
        XCTAssertEqual(input.timeZone.rawValue, "America/New_York")
        try assertRoundTrips(input)

        let output = try decodeFixture(GetTodayBriefOutput.self, "GetTodayBriefOutput")
        XCTAssertEqual(output.from.rawValue, "2026-11-01T04:00:00.000Z")
        XCTAssertEqual(output.to.rawValue, "2026-11-02T05:00:00.000Z")
        XCTAssertEqual(output.calendarHistory.status, .found)
        XCTAssertEqual(output.events.first?.people.map(\.displayName), ["Alice", nil])
        try assertRoundTrips(output)
    }
}
