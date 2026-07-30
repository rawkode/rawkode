import EnchiridionCore
import LinkPresentation
import SwiftUI
@preconcurrency import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

extension Notification.Name {
  static let enchiridionEditorFocusDidChange = Notification.Name(
    "dev.rawkode.enchiridion.editorFocusDidChange"
  )
}

@MainActor
final class EditorFlushController {
  typealias Flusher = @MainActor () async -> Bool

  private var flushers: [UUID: Flusher] = [:]

  func register(_ id: UUID, flusher: @escaping Flusher) {
    flushers[id] = flusher
  }

  func unregister(_ id: UUID) {
    flushers[id] = nil
  }

  @discardableResult
  func flush() async -> Bool {
    for flusher in Array(flushers.values) {
      guard await flusher() else { return false }
    }
    return true
  }
}

@MainActor
final class EditorFindController {
  typealias Finder = @MainActor () -> Void

  private var finders: [UUID: Finder] = [:]

  func register(_ id: UUID, finder: @escaping Finder) {
    finders[id] = finder
  }

  func unregister(_ id: UUID) {
    finders[id] = nil
  }

  func openFind() {
    Array(finders.values).first?()
  }
}

struct PageDestinationView: View {
  let store: LibraryStore
  let pageID: PageID
  private let onOpenPage: ((PageID) -> Void)?
  @State private var flushController: EditorFlushController
  @State private var findController: EditorFindController

  init(
    store: LibraryStore,
    pageID: PageID,
    flushController: EditorFlushController? = nil,
    onOpenPage: ((PageID) -> Void)? = nil
  ) {
    self.store = store
    self.pageID = pageID
    self.onOpenPage = onOpenPage
    _flushController = State(initialValue: flushController ?? EditorFlushController())
    _findController = State(initialValue: EditorFindController())
  }

  var body: some View {
    switch PageDestinationClassifier.classify(store.page(id: pageID)) {
    case .unavailable:
      ContentUnavailableView(
        "Page unavailable",
        systemImage: "doc.questionmark",
        description: Text("Choose another page from the library.")
      )
    case .task, .entity:
      if let page = store.page(id: pageID) {
        EntityDetailView(
          store: store,
          page: page,
          flushController: flushController,
          findController: findController,
          onOpenPage: onOpenPage
        )
      }
    case .note:
      PageEditorView(
        store: store,
        pageID: pageID,
        flushController: flushController,
        findController: findController,
        onOpenPage: onOpenPage
      )
    }
  }
}

private enum EntityDetailSection: String, CaseIterable, Identifiable {
  case properties = "Properties"
  case relationships = "Relationships"
  case notes = "Notes"

  var id: Self { self }
}

struct EntityDetailView: View {
  let store: LibraryStore
  let page: PageSnapshot
  let flushController: EditorFlushController
  let findController: EditorFindController
  let onOpenPage: ((PageID) -> Void)?

