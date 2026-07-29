import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class AccessGrantStore {
  private(set) var grants: [AccessGrant] = []
  private(set) var loadError: String?

  private let storageURL: URL
  private let resolver: any BookmarkResolving

  init(
    storageURL: URL? = nil,
    resolver: any BookmarkResolving = SystemBookmarkResolver(),
    seedFixtureWhenRequested: Bool = true
  ) {
    self.resolver = resolver
    self.storageURL = storageURL ?? Self.defaultStorageURL
    load()

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
    try save()
    return grant
  }

  func update(grantID: UUID, bookmarkData: Data, url: URL) throws {
    guard let index = grants.firstIndex(where: { $0.id == grantID }) else { return }
    grants[index].bookmarkData = bookmarkData
    grants[index].lastKnownPath = url.standardizedFileURL.path
    grants[index].displayName = url.lastPathComponent
    try save()
  }

  func remove(_ grant: AccessGrant) throws {
    grants.removeAll { $0.id == grant.id }
    normalizeOrdering()
    try save()
  }

  func move(from source: IndexSet, to destination: Int) throws {
    var ordered = orderedGrants
    ordered.move(fromOffsets: source, toOffset: destination)
    grants = ordered
    normalizeOrdering()
    try save()
  }

  private func normalizeOrdering() {
    for index in grants.indices { grants[index].sortOrder = index }
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

  private func save() throws {
    let directory = storageURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(grants)
    try data.write(to: storageURL, options: .atomic)
  }

  private static var defaultStorageURL: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    return base.appending(path: "Scout", directoryHint: .isDirectory)
      .appending(path: "AccessGrants.json", directoryHint: .notDirectory)
  }
}
