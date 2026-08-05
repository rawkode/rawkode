import EnchiridionCore
import SwiftUI

struct BookmarkPageRow: View {
  let page: PageSnapshot
  let saveCount: Int?
  let openPage: () -> Void

  @Environment(\.openURL) private var openURL

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: "bookmark")
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
      Button(action: openPage) {
        VStack(alignment: .leading, spacing: 3) {
          Text(page.displayTitle)
            .foregroundStyle(.primary)
            .lineLimit(2)
          Text(host)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          if let saveCount, saveCount > 1 {
            Text("Saved \(saveCount) times")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(openPageAccessibilityLabel)
      .accessibilityHint("Open Page")

      if let url = sourceURL {
        Button { openURL(url) } label: {
          Image(systemName: "arrow.up.right.square")
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Open Link: \(page.displayTitle), \(host)\(saveCount.map { ", saved \($0) times" } ?? "")")
      }
    }
    .accessibilityElement(children: .contain)
  }

  private var sourceURL: URL? {
    guard let key = BookmarkSavedLinksProjection.urlKey(for: page) else { return nil }
    return URL(string: key.canonicalURL)
  }

  private var host: String {
    sourceURL?.host ?? "Link"
  }

  private var openPageAccessibilityLabel: String {
    "Open Page: \(page.displayTitle), \(host)\(saveCount.map { ", saved \($0) times" } ?? "")"
  }
}

struct BookmarkLibraryList: View {
  let links: [BookmarkSavedLink]
  let aliasCount: Int
  let historyDiagnostic: BookmarkHistoryDiagnosticSummary?
  let openPage: (PageID) -> Void

  var body: some View {
    List {
      BookmarkLibraryRows(
        links: links,
        aliasCount: aliasCount,
        historyDiagnostic: historyDiagnostic,
        openPage: openPage
      )
    }
  }
}

struct BookmarkLibraryRows: View {
  let links: [BookmarkSavedLink]
  let aliasCount: Int
  let historyDiagnostic: BookmarkHistoryDiagnosticSummary?
  let openPage: (PageID) -> Void

  var body: some View {
    Group {
      if links.isEmpty {
        ContentUnavailableView(
          "No saved links",
          systemImage: "bookmark",
          description: Text("Save a link from the Share Sheet on iPhone or Mac to keep it here."))
      } else {
        ForEach(links) { link in
          BookmarkPageRow(page: link.page, saveCount: link.saveCount) {
            openPage(link.page.id)
          }
        }
      }
      if aliasCount > 0 {
        Text("\(aliasCount) duplicate saved link\(aliasCount == 1 ? "" : "s") can be reviewed without losing either page.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .accessibilityLabel("\(aliasCount) duplicate saved link suggestions available")
      }
      if let historyDiagnostic {
        Label {
          Text(historyDiagnostic.notice)
        } icon: {
          Image(systemName: "exclamationmark.triangle")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Saved-link history notice. \(historyDiagnostic.notice)")
      }
    }
  }
}

/// A non-interactive Trash row. Omitting page and URL buttons is deliberate: a suppressed
/// bookmark identity is reviewable before purge, but it cannot be restored or opened.
struct SuppressedBookmarkTrashRow: View {
  let page: PageSnapshot
  let presentation: SuppressedBookmarkTrashPresentation

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(page.displayTitle)
        .font(.headline)
        .lineLimit(2)
      if !page.preview.isEmpty {
        Text(page.preview)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
      Label(presentation.status, systemImage: "lock")
        .font(.caption.weight(.medium))
        .foregroundStyle(EnchiridionRosePine.text)
      Text(presentation.explanation)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(page.displayTitle). \(presentation.status). \(presentation.explanation)"
    )
  }
}
