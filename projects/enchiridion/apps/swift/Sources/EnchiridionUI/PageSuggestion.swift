// PageSuggestion.swift
// EnchiridionUI
//
// A minimal candidate for the "[[" reference picker (task point 2). Not a
// port of the old app's `PageSuggestion` (EnchiridionCore/
// LibraryRepository.swift) — that type carries `PageKind`-derived display
// subtitle logic tied to a repository this task doesn't have (no
// `EnchiridionStore`/GRDB projection reader is wired up yet). This is the
// small, real-search-agnostic shape `PageEditorView` needs from whatever
// search source a caller supplies via `suggestPages`.
import EnchiridionCore

public struct PageSuggestion: Hashable, Sendable, Identifiable {
  public var id: PageID { pageID }
  public var pageID: PageID
  public var title: String

  public init(pageID: PageID, title: String) {
    self.pageID = pageID
    self.title = title
  }
}
