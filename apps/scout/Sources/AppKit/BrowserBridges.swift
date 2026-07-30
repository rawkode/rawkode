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
    table.registerForDraggedTypes([.fileURL])
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

    func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> (any NSPasteboardWriting)? {
      guard session.displayedItems.indices.contains(row) else { return nil }
      return session.displayedItems[row].url as NSURL
    }

    func tableView(
      _ tableView: NSTableView,
      validateDrop info: any NSDraggingInfo,
      proposedRow row: Int,
      proposedDropOperation dropOperation: NSTableView.DropOperation
    ) -> NSDragOperation {
      .copy
    }

    func tableView(
      _ tableView: NSTableView,
      acceptDrop info: any NSDraggingInfo,
      row: Int,
      dropOperation: NSTableView.DropOperation
    ) -> Bool {
      let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL] ?? []
      guard !urls.isEmpty else { return false }
      let move = info.draggingSourceOperationMask.contains(.move)
      Task { await session.transfer(urls, move: move) }
      return true
    }
  }
}

struct FileIconGridView: NSViewRepresentable {
  @Bindable var session: BrowserSession

  func makeCoordinator() -> Coordinator { Coordinator(session: session) }

  func makeNSView(context: Context) -> NSScrollView {
    let layout = NSCollectionViewFlowLayout()
    layout.itemSize = NSSize(width: 116, height: 104)
    layout.sectionInset = NSEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
    layout.minimumInteritemSpacing = 8
    layout.minimumLineSpacing = 10

    let collection = ScoutCollectionView()
    collection.collectionViewLayout = layout
    collection.delegate = context.coordinator
    collection.dataSource = context.coordinator
    collection.isSelectable = true
    collection.allowsMultipleSelection = true
    collection.backgroundColors = [.controlBackgroundColor]
    collection.register(ScoutIconItem.self, forItemWithIdentifier: ScoutIconItem.identifier)
    collection.registerForDraggedTypes([.fileURL])
    collection.doubleClickHandler = { [weak coordinator = context.coordinator] in
      coordinator?.openSelection()
    }
    collection.setAccessibilityLabel(String(localized: "File icons"))

    let scroll = NSScrollView()
    scroll.documentView = collection
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.session = session
    (scroll.documentView as? NSCollectionView)?.reloadData()
  }

  final class Coordinator: NSObject, NSCollectionViewDataSource, NSCollectionViewDelegate {
    var session: BrowserSession
    init(session: BrowserSession) { self.session = session }

    func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int {
      session.displayedItems.count
    }

    func collectionView(_ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
      let item = collectionView.makeItem(withIdentifier: ScoutIconItem.identifier, for: indexPath)
      if let iconItem = item as? ScoutIconItem, session.displayedItems.indices.contains(indexPath.item) {
        iconItem.configure(with: session.displayedItems[indexPath.item])
      }
      return item
    }

    @MainActor
    func collectionView(_ collectionView: NSCollectionView, didSelectItemsAt indexPaths: Set<IndexPath>) {
      let ids = Set(indexPaths.compactMap { session.displayedItems.indices.contains($0.item) ? session.displayedItems[$0.item].id : nil })
      Task { await session.select(ids) }
    }

    @MainActor @objc func openSelection() { Task { await session.openSelection() } }

    func collectionView(_ collectionView: NSCollectionView, pasteboardWriterForItemAt indexPath: IndexPath) -> (any NSPasteboardWriting)? {
      guard session.displayedItems.indices.contains(indexPath.item) else { return nil }
      return session.displayedItems[indexPath.item].url as NSURL
    }

    func collectionView(
      _ collectionView: NSCollectionView,
      validateDrop draggingInfo: any NSDraggingInfo,
      proposedIndexPath proposedDropIndexPath: AutoreleasingUnsafeMutablePointer<NSIndexPath>,
      dropOperation proposedDropOperation: UnsafeMutablePointer<NSCollectionView.DropOperation>
    ) -> NSDragOperation {
      proposedDropOperation.pointee = .on
      return .copy
    }

    func collectionView(
      _ collectionView: NSCollectionView,
      acceptDrop draggingInfo: any NSDraggingInfo,
      indexPath: IndexPath,
      dropOperation: NSCollectionView.DropOperation
    ) -> Bool {
      let urls = draggingInfo.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL] ?? []
      guard !urls.isEmpty else { return false }
      let move = draggingInfo.draggingSourceOperationMask.contains(.move)
      Task { await session.transfer(urls, move: move) }
      return true
    }
  }
}

private final class ScoutIconItem: NSCollectionViewItem {
  static let identifier = NSUserInterfaceItemIdentifier("ScoutIconItem")
  private let iconView = NSImageView()
  private let nameField = NSTextField(labelWithString: "")

  override func loadView() {
    view = NSView()
    view.wantsLayer = true
    iconView.imageScaling = .scaleProportionallyUpOrDown
    iconView.translatesAutoresizingMaskIntoConstraints = false
    nameField.alignment = .center
    nameField.maximumNumberOfLines = 2
    nameField.lineBreakMode = .byTruncatingMiddle
    nameField.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(iconView)
    view.addSubview(nameField)
    NSLayoutConstraint.activate([
      iconView.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
      iconView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      iconView.widthAnchor.constraint(equalToConstant: 48),
      iconView.heightAnchor.constraint(equalToConstant: 48),
      nameField.topAnchor.constraint(equalTo: iconView.bottomAnchor, constant: 6),
      nameField.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 4),
      nameField.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -4),
    ])
  }

  override var isSelected: Bool {
    didSet {
      view.layer?.backgroundColor = isSelected ? NSColor.controlAccentColor.withAlphaComponent(0.18).cgColor : NSColor.clear.cgColor
      view.layer?.cornerRadius = 8
    }
  }

  func configure(with item: FileItem) {
    iconView.image = NSWorkspace.shared.icon(forFile: item.url.path)
    nameField.stringValue = item.name
    view.setAccessibilityLabel(item.name)
    view.setAccessibilityValue(item.kindDescription)
  }
}

private final class ScoutCollectionView: NSCollectionView {
  var doubleClickHandler: (() -> Void)?

  override func mouseDown(with event: NSEvent) {
    super.mouseDown(with: event)
    if event.clickCount == 2 { doubleClickHandler?() }
  }
}