  @State private var selectedSection = EntityDetailSection.properties
  @State private var pagePendingPermanentDeletion: PageSnapshot?

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: selectedSection == .properties ? 14 : 0) {
        if selectedSection == .properties {
          VStack(alignment: .leading, spacing: 6) {
            Text(page.displayTitle)
              .font(.largeTitle.weight(.semibold))
              .frame(maxWidth: .infinity, alignment: .leading)
              .fixedSize(horizontal: false, vertical: true)

            Label(typeNames, systemImage: primaryTypeSymbol)
              .font(.subheadline.weight(.medium))
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        Picker("Page section", selection: $selectedSection) {
          ForEach(EntityDetailSection.allCases) { section in
            Text(section.rawValue).tag(section)
          }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 360, minHeight: 44, alignment: .leading)
        .accessibilityIdentifier("page-detail-section")
      }
      .padding(.horizontal, 20)
      .padding(.top, selectedSection == .properties ? 20 : 12)
      .padding(.bottom, 14)

      Divider()

      switch selectedSection {
      case .properties:
        PagePropertiesView(store: store, pageID: page.id)
      case .relationships:
        GraphRelationshipsView(
          store: store,
          pageID: page.id,
          onOpenPage: onOpenPage
        )
      case .notes:
        PageEditorView(
          store: store,
          pageID: page.id,
          flushController: flushController,
          findController: findController,
          onOpenPage: onOpenPage,
          showsPropertiesAction: false,
          showsPageActions: false
        )
      }
    }
    .navigationTitle("")
    .toolbar {
      ToolbarItem(placement: .secondaryAction) {
        Menu {
          if selectedSection == .notes {
            Button {
              findController.openFind()
            } label: {
              Label("Find in Page", systemImage: "magnifyingglass")
            }
          }

          if page.deletedAt == nil {
            Button {
              store.togglePinned(pageID: page.id)
            } label: {
              Label(page.isPinned ? "Unpin" : "Pin", systemImage: page.isPinned ? "pin.slash" : "pin")
            }
          }

          PageLifecycleMenuActions(
            store: store,
            page: page,
            showsPinAction: false,
            requestPermanentDeletion: { pagePendingPermanentDeletion = $0 }
          )
        } label: {
          Label("Page actions", systemImage: "ellipsis.circle")
        }
      }
    }
    .confirmsPermanentPageDeletion(page: $pagePendingPermanentDeletion) {
      store.purge(pageID: $0)
    }
  }

  private var typeDefinitions: [SupertagDefinition] {
    let definitions = page.objectMetadata.supertagIDs.compactMap { tagID in
      store.supertags.first(where: { $0.id == tagID })
    }
    guard page.hasSupertag(BuiltInSupertags.task),
      let task = definitions.first(where: { $0.id == BuiltInSupertags.task })
    else { return definitions }
    return [task] + definitions.filter { $0.id != BuiltInSupertags.task }
  }

  private var typeNames: String {
    let resolvedNames = typeDefinitions.map(\.name)
    if !resolvedNames.isEmpty { return resolvedNames.joined(separator: " · ") }
    let storedNames = page.objectMetadata.supertagIDs.map(\.rawValue)
    return storedNames.isEmpty ? "Page" : storedNames.joined(separator: " · ")
  }

  private var primaryTypeSymbol: String {
    typeDefinitions.first?.symbol
      ?? (page.hasSupertag(BuiltInSupertags.task) ? "checkmark.circle" : "doc.text")
  }
}

private struct PagePropertiesView: View {
  let store: LibraryStore
  let pageID: PageID

  var body: some View {
    if let page = store.page(id: pageID), page.deletedAt == nil {
      if let taskData = page.taskData {
        TaskPropertiesView(store: store, page: page, initialData: taskData)
      } else {
        SupertagPropertiesView(
          store: store,
          pageID: pageID,
          navigationTitle: ""
        )
      }
    } else {
      ContentUnavailableView(
        "Page unavailable",
        systemImage: "doc.questionmark",
        description: Text("Choose another page from the library.")
      )
    }
  }
}

struct PageEditorView: View {
  let store: LibraryStore
  let pageID: PageID
  private let onOpenPage: ((PageID) -> Void)?
  private let showsPropertiesAction: Bool
  private let showsPageActions: Bool
  @State private var flushController: EditorFlushController
  @State private var findController: EditorFindController
  @State private var showsProperties = false
  @State private var propertiesSheetPage: PageID?
  @State private var pagePendingPermanentDeletion: PageSnapshot?
  #if !os(macOS)
  @State private var pushedPageID: PageID?
  #endif

