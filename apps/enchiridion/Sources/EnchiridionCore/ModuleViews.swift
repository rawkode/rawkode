import Foundation

public struct ViewTypeID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
}

/// The only data a module renderer receives: precomputed query results and its saved definition.
/// It intentionally has no repository/store or SQL handle.
@MainActor
public struct ModuleViewContext {
  public let vaultID: VaultID
  public let definition: LiveQueryDefinition
  public let items: [LiveQueryItem]
  public let dispatch: (ModuleViewCommand) -> Void
  public init(vaultID: VaultID, definition: LiveQueryDefinition, items: [LiveQueryItem], dispatch: @escaping (ModuleViewCommand) -> Void) {
    self.vaultID = vaultID; self.definition = definition; self.items = items; self.dispatch = dispatch
  }
}

public enum ModuleViewCommand: Hashable, Sendable {
  case openPage(VaultScopedNodeID)
}
