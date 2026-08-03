import Foundation
import GRDB

/// Stable identifier for a compiled, first-party Enchiridion module.
public struct EnchiridionModuleID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  Comparable
{
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// The identifier prefix a module owns. A namespace is deliberately not a broad "system" grant.
public struct ModuleNamespace: Codable, Hashable, Sendable {
  public let moduleID: EnchiridionModuleID
  public let prefix: String

  public init(moduleID: EnchiridionModuleID, prefix: String? = nil) {
    self.moduleID = moduleID
    self.prefix = prefix ?? "\(moduleID.rawValue)."
  }

  public func contains(_ identifier: String) -> Bool { identifier.hasPrefix(prefix) }

  /// Compiled first-party declarations use a reserved prefix. This also lets an older client keep
  /// a received definition opaque rather than publishing or deleting it as user schema.
  public static func isCompiledIdentifier(_ identifier: String) -> Bool {
    identifier.hasPrefix("dev.rawkode.enchiridion.")
  }
}

public enum DeclarationOwnership: Codable, Hashable, Sendable {
  case core
  case user
  case module(EnchiridionModuleID)
}

/// Resolves ownership without changing the durable shape of legacy declarations.
public enum DeclarationOwnershipResolver {
  public static func ownership(of identifier: String, registry: ModuleRegistry) -> DeclarationOwnership {
    for manifest in registry.manifests where manifest.namespace.contains(identifier) {
      return .module(manifest.id)
    }
    return identifier.hasPrefix("dev.rawkode.enchiridion.") ? .core : .user
  }
}

public struct ModuleProjectionDeclaration: Codable, Hashable, Sendable, Identifiable {
  /// A stable module-owned declaration identifier, distinct from the public SQL view name.
  public let id: String
  public let viewName: String
  public let version: Int
  public let statement: String

  public init(id: String, viewName: String, version: Int, statement: String) {
    self.id = id; self.viewName = viewName; self.version = version; self.statement = statement
  }
}

public struct ModuleViewTypeDeclaration: Codable, Hashable, Sendable, Identifiable {
  public let id: ViewTypeID
  public let version: Int
  public init(id: ViewTypeID, version: Int = 1) { self.id = id; self.version = version }
}

public struct EnchiridionModuleManifest: Sendable {
  public let id: EnchiridionModuleID
  public let version: Int
  public let namespace: ModuleNamespace
  public let supertags: [SupertagDefinition]
  public let relations: [RelationDefinition]
  public let projections: [ModuleProjectionDeclaration]
  public let viewTypes: [ModuleViewTypeDeclaration]

  public init(
    id: EnchiridionModuleID,
    version: Int,
    namespace: ModuleNamespace? = nil,
    supertags: [SupertagDefinition] = [],
    relations: [RelationDefinition] = [],
    projections: [ModuleProjectionDeclaration] = [],
    viewTypes: [ModuleViewTypeDeclaration] = []
  ) {
    self.id = id; self.version = version; self.namespace = namespace ?? .init(moduleID: id)
    self.supertags = supertags; self.relations = relations; self.projections = projections
    self.viewTypes = viewTypes
  }
}

public enum ModuleRegistryError: Error, LocalizedError, Equatable {
  case invalidNamespace(EnchiridionModuleID)
  case duplicateModule(EnchiridionModuleID)
  case identifierCollision(String)
  case foreignDeclaration(module: EnchiridionModuleID, identifier: String)
  case incompatibleUpgrade(String)
  case invalidProjection(String)

  public var errorDescription: String? {
    switch self {
    case .invalidNamespace(let id): "Invalid namespace for \(id.rawValue)."
    case .duplicateModule(let id): "Module \(id.rawValue) is registered twice."
    case .identifierCollision(let id): "Module declaration identifier collision: \(id)."
    case .foreignDeclaration(let module, let id): "\(module.rawValue) does not own \(id)."
    case .incompatibleUpgrade(let id): "Module upgrade changes incompatible declaration \(id)."
    case .invalidProjection(let id): "Invalid read-only module projection \(id)."
    }
  }
}

/// Immutable registry validated once at startup. In production callers can retain a last-known-good
/// registry if validation fails rather than partially installing a module.
public struct ModuleRegistry: Sendable {
  public let manifests: [EnchiridionModuleManifest]

  public init(manifests: [EnchiridionModuleManifest]) throws {
    let ordered = manifests.sorted { $0.id < $1.id }
    var modules = Set<EnchiridionModuleID>()
    var identifiers = Set<String>()
    var projectionViews = Set<String>()
    for manifest in ordered {
      guard manifest.version > 0, manifest.namespace.moduleID == manifest.id,
        manifest.namespace.prefix.hasSuffix("."), !manifest.namespace.prefix.isEmpty
      else { throw ModuleRegistryError.invalidNamespace(manifest.id) }
      guard modules.insert(manifest.id).inserted else { throw ModuleRegistryError.duplicateModule(manifest.id) }
      for projection in manifest.projections {
        guard Self.isValidProjectionViewName(projection.viewName), Self.isSafeProjectionStatement(projection.statement),
          projectionViews.insert(projection.viewName).inserted
        else { throw ModuleRegistryError.invalidProjection(projection.id) }
      }
      let declared = manifest.supertags.map(\.id.rawValue) + manifest.relations.map(\.id.rawValue)
        + manifest.projections.map(\.id) + manifest.viewTypes.map(\.id.rawValue)
      for identifier in declared {
        guard manifest.namespace.contains(identifier) else {
          throw ModuleRegistryError.foreignDeclaration(module: manifest.id, identifier: identifier)
        }
        guard identifiers.insert(identifier).inserted else { throw ModuleRegistryError.identifierCollision(identifier) }
      }
    }
    self.manifests = ordered
  }

