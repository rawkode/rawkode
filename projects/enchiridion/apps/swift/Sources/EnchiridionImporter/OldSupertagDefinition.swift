// OldSupertagDefinition.swift
// EnchiridionImporter
//
// Decodable mirror of the old app's `SupertagDefinition` /
// `SupertagFieldDefinition` (apps/enchiridion/Sources/EnchiridionCore/
// SupertagModels.swift) — the shape stored as
// `supertag_schemas.definition_json` (see `OldVaultSQLiteSource`). A local
// mirror, not a reuse of `EnchiridionCore.SupertagDefinition`, because the
// NEW app has no such type at all (P1's supertag module contract replaced
// runtime-editable `SupertagDefinition` rows with as-code TS modules —
// plan §Supertag module contract) — there is nothing to decode into on the
// new side; this type exists purely to feed `SupertagModuleGenerator`.
//
// Field types are decoded as plain `String` (not a matching Swift enum)
// deliberately: `SupertagModuleGenerator.fieldSource(for:)` already has to
// handle an unrecognized value gracefully (a defensive default, not a
// decode failure) for forward-compatibility with old-app field types this
// importer doesn't know about yet — decoding straight to `String` keeps
// that fallback in one place instead of two.
import Foundation

public struct OldSupertagSelectOption: Decodable, Sendable {
  public var id: String
  public var name: String
  public var color: String
}

public struct OldSupertagFieldDefinition: Decodable, Sendable {
  public var id: String
  public var name: String
  public var type: String
  public var allowsMultiple: Bool
  public var isRequired: Bool
  public var isMultiline: Bool
  public var options: [OldSupertagSelectOption]
  public var allowedSupertagIDs: [String]
  public var isDeleted: Bool
}

public struct OldSupertagDefinition: Decodable, Sendable {
  public var id: String
  public var name: String
  public var symbol: String
  public var fields: [OldSupertagFieldDefinition]
  public var parentIDs: [String]
  public var isBuiltIn: Bool
  public var isDeleted: Bool

  public static func decode(from json: Data) throws -> OldSupertagDefinition {
    try JSONDecoder().decode(OldSupertagDefinition.self, from: json)
  }
}

/// Reserved namespace prefix for the old app's compiled, first-party
/// declarations (`ModuleNamespace.isCompiledIdentifier`,
/// ModuleFoundation.swift:28-30) — NOT used by any built-in
/// `SupertagDefinition.id` (those are bare, e.g. `"person"`), only by
/// compiled-MODULE declarations, if any ever used it. Kept here for
/// parity/documentation with the old app's own constant; the real
/// ownership signal this importer uses is `isBuiltIn` (see
/// `OldSupertagOwnershipResolver`).
private let compiledDeclarationPrefix = "dev.rawkode.enchiridion."

/// Determines whether an old `SupertagDefinition` is a "runtime user-created
/// supertag" per the plan's P1 pre-migration step — the ones that need a
/// generated TS module, because as-code TS is now the ONLY way a supertag
/// definition can exist going forward.
public enum OldSupertagOwnershipResolver {
  /// Known compiled-module namespace prefixes beyond the bare-id built-ins
  /// (`BuiltInSupertags.all` — person/organization/company/event/area/
  /// project/task/place/bookmark, all UN-namespaced ids) and the reserved
  /// `dev.rawkode.enchiridion.` prefix. This importer has no live
  /// `ModuleRegistry` to consult (deliberately — see this package's
  /// Package.swift comment on why it doesn't depend on the old app's
  /// package at all), so the one compiled module the plan's monorepo
  /// layout names (`supertags/workouts`) is hardcoded here; anything else
  /// not caught by `isBuiltIn` or these prefixes is `.user` by elimination
  /// — the same logic `DeclarationOwnershipResolver.ownership(of:registry:)`
  /// (ModuleFoundation.swift:40-49) applies, restated for a registry-less
  /// caller.
  static let knownCompiledModulePrefixes = ["dev.rawkode.workouts."]

  /// `true` for exactly the definitions the plan's pre-migration step wants
  /// migrated: not a built-in (`BuiltInSupertags.all`, `isBuiltIn: true` in
  /// its persisted JSON — see `LibraryRepository`'s migration that inserts
  /// them into `supertag_schemas` with that flag set), not under a known
  /// compiled-module namespace, and not soft-deleted (`isDeleted`/the SQL
  /// row's `deleted` flag — a deleted definition has nothing left to
  /// migrate).
  public static func isRuntimeUserCreated(_ definition: OldSupertagDefinition, rowDeleted: Bool) -> Bool {
    guard !definition.isBuiltIn, !definition.isDeleted, !rowDeleted else { return false }
    if definition.id.hasPrefix(compiledDeclarationPrefix) { return false }
    for prefix in knownCompiledModulePrefixes where definition.id.hasPrefix(prefix) {
      return false
    }
    return true
  }
}
