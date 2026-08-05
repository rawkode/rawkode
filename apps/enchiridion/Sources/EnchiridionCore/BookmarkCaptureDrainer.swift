import Foundation

/// A background-only opening seam. It exposes a repository, never a graph path, so extension code
/// can enqueue captures but cannot accidentally open a vault database.
public typealias BookmarkCaptureBackgroundRepositoryOpener = @Sendable (VaultID) async throws -> LibraryRepository
public typealias BookmarkCaptureMaterializer = @Sendable (LibraryRepository, BookmarkCaptureRequest) async throws -> BookmarkCaptureResult

public enum BookmarkCaptureDrainOutcome: Sendable, Equatable {
  case imported, quarantined, retained
}

public actor BookmarkCaptureDrainer {
  private let inbox: CaptureInboxStore
  private let openRepository: BookmarkCaptureBackgroundRepositoryOpener
  private let materialize: BookmarkCaptureMaterializer
  private let ownerID: UUID
  private var draining = false

  public init(
    inbox: CaptureInboxStore,
    ownerID: UUID = UUID(),
    openRepository: @escaping BookmarkCaptureBackgroundRepositoryOpener,
    materialize: @escaping BookmarkCaptureMaterializer = { repository, request in try repository.materializeBookmark(request) }
  ) {
    self.inbox = inbox; self.ownerID = ownerID; self.openRepository = openRepository; self.materialize = materialize
  }

  /// Host-only cleanup seam. Repositories expose only completed, digest-only handoffs, and the
  /// inbox derives each queued digest transiently before deleting matching URL payloads.
  @discardableResult
  public func purgePermanentDeletionHandoffs(vaultIDs: [VaultID]) async -> Int {
    var digests = Set<String>()
    for vaultID in Set(vaultIDs) {
      guard let repository = try? await openRepository(vaultID),
        let handoffs = try? await repository.bookmarkPermanentDeletionHandoffs()
      else { continue }
      digests.formUnion(handoffs.map(\.urlKeyDigest))
    }
    return (try? await inbox.purgeURLKeyDigests(digests)) ?? 0
  }

  /// Serialized, bounded draining. The SQLite lease is released before every await.
  @discardableResult public func drain(limit: Int = 25, leaseDuration: TimeInterval = 60) async -> [BookmarkCaptureDrainOutcome] {
    guard !draining else { return [] }
    draining = true; defer { draining = false }
    let leaseID = UUID()
    guard let records = try? await inbox.claim(ownerID: ownerID, leaseID: leaseID, leaseDuration: leaseDuration, limit: limit) else { return [] }
    var outcomes: [BookmarkCaptureDrainOutcome] = []
    for record in records {
      let request = record.payload.request(captureID: record.captureID, vaultID: record.vaultID)
      do {
        let repository = try await openRepository(record.vaultID)
        let result = try await materialize(repository, request)
        // Both a fresh receipt and its idempotent replay are durable graph successes.
        let finished = (try? await inbox.finishImported(
          captureID: record.captureID,
          ownerID: ownerID,
          leaseID: leaseID
        )) == true
        outcomes.append(finished ? .imported : .retained)
        _ = result
      } catch let error as VaultRegistryError where error == .vaultNotFound {
        let quarantined = (try? await inbox.quarantine(
          captureID: record.captureID,
          ownerID: ownerID,
          leaseID: leaseID,
          reason: error.localizedDescription
        )) == true
        outcomes.append(quarantined ? .quarantined : .retained)
      } catch let error as CaptureInboxStoreError where error == .invalidURL || error == .conflictingPayload {
        let quarantined = (try? await inbox.quarantine(
          captureID: record.captureID,
          ownerID: ownerID,
          leaseID: leaseID,
          reason: error.localizedDescription
        )) == true
        outcomes.append(quarantined ? .quarantined : .retained)
      } catch let error as LibraryRepositoryError where error == .invalidRecord || error == .pagePurged {
        let quarantined = (try? await inbox.quarantine(
          captureID: record.captureID,
          ownerID: ownerID,
          leaseID: leaseID,
          reason: error.localizedDescription
        )) == true
        outcomes.append(quarantined ? .quarantined : .retained)
      } catch let error as LibraryRepositoryError where error == .bookmarkSuppressed {
        // Suppression is a durable graph success. Remove every queued spelling of this identity,
        // including this active lease, so neither retry nor quarantine retains the submitted URL.
        guard let key = BookmarkURLKey(submittedURL: request.submittedURL) else {
          outcomes.append(.retained)
          continue
        }
        do {
          _ = try await inbox.purgeURLKeyDigests([key.digest])
          // A prior record in this claimed batch may already have removed this row.
          outcomes.append(.imported)
        } catch {
          outcomes.append(.retained)
        }
      } catch {
        // Transient failures retain the immutable route and payload for a later launch/sync scan.
        _ = try? await inbox.release(captureID: record.captureID, ownerID: ownerID, leaseID: leaseID)
        outcomes.append(.retained)
      }
    }
    return outcomes
  }
}
