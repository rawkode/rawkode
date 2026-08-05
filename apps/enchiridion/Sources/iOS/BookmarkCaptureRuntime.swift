import CoreFoundation
import EnchiridionCore
import Foundation

/// Host-only bridge for the app-group capture queue. It deliberately opens a routed graph only
/// while materializing a claimed record; share extensions only ever touch the inbox and catalog.
actor BookmarkCaptureRuntime {
  static let shared = BookmarkCaptureRuntime()

  private let drainer: BookmarkCaptureDrainer?

  private init() {
    do {
      let inbox = try CaptureInboxStore(path: CaptureInboxStore.defaultPath())
      drainer = BookmarkCaptureDrainer(
        inbox: inbox,
        openRepository: { vaultID in
          try VaultRepositoryContext.open(.vault(vaultID)).repository
        }
      )
    } catch {
      drainer = nil
    }

    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      bookmarkCaptureInboxDidChange,
      CaptureInboxStore.notificationName as CFString,
      nil,
      .deliverImmediately
    )
  }

  deinit {
    CFNotificationCenterRemoveObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      CFNotificationName(CaptureInboxStore.notificationName as CFString),
      nil
    )
  }

  /// An explicit lifecycle and notification seam. Notification loss is safe because activation
  /// always re-scans the durable queue.
  func refresh() async -> Bool {
    guard let drainer else { return false }
    let vaultIDs = Self.downloadedVaultIDs()
    let purgedBeforeDrain = await drainer.purgePermanentDeletionHandoffs(vaultIDs: vaultIDs)
    let outcomes = await drainer.drain()
    // Close the race where a CloudKit acknowledgement completes while the queue is draining.
    let purgedAfterDrain = await drainer.purgePermanentDeletionHandoffs(vaultIDs: vaultIDs)
    return purgedBeforeDrain + purgedAfterDrain > 0 || outcomes.contains(.imported)
  }

  private static func downloadedVaultIDs() -> [VaultID] {
    guard let path = try? VaultRegistry.defaultCatalogPath(),
      let registry = try? VaultRegistry(path: path),
      let snapshot = try? registry.snapshot()
    else { return [] }
    return snapshot.vaults.filter { $0.isDownloaded && $0.deletedAt == nil }.map(\.id)
  }
}

private func bookmarkCaptureInboxDidChange(
  _ center: CFNotificationCenter?,
  _ observer: UnsafeMutableRawPointer?,
  _ name: CFNotificationName?,
  _ object: UnsafeRawPointer?,
  _ userInfo: CFDictionary?
) {
  guard let observer else { return }
  let runtime = Unmanaged<BookmarkCaptureRuntime>.fromOpaque(observer).takeUnretainedValue()
  Task { @MainActor in
    // Use the host seam so an active app reloads its selected store after a successful import.
    _ = runtime
    await EnchiridionAppRuntime.shared.refreshBookmarkCaptures()
  }
}
