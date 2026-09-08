import XCTest
@testable import AthenaeumDomain

/// Decodes each entity type against a fixture produced by the real TS `Schema.encodeSync`
/// (`scripts/generate-fixtures.ts`) — validates this package's Codable mirrors against the actual
/// wire shape `@athenaeum/domain` produces, not a hand-guessed one. Also round-trips every decoded
/// value back through this package's own encoder to catch asymmetric Codable bugs.
final class EntityDecodingTests: XCTestCase {
    func testNode() throws {
        let node = try decodeFixture(Node.self, "Node")
        XCTAssertEqual(node.title, "Daily note — 2026-08-20")
        XCTAssertEqual(node.id.rawValue, "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60")
        try assertRoundTrips(node)
    }

    func testBaseTagsFixtureMatchesPackageConstant() throws {
        let fromFixture = try decodeFixture([Tag].self, "BaseTags")
        XCTAssertEqual(fromFixture, BASE_TAGS, "this package's BASE_TAGS must match the TS side's BASE_TAGS exactly")
        XCTAssertEqual(fromFixture.count, 8)
        XCTAssertEqual(BaseTagIds.person.rawValue, "00000000-0000-0000-0000-000000000001")
        XCTAssertEqual(BaseTagIds.task.rawValue, "00000000-0000-0000-0000-000000000008")
        for tag in BASE_TAGS {
            try assertRoundTrips(tag)
        }
    }

    func testPage() throws {
        let page = try decodeFixture(Page.self, "Page")
        XCTAssertEqual(page.automergeDocId, "doc-abc123")
        try assertRoundTrips(page)
    }

    func testFact() throws {
        let fact = try decodeFixture(Fact.self, "Fact")
        XCTAssertEqual(fact.predicateId, "status")
        guard case .object(let obj) = fact.value else {
            XCTFail("expected object JSONValue"); return
        }
        XCTAssertEqual(obj["done"], .bool(false))
        XCTAssertEqual(obj["priority"], .number(2))
        XCTAssertEqual(obj["tags"], .array([.string("urgent"), .string("home")]))
        XCTAssertEqual(obj["note"], .null)
        try assertRoundTrips(fact)
    }

    func testRelationDefinition() throws {
        let rd = try decodeFixture(RelationDefinition.self, "RelationDefinition")
        XCTAssertEqual(rd.forwardName, "employs")
        XCTAssertEqual(rd.cardinality, .oneToMany)
        try assertRoundTrips(rd)
    }

    func testEdge() throws {
        let edge = try decodeFixture(Edge.self, "Edge")
        XCTAssertEqual(edge.sourceNodeId.rawValue, "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60")
        try assertRoundTrips(edge)
    }

    func testGraphIssue() throws {
        let issue = try decodeFixture(GraphIssue.self, "GraphIssue")
        XCTAssertEqual(issue.kind, .concurrentMaxOneEdgeConflict)
        XCTAssertEqual(issue.conflictingEdgeIds.count, 1)
        try assertRoundTrips(issue)
    }

    func testViewSpecFull() throws {
        let spec = try decodeFixture(ViewSpec.self, "ViewSpec")
        XCTAssertEqual(spec.view, .board)
        XCTAssertEqual(spec.groupBy, "status")
        XCTAssertEqual(spec.sortDescending, true)
        XCTAssertEqual(spec.rowLimit, 50)
        guard case .and(let predicates) = spec.filter else {
            XCTFail("expected top-level `and`"); return
        }
        XCTAssertEqual(predicates.count, 3)
        guard case .eq(let field, let value) = predicates[0] else {
            XCTFail("expected `eq`"); return
        }
        XCTAssertEqual(field, .column("title"))
        XCTAssertEqual(value, .string("Daily note"))
        guard case .hasTag(let tagId) = predicates[1] else {
            XCTFail("expected `hasTag`"); return
        }
        XCTAssertEqual(tagId.rawValue, "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62")
        guard case .in(let inField, let values) = predicates[2] else {
            XCTFail("expected `in`"); return
        }
        XCTAssertEqual(inField, .fact(predicateId: "status"))
        XCTAssertEqual(values, [.string("todo"), .string("doing")])
        try assertRoundTrips(spec)
    }

    /// Every optional `ViewSpec` field absent — verifies decode tolerates missing keys and
    /// encode omits them again (the TS `Schema.optional` wire contract), not just that decode
    /// happens to work with `null` present.
    func testViewSpecMinimalOmitsOptionalKeys() throws {
        let data = loadFixture("ViewSpecMinimal")
        let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNil(raw?["filter"])
        XCTAssertNil(raw?["groupBy"])
        XCTAssertNil(raw?["sortColumn"])
        XCTAssertNil(raw?["sortDescending"])

        let spec = try decodeFixture(ViewSpec.self, "ViewSpecMinimal")
        XCTAssertNil(spec.filter)
        XCTAssertNil(spec.groupBy)
        XCTAssertNil(spec.sortColumn)
        XCTAssertNil(spec.sortDescending)
        XCTAssertEqual(spec.view, .table)

        // Re-encoding must omit the same keys, matching Schema.optional's wire behavior.
        let reEncoded = try JSONEncoder().encode(spec)
        let reEncodedRaw = try JSONSerialization.jsonObject(with: reEncoded) as? [String: Any]
        XCTAssertNil(reEncodedRaw?["filter"])
        XCTAssertNil(reEncodedRaw?["groupBy"])
        XCTAssertNil(reEncodedRaw?["sortColumn"])
        XCTAssertNil(reEncodedRaw?["sortDescending"])
        try assertRoundTrips(spec)
    }

    func testSyncFeedEntry() throws {
        let entry = try decodeFixture(SyncFeedEntry.self, "SyncFeedEntry")
        XCTAssertEqual(entry.entityKind, "node")
        XCTAssertEqual(entry.operation, .put)
        XCTAssertEqual(entry.monotonicCounter, 42)
        guard case .object(let payload) = entry.payload else {
            XCTFail("expected object payload"); return
        }
        XCTAssertEqual(payload["title"], .string("Daily note"))
        try assertRoundTrips(entry)
    }
}
