import Foundation

public struct VaultID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) { self.rawValue = rawValue }

  public static func random() -> Self {
    .init(rawValue: "vault_\(UUID().uuidString.lowercased())")
  }

  /// Stable identity shared by fresh installations so the built-in graph uses one CloudKit zone.
  public static let personal = Self(rawValue: "vault_personal")

  /// Identity used only by explicitly standalone repositories, such as isolated tests.
  public static let standalone = Self(rawValue: "vault_standalone")

  /// Existing installations already synchronize the built-in vault through this zone.
  public static let personalCloudZoneName = "EnchiridionVault"

  public var cloudZoneName: String {
    self == .personal ? Self.personalCloudZoneName : "EnchiridionGraph-\(rawValue)"
  }
}

/// Nodes are the durable identities in an Enchiridion knowledge graph. PageID remains the
/// concrete representation so task, note, and calendar domain APIs share the same identity.
public typealias NodeID = PageID
public typealias TagID = SupertagID

public struct PredicateID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) { self.rawValue = rawValue }

  public static func property(tagID: TagID, fieldID: SupertagFieldID) -> Self {
    .init(rawValue: "property:\(tagID.rawValue):\(fieldID.rawValue)")
  }
}

public struct FactID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
  public static func random() -> Self {
    .init(rawValue: "fact_\(UUID().uuidString.lowercased())")
  }
}

public struct RelationID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
  public static func random() -> Self {
    .init(rawValue: "relation_\(UUID().uuidString.lowercased())")
  }
}

public struct EdgeID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
  public static func random() -> Self {
    .init(rawValue: "edge_\(UUID().uuidString.lowercased())")
  }
}

public struct GraphIssueID: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
  public let rawValue: String
  public var id: String { rawValue }
  public init(rawValue: String) { self.rawValue = rawValue }
}

public struct VaultScopedNodeID: Codable, Hashable, Sendable, Identifiable {
  public var vaultID: VaultID
  public var nodeID: NodeID
  public var id: String { "\(vaultID.rawValue)/\(nodeID.rawValue)" }

  public init(vaultID: VaultID, nodeID: NodeID) {
    self.vaultID = vaultID
    self.nodeID = nodeID
  }

  public init?(serialized: String) {
    guard !serialized.isEmpty else { return nil }
    guard let separator = serialized.firstIndex(of: "/") else {
      // AppEntity identifiers created before vault support stored only the page identity.
      self.init(vaultID: .personal, nodeID: .init(rawValue: serialized))
      return
    }
    let vault = String(serialized[..<separator])
    let node = String(serialized[serialized.index(after: separator)...])
    guard vault.hasPrefix("vault_"), !node.isEmpty else { return nil }
    self.init(
      vaultID: .init(rawValue: vault),
      nodeID: .init(rawValue: node)
    )
  }
}

public struct LocalDate: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init?(rawValue: String) {
    let pieces = rawValue.split(separator: "-", omittingEmptySubsequences: false)
    guard pieces.count == 3,
      pieces[0].count == 4,
      pieces[1].count == 2,
      pieces[2].count == 2,
      let year = Int(pieces[0]),
      let month = Int(pieces[1]),
      let day = Int(pieces[2]),
      (1...12).contains(month),
      (1...31).contains(day),
      year > 0
    else { return nil }
    self.rawValue = rawValue
  }

  public init(date: Date, calendar: Calendar = .current) {
    self.rawValue = DayKey(date: date, calendar: calendar).rawValue
  }
}