  init(
    store: LibraryStore,
    pageID: PageID,
    flushController: EditorFlushController? = nil,
    findController: EditorFindController? = nil,
    onOpenPage: ((PageID) -> Void)? = nil,
    showsPropertiesAction: Bool = true,
    showsPageActions: Bool = true
  ) {
    self.store = store
    self.pageID = pageID
    self.onOpenPage = onOpenPage
    self.showsPropertiesAction = showsPropertiesAction
    self.showsPageActions = showsPageActions
    _flushController = State(initialValue: flushController ?? EditorFlushController())
    _findController = State(initialValue: findController ?? EditorFindController())
  }

  var body: some View {
    Group {
      if let page = store.page(id: pageID) {
        if page.isOtherPerson, page.deletedAt == nil {
          OtherPersonPromotionGate(store: store, page: page)
            .navigationTitle("")
        } else {
          editor(page)
        }
      } else {
        ContentUnavailableView(
          "Page unavailable",
          systemImage: "doc.questionmark",
          description: Text("Choose another page from the library.")
        )
      }
    }
    #if !os(macOS)
    .navigationDestination(item: $pushedPageID) { pageID in
      PageDestinationView(
        store: store,
        pageID: pageID,
        flushController: flushController
      )
    }
    #endif
    .confirmsPermanentPageDeletion(page: $pagePendingPermanentDeletion) {
      store.purge(pageID: $0)
    }
  }

  private func editor(_ page: PageSnapshot) -> some View {
    RichPageEditor(
        page: page,
        calendarContext: store.calendarPageContext(for: pageID),
        store: store,
        flushController: flushController,
        findController: findController,
        openPage: openPage
      )
        .navigationTitle("")
        .toolbar {
          if showsPageActions {
            ToolbarItemGroup {
            if page.deletedAt == nil {
              Menu {
                ForEach(store.supertags.filter { !page.objectMetadata.supertagIDs.contains($0.id) }) { tag in
                  Button { store.addSupertag(tag.id, to: page.id) } label: {
                    Label(tag.name, systemImage: tag.symbol)
                  }
                }
              } label: {
                Label("Add Supertag", systemImage: "number")
              }

              if showsPropertiesAction {
                Button {
                  Task { @MainActor in
                    guard await flushController.flush() else { return }
                    #if os(macOS)
                    showsProperties.toggle()
                    #else
                    propertiesSheetPage = page.id
                    #endif
                  }
                } label: {
                  Label("Properties", systemImage: "slider.horizontal.3")
                }
              }

              Button {
                store.togglePinned(pageID: page.id)
              } label: {
                Label(page.isPinned ? "Unpin" : "Pin", systemImage: page.isPinned ? "pin.slash" : "pin")
              }
            }

            Menu {
              Button {
                findController.openFind()
              } label: {
                Label("Find in Page", systemImage: "magnifyingglass")
              }

              PageLifecycleMenuActions(
                store: store,
                page: page,
                showsPinAction: false,
                requestPermanentDeletion: { pagePendingPermanentDeletion = $0 }
              )
            } label: {
              Label("Page actions", systemImage: "ellipsis.circle")
            }
            }
          }
        }
        #if os(macOS)
        .inspector(isPresented: $showsProperties) {
          PagePropertiesView(store: store, pageID: page.id)
            .inspectorColumnWidth(min: 280, ideal: 340, max: 480)
        }
        #else
        .sheet(item: $propertiesSheetPage) { pageID in
          NavigationStack {
            PagePropertiesView(store: store, pageID: pageID)
              .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                  Button("Done") { propertiesSheetPage = nil }
                }
              }
          }
        }
        #endif
  }

  private func openPage(_ destination: PageID) {
    if let onOpenPage {
      onOpenPage(destination)
      return
    }
    #if os(macOS)
    store.selectedPageID = destination
    #else
    pushedPageID = destination
    #endif
  }
}

private struct OtherPersonPromotionGate: View {
  let store: LibraryStore
  let page: PageSnapshot
  @State private var isPromoting = false

