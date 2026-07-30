import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class AccessGrantStore {
  private(set) var grants: [AccessGrant] = []
  private(set) var loadError: String?
  private(set) var syncStatus: GrantMetadataSyncStatus = .unavailable

  private let storageURL: URL
  private let syncStateURL: URL
  private let resolver: any BookmarkResolving
  private let metadataSync: any GrantMetadataSyncing
  private let deviceID: UUID
  private var externalSyncObserver: NSObjectProtocol?
  private var syncState = GrantMetadataSyncState()

  init(
    storageURL: URL? = nil,
    resolver: any BookmarkResolving = SystemBookmarkResolver(),
    metadataSync: (any GrantMetadataSyncing)? = nil,
    deviceID: UUID = UUID(),
    seedFixtureWhenRequested: Bool = true
  ) {
    self.resolver = resolver
    self.storageURL = storageURL ?? Self.defaultStorageURL
    self.syncStateURL = self.storageURL.deletingLastPathComponent()
      .appending(path: "AccessGrantSyncState.json", directoryHint: .notDirectory)
    self.metadataSync = metadataSync ?? UbiquitousGrantMetadataStore()
    self.deviceID = deviceID
    load()
    loadSyncState()
    refreshSyncedMetadata()
    observeExternalMetadataChanges()

    if seedFixtureWhenRequested,
       ProcessInfo.processInfo.arguments.contains("--scout-ui-fixture"),
       let fixturePath = ProcessInfo.processInfo.environment["SCOUT_FIXTURE_ROOT"] {
      grants = [
        AccessGrant(
          displayName: "Scout Fixture",
          bookmarkData: Data(),
          lastKnownPath: fixturePath,
          sortOrder: 0,
          requiresSecurityScope: false
        )
      ]
    }
  }

  var orderedGrants: [AccessGrant] {
    grants.sorted {
      if $0.sortOrder == $1.sortOrder { return $0.displayName < $1.displayName }
      return $0.sortOrder < $1.sortOrder
    }
  }

  func addLocation() async throws -> AccessGrant? {
    let panel = NSOpenPanel()
    panel.title = String(localized: "Add a Location")
    panel.message = String(localized: "Scout can browse this folder and everything inside it.")
    panel.prompt = String(localized: "Add Location")
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.resolvesAliases = false

    guard await panel.begin() == .OK, let url = panel.url else { return nil }
    return try add(url: url)
  }

  @discardableResult
  func add(url: URL) throws -> AccessGrant {
    let standardized = url.standardizedFileURL
    if let existing = grants.first(where: { $0.lastKnownPath == standardized.path }) {
      return existing
    }

    let bookmarkData = try resolver.bookmark(for: standardized)
    let grant = AccessGrant(
      displayName: standardized.lastPathComponent.isEmpty ? standardized.path : standardized.lastPathComponent,
      bookmarkData: bookmarkData,
      lastKnownPath: standardized.path,
      sortOrder: grants.count
    )
    grants.append(grant)
    try save(publishingMetadata: true)
    return grant
  }

  /// Replaces local authorization without changing the private synced metadata.
  /// This is used for stale-bookmark renewal and reconnecting another Mac.
  func updateLocalBookmark(grantID: UUID, bookmarkData: Data, url: URL) throws {
    guard let index = grants.firstIndex(where: { $0.id == grantID }) else { return }
    grants[index].bookmarkData = bookmarkData
    grants[index].lastKnownPath = url.standardizedFileURL.path
    try save(publishingMetadata: false)
  }

  func reconnect(_ grant: AccessGrant) async throws -> AccessGrant? {
    let panel = NSOpenPanel()
    panel.title = String(localized: "Reconnect Location")
    panel.message = String(localized: "Choose this location again to give this Mac access.")
    panel.prompt = String(localized: "Reconnect")
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.resolvesAliases = false

    guard await panel.begin() == .OK, let url = panel.url else { return nil }
    let standardized = url.standardizedFileURL
    let bookmarkData = try resolver.bookmark(for: standardized)
    try updateLocalBookmark(grantID: grant.id, bookmarkData: bookmarkData, url: standardized)
    return grants.first(where: { $0.id == grant.id })
  }

  func remove(_ grant: AccessGrant) throws {
    grants.removeAll { $0.id == grant.id }
    syncState.deletedGrantIDs.insert(grant.id)
    normalizeOrdering()
    try save(publishingMetadata: true)
  }

  func move(from source: IndexSet, to destination: Int) throws {
    var ordered = orderedGrants
    ordered.move(fromOffsets: source, toOffset: destination)
    grants = ordered
    normalizeOrdering()
    try save(publishingMetadata: true)
  }

  /// Pulls a private KVS envelope. Unknown grants become reconnect-required
  /// placeholders, never cross-machine security-scoped bookmarks.
  func refreshSyncedMetadata() {
    guard metadataSync.isAvailable else {
      syncStatus = .unavailable
      return
    }

    _ = metadataSync.synchronize()
    syncStatus = .available
    guard let data = metadataSync.loadEnvelopeData(),
          let envelope = try? JSONDecoder().decode(GrantMetadataEnvelope.self, from: data),
          envelope.version == GrantMetadataEnvelope.currentVersion
    else {
      if !grants.isEmpty { publishMetadata() }
      return
    }

    let remoteIDs = Set(envelope.grants.map(\.id))
    let remoteDeletedIDs = Set(envelope.deletedGrantIDs)
    let previouslySyncedIDs = syncState.knownSyncedGrantIDs
    let removedByRemote = remoteDeletedIDs.union(previouslySyncedIDs.subtracting(remoteIDs))

    // A manifest is authoritative for locations it has already introduced.
    // Grants this device made while offline remain eligible for its next upload.
    var merged = grants.filter { !removedByRemote.contains($0.id) }
    syncState.deletedGrantIDs.formUnion(remoteDeletedIDs)
    syncState.knownSyncedGrantIDs.formUnion(remoteIDs)
    syncState.knownSyncedGrantIDs.subtract(remoteDeletedIDs)

    for metadata in envelope.grants {
      guard !syncState.deletedGrantIDs.contains(metadata.id) else { continue }
      if let index = merged.firstIndex(where: { $0.id == metadata.id }) {
        merged[index].displayName = metadata.displayName
        merged[index].sortOrder = metadata.sortOrder
        merged[index].dateAdded = metadata.dateAdded
      } else {
        merged.append(
          AccessGrant(
            id: metadata.id,
            displayName: metadata.displayName,
            bookmarkData: Data(),
            lastKnownPath: "",
            dateAdded: metadata.dateAdded,
            sortOrder: metadata.sortOrder,
            requiresSecurityScope: true
          )
        )
      }
    }
    let hasLocalOnlyGrant = merged.contains { !syncState.knownSyncedGrantIDs.contains($0.id) }
    grants = merged.sorted {
      if $0.sortOrder == $1.sortOrder { return $0.displayName < $1.displayName }
      return $0.sortOrder < $1.sortOrder
    }
    normalizeOrdering()
    try? save(publishingMetadata: false)

    // A grant made while offline is safe to add to the next metadata upload.
    if hasLocalOnlyGrant { publishMetadata() }
  }

  private func normalizeOrdering() {
    for index in grants.indices { grants[index].sortOrder = index }
  }

  private func observeExternalMetadataChanges() {
    guard let notificationObject = metadataSync.notificationObject else { return }
    externalSyncObserver = NotificationCenter.default.addObserver(
      forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
      object: notificationObject,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.refreshSyncedMetadata()
      }
    }
  }

  private func load() {
    do {
      guard FileManager.default.fileExists(atPath: storageURL.path) else { return }
      let data = try Data(contentsOf: storageURL)
      grants = try JSONDecoder().decode([AccessGrant].self, from: data)
      loadError = nil
    } catch {
      grants = []
      loadError = error.localizedDescription
    }
  }

  private func loadSyncState() {
    guard let data = try? Data(contentsOf: syncStateURL),
          let state = try? JSONDecoder().decode(GrantMetadataSyncState.self, from: data)
    else { return }
    syncState = state
  }

  private func saveSyncState() {
    let directory = syncStateURL.deletingLastPathComponent()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    guard let data = try? JSONEncoder().encode(syncState) else { return }
    try? data.write(to: syncStateURL, options: .atomic)
  }

  private func save(publishingMetadata: Bool) throws {
    let directory = storageURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(grants)
    try data.write(to: storageURL, options: .atomic)
    saveSyncState()
    if publishingMetadata { publishMetadata() }
  }

  private func publishMetadata() {
    guard metadataSync.isAvailable else {
      syncStatus = .unavailable
      return
    }

    let envelope = GrantMetadataEnvelope(
      originDeviceID: deviceID,
      grants: orderedGrants.map {
        GrantMetadata(
          id: $0.id,
          displayName: $0.displayName,
          sortOrder: $0.sortOrder,
          dateAdded: $0.dateAdded
        )
      },
      deletedGrantIDs: syncState.deletedGrantIDs.sorted { $0.uuidString < $1.uuidString }
    )
    guard let data = try? JSONEncoder().encode(envelope) else { return }
    metadataSync.saveEnvelopeData(data)
    _ = metadataSync.synchronize()
    syncState.knownSyncedGrantIDs.formUnion(grants.map(\.id))
    syncState.knownSyncedGrantIDs.subtract(syncState.deletedGrantIDs)
    saveSyncState()
    syncStatus = .available
  }

  private static var defaultStorageURL: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    return base.appending(path: "Scout", directoryHint: .isDirectory)
      .appending(path: "AccessGrants.json", directoryHint: .notDirectory)
  }
}