  private static func isValidProjectionViewName(_ value: String) -> Bool {
    value.range(of: "^graph_[a-z0-9_]+$", options: .regularExpression) != nil
  }

  /// Projections are code-owned but still get a deliberately narrow SQL contract. They are a
  /// single query body, never a DDL/DML script.
  private static func isSafeProjectionStatement(_ statement: String) -> Bool {
    let normalized = statement.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty, !normalized.contains(";"), !normalized.contains("--"), !normalized.contains("/*"),
      normalized.range(of: "^SELECT\\b", options: [.regularExpression, .caseInsensitive]) != nil
    else { return false }
    let words = normalized.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    let forbidden: Set<String> = ["insert", "update", "delete", "drop", "alter", "create", "attach", "pragma", "vacuum", "replace"]
    return !words.contains(where: { forbidden.contains($0) }) && words.filter { $0 == "select" }.count == 1
  }

  public func writeCapability(for id: EnchiridionModuleID) -> ModuleWriteCapability? {
    manifests.contains(where: { $0.id == id }) ? ModuleWriteCapability(moduleID: id) : nil
  }
}

/// Capability required for module declaration writes. Only a registry can mint it.
public struct ModuleWriteCapability: Hashable, Sendable {
  public let moduleID: EnchiridionModuleID
  fileprivate init(moduleID: EnchiridionModuleID) { self.moduleID = moduleID }
}

extension LibraryRepository {
  /// Installs only additive, compiled declarations. They are local metadata and must never enter
  /// CloudKit's user-editable schema stream.
  public func reconcileModule(_ manifest: EnchiridionModuleManifest, using capability: ModuleWriteCapability) throws {
    guard capability.moduleID == manifest.id else {
      throw ModuleRegistryError.foreignDeclaration(module: capability.moduleID, identifier: manifest.id.rawValue)
    }
    try database.write { db in
      for declaration in manifest.supertags {
        guard manifest.namespace.contains(declaration.id.rawValue) else {
          throw ModuleRegistryError.foreignDeclaration(module: manifest.id, identifier: declaration.id.rawValue)
        }
        let resolved = try Self.additivelyMergedModuleSupertag(declaration, in: db)
        try db.execute(sql: """
          INSERT INTO supertag_schemas (id,name,definition_json,deleted,sort_order,modified_at,dirty_generation,cloud_dirty,cloud_synced_generation)
          VALUES (?,?,?,?,999,?,0,0,0)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name, definition_json=excluded.definition_json,
            deleted=0, modified_at=excluded.modified_at, cloud_dirty=0, cloud_record=NULL
          """, arguments: [resolved.id.rawValue, resolved.name, try JSONEncoder.enchiridion.encode(resolved), false, Date().timeIntervalSince1970])
      }
      for relation in manifest.relations {
        guard manifest.namespace.contains(relation.id.rawValue) else {
          throw ModuleRegistryError.foreignDeclaration(module: manifest.id, identifier: relation.id.rawValue)
        }
        var local = relation
        local.isSystem = true
        try GraphDatabaseSchema.saveRelation(local, in: db, modifiedAt: Date())
        try db.execute(sql: "UPDATE _graph_relation_definitions SET cloud_dirty = 0, cloud_record = NULL WHERE id = ?", arguments: [relation.id.rawValue])
      }
      try GraphDatabaseSchema.rebuildTagClosure(in: db)
      try GraphProjectionStore.refreshIssues(in: db)
    }
  }

  /// A module may only reconcile declarations inside its own namespace.
  public func saveModuleSupertag(_ definition: SupertagDefinition, using capability: ModuleWriteCapability, registry: ModuleRegistry) throws {
    guard let manifest = registry.manifests.first(where: { $0.id == capability.moduleID }),
      manifest.supertags.contains(where: { $0.id == definition.id })
    else { throw ModuleRegistryError.foreignDeclaration(module: capability.moduleID, identifier: definition.id.rawValue) }
    try reconcileModule(.init(id: manifest.id, version: manifest.version, namespace: manifest.namespace, supertags: [definition]), using: capability)
  }

  private static func additivelyMergedModuleSupertag(_ incoming: SupertagDefinition, in db: Database) throws -> SupertagDefinition {
    guard let data = try Data.fetchOne(db, sql: "SELECT definition_json FROM supertag_schemas WHERE id = ?", arguments: [incoming.id.rawValue]),
      let existing = try? JSONDecoder.enchiridion.decode(SupertagDefinition.self, from: data)
    else { return incoming }
    var merged = incoming
    for oldField in existing.fields where !incoming.fields.contains(where: { $0.id == oldField.id }) { merged.fields.append(oldField) }
    for field in incoming.fields {
      if let old = existing.fields.first(where: { $0.id == field.id }), (old.type != field.type || old.allowsMultiple != field.allowsMultiple) {
        throw ModuleRegistryError.incompatibleUpgrade("\(incoming.id.rawValue):\(field.id.rawValue)")
      }
    }
    return merged
  }
}
