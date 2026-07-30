import Foundation

enum BrowserViewMode: String, Codable, CaseIterable, Identifiable, Sendable {
  case icons
  case list
  case columns

  var id: String { rawValue }

  var title: String {
    switch self {
    case .icons: String(localized: "Icons")
    case .list: String(localized: "List")
    case .columns: String(localized: "Columns")
    }
  }

  var systemImage: String {
    switch self {
    case .icons: "square.grid.2x2"
    case .list: "list.bullet"
    case .columns: "rectangle.split.3x1"
    }
  }
}

struct BrowserColumn: Identifiable, Equatable, Sendable {
  var id: URL { directoryURL }
  let directoryURL: URL
  var items: [FileItem]
  var selectedIDs: Set<FileItem.ID> = []
  var isLoading = false
}

struct BrowserWindowState: Codable, Equatable, Sendable {
  var grantID: UUID?
  var relativePathComponents: [String]
  var viewMode: BrowserViewMode
  var inspectorPresented: Bool
  var sidebarPresented: Bool
  var searchScopeAllRoots: Bool

  static let initial = BrowserWindowState(
    grantID: nil,
    relativePathComponents: [],
    viewMode: .columns,
    inspectorPresented: false,
    sidebarPresented: true,
    searchScopeAllRoots: false
  )
}

struct OperationNotice: Identifiable, Equatable, Sendable {
  let id: UUID
  let title: String
  let detail: String
  let isError: Bool
  let canUndo: Bool
}

struct PendingConflict: Identifiable, Sendable {
  let id = UUID()
  let request: FileOperationRequest
  let conflictingURLs: [URL]
}

struct CommandDescriptor: Identifiable, Hashable, Sendable {
  let id: String
  let title: String
  let subtitle: String?
  let systemImage: String
  let keyEquivalent: String?
  let keywords: [String]

  func matches(_ query: String) -> Bool {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return true }
    let haystack = ([title, subtitle ?? ""] + keywords).joined(separator: " ")
    return haystack.localizedCaseInsensitiveContains(query)
  }
}
