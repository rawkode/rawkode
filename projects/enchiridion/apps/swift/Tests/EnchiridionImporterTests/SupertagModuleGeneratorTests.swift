// SupertagModuleGeneratorTests.swift
// EnchiridionImporterTests
//
// Task brief: "a runtime supertag produces a correctly-shaped generated TS
// module." Feeds `SupertagModuleGenerator` a synthetic `OldSupertagDefinition`
// (structured data — not decoded from a real vault; there's nothing
// Automerge-specific about supertag DEFINITIONS, see
// `OldVaultSQLiteSource.swift`'s header) shaped like a real runtime
// user-created supertag would be, and asserts the generated TS text has the
// shape `packages/schema/src/registry.ts`'s `defineSupertagModule` /
// `types.ts`'s `SupertagModule` expect.
import Foundation
import XCTest

@testable import EnchiridionImporter

final class SupertagModuleGeneratorTests: XCTestCase {

  private func makeRuntimeSourdoughDefinition() -> OldSupertagDefinition {
    OldSupertagDefinition(
      id: "tag-3f9ad9c2-1111-4a11-9a11-111111111111",
      name: "Sourdough Bake",
      symbol: "circle.grid.cross",
      fields: [
        OldSupertagFieldDefinition(
          id: "hydration", name: "Hydration %", type: "number", allowsMultiple: false, isRequired: false,
          isMultiline: false, options: [], allowedSupertagIDs: [], isDeleted: false
        ),
        OldSupertagFieldDefinition(
          id: "crumb-notes", name: "Crumb notes", type: "text", allowsMultiple: false, isRequired: false,
          isMultiline: true, options: [], allowedSupertagIDs: [], isDeleted: false
        ),
        OldSupertagFieldDefinition(
          id: "result", name: "Result", type: "select", allowsMultiple: false, isRequired: false,
          isMultiline: false,
          options: [
            OldSupertagSelectOption(id: "great", name: "Great", color: "green"),
            OldSupertagSelectOption(id: "dense", name: "Dense", color: "orange"),
          ], allowedSupertagIDs: [], isDeleted: false
        ),
        OldSupertagFieldDefinition(
          id: "starter", name: "Starter used", type: "entityReference", allowsMultiple: false, isRequired: false,
          isMultiline: false, options: [], allowedSupertagIDs: ["tag-starter-id"], isDeleted: false
        ),
        // A soft-deleted field must not appear in the generated module.
        OldSupertagFieldDefinition(
          id: "old-field", name: "Old field", type: "text", allowsMultiple: false, isRequired: false,
          isMultiline: false, options: [], allowedSupertagIDs: [], isDeleted: true
        ),
      ],
      parentIDs: [],
      isBuiltIn: false,
      isDeleted: false
    )
  }

  func testGeneratesDefineSupertagModuleCallWithExpectedFields() {
    let definition = makeRuntimeSourdoughDefinition()
    let source = SupertagModuleGenerator.generateModule(from: definition)

    XCTAssertTrue(source.contains("import { defineSupertagModule, f, type SupertagModule } from \"@enchiridion/schema\";"))
    XCTAssertTrue(source.contains("export default defineSupertagModule({"))
    XCTAssertTrue(source.contains("id: MODULE_ID,"))
    XCTAssertTrue(source.contains("version: 1,"))

    let slug = SupertagModuleGenerator.slug(forOldSupertagID: definition.id)
    XCTAssertTrue(source.contains("const MODULE_ID = \"dev.rawkode.imported.\(slug)\";"))
    XCTAssertTrue(source.contains("\(slug): {"))
    XCTAssertTrue(source.contains("name: \"Sourdough Bake\","))
    XCTAssertTrue(source.contains("symbol: \"circle.grid.cross\","))

    XCTAssertTrue(source.contains("hydration: f.number({ name: \"Hydration %\" }),"))
    XCTAssertTrue(source.contains("\"crumb-notes\": f.text({ name: \"Crumb notes\", isMultiline: true }),"))
    XCTAssertTrue(source.contains("result: f.select([\"Great\", \"Dense\"], { name: \"Result\" }),"))
    XCTAssertTrue(source.contains("f.entityReference([\"tag-starter-id\"]"))

    XCTAssertFalse(source.contains("old-field"), "soft-deleted fields must be dropped")
    XCTAssertFalse(source.contains("Old field"))
  }

  func testGeneratedTsTextIsParenBraceBalanced() {
    let source = SupertagModuleGenerator.generateModule(from: makeRuntimeSourdoughDefinition())
    XCTAssertEqual(source.filter { $0 == "{" }.count, source.filter { $0 == "}" }.count)
    XCTAssertEqual(source.filter { $0 == "(" }.count, source.filter { $0 == ")" }.count)
    XCTAssertEqual(source.filter { $0 == "[" }.count, source.filter { $0 == "]" }.count)
  }

  func testSlugIsFilesystemAndIdentifierSafe() {
    let slug = SupertagModuleGenerator.slug(forOldSupertagID: "tag-3f9ad9c2-1111-4a11-9a11-111111111111")
    XCTAssertEqual(slug, "tag-3f9ad9c2-1111-4a11-9a11-111111111111")
    XCTAssertFalse(slug.contains(" "))
  }

  func testOwnershipResolverAcceptsOnlyRuntimeUserCreatedDefinitions() throws {
    let runtime = makeRuntimeSourdoughDefinition()
    XCTAssertTrue(OldSupertagOwnershipResolver.isRuntimeUserCreated(runtime, rowDeleted: false))

    var builtIn = runtime
    builtIn.isBuiltIn = true
    XCTAssertFalse(OldSupertagOwnershipResolver.isRuntimeUserCreated(builtIn, rowDeleted: false))

    var softDeletedDefinition = runtime
    softDeletedDefinition.isDeleted = true
    XCTAssertFalse(OldSupertagOwnershipResolver.isRuntimeUserCreated(softDeletedDefinition, rowDeleted: false))

    XCTAssertFalse(OldSupertagOwnershipResolver.isRuntimeUserCreated(runtime, rowDeleted: true))

    var compiledModule = runtime
    compiledModule.id = "dev.rawkode.workouts.workout"
    XCTAssertFalse(OldSupertagOwnershipResolver.isRuntimeUserCreated(compiledModule, rowDeleted: false))
  }

  /// Round-trips a definition through the OLD app's real JSON encoding
  /// shape (as `OldVaultSQLiteSource` would read it out of
  /// `supertag_schemas.definition_json`) to prove `OldSupertagDefinition.decode`
  /// actually parses what the old app writes, not just a hand-built Swift
  /// value.
  func testDecodesFromRealOldAppJsonShape() throws {
    let json = """
      {
        "id": "tag-abc",
        "name": "Widget",
        "symbol": "circle",
        "fields": [
          {
            "id": "count", "name": "Count", "type": "number", "allowsMultiple": false,
            "isRequired": false, "isMultiline": false, "options": [], "allowedSupertagIDs": [],
            "isDeleted": false
          }
        ],
        "parentIDs": [],
        "relationIDs": [],
        "presentationOrder": [],
        "isBuiltIn": false,
        "isDeleted": false
      }
      """
    let definition = try OldSupertagDefinition.decode(from: Data(json.utf8))
    XCTAssertEqual(definition.id, "tag-abc")
    XCTAssertEqual(definition.fields.count, 1)
    XCTAssertTrue(OldSupertagOwnershipResolver.isRuntimeUserCreated(definition, rowDeleted: false))
  }
}
