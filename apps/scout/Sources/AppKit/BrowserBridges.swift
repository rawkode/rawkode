import AppKit
import SwiftUI

struct MillerColumnsView: NSViewRepresentable {
  @Bindable var session: BrowserSession

  func makeCoordinator() -> Coordinator { Coordinator(session: session) }

  func makeNSView(context: Context) -> NSBrowser {
    let browser = NSBrowser()
    browser.delegate = context.coordinator
    browser.allowsMultipleSelection = true
    browser.allowsEmptySelection = true
    browser.minColumnWidth = 220
    browser.maxVisibleColumns = 12
    browser.hasHorizontalScroller = true
    browser.takesTitleFromPreviousColumn = false
    browser.setAccessibilityLabel(String(localized: "File columns"))
    browser.loadColumnZero()
    return browser
  }

  func updateNSView(_ browser: NSBrowser, context: Context) {
    context.coordinator.session = session
    browser.reloadColumn(0)
    for column in 1..<session.columns.count { browser.reloadColumn(column) }
  }

  final class Coordinator: NSObject, NSBrowserDelegate {
    var session: BrowserSession
    init(session: BrowserSession) { self.session = session }

    func browser(_ browser: NSBrowser, numberOfRowsInColumn column: Int) -> Int {
      guard session.columns.indices.contains(column) else { return 0 }
      return session.columns[column].items.count
    }

    func browser(_ browser: NSBrowser, willDisplayCell cell: Any, atRow row: Int, column: Int) {
      guard let cell = cell as? NSBrowserCell,
            session.columns.indices.contains(column),
            session.columns[column].items.indices.contains(row)
      else { return }
      let item = session.columns[column].items[row]
      cell.title = item.name
      cell.image = NSImage(systemSymbolName: item.systemImage, accessibilityDescription: item.kindDescription)
      cell.isLeaf = !item.isTraversableDirectory
      cell.isEnabled = item.isReadable
    }

    func browser(_ sender: NSBrowser, titleOfColumn column: Int) -> String? {
      guard session.columns.indices.contains(column) else { return nil }
      return session.columns[column].directoryURL.lastPathComponent
    }

    @MainActor
    func browserSelectionDidChange(_ notification: Notification) {
      guard let browser = notification.object as? NSBrowser else { return }
      let column = browser.selectedColumn
      guard session.columns.indices.contains(column) else { return }
      let ids = Set((browser.selectedRowIndexes(inColumn: column) ?? []).compactMap { row in
        session.columns[column].items.indices.contains(row) ? session.columns[column].items[row].id : nil
      })
      let directory = session.columns[column].directoryURL
      Task { await session.select(ids, in: directory) }
    }

    func browser(_ browser: NSBrowser, isColumnValid column: Int) -> Bool {
      session.columns.indices.contains(column)
    }
  }
}

struct FileListView: NSViewRepresentable {
  @Bindable var session: BrowserSession

  func makeCoordinator() -> Coordinator { Coordinator(session: session) }

  func makeNSView(context: Context) -> NSScrollView {
    let table = NSTableView()
    table.delegate = context.coordinator
    table.dataSource = context.coordinator
    table.allowsMultipleSelection = true
    table.usesAlternatingRowBackgroundColors = true
    table.rowSizeStyle = .medium
    table.doubleAction = #selector(Coordinator.openSelection)
    table.target = context.coordinator
    for (identifier, title, width) in [("name", String(localized: "Name"), 360.0), ("date", String(localized: "Date Modified"), 170.0), ("size", String(localized: "Size"), 90.0)] {
      let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(identifier))
      column.title = title
      column.width = width
      table.addTableColumn(column)
    }
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.documentView = table
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.session = session
    (scroll.documentView as? NSTableView)?.reloadData()
  }

  final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    var session: BrowserSession
    init(session: BrowserSession) { self.session = session }
    func numberOfRows(in tableView: NSTableView) -> Int { session.displayedItems.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
      guard session.displayedItems.indices.contains(row), let tableColumn else { return nil }
      let item = session.displayedItems[row]
      let cell = NSTableCellView()
      let text = NSTextField(labelWithString: tableColumn.identifier.rawValue == "name" ? item.name : tableColumn.identifier.rawValue == "date" ? item.formattedModificationDate : item.formattedSize)
      text.lineBreakMode = .byTruncatingMiddle
      text.translatesAutoresizingMaskIntoConstraints = false
      cell.addSubview(text)
      NSLayoutConstraint.activate([text.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6), text.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6), text.centerYAnchor.constraint(equalTo: cell.centerYAnchor)])
      if tableColumn.identifier.rawValue == "name" {
        let image = NSImageView(image: NSImage(systemSymbolName: item.systemImage, accessibilityDescription: item.kindDescription) ?? NSImage())
        image.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(image)
        NSLayoutConstraint.activate([image.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 5), image.centerYAnchor.constraint(equalTo: cell.centerYAnchor), image.widthAnchor.constraint(equalToConstant: 18), image.heightAnchor.constraint(equalToConstant: 18), text.leadingAnchor.constraint(equalTo: image.trailingAnchor, constant: 7)])
      }
      return cell
    }
    @MainActor
    func tableViewSelectionDidChange(_ notification: Notification) {
      guard let table = notification.object as? NSTableView else { return }
      let ids = Set(table.selectedRowIndexes.compactMap { session.displayedItems.indices.contains($0) ? session.displayedItems[$0].id : nil })
      Task { await session.select(ids) }
    }
    @MainActor @objc func openSelection() { Task { await session.openSelection() } }
  }
}

struct FileIconGridView: View {
  @Bindable var session: BrowserSession

  var body: some View {
    ScrollView {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 104, maximum: 132), spacing: 10)], spacing: 14) {
        ForEach(session.displayedItems) { item in
          Button {
            Task { await session.select([item.id]) }
          } label: {
            VStack(spacing: 7) {
              Image(systemName: item.systemImage)
                .font(.system(size: 40, weight: .light))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(item.isDirectory ? Color.accentColor : .secondary)
              Text(item.name)
                .font(.callout)
                .lineLimit(2)
                .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 86)
            .padding(8)
            .background(session.selectedIDs.contains(item.id) ? Color.accentColor.opacity(0.18) : .clear, in: .rect(cornerRadius: 8))
          }
          .buttonStyle(.plain)
          .simultaneousGesture(TapGesture(count: 2).onEnded { Task { await session.activate(item) } })
          .accessibilityLabel(item.name)
          .accessibilityValue(item.kindDescription)
        }
      }
      .padding(14)
    }
  }
}
