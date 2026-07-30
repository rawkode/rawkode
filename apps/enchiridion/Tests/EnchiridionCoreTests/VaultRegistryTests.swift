import Foundation
import XCTest
@testable import EnchiridionCore

final class VaultRegistryTests: XCTestCase {
  func testFreshCatalogCreatesPersonalVaultAndIndependentGraphPath() throws {
    let fixture = try makeFixture()
    let snapshot = try fixture.registry.snapshot()

    XCTAssertEqual(snapshot.vaults.map(\.name), ["Personal"])
    XCTAssertEqual(snapshot.vaults.map(\.id), [.personal])
    XCTAssertEqual(snapshot.selectedVaultID, snapshot.defaultCaptureVaultID)
    XCTAssertEqual(snapshot.vaults[0].cloudZoneName, "EnchiridionVault")
    XCTAssertEqual(
      URL(fileURLWithPath: try fixture.registry.graphPath(selection: .selected)).lastPathComponent,
      "graph.sqlite"
    )
    XCTAssertTrue(
      try fixture.registry.graphPath(selection: .selected)
        .contains(snapshot.selectedVaultID.rawValue)
    )
  }

  func testCreateRenameReorderAndSelectionsPersistAcrossReopen() throws {
    let fixture = try makeFixture()
    let work = try fixture.registry.createVault(name: "  Work  ")
    let personal = try fixture.registry.snapshot().vaults.first { $0.name == "Personal" }!

    try fixture.registry.renameVault(work.id, name: "Studio")
    try fixture.registry.reorderVaults([work.id, personal.id])
    try fixture.registry.setSelectedVault(work.id)
    try fixture.registry.setDefaultCaptureVault(personal.id)

    let reopened = try VaultRegistry(path: fixture.catalogPath)
    let snapshot = try reopened.snapshot()
    XCTAssertEqual(snapshot.vaults.map(\.name), ["Studio", "Personal"])
    XCTAssertEqual(snapshot.selectedVaultID, work.id)
    XCTAssertEqual(snapshot.defaultCaptureVaultID, personal.id)
  }

  func testDeletingSelectedVaultFallsBackWithoutDeletingLastVault() throws {
    let fixture = try makeFixture()
    let personal = try fixture.registry.snapshot().selectedVaultID
    let second = try fixture.registry.createVault(name: "Work")
    try fixture.registry.setSelectedVault(second.id)
    try fixture.registry.setDefaultCaptureVault(second.id)

    let deletedPath = try fixture.registry.deleteVault(second.id)
    let snapshot = try fixture.registry.snapshot()

    XCTAssertTrue(deletedPath.contains(second.id.rawValue))
    XCTAssertEqual(snapshot.vaults.map(\.id), [personal])
    XCTAssertEqual(snapshot.selectedVaultID, personal)
    XCTAssertEqual(snapshot.defaultCaptureVaultID, personal)
    XCTAssertThrowsError(try fixture.registry.deleteVault(personal)) { error in
      XCTAssertEqual(error as? VaultRegistryError, .cannotDeleteOnlyVault)
    }
  }

  func testGraphPathRejectsUntrustedVaultIdentifier() throws {
    let fixture = try makeFixture()

    XCTAssertThrowsError(
      try fixture.registry.graphPath(for: .init(rawValue: "../../outside"))
    ) { error in
      XCTAssertEqual(error as? VaultRegistryError, .invalidIdentifier)
    }
  }

  func testCustomVaultUsesIndependentCloudZone() {
    let vault = VaultID(rawValue: "vault_work")

    XCTAssertEqual(vault.cloudZoneName, "EnchiridionGraph-vault_work")
  }

  func testLegacyLibraryMigratesToPersonalGraphBeforeCatalogOpens() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("VaultRegistryMigrationTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let legacyDatabase = directory.appendingPathComponent("legacy-library.sqlite")
    let catalogPath = directory.appendingPathComponent("vaults/catalog.sqlite").path
    let contents = Data("legacy-library".utf8)
    try contents.write(to: legacyDatabase)

    try VaultRegistry.migrateLegacyPersonalVaultIfNeeded(
      catalogPath: catalogPath,
      legacyDatabaseURLs: [legacyDatabase]
    )

    let personalGraph = directory
      .appendingPathComponent("vaults/vault_personal/graph.sqlite")
    XCTAssertEqual(try Data(contentsOf: personalGraph), contents)
  }

  private func makeFixture() throws -> (
    registry: VaultRegistry,
    catalogPath: String
  ) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("VaultRegistryTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("catalog.sqlite").path
    return (try VaultRegistry(path: path), path)
  }
}
