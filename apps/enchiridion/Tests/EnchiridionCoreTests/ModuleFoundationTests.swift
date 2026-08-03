import Foundation
import XCTest
@testable import EnchiridionCore

final class ModuleFoundationTests: XCTestCase {
  func testRegistryRejectsDeterministicDeclarationCollisions() throws {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.alpha")
    let duplicate = EnchiridionModuleManifest(
      id: .init(rawValue: "dev.rawkode.enchiridion.beta"), version: 1,
      namespace: .init(moduleID: .init(rawValue: "dev.rawkode.enchiridion.beta"), prefix: "dev.rawkode.enchiridion."),
      projections: [.init(id: "dev.rawkode.enchiridion.shared.graph", viewName: "graph_shared", version: 1, statement: "SELECT 1")]
    )
    let first = EnchiridionModuleManifest(
      id: id, version: 1, namespace: .init(moduleID: id, prefix: "dev.rawkode.enchiridion."),
      projections: [.init(id: "dev.rawkode.enchiridion.shared.graph", viewName: "graph_other", version: 1, statement: "SELECT 1")]
    )
    XCTAssertThrowsError(try ModuleRegistry(manifests: [duplicate, first])) { error in
      XCTAssertEqual(error as? ModuleRegistryError, .identifierCollision("dev.rawkode.enchiridion.shared.graph"))
    }
  }

  func testRegistryRequiresModuleOwnedDeclarationsAndMintsScopedCapability() throws {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.workouts")
    let manifest = EnchiridionModuleManifest(
      id: id, version: 1,
      supertags: [.init(id: .init(rawValue: "dev.rawkode.enchiridion.workouts.workout"), name: "Workout", symbol: "figure.run", fields: [])]
    )
    let registry = try ModuleRegistry(manifests: [manifest])
    XCTAssertEqual(registry.writeCapability(for: id)?.moduleID, id)
    XCTAssertEqual(
      DeclarationOwnershipResolver.ownership(of: "dev.rawkode.enchiridion.workouts.workout", registry: registry),
      .module(id)
    )
    XCTAssertEqual(DeclarationOwnershipResolver.ownership(of: "custom-tag", registry: registry), .user)
  }

  func testRegistryRejectsUnsafeOrNonPublicProjectionDeclarations() {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.workouts")
    let invalid = EnchiridionModuleManifest(
      id: id, version: 1,
      projections: [.init(id: "dev.rawkode.enchiridion.workouts.projection", viewName: "workouts", version: 1, statement: "SELECT 1; DELETE FROM pages")]
    )
    XCTAssertThrowsError(try ModuleRegistry(manifests: [invalid])) { error in
      XCTAssertEqual(error as? ModuleRegistryError, .invalidProjection("dev.rawkode.enchiridion.workouts.projection"))
    }
  }

  func testModuleSchemaWriteRequiresAnExactlyDeclaredTag() async throws {
    let id = EnchiridionModuleID(rawValue: "dev.rawkode.enchiridion.workouts")
    let declared = SupertagDefinition(id: .init(rawValue: "dev.rawkode.enchiridion.workouts.workout"), name: "Workout", symbol: "figure.run", fields: [])
    let manifest = EnchiridionModuleManifest(id: id, version: 1, supertags: [declared])
    let registry = try ModuleRegistry(manifests: [manifest])
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let repository = try LibraryRepository(path: directory.appendingPathComponent("library.sqlite").path)
    let undeclared = SupertagDefinition(id: .init(rawValue: "dev.rawkode.enchiridion.workouts.hidden"), name: "Hidden", symbol: "eye.slash", fields: [])
    do {
      try await repository.saveModuleSupertag(undeclared, using: try XCTUnwrap(registry.writeCapability(for: id)), registry: registry)
      XCTFail("Expected the undeclared tag to be rejected")
    } catch {
      XCTAssertEqual(error as? ModuleRegistryError, .foreignDeclaration(module: id, identifier: undeclared.id.rawValue))
    }
  }

  func testLiveViewDecodesLegacyPayloadWithoutRendererAndRoundTripsRenderer() throws {
    let legacy = try JSONEncoder.enchiridion.encode(
      LiveQueryDefinition(id: .init(rawValue: "view_legacy"), name: "Legacy", source: .pages, limit: 5)
    )
    XCTAssertNil(try JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: legacy).viewTypeID)

    let view = LiveQueryDefinition(name: "Workout summary", source: .pages, viewTypeID: .init(rawValue: "dev.rawkode.enchiridion.workouts.summary"))
    XCTAssertEqual(try JSONDecoder.enchiridion.decode(LiveQueryDefinition.self, from: JSONEncoder.enchiridion.encode(view)).viewTypeID, view.viewTypeID)
  }
}
