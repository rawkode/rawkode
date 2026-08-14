// LocalVaultSyncCoordinator.swift
// EnchiridionUI
//
// The working local-prototype sync seam: it connects the app's durable
// LocalGraphStore to a locally running VaultDO using the same WebSocket
// protocol as a production device. It is deliberately opt-in at composition
// time (RootView checks AppBackendConfiguration.localVaultSyncConfiguration),
// never a replacement for production Cloudflare Access.

import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation

/// Owns one local app instance's Vault sync lifecycle. Local writes are
/// emitted only after their SQLite transaction commits, then uploaded as a
/// catalog entry plus a full CRDT snapshot. Received bytes are merged into
/// the same durable store and explicitly marked `.remote`, preventing an
/// echo loop back to Vault.
public actor LocalVaultSyncCoordinator {
  private let store: LocalGraphStore
  private let client: VaultSyncClient

  private var catalog: [PageID: CatalogEntry] = [:]
  private var incomingTask: Task<Void, Never>?
  private var localChangesTask: Task<Void, Never>?
  private var shouldUploadAllOnNextCatalog = true

  public private(set) var lastError: String?

  public init(store: LocalGraphStore, configuration: LocalVaultSyncConfiguration) {
    self.store = store
    self.client = VaultSyncClient(
      vaultURL: configuration.syncURL,
      localDevelopmentToken: configuration.token
    )
  }

  /// Begins receiving remote frames and observing committed local documents.
  /// The first catalog response (and any response after an unsuccessful
  /// outbound send) causes a complete durable-store upload, covering edits
  /// made while the connection was unavailable.
  public func start() async {
    guard incomingTask == nil, localChangesTask == nil else { return }

    let incomingMessages = await client.incomingMessages
    let localChanges = await store.documentSnapshotChanges()

    incomingTask = Task { [weak self] in
      for await message in incomingMessages {
        await self?.handleIncoming(message)
      }
    }
    localChangesTask = Task { [weak self] in
      for await change in localChanges where change.origin == .local {
        await self?.upload(change)
      }
    }

    await client.connect()
  }

  public func stop() async {
    incomingTask?.cancel()
    incomingTask = nil
    localChangesTask?.cancel()
    localChangesTask = nil
    await client.disconnect()
  }

  private func handleIncoming(_ message: SyncProtocolMessage) async {
    switch message {
    case .catalogDiff(let entries):
      await handleCatalog(entries)
    case .docUpdate(let pageID, let bytes), .docFullSnapshot(let pageID, let bytes):
      await applyRemote(bytes: bytes, for: pageID)
    case .tombstone(let pageID, let undelete):
      await handleTombstone(pageID: pageID, undelete: undelete)
    case .catalogRequest, .docVersionVector:
      break
    }
  }

  private func handleCatalog(_ entries: [CatalogEntry]) async {
    for entry in entries {
      catalog[entry.pageID] = entry

      if entry.tombstoned {
        do {
          try await store.removeProjection(pageID: entry.pageID)
        } catch {
          record(error)
        }
        continue
      }

      do {
        let version = try await store.documentSnapshot(for: entry.pageID)?.version ?? .empty
        await send(.docVersionVector(pageID: entry.pageID, versionVector: version.encoded))
      } catch {
        record(error)
      }
    }

    guard shouldUploadAllOnNextCatalog else { return }
    shouldUploadAllOnNextCatalog = false
    await uploadAllLocalDocuments()
  }

  private func handleTombstone(pageID: PageID, undelete: Bool) async {
    guard !undelete else {
      // The next catalog response supplies the authoritative metadata before
      // a restored document is reprojected.
      shouldUploadAllOnNextCatalog = true
      return
    }

    if var entry = catalog[pageID] {
      entry.tombstoned = true
      entry.updatedAt = Date()
      catalog[pageID] = entry
    }
    do {
      try await store.removeProjection(pageID: pageID)
    } catch {
      record(error)
    }
  }

  private func uploadAllLocalDocuments() async {
    do {
      for record in try await store.documentSnapshots() {
        await upload(
          LocalDocumentSnapshotChange(
            pageID: record.pageID,
            snapshot: record.snapshot,
            version: record.version,
            origin: .local
          ))
      }
    } catch {
      record(error)
    }
  }

  private func upload(_ change: LocalDocumentSnapshotChange) async {
    guard change.origin == .local else { return }

    do {
      let metadata = try PageDocument.metadata(of: change.snapshot)
      guard metadata.pageID == change.pageID else {
        throw PageDocumentError.invalidSchema
      }
      let entry = CatalogEntry(
        pageID: change.pageID,
        docType: Self.documentType(for: metadata.kind),
        createdAt: metadata.createdAt,
        tombstoned: false,
        updatedAt: Date()
      )
      catalog[change.pageID] = entry
      try await client.send(.catalogDiff(entries: [entry]))
      try await client.send(.docFullSnapshot(pageID: change.pageID, bytes: change.snapshot))
    } catch {
      shouldUploadAllOnNextCatalog = true
      record(error)
    }
  }

  private func applyRemote(bytes: Data, for pageID: PageID) async {
    guard let catalogEntry = catalog[pageID], !catalogEntry.tombstoned else {
      // Catalog-first is the protocol invariant. If an out-of-order frame
      // ever appears, wait for the following catalog response rather than
      // project a document without its kind/creation metadata.
      shouldUploadAllOnNextCatalog = true
      return
    }

    do {
      let result: PageDocument.MutationResult
      if let local = try await store.documentSnapshot(for: pageID) {
        result = try PageDocument.merge(local: local.snapshot, remote: bytes)
      } else {
        result = (
          document: bytes,
          version: try PageDocument.currentVersion(of: bytes),
          projection: try PageDocument.projection(of: bytes)
        )
      }
      let metadata = try PageDocument.metadata(of: result.document)
      guard metadata.pageID == pageID else { throw PageDocumentError.invalidSchema }

      try await store.saveDocumentSnapshot(
        pageID: pageID,
        snapshot: result.document,
        version: result.version,
        origin: .remote
      )
      try await store.writeProjection(
        pageID: pageID,
        kind: metadata.kind,
        createdAt: metadata.createdAt,
        modifiedAt: Date(),
        projection: result.projection
      )
    } catch {
      record(error)
    }
  }

  private func send(_ message: SyncProtocolMessage) async {
    do {
      try await client.send(message)
    } catch {
      shouldUploadAllOnNextCatalog = true
      record(error)
    }
  }

  private func record(_ error: Error) {
    lastError = error.localizedDescription
  }

  private static func documentType(for kind: PageKind) -> String {
    switch kind {
    case .daily: "daily"
    case .free: "free"
    case .calendarEvent: "calendarEvent"
    case .calendarSeries: "calendarSeries"
    case .calendarMaterializedEvent: "calendarMaterializedEvent"
    }
  }
}
