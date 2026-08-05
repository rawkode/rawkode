import Foundation
import EnchiridionCore

/// Host-only materialization for the app-group capture inbox. Share extensions never open a vault.
actor MacBookmarkCaptureRuntime {
  static let shared = MacBookmarkCaptureRuntime()

  private let drainer: BookmarkCaptureDrainer?
  private var refreshCurrentStore: (@MainActor @Sendable () async -> Void)?

  private init() {
    do {
      let inbox = try CaptureInboxStore(path: CaptureInboxStore.defaultPath())
      drainer = BookmarkCaptureDrainer(inbox: inbox) { vaultID in
        try VaultRepositoryContext.open(.vault(vaultID)).repository
      }
      MacCaptureInboxDarwinObserver.install()
    } catch {
      drainer = nil
    }
  }

  func configure(refreshCurrentStore: @escaping @MainActor @Sendable () async -> Void) {
    self.refreshCurrentStore = refreshCurrentStore
  }

  func drainInbox() async {
    guard let drainer else { return }
    let vaultIDs = Self.downloadedVaultIDs()
    let purgedBeforeDrain = await drainer.purgePermanentDeletionHandoffs(vaultIDs: vaultIDs)
    let outcomes = await drainer.drain()
    // Close the race where a CloudKit acknowledgement completes while the queue is draining.
    let purgedAfterDrain = await drainer.purgePermanentDeletionHandoffs(vaultIDs: vaultIDs)
    guard purgedBeforeDrain + purgedAfterDrain > 0 || outcomes.contains(.imported),
      let refreshCurrentStore
    else { return }
    await refreshCurrentStore()
  }

  private static func downloadedVaultIDs() -> [VaultID] {
    guard let path = try? VaultRegistry.defaultCatalogPath(),
      let registry = try? VaultRegistry(path: path),
      let snapshot = try? registry.snapshot()
    else { return [] }
    return snapshot.vaults.filter { $0.isDownloaded && $0.deletedAt == nil }.map(\.id)
  }
}

private enum MacCaptureInboxDarwinObserver {
  static func install() {
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      nil,
      { _, _, _, _, _ in
        Task { await MacBookmarkCaptureRuntime.shared.drainInbox() }
      },
      CaptureInboxStore.notificationName as CFString,
      nil,
      .deliverImmediately
    )
  }
}
