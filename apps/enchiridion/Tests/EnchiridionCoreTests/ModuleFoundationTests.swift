import Foundation
import GRDB
import XCTest

@testable import EnchiridionCore

final class ModuleFoundationTests: XCTestCase {
  func testRegistryRejectsDeterministicDeclarationCollisions() throws {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.alpha")
    let duplicate = EnchiridionModuleManifest(
      id: .init(rawValue: "dev.rawkode.enchiridion.beta"), version: 1,
      namespace: .init(
        moduleID: .init(rawValue: "dev.rawkode.enchiridion.beta"),
        prefix: "dev.rawkode.enchiridion."),
      projections: [
        .init(
          id: "dev.rawkode.enchiridion.shared.graph", viewName: "graph_shared", version: 1,
          statement: "SELECT 1")
      ]
    )
    let first = EnchiridionModuleManifest(
      id: id, version: 1, namespace: .init(moduleID: id, prefix: "dev.rawkode.enchiridion."),
      projections: [
        .init(
          id: "dev.rawkode.enchiridion.shared.graph", viewName: "graph_other", version: 1,
          statement: "SELECT 1")
      ]
    )
    XCTAssertThrowsError(try ModuleRegistry(manifests: [duplicate, first])) { error in
      XCTAssertEqual(
        error as? ModuleRegistryError, .identifierCollision("dev.rawkode.enchiridion.shared.graph"))
    }
  }

  func testRegistryRequiresModuleOwnedDeclarationsAndMintsScopedCapability() throws {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.workouts")
    let manifest = EnchiridionModuleManifest(
      id: id, version: 1,
      supertags: [
        .init(
          id: .init(rawValue: "dev.rawkode.enchiridion.workouts.workout"), name: "Workout",
          symbol: "figure.run", fields: [])
      ]
    )
    let registry = try ModuleRegistry(manifests: [manifest])
    XCTAssertEqual(registry.writeCapability(for: id)?.moduleID, id)
    XCTAssertEqual(
      DeclarationOwnershipResolver.ownership(
        of: "dev.rawkode.enchiridion.workouts.workout", registry: registry),
      .module(id)
    )
    XCTAssertEqual(
      DeclarationOwnershipResolver.ownership(of: "custom-tag", registry: registry), .user)
  }

  func testRegistryRejectsUnsafeOrNonPublicProjectionDeclarations() {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.workouts")
    let invalid = EnchiridionModuleManifest(
      id: id, version: 1,
      projections: [
        .init(
          id: "dev.rawkode.enchiridion.workouts.projection", viewName: "workouts", version: 1,
          statement: "SELECT 1; DELETE FROM pages")
      ]
    )
    XCTAssertThrowsError(try ModuleRegistry(manifests: [invalid])) { error in
      XCTAssertEqual(
        error as? ModuleRegistryError,
        .invalidProjection("dev.rawkode.enchiridion.workouts.projection"))
    }
  }

  func testModuleSchemaWriteRequiresAnExactlyDeclaredTag() async throws {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.workouts")
    let declared = SupertagDefinition(
      id: .init(rawValue: "dev.rawkode.enchiridion.workouts.workout"), name: "Workout",
      symbol: "figure.run", fields: [])
    let manifest = EnchiridionModuleManifest(id: id, version: 1, supertags: [declared])
    let registry = try ModuleRegistry(manifests: [manifest])
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let repository = try LibraryRepository(
      path: directory.appendingPathComponent("library.sqlite").path)
    let undeclared = SupertagDefinition(
      id: .init(rawValue: "dev.rawkode.enchiridion.workouts.hidden"), name: "Hidden",
      symbol: "eye.slash", fields: [])
    do {
      try await repository.saveModuleSupertag(
        undeclared, using: try XCTUnwrap(registry.writeCapability(for: id)), registry: registry)
      XCTFail("Expected the undeclared tag to be rejected")
    } catch {
      XCTAssertEqual(
        error as? ModuleRegistryError,
        .foreignDeclaration(module: id, identifier: undeclared.id.rawValue))
    }
  }

  func testReconcileModuleProvisionsAndVersionUpgradesOwnedProjection() async throws {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.alpha")
    let v1 = EnchiridionModuleManifest(
      id: id, version: 1,
      projections: [
        .init(
          id: "dev.rawkode.enchiridion.alpha.projection.value",
          viewName: "graph_module_alpha_value_v1", version: 1,
          statement: "SELECT 1 AS value")
      ]
    )
    let v2 = EnchiridionModuleManifest(
      id: id, version: 2,
      projections: [
        .init(
          id: "dev.rawkode.enchiridion.alpha.projection.value",
          viewName: "graph_module_alpha_value_v1", version: 2,
          statement: "SELECT 2 AS value")
      ]
    )
    let registry = try ModuleRegistry(manifests: [v1])
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let repository = try LibraryRepository(
      path: directory.appendingPathComponent("library.sqlite").path)
    let capability = try XCTUnwrap(registry.writeCapability(for: id))
    let database = try DatabaseQueue(path: repository.path)
    // Simulates an older client that created the same public view before declaration metadata
    // existed. Reconciliation must adopt an equivalent read-only projection, not replace it.
    try await database.write { db in
      try db.execute(sql: "CREATE VIEW graph_module_alpha_value_v1 AS SELECT 1 AS value")
    }

    try await repository.reconcileModule(v1, using: capability)
    XCTAssertEqual(
      try repository.runGraphSQL("SELECT value FROM graph_module_alpha_value_v1")
        .rows.first?.values,
      [.integer(1)])
    let v1Value = try await database.read { db in
      try Int.fetchOne(db, sql: "SELECT value FROM graph_module_alpha_value_v1")
    }
    XCTAssertEqual(v1Value, 1)

    try await repository.reconcileModule(v2, using: capability)
    let v2Value = try await database.read { db in
      try Int.fetchOne(db, sql: "SELECT value FROM graph_module_alpha_value_v1")
    }
    XCTAssertEqual(v2Value, 2)
    do {
      try await repository.reconcileModule(
        .init(
          id: id, version: 2,
          projections: [
            .init(
              id: "dev.rawkode.enchiridion.alpha.projection.value",
              viewName: "graph_module_alpha_value_v1", version: 2,
              statement: "SELECT 3 AS value")
          ]
        ),
        using: capability
      )
      XCTFail("Expected a same-version projection rewrite to be rejected")
    } catch let error as ModuleRegistryError {
      XCTAssertEqual(error, .incompatibleUpgrade("dev.rawkode.enchiridion.alpha.projection.value"))
    } catch {
      XCTFail("Unexpected projection upgrade error: \(error)")
    }
  }

  func testLiveViewDecodesLegacyPayloadWithoutRendererAndRoundTripsRenderer() throws {
    let legacy = try JSONEncoder.enchiridion.encode(
      LiveQueryDefinition(
        id: .init(rawValue: "view_legacy"), name: "Legacy", source: .pages, limit: 5)
    )
    XCTAssertNil(
      try JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: legacy).viewTypeID)

    let view = LiveQueryDefinition(
      name: "Workout summary", source: .pages,
      viewTypeID: .init(rawValue: "dev.rawkode.enchiridion.workouts.summary"))
    XCTAssertEqual(
      try JSONDecoder.enchiridion.decode(
        LiveQueryDefinition.self, from: JSONEncoder.enchiridion.encode(view)
      ).viewTypeID, view.viewTypeID)
  }
}
