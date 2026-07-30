import Foundation
import XCTest
@testable import EnchiridionCore

final class VaultSearchTests: XCTestCase {
  func testSearchReturnsVaultScopedResultsAcrossIndependentGraphs() async throws {
    let fixture = try VaultSearchFixture(testCase: self)
    let snapshot = try fixture.registry.snapshot()
    let personal = snapshot.vaults[0]
    let work = try fixture.registry.createVault(name: "Work")
    let personalRepository = try LibraryRepository(path: fixture.registry.graphPath(for: personal.id))
    let workRepository = try LibraryRepository(path: fixture.registry.graphPath(for: work.id))
    let personalPage = try await personalRepository.createFreePage(title: "Knowledge garden")
    let workPage = try await workRepository.createFreePage(title: "Knowledge graph launch")

    let results = try await VaultSearch(registry: fixture.registry).search("knowledge")

    XCTAssertEqual(Set(results.map(\.scopedNodeID)), Set([
      .init(vaultID: personal.id, nodeID: personalPage.id),
      .init(vaultID: work.id, nodeID: workPage.id),
    ]))
    XCTAssertEqual(Set(results.map(\.vaultName)), Set(["Personal", "Work"]))
  }

  func testSearchTreatsFTSSyntaxAsLiteralTextAndHonorsGlobalLimit() async throws {
    let fixture = try VaultSearchFixture(testCase: self)
    let vault = try fixture.registry.snapshot().vaults[0]
    let repository = try LibraryRepository(path: fixture.registry.graphPath(for: vault.id))
    let literalMatch = try await repository.createFreePage(title: "Quoted OR project")
    _ = try await repository.createFreePage(title: "Another quoted project")

    let literalResults = try await VaultSearch(registry: fixture.registry).search("quoted OR *")
    XCTAssertEqual(literalResults.map(\.scopedNodeID), [
      .init(vaultID: vault.id, nodeID: literalMatch.id)
    ])

    let limitedResults = try await VaultSearch(registry: fixture.registry).search("quoted", limit: 1)
    XCTAssertLessThanOrEqual(limitedResults.count, 1)
  }
}

private struct VaultSearchFixture {
  let registry: VaultRegistry

  init(testCase: XCTestCase) throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("VaultSearchTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    testCase.addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    registry = try VaultRegistry(path: directory.appendingPathComponent("catalog.sqlite").path)
  }
}