  var body: some View {
    ContentUnavailableView {
      Label("Other Person", systemImage: "person.crop.circle.badge.questionmark")
    } description: {
      Text("Promote \(page.displayTitle) to edit their page and include them in mentions and normal views.")
    } actions: {
      Button {
        isPromoting = true
        Task { @MainActor in
          await store.promotePerson(page.id)
          isPromoting = false
        }
      } label: {
        if isPromoting {
          ProgressView()
        } else {
          Label("Promote Person", systemImage: "person.badge.plus")
        }
      }
      .buttonStyle(.borderedProminent)
      .disabled(isPromoting)
    }
  }
}

#if os(macOS)
private struct RichPageEditor: NSViewRepresentable {
  let page: PageSnapshot
  let calendarContext: CalendarPageContext?
  let store: LibraryStore
  let flushController: EditorFlushController
  let findController: EditorFindController
  let openPage: (PageID) -> Void

  func makeCoordinator() -> EditorBridge {
    EditorBridge(
      store: store,
      flushController: flushController,
      findController: findController,
      openPage: openPage
    )
  }

  func makeNSView(context: Context) -> WKWebView {
    context.coordinator.makeWebView(page: page, calendarContext: calendarContext)
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.update(page: page, calendarContext: calendarContext)
  }

  static func dismantleNSView(_ webView: WKWebView, coordinator: EditorBridge) {
    coordinator.stopAfterFlushing(webView)
  }
}
#else
private struct RichPageEditor: UIViewRepresentable {
  let page: PageSnapshot
  let calendarContext: CalendarPageContext?
  let store: LibraryStore
  let flushController: EditorFlushController
  let findController: EditorFindController
  let openPage: (PageID) -> Void

  func makeCoordinator() -> EditorBridge {
    EditorBridge(
      store: store,
      flushController: flushController,
      findController: findController,
      openPage: openPage
    )
  }

  func makeUIView(context: Context) -> WKWebView {
    context.coordinator.makeWebView(page: page, calendarContext: calendarContext)
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    context.coordinator.update(page: page, calendarContext: calendarContext)
  }

  static func dismantleUIView(_ webView: WKWebView, coordinator: EditorBridge) {
    coordinator.stopAfterFlushing(webView)
  }
}
#endif

