import Foundation

struct ResolvedAccess: Sendable {
  let grantID: UUID
  let url: URL
  let refreshedBookmarkData: Data?
}

protocol BookmarkResolving: Sendable {
  func resolve(_ grant: AccessGrant) throws -> (url: URL, stale: Bool)
  func bookmark(for url: URL) throws -> Data
}

struct SystemBookmarkResolver: BookmarkResolving {
  func resolve(_ grant: AccessGrant) throws -> (url: URL, stale: Bool) {
    if !grant.requiresSecurityScope {
      return (URL(fileURLWithPath: grant.lastKnownPath, isDirectory: true), false)
    }

    var stale = false
    let url = try URL(
      resolvingBookmarkData: grant.bookmarkData,
      options: [.withSecurityScope, .withoutUI],
      relativeTo: nil,
      bookmarkDataIsStale: &stale
    )
    return (url, stale)
  }

  func bookmark(for url: URL) throws -> Data {
    try url.bookmarkData(
      options: [.withSecurityScope],
      includingResourceValuesForKeys: [.nameKey, .volumeNameKey],
      relativeTo: nil
    )
  }
}

actor SecurityScopeBroker {
  private struct Lease {
    let url: URL
    var count: Int
    let didStartAccess: Bool
  }

  private var leases: [UUID: Lease] = [:]
  private let resolver: any BookmarkResolving

  init(resolver: any BookmarkResolving = SystemBookmarkResolver()) {
    self.resolver = resolver
  }

  func acquire(_ grant: AccessGrant) throws -> ResolvedAccess {
    if var lease = leases[grant.id] {
      lease.count += 1
      leases[grant.id] = lease
      return ResolvedAccess(grantID: grant.id, url: lease.url, refreshedBookmarkData: nil)
    }

    let resolution = try resolver.resolve(grant)
    let didStartAccess = grant.requiresSecurityScope
      ? resolution.url.startAccessingSecurityScopedResource()
      : false

    if grant.requiresSecurityScope && !didStartAccess {
      throw CocoaError(.fileReadNoPermission, userInfo: [NSURLErrorKey: resolution.url])
    }

    do {
      let refreshed = resolution.stale ? try resolver.bookmark(for: resolution.url) : nil
      leases[grant.id] = Lease(url: resolution.url, count: 1, didStartAccess: didStartAccess)
      return ResolvedAccess(grantID: grant.id, url: resolution.url, refreshedBookmarkData: refreshed)
    } catch {
      if didStartAccess { resolution.url.stopAccessingSecurityScopedResource() }
      throw error
    }
  }

  func release(grantID: UUID) {
    guard var lease = leases[grantID] else { return }
    lease.count -= 1
    if lease.count > 0 {
      leases[grantID] = lease
    } else {
      if lease.didStartAccess { lease.url.stopAccessingSecurityScopedResource() }
      leases.removeValue(forKey: grantID)
    }
  }

  func activeReferenceCount(for grantID: UUID) -> Int {
    leases[grantID]?.count ?? 0
  }
}
