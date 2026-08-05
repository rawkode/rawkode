import Foundation

/// A day-scoped view of captured links. Capture events are immutable facts;
/// this projection deliberately keeps the canonical bookmark Page as the navigation target.
public struct BookmarkSavedLink: Identifiable, Hashable, Sendable {
  public let urlKey: BookmarkURLKey
  public let page: PageSnapshot
  public let saveCount: Int
  public let newestCaptureAt: Date

  public var id: String { urlKey.digest }

  public init(urlKey: BookmarkURLKey, page: PageSnapshot, saveCount: Int, newestCaptureAt: Date) {
    self.urlKey = urlKey
    self.page = page
    self.saveCount = saveCount
    self.newestCaptureAt = newestCaptureAt
  }

  public var sourceURL: String { urlKey.canonicalURL }

  public var host: String {
    URLComponents(string: sourceURL)?.host ?? sourceURL
  }
}

/// A deliberately small, content-free summary suitable for the main bookmark UI.
/// Detailed provenance remains available to diagnostics without exposing captured URLs or
/// local-only metadata such as notes, source, platform, or vault.
public struct BookmarkHistoryDiagnosticSummary: Hashable, Sendable {
  public let issueCount: Int
  public let affectedPageCount: Int

  public init(issueCount: Int, affectedPageCount: Int) {
    self.issueCount = issueCount
    self.affectedPageCount = affectedPageCount
  }

  public var notice: String {
    let issueLabel = issueCount == 1 ? "issue" : "issues"
    let pageLabel = affectedPageCount == 1 ? "page" : "pages"
    return "Some saved-link history is unavailable. \(issueCount) \(issueLabel) affected \(affectedPageCount) \(pageLabel). Saved pages are unchanged."
  }
}

public struct SuppressedBookmarkTrashPresentation: Hashable, Sendable {
  public let pageID: PageID
  public let permanentDeletionRequested: Bool

  public init(pageID: PageID, permanentDeletionRequested: Bool) {
    self.pageID = pageID
    self.permanentDeletionRequested = permanentDeletionRequested
  }

  public var status: String {
    permanentDeletionRequested ? "Permanent deletion is waiting for sync" : "Deleted saved link"
  }

  public var explanation: String {
    if permanentDeletionRequested {
      return "This content stays in Trash until deletion is safe to finish. It cannot be restored or opened."
    }
    return "This saved-link identity was deleted. Its content can be reviewed here, but it cannot be restored or opened."
  }
}

/// The single content-access decision used by navigation and editor surfaces.
/// Suppressed bookmark details are intentionally limited to calm, URL-free UI copy.
public enum PageContentAccess: Hashable, Sendable {
  case allowed
  case suppressedBookmark(SuppressedBookmarkTrashPresentation)
}

public enum PagePermanentDeletionCopy {
  public static func message(for page: PageSnapshot) -> String {
    if page.hasSupertag(BuiltInSupertags.bookmark) {
      return "This saved link and its local content will be removed after deletion syncs. A non-reversible identity digest remains so the link cannot be saved again. This cannot be undone."
    }
    return "\(page.displayTitle) and its data will be permanently deleted. This cannot be undone."
  }
}

public enum BookmarkSavedLinksProjection {
  /// `events` may be the whole Page-synced event union. Suppressed identities are expected
  /// to have been removed by the repository before reaching this projection.
  public static func rows(
    dayKey: DayKey,
    timeZoneIdentifier: String,
    events: [BookmarkSyncedCaptureEvent],
    resolvedPages: [PageSnapshot]
  ) -> [BookmarkSavedLink] {
    rowsWithCaptures(
      events.filter {
        $0.dayKey == dayKey && $0.timeZoneIdentifier == timeZoneIdentifier
      },
      resolvedPages: resolvedPages,
      includesPagesWithoutCaptures: false
    )
  }

  /// Produces one deterministic library row per resolved identity across all synced captures.
  public static func rows(
    events: [BookmarkSyncedCaptureEvent],
    resolvedPages: [PageSnapshot]
  ) -> [BookmarkSavedLink] {
    rowsWithCaptures(events, resolvedPages: resolvedPages, includesPagesWithoutCaptures: true)
  }

  private static func rowsWithCaptures(
    _ events: [BookmarkSyncedCaptureEvent],
    resolvedPages: [PageSnapshot],
    includesPagesWithoutCaptures: Bool
  ) -> [BookmarkSavedLink] {
    let pageByDigest = resolvedPages.reduce(into: [String: PageSnapshot]()) { result, page in
      guard page.deletedAt == nil, let key = urlKey(for: page) else { return }
      // The repository supplies one winning Page per identity. Keeping the first
      // also makes this pure projection safe for defensive or test inputs.
      if result[key.digest] == nil { result[key.digest] = page }
    }
    let capturesByDigest = Dictionary(grouping: events, by: { $0.urlKey.digest })
    return pageByDigest.compactMap { digest, page in
      let captures = capturesByDigest[digest] ?? []
      guard includesPagesWithoutCaptures || !captures.isEmpty,
        let key = captures.first?.urlKey ?? urlKey(for: page)
      else { return nil }
      let newest = captures.max(by: { lhs, rhs in
        if lhs.capturedAt != rhs.capturedAt { return lhs.capturedAt < rhs.capturedAt }
        return lhs.captureID.uuidString < rhs.captureID.uuidString
      })
      return BookmarkSavedLink(
        urlKey: key,
        page: page,
        saveCount: captures.count,
        newestCaptureAt: newest?.capturedAt ?? page.modifiedAt
      )
    }
    .sorted {
      if $0.newestCaptureAt != $1.newestCaptureAt { return $0.newestCaptureAt > $1.newestCaptureAt }
      return $0.urlKey.digest < $1.urlKey.digest
    }
  }

  public static func diagnosticSummary(
    issues: [BookmarkCaptureHistoryIssue]
  ) -> BookmarkHistoryDiagnosticSummary? {
    guard !issues.isEmpty else { return nil }
    return .init(
      issueCount: issues.count,
      affectedPageCount: Set(issues.flatMap(\.pageIDs)).count
    )
  }

  public static func urlKey(for page: PageSnapshot) -> BookmarkURLKey? {
    let property = SupertagPropertyKey(
      supertagID: BuiltInSupertags.bookmark,
      fieldID: BuiltInSupertags.bookmarkSourceURLField
    )
    guard let values = page.objectMetadata.properties[property] else { return nil }
    for value in values {
      if case .url(let sourceURL) = value, let key = BookmarkURLKey(submittedURL: sourceURL) {
        return key
      }
    }
    return nil
  }
}
