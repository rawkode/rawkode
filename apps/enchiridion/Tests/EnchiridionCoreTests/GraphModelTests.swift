import XCTest
@testable import EnchiridionCore

final class GraphModelTests: XCTestCase {
  func testFixedBaseOntologyIncludesGraphTypesAndCompanyInheritance() {
    let definitions = Dictionary(uniqueKeysWithValues: BuiltInSupertags.all.map { ($0.id, $0) })

    XCTAssertNotNil(definitions[BuiltInSupertags.person])
    XCTAssertNotNil(definitions[BuiltInSupertags.event])
    XCTAssertEqual(definitions[BuiltInSupertags.company]?.parentIDs, [BuiltInSupertags.organization])
  }

  func testBuiltInRelationsCoverEveryCardinalityShape() {
    let relations = BuiltInRelations.all

    XCTAssertTrue(relations.contains { $0.cardinality == .manyToOne })
    XCTAssertTrue(relations.contains { $0.cardinality == .manyToMany })
    XCTAssertEqual(
      relations.first(where: { $0.id == BuiltInRelations.taskProject })?.inverseName,
      "tasks"
    )
  }

  func testLegacyReferenceFieldMapsToCanonicalRelation() {
    let key = SupertagPropertyKey(
      supertagID: BuiltInSupertags.task,
      fieldID: .init(rawValue: "project")
    )

    XCTAssertEqual(BuiltInRelations.relationID(for: key), BuiltInRelations.taskProject)
    XCTAssertEqual(BuiltInRelations.propertyKey(for: BuiltInRelations.taskProject), key)
  }

  func testVaultScopedNodeIdentityCannotCollideAcrossVaults() {
    let nodeID = PageID.free(UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!)
    let first = VaultScopedNodeID(vaultID: .init(rawValue: "vault_one"), nodeID: nodeID)
    let second = VaultScopedNodeID(vaultID: .init(rawValue: "vault_two"), nodeID: nodeID)

    XCTAssertNotEqual(first, second)
    XCTAssertNotEqual(first.id, second.id)
  }

  func testLocalDateRejectsInstantsAndRetainsCalendarIdentity() {
    XCTAssertEqual(LocalDate(rawValue: "2026-07-30")?.rawValue, "2026-07-30")
    XCTAssertNil(LocalDate(rawValue: "2026-07-30T12:00:00Z"))
    XCTAssertNil(LocalDate(rawValue: "2026-13-30"))
  }
}
