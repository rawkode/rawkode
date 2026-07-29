import Foundation

@MainActor
protocol FileSearchClient: AnyObject {
  func startSearch(text: String, roots: [URL], onUpdate: @escaping @MainActor ([FileItem]) -> Void)
  func stopSearch()
}

@MainActor
final class SpotlightSearchClient: NSObject, FileSearchClient {
  private var query: NSMetadataQuery?
  private var observations: [NSObjectProtocol] = []
  private var roots: [URL] = []
  private var onUpdate: (@MainActor ([FileItem]) -> Void)?

  func startSearch(
    text: String,
    roots: [URL],
    onUpdate: @escaping @MainActor ([FileItem]) -> Void
  ) {
    stopSearch()
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      onUpdate([])
      return
    }

    self.roots = roots.map(\.standardizedFileURL)
    self.onUpdate = onUpdate

    let query = NSMetadataQuery()
    query.searchScopes = roots
    query.predicate = NSPredicate(
      format: "%K CONTAINS[cd] %@",
      NSMetadataItemFSNameKey,
      text
    )
    query.sortDescriptors = [NSSortDescriptor(key: NSMetadataItemFSNameKey, ascending: true, selector: #selector(NSString.localizedStandardCompare(_:)))]
    self.query = query

    let center = NotificationCenter.default
    observations = [
      center.addObserver(forName: .NSMetadataQueryDidFinishGathering, object: query, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.publishResults() }
      },
      center.addObserver(forName: .NSMetadataQueryDidUpdate, object: query, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.publishResults() }
      },
    ]
    query.start()
  }

  func stopSearch() {
    query?.stop()
    for observation in observations { NotificationCenter.default.removeObserver(observation) }
    observations = []
    query = nil
    roots = []
    onUpdate = nil
  }

  private func publishResults() {
    guard let query else { return }
    query.disableUpdates()
    defer { query.enableUpdates() }

    let keys: Set<URLResourceKey> = [
      .nameKey, .contentTypeKey, .fileSizeKey, .creationDateKey,
      .contentModificationDateKey, .isDirectoryKey, .isPackageKey,
      .isSymbolicLinkKey, .isHiddenKey, .isReadableKey, .isWritableKey, .tagNamesKey,
    ]

    let items = query.results.compactMap { value -> FileItem? in
      guard let item = value as? NSMetadataItem,
            let path = item.value(forAttribute: NSMetadataItemPathKey) as? String
      else { return nil }
      let url = URL(fileURLWithPath: path)
      guard roots.contains(where: { PathSafety.contains(url, within: $0) }),
            let values = try? url.resourceValues(forKeys: keys)
      else { return nil }
      return FileItem.from(url: url, values: values)
    }
    onUpdate?(items)
  }
}
