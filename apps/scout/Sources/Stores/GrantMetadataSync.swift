import Foundation

/// The only grant data permitted to leave this Mac. Security-scoped bookmark
/// data and local filesystem paths deliberately have no representation here.
struct GrantMetadataEnvelope: Codable, Equatable, Sendable {
  static let currentVersion = 2

  var version: Int
  var modifiedAt: Date
  var originDeviceID: UUID
  var grants: [GrantMetadata]
  var deletedGrantIDs: [UUID]

  init(
    version: Int = Self.currentVersion,
    modifiedAt: Date = .now,
    originDeviceID: UUID,
    grants: [GrantMetadata],
    deletedGrantIDs: [UUID] = []
  ) {
    self.version = version
    self.modifiedAt = modifiedAt
    self.originDeviceID = originDeviceID
    self.grants = grants
    self.deletedGrantIDs = deletedGrantIDs
  }
}

/// Local bookkeeping that distinguishes a grant created while offline from a
/// grant that previously existed in the synced manifest and was later removed.
struct GrantMetadataSyncState: Codable, Sendable {
  var knownSyncedGrantIDs: Set<UUID> = []
  var deletedGrantIDs: Set<UUID> = []
}

struct GrantMetadata: Codable, Equatable, Identifiable, Sendable {
  let id: UUID
  var displayName: String
  var sortOrder: Int
  var dateAdded: Date
}

enum GrantMetadataSyncStatus: Equatable, Sendable {
  case unavailable
  case available
}

@MainActor
protocol GrantMetadataSyncing: AnyObject {
  var isAvailable: Bool { get }
  var notificationObject: AnyObject? { get }
  func loadEnvelopeData() -> Data?
  func saveEnvelopeData(_ data: Data)
  func synchronize() -> Bool
}

@MainActor
final class UbiquitousGrantMetadataStore: GrantMetadataSyncing {
  private static let key = "Scout.AccessGrantMetadata.v1"
  private let store: NSUbiquitousKeyValueStore

  init(store: NSUbiquitousKeyValueStore = .default) {
    self.store = store
  }

  var isAvailable: Bool {
    FileManager.default.ubiquityIdentityToken != nil
  }

  var notificationObject: AnyObject? { store }

  func loadEnvelopeData() -> Data? {
    store.data(forKey: Self.key)
  }

  func saveEnvelopeData(_ data: Data) {
    store.set(data, forKey: Self.key)
  }

  func synchronize() -> Bool {
    store.synchronize()
  }
}
