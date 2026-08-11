// SyncProtocolMessage.swift
// EnchiridionSync
//
// Wire messages for the plan's sync protocol (§Backend architecture, "Sync
// protocol"). There is no server to talk to yet (VaultDO/workers/vault is a
// separate, not-yet-implemented task) — this is the message vocabulary both
// sides will speak, defined now so `VaultSyncClient` has a real contract to
// implement against instead of ad hoc dictionaries.
//
// Design choices, each tied to a specific plan sentence:
// - `.catalogRequest` / `.catalogDiff`: "Catalog first: the vault-meta doc
//   is a CRDT map of pageID -> {docType, createdAt, tombstone?}. It syncs
//   first on every connect; devices diff it against their local catalog to
//   discover pages created elsewhere."
// - `.docVersionVector`: "Per-doc: version-vector exchange -> missing-update
//   streaming both ways."
// - `.docUpdate`: the missing-update streaming payload itself.
// - `.docFullSnapshot`: "If a client's VV predates the DO's compaction
//   horizon, the DO answers with a full snapshot instead of a diff (explicit
//   protocol message — the device-in-a-drawer case)."
// - `.tombstone`: "Deletion is a catalog tombstone (last-tombstone-wins,
//   explicit undelete supported); tombstone sync purges that page's
//   projection rows on both sides." Modeled as its own message (not folded
//   into `catalogDiff`) because a tombstone needs to be actionable
//   individually — it drives local projection-row deletion — where a
//   catalog diff entry is just "here's what changed in the map".
//
// Every case is `Codable` with a stable `type` discriminator (rather than
// relying on Swift's default enum-with-associated-values encoding) so the
// wire format is legible from the TS side and stable across refactors of
// this enum's case order/names.

import EnchiridionCore
import Foundation

/// One entry in a catalog diff — mirrors a `vault-meta` map value:
/// `pageID -> {docType, createdAt, tombstone?, updatedAt}`. Field-for-field
/// mirror of the TS side's `WireCatalogEntry`
/// (workers/vault/src/sync-protocol.ts) and `CatalogEntry`
/// (workers/vault/src/catalog.ts).
public struct CatalogEntry: Codable, Hashable, Sendable {
  public var pageID: PageID
  public var docType: String
  public var createdAt: Date
  public var tombstoned: Bool

  /// When this catalog entry (not necessarily the page's own doc) last
  /// changed — what `catalog.ts`'s `diffCatalog` compares when two
  /// independently-collected entry lists (e.g. client vs. server) disagree
  /// about the same `pageID`, implementing "last-tombstone-wins" as
  /// something more than "whoever the CRDT map happened to apply last".
  /// Required (no default), matching the TS side's `WireCatalogEntry`,
  /// where `updatedAt` is always present, never optional.
  public var updatedAt: Date

  public init(
    pageID: PageID,
    docType: String,
    createdAt: Date,
    tombstoned: Bool = false,
    updatedAt: Date
  ) {
    self.pageID = pageID
    self.docType = docType
    self.createdAt = createdAt
    self.tombstoned = tombstoned
    self.updatedAt = updatedAt
  }
}

// MARK: - Wire JSON coding

/// Shared `JSONEncoder`/`JSONDecoder` configuration for
/// `SyncProtocolMessage` (and anything nested inside it, e.g.
/// `CatalogEntry`). Every `Date` field on the wire (`CatalogEntry.createdAt`,
/// `CatalogEntry.updatedAt`) must be Unix epoch MILLISECONDS to match the TS
/// side (`sync-protocol.ts`, `catalog.ts`), NOT Foundation's default
/// `.deferredToDate` (seconds since the 2001 Cocoa reference date). Every
/// caller that encodes/decodes `SyncProtocolMessage` — production
/// (`VaultSyncClient`) and tests alike — must go through these, never a bare
/// `JSONEncoder()`/`JSONDecoder()`, or the two ends of the WebSocket will
/// silently disagree about every timestamp.
extension JSONEncoder {
  public static var vaultSyncProtocol: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .millisecondsSince1970
    return encoder
  }
}

extension JSONDecoder {
  public static var vaultSyncProtocol: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .millisecondsSince1970
    return decoder
  }
}