@MainActor
private final class EditorBridge: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
  private let store: LibraryStore
  private let flushController: EditorFlushController
  private let findController: EditorFindController
  private let openPageHandler: (PageID) -> Void
  private let flushRegistrationID = UUID()
  private let findRegistrationID = UUID()
  private weak var webView: WKWebView?
  private var page: PageSnapshot?
  private var calendarContext: CalendarPageContext?
  private var loadedPageID: PageID?
  private var loadedCalendarContext: CalendarPageContext?
  private var isEditorReady = false
  private var loadGeneration = 0

  init(
    store: LibraryStore,
    flushController: EditorFlushController,
    findController: EditorFindController,
    openPage: @escaping (PageID) -> Void
  ) {
    self.store = store
    self.flushController = flushController
    self.findController = findController
    openPageHandler = openPage
  }

  func makeWebView(page: PageSnapshot, calendarContext: CalendarPageContext?) -> WKWebView {
    self.page = page
    self.calendarContext = calendarContext
    let configuration = WKWebViewConfiguration()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.websiteDataStore = .default()
    configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "enchiridion")
    configuration.preferences.isTextInteractionEnabled = true

    let webView = WKWebView(frame: .zero, configuration: configuration)
    self.webView = webView
    flushController.register(flushRegistrationID) { [weak self] in
      guard let self else { return true }
      return await self.flush()
    }
    findController.register(findRegistrationID) { [weak self, weak webView] in
      guard let self, let webView else { return }
      self.openFind(in: webView)
    }
    webView.navigationDelegate = self
    #if os(macOS)
    webView.setValue(false, forKey: "drawsBackground")
    #else
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(keyboardDidHide(_:)),
      name: UIResponder.keyboardDidHideNotification,
      object: nil
    )
    #endif
    loadEditor(in: webView)
    return webView
  }

  func update(page: PageSnapshot, calendarContext: CalendarPageContext?) {
    self.page = page
    self.calendarContext = calendarContext
    guard isEditorReady,
      loadedPageID != page.id || loadedCalendarContext != calendarContext
    else { return }
    load(page: page)
  }

  func stopAfterFlushing(_ webView: WKWebView) {
    Task { @MainActor [self, webView] in
      _ = await flush(webView)
      stop()
    }
  }

  private func stop() {
    flushController.unregister(flushRegistrationID)
    findController.unregister(findRegistrationID)
    #if !os(macOS)
    NotificationCenter.default.removeObserver(
      self,
      name: UIResponder.keyboardDidHideNotification,
      object: nil
    )
    publishEditorFocus(false)
    #endif
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "enchiridion", contentWorld: .page)
    webView?.navigationDelegate = nil
  }

  #if !os(macOS)
  @objc private func keyboardDidHide(_ notification: Notification) {
    webView?.evaluateJavaScript("window.EnchiridionEditor?.dismissKeyboard()")
  }

  private func publishEditorFocus(_ isFocused: Bool) {
    NotificationCenter.default.post(
      name: .enchiridionEditorFocusDidChange,
      object: nil,
      userInfo: ["isFocused": isFocused]
    )
  }
  #endif

  private func flush(_ explicitWebView: WKWebView? = nil) async -> Bool {
    guard isEditorReady, let webView = explicitWebView ?? webView else { return true }
    do {
      _ = try await webView.callAsyncJavaScript(
        "return await window.EnchiridionEditor.flush()",
        arguments: [:],
        in: nil,
        contentWorld: .page
      )
      return true
    } catch {
      print("[Enchiridion editor] flush failed: \(error)")
      return false
    }
  }

  private func openFind(in webView: WKWebView) {
    webView.evaluateJavaScript("window.EnchiridionEditor?.find()")
  }

  private func loadEditor(in webView: WKWebView) {
    let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Editor")
      ?? Bundle.main.url(forResource: "index", withExtension: "html")
    guard let url else { return }
    webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
  }

  private func load(page: PageSnapshot) {
    guard let webView else { return }
    loadGeneration += 1
    loadedPageID = page.id
    loadedCalendarContext = calendarContext
    var request: [String: Any] = [
      "protocolVersion": 2,
      "pageID": page.id.rawValue,
      "loadGeneration": loadGeneration,
      "snapshotBase64": page.document.base64EncodedString(),
    ]
    if let payload = Self.editorContextPayload(calendarContext) {
      request["context"] = payload
    }
    guard let data = try? JSONSerialization.data(withJSONObject: request),
      let json = String(data: data, encoding: .utf8)
    else { return }
    webView.evaluateJavaScript("window.EnchiridionEditor.load(\(json))")
  }

  private static func editorContextPayload(_ context: CalendarPageContext?) -> [String: Any]? {
    guard let context else { return nil }
    switch context.kind {
    case .occurrence:
      guard let event = context.event else { return nil }
      var secondary = [event.calendarTitle]
      if let location = event.location, !location.isEmpty { secondary.append(location) }
      var payload: [String: Any] = [
        "kind": "occurrence",
        "primary": occurrenceLabel(
          start: event.startDate,
          end: event.endDate,
          isAllDay: event.isAllDay
        ),
        "secondary": secondary.joined(separator: " · "),
        "warning": context.sourceUnavailable ? "This occurrence is no longer available from its calendar source." : "",
      ]
      if let seriesPageID = context.seriesPageID {
        payload["action"] = [
          "pageID": seriesPageID.rawValue,
          "label": "Series notes",
        ]
      }
      return payload

    case .series:
      return [
        "kind": "series",
        "primary": "Recurring event",
        "secondary": context.calendarTitle ?? "Shared notes across occurrences",
        "warning": context.sourceUnavailable ? "This series is no longer available from its calendar source." : "",
        "occurrences": context.occurrences.map { occurrence in
          [
            "pageID": occurrence.pageID.rawValue,
            "label": occurrenceLabel(
              start: occurrence.startDate,
              end: occurrence.endDate,
              isAllDay: occurrence.isAllDay
            ),
            "detail": occurrence.preview,
          ]
        },
      ]
    }
  }

  private static func occurrenceLabel(start: Date, end: Date?, isAllDay: Bool) -> String {
    if isAllDay {
      return start.formatted(date: .long, time: .omitted)
    }
    let startLabel = start.formatted(date: .long, time: .shortened)
    guard let end else { return startLabel }
    if Calendar.current.isDate(start, inSameDayAs: end) {
      return "\(startLabel)–\(end.formatted(date: .omitted, time: .shortened))"
    }
    return "\(startLabel)–\(end.formatted(date: .long, time: .shortened))"
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
      replyHandler(nil, "Malformed editor message")
      return
    }
    switch type {
    case "ready":
      isEditorReady = true
      if let page { load(page: page) }
      replyHandler(["ok": true], nil)
    case "commit":
      persistCommit(body, replyHandler: replyHandler)
    case "editorFocusChanged":
      #if !os(macOS)
      let isFocused = body["isFocused"] as? Bool ?? false
      publishEditorFocus(isFocused)
      #endif
      replyHandler(["ok": true], nil)
    case "suggestPages":
      suggestPages(body, replyHandler: replyHandler)
    case "listSupertags":
      replyHandler([
        "ok": true,
        "supertags": store.supertags.map { tag in
          ["id": tag.id.rawValue, "name": tag.name, "symbol": tag.symbol]
        },
      ], nil)
    case "suggestTaggedPages":
      suggestTaggedPages(body, replyHandler: replyHandler)
    case "createPage":
      createPage(body, replyHandler: replyHandler)
    case "createTaggedPage":
      createTaggedPage(body, replyHandler: replyHandler)
    case "openPage":
      openPage(body, replyHandler: replyHandler)
    case "resolveDailyPage":
      resolveDailyPage(body, replyHandler: replyHandler)
    case "fetchLinkMetadata":
      fetchLinkMetadata(body, replyHandler: replyHandler)
    default:
      replyHandler(nil, "Unknown editor message")
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(2))
      let script = """
        JSON.stringify({
          editorType: typeof window.EnchiridionEditor,
          readyState: document.readyState,
          status: document.getElementById('status')?.textContent,
          scripts: Array.from(document.scripts).map(script => ({src: script.src, type: script.type})),
          resources: performance.getEntriesByType('resource').map(entry => entry.name)
        })
        """
      do {
        let diagnostics = try await webView.evaluateJavaScript(script)
        print("[Enchiridion editor] \(String(describing: diagnostics))")
        if let value = diagnostics as? String,
          let data = value.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["editorType"] as? String != "object"
        {
          let message = "Editor failed to initialize. Check the bundled module and WASM runtime."
          _ = try? await webView.evaluateJavaScript(
            "document.getElementById('status').textContent = \(Self.javaScriptString(message))"
          )
        }
      } catch {
        print("[Enchiridion editor] diagnostics failed: \(error)")
      }
    }
  }

  private func persistCommit(
    _ body: [String: Any],
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    guard let rawPageID = body["pageID"] as? String,
      rawPageID == loadedPageID?.rawValue,
      let generation = body["loadGeneration"] as? Int,
      generation == loadGeneration,
      let journalID = body["journalID"] as? String,
      let encoded = body["encodedChangesBase64"] as? String,
      let changes = Data(base64Encoded: encoded),
      let heads = body["advertisedHeads"] as? [String]
    else {
      replyHandler(["ok": false, "message": "The editor page changed before this commit arrived."], nil)
      return
    }
    let commit = EditorCommit(
      pageID: PageID(rawValue: rawPageID),
      loadGeneration: generation,
      journalID: journalID,
      encodedChanges: changes,
      advertisedHeads: AutomergeHeads(heads)
    )
    Task { @MainActor in
      do {
        let receipt = try await store.persistEditorCommit(commit)
        replyHandler([
          "ok": true,
          "journalID": receipt.journalID,
          "heads": receipt.heads.values,
          "duplicate": receipt.duplicate,
        ], nil)
      } catch {
        replyHandler(["ok": false, "message": error.localizedDescription], nil)
      }
    }
  }

  private func suggestPages(
    _ body: [String: Any],
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    let query = body["query"] as? String ?? ""
    Task { @MainActor in
      var suggestions = await store.suggestions(matching: query).map { suggestion in
        [
          "pageID": suggestion.id.rawValue,
          "title": suggestion.title.isEmpty ? "Untitled" : suggestion.title,
          "subtitle": suggestion.displaySubtitle ?? "",
        ]
      }
      let existingPageIDs = Set(suggestions.compactMap { $0["pageID"] })
      suggestions.append(
        contentsOf: Self.dateSuggestions(matching: query).filter { suggestion in
          guard let dateISO = suggestion["dateISO"] else { return false }
          return !existingPageIDs.contains(PageID.daily(DayKey(rawValue: dateISO)).rawValue)
        }
      )
      replyHandler(["ok": true, "suggestions": suggestions], nil)
    }
  }

  private func openPage(
    _ body: [String: Any],
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    guard let rawPageID = body["pageID"] as? String else {
      replyHandler(["ok": false, "message": "A destination page is required"], nil)
      return
    }
    let destination = PageID(rawValue: rawPageID)
    Task { @MainActor in
      if store.page(id: destination) == nil,
        let date = Self.date(fromDailyPageID: destination),
        await store.openDailyPage(for: date) == nil
      {
        replyHandler(["ok": false, "message": "Could not open that daily note"], nil)
        return
      }
      openPageHandler(destination)
      replyHandler(["ok": true], nil)
    }
  }

  private func resolveDailyPage(
    _ body: [String: Any],
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    guard let dateISO = body["dateISO"] as? String,
      let date = Self.date(fromDayKey: dateISO)
    else {
      replyHandler(["ok": false, "message": "That date is not valid"], nil)
      return
    }
    replyHandler([
      "ok": true,
      "pageID": PageID.daily(DayKey(rawValue: dateISO)).rawValue,
      "title": Self.dailyPageTitle(for: date),
    ], nil)
  }

  private static func dateSuggestions(matching query: String, now: Date = Date()) -> [[String: String]] {
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: now)
    var dates = (-1...7).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if let explicitDate = date(fromDayKey: trimmedQuery),
      !dates.contains(where: { calendar.isDate($0, inSameDayAs: explicitDate) })
    {
      dates.insert(explicitDate, at: 0)
    }

    return dates.compactMap { date in
      let relative: String
      if calendar.isDateInToday(date) {
        relative = "Today"
      } else if calendar.isDateInTomorrow(date) {
        relative = "Tomorrow"
      } else if calendar.isDateInYesterday(date) {
        relative = "Yesterday"
      } else {
        relative = date.formatted(.dateTime.weekday(.wide))
      }
      let title = dailyPageTitle(for: date)
      let dateISO = DayKey(date: date, calendar: calendar).rawValue
      let subtitle = "\(relative) · Daily note"
      let haystack = "\(title) \(subtitle) \(dateISO)"
      guard trimmedQuery.isEmpty || haystack.localizedStandardContains(trimmedQuery) else { return nil }
      return ["dateISO": dateISO, "title": title, "subtitle": subtitle]
    }
  }

  private static func date(fromDailyPageID pageID: PageID) -> Date? {
    guard pageID.rawValue.hasPrefix("daily_") else { return nil }
    return date(fromDayKey: String(pageID.rawValue.dropFirst("daily_".count)))
  }

  private static func date(fromDayKey value: String) -> Date? {
    let parts = value.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3,
      let year = Int(parts[0]),
      let month = Int(parts[1]),
      let day = Int(parts[2]),
      (1...12).contains(month),
      (1...31).contains(day)
    else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    let components = DateComponents(
      calendar: calendar,
      timeZone: calendar.timeZone,
      year: year,
      month: month,
      day: day
    )
    guard let date = calendar.date(from: components) else { return nil }
    let verified = calendar.dateComponents([.year, .month, .day], from: date)
    guard verified.year == year, verified.month == month, verified.day == day else { return nil }
    return date
  }

  private static func dailyPageTitle(for date: Date) -> String {
    date.formatted(.dateTime.weekday(.wide).day().month(.wide).year())
  }

  private func createPage(
    _ body: [String: Any],
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    let title = (body["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !title.isEmpty else {
      replyHandler(["ok": false, "message": "A page title is required"], nil)
      return
    }
    Task { @MainActor in
      guard let pageID = await store.createReferencePage(title: title) else {
        replyHandler(["ok": false, "message": "Could not create the reference page"], nil)
        return
      }
      replyHandler(["ok": true, "pageID": pageID.rawValue, "title": title], nil)
    }
  }

  private func suggestTaggedPages(
    _ body: [String: Any],
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    let query = body["query"] as? String ?? ""
    guard let rawTagID = body["supertagID"] as? String else {
      replyHandler(["ok": false, "suggestions": []], nil)
      return
    }
    Task { @MainActor in
      let suggestions = await store.taggedSuggestions(
        matching: query,
        supertagID: SupertagID(rawValue: rawTagID)
      ).map { suggestion in
        [
          "pageID": suggestion.id.rawValue,
          "title": suggestion.title.isEmpty ? "Untitled" : suggestion.title,
          "subtitle": suggestion.displaySubtitle ?? "",
        ]
      }
      replyHandler(["ok": true, "suggestions": suggestions], nil)
    }
  }

  private func createTaggedPage(
    _ body: [String: Any],
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    let title = (body["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !title.isEmpty, let rawTagID = body["supertagID"] as? String else {
      replyHandler(["ok": false, "message": "A title and Supertag are required"], nil)
      return
    }
    Task { @MainActor in
      guard let pageID = await store.createTaggedPage(
        title: title,
        supertagID: SupertagID(rawValue: rawTagID)
      ) else {
        replyHandler(["ok": false, "message": "Could not create the tagged page"], nil)
        return
      }
      replyHandler(["ok": true, "pageID": pageID.rawValue, "title": title], nil)
    }
  }

  private func fetchLinkMetadata(
    _ body: [String: Any],
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    guard let value = body["url"] as? String, let url = URL(string: value) else {
      replyHandler(["ok": false], nil)
      return
    }
    Task { @MainActor in
      do {
        let metadata = try await LPMetadataProvider().startFetchingMetadata(for: url)
        replyHandler([
          "ok": true,
          "title": metadata.title ?? url.host() ?? value,
          "summary": metadata.originalURL?.absoluteString ?? "",
          "imageURL": "",
        ], nil)
      } catch {
        replyHandler(["ok": false, "title": url.host() ?? value], nil)
      }
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    guard navigationAction.targetFrame?.isMainFrame == true,
      let url = navigationAction.request.url,
      ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    else {
      decisionHandler(.allow)
      return
    }
    decisionHandler(.cancel)
    #if os(macOS)
    NSWorkspace.shared.open(url)
    #else
    UIApplication.shared.open(url)
    #endif
  }

  private static func javaScriptString(_ value: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
      let result = String(data: data, encoding: .utf8)
    else { return "\"Editor unavailable\"" }
    return result
  }
}