/// A message in the vault sync protocol, exchanged in both directions over
/// the WebSocket connection to a vault's VaultDO.
public enum SyncProtocolMessage: Sendable, Equatable {
  /// Sent by the device on connect (and on any reconnect, per the plan's
  /// "WebSocket Hibernation API ... resumable from durable state only"
  /// requirement — there is no in-memory handshake state to resume, so
  /// every (re)connect re-requests the catalog).
  case catalogRequest

  /// The DO's (or a device's, since catalog sync can flow either direction
  /// once diffed) reply: entries the recipient is missing or has stale.
  case catalogDiff(entries: [CatalogEntry])

  /// One side's current version vector for a specific doc, encoded in the
  /// sender's `CRDTEngine` format (see `CRDTEngine.versionVector(of:)`).
  /// Exchanging these is how each side determines what the other is
  /// missing.
  case docVersionVector(pageID: PageID, versionVector: Data)

  /// Ops the sender has that the recipient's last-known version vector
  /// didn't include (see `CRDTEngine.exportUpdates(of:since:)`).
  case docUpdate(pageID: PageID, bytes: Data)

  /// A full (or shallow, per the compaction-horizon case) snapshot sent
  /// instead of an update stream — see the file header note on this case.
  case docFullSnapshot(pageID: PageID, bytes: Data)

  /// The page identified by `pageID` was deleted (or, if `undelete` is
  /// true, an explicit undelete of a previously tombstoned page) — a
  /// catalog-tombstone event significant enough to react to individually
  /// (purge local projection rows) rather than folding into a generic
  /// catalog diff entry.
  case tombstone(pageID: PageID, undelete: Bool)
}

// MARK: - Codable

extension SyncProtocolMessage: Codable {
  private enum MessageType: String, Codable {
    case catalogRequest
    case catalogDiff
    case docVersionVector
    case docUpdate
    case docFullSnapshot
    case tombstone
  }

  private enum CodingKeys: String, CodingKey {
    case type
    case entries
    case pageID
    case versionVector
    case bytes
    case undelete
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(MessageType.self, forKey: .type)
    switch type {
    case .catalogRequest:
      self = .catalogRequest

    case .catalogDiff:
      let entries = try container.decode([CatalogEntry].self, forKey: .entries)
      self = .catalogDiff(entries: entries)

    case .docVersionVector:
      let pageID = try container.decode(PageID.self, forKey: .pageID)
      let vv = try container.decode(Data.self, forKey: .versionVector)
      self = .docVersionVector(pageID: pageID, versionVector: vv)

    case .docUpdate:
      let pageID = try container.decode(PageID.self, forKey: .pageID)
      let bytes = try container.decode(Data.self, forKey: .bytes)
      self = .docUpdate(pageID: pageID, bytes: bytes)

    case .docFullSnapshot:
      let pageID = try container.decode(PageID.self, forKey: .pageID)
      let bytes = try container.decode(Data.self, forKey: .bytes)
      self = .docFullSnapshot(pageID: pageID, bytes: bytes)

    case .tombstone:
      let pageID = try container.decode(PageID.self, forKey: .pageID)
      let undelete = try container.decode(Bool.self, forKey: .undelete)
      self = .tombstone(pageID: pageID, undelete: undelete)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .catalogRequest:
      try container.encode(MessageType.catalogRequest, forKey: .type)

    case .catalogDiff(let entries):
      try container.encode(MessageType.catalogDiff, forKey: .type)
      try container.encode(entries, forKey: .entries)

    case .docVersionVector(let pageID, let versionVector):
      try container.encode(MessageType.docVersionVector, forKey: .type)
      try container.encode(pageID, forKey: .pageID)
      try container.encode(versionVector, forKey: .versionVector)

    case .docUpdate(let pageID, let bytes):
      try container.encode(MessageType.docUpdate, forKey: .type)
      try container.encode(pageID, forKey: .pageID)
      try container.encode(bytes, forKey: .bytes)

    case .docFullSnapshot(let pageID, let bytes):
      try container.encode(MessageType.docFullSnapshot, forKey: .type)
      try container.encode(pageID, forKey: .pageID)
      try container.encode(bytes, forKey: .bytes)

    case .tombstone(let pageID, let undelete):
      try container.encode(MessageType.tombstone, forKey: .type)
      try container.encode(pageID, forKey: .pageID)
      try container.encode(undelete, forKey: .undelete)
    }
  }
}
