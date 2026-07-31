import EnchiridionCore
import Observation
import SwiftUI

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
        .id(store.vaultID)
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

private enum NativeRichEditorPaletteKind {
  case commands
  case references
  case supertags
  case taggedPages
}

private enum NativeRichEditorCommand: CaseIterable, Identifiable {
  case bold
  case italic
  case strikethrough
  case code
  case pageReference
  case supertag

  var id: Self { self }

  var title: String {
    switch self {
    case .bold: "Bold"
    case .italic: "Italic"
    case .strikethrough: "Strikethrough"
    case .code: "Inline Code"
    case .pageReference: "Page or Date"
    case .supertag: "Supertag"
    }
  }

  var detail: String {
    switch self {
    case .bold: "Strong emphasis"
    case .italic: "Emphasis"
    case .strikethrough: "Mark text as no longer relevant"
    case .code: "Technical text"
    case .pageReference: "Create a page or daily-note reference"
    case .supertag: "Find or create a typed page from selected text"
    }
  }

  var symbol: String {
    switch self {
    case .bold: "bold"
    case .italic: "italic"
    case .strikethrough: "strikethrough"
    case .code: "chevron.left.forwardslash.chevron.right"
    case .pageReference: "at"
    case .supertag: "number"
    }
  }
}

private struct NativeDailyPageSuggestion: Identifiable {
  let date: Date
  let title: String
  let subtitle: String

  var id: String {
    DayKey(date: date, calendar: .current).rawValue
  }
}

@MainActor
@Observable
private final class NativeRichPageEditorState {
  let registrationID = UUID()

  var title = ""
  var body = AttributedString()
  var selection = AttributedTextSelection()
  var isLoading = true
  var showsFind = false
  var errorMessage: String?
  var isPalettePresented = false
  var paletteKind: NativeRichEditorPaletteKind = .commands
  var referenceQuery = ""
  var referenceSuggestions: [PageSuggestion] = []
  var activeSupertag: SupertagDefinition?
  var taggedPageQuery = ""
  var taggedPageSuggestions: [PageSuggestion] = []

  private let store: LibraryStore
  private var pageID: PageID?
  private var persistedTitle = ""
  private var persistedBody = AttributedString()
  private var saveTask: Task<Void, Never>?
  private var isSaving = false
  private var shortcutRange: Range<AttributedString.Index>?
  private var selectionForReference: AttributedTextSelection?

  init(store: LibraryStore) {
    self.store = store
  }

  func load(_ page: PageSnapshot) {
    saveTask?.cancel()
    pageID = page.id
    do {
      let content = try PageDocument.richText(in: page.document)
      title = content.title
      body = content.body
      selection = AttributedTextSelection()
      errorMessage = nil
    } catch {
      title = page.title
      body = AttributedString(page.plainText)
      errorMessage = error.localizedDescription
    }
    persistedTitle = title
    persistedBody = body
    isLoading = false
  }

  func contentDidChange(bodyDidChange: Bool = true) {
    guard !isLoading else { return }
    saveTask?.cancel()
    guard hasUnsavedChanges else { return }
    scheduleSave()
    if bodyDidChange {
      detectInlineShortcut()
    }
  }

  func toggle(_ intent: InlinePresentationIntent) {
    body.transformAttributes(in: &selection) { attributes in
      var current = attributes.inlinePresentationIntent ?? []
      if current.contains(intent) {
        current.remove(intent)
      } else {
        current.insert(intent)
      }
      attributes.inlinePresentationIntent = current
    }
    contentDidChange()
  }

  func insertReference(to page: PageSnapshot) {
    insertReference(to: page.id, label: page.displayTitle)
  }

  var hasSelectedText: Bool {
    guard case .ranges(let rangeSet) = selection.indices(in: body) else { return false }
    return !rangeSet.isEmpty
  }

  var supertags: [SupertagDefinition] {
    store.supertags
  }

  func showCommandPalette() {
    shortcutRange = nil
    paletteKind = .commands
    isPalettePresented = true
  }

  func showReferencePicker() {
    selectionForReference = hasSelectedText ? selection : nil
    referenceQuery = selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
    paletteKind = .references
    isPalettePresented = true
  }

  func showSupertagPicker() {
    guard hasSelectedText else {
      errorMessage = "Select text before applying a supertag."
      return
    }
    selectionForReference = selection
    taggedPageQuery = selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
    activeSupertag = nil
    paletteKind = .supertags
    isPalettePresented = true
  }

  func chooseSupertag(_ supertag: SupertagDefinition) {
    activeSupertag = supertag
    taggedPageSuggestions = []
    paletteKind = .taggedPages
  }

  func refreshReferenceSuggestions() async {
    let suggestions = await store.suggestions(matching: referenceQuery)
    referenceSuggestions = suggestions.isEmpty ? cachedPageSuggestions() : suggestions
  }

  func refreshTaggedPageSuggestions() async {
    guard let activeSupertag else {
      taggedPageSuggestions = []
      return
    }
    taggedPageSuggestions = await store.taggedSuggestions(
      matching: taggedPageQuery,
      supertagID: activeSupertag.id
    )
  }

  func chooseReference(_ suggestion: PageSuggestion) {
    insertReference(to: suggestion.id, label: suggestion.title)
    dismissPalette()
  }

  func chooseDailyReference(_ suggestion: NativeDailyPageSuggestion) {
    let day = DayKey(date: suggestion.date, calendar: .current)
    insertReference(to: .daily(day), label: suggestion.title)
    dismissPalette()
  }

  func chooseTaggedPage(_ suggestion: PageSuggestion) {
    insertReference(to: suggestion.id, label: suggestion.title)
    dismissPalette()
  }

  func createTaggedPage() async {
    guard let activeSupertag else { return }
    let title = taggedPageQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else {
      errorMessage = "Select text with a title before creating a tagged page."
      return
    }
    guard let pageID = await store.createTaggedPage(title: title, supertagID: activeSupertag.id) else {
      errorMessage = "Could not create the tagged page."
      return
    }
    insertReference(to: pageID, label: title)
    dismissPalette()
  }

  func runCommand(_ command: NativeRichEditorCommand) {
    switch command {
    case .bold:
      consumeShortcut()
      toggle(.stronglyEmphasized)
      dismissPalette()
    case .italic:
      consumeShortcut()
      toggle(.emphasized)
      dismissPalette()
    case .strikethrough:
      consumeShortcut()
      toggle(.strikethrough)
      dismissPalette()
    case .code:
      consumeShortcut()
      toggle(.code)
      dismissPalette()
    case .pageReference:
      consumeShortcut()
      showReferencePicker()
    case .supertag:
      consumeShortcut()
      showSupertagPicker()
    }
  }

  func dismissPalette() {
    isPalettePresented = false
    referenceSuggestions = []
    taggedPageSuggestions = []
    activeSupertag = nil
    taggedPageQuery = ""
    selectionForReference = nil
    shortcutRange = nil
  }

  func dailyReferenceSuggestions() -> [NativeDailyPageSuggestion] {
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: Date())
    let query = referenceQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    return (-1...7).compactMap { offset in
      guard let date = calendar.date(byAdding: .day, value: offset, to: today) else { return nil }
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
      let title = date.formatted(.dateTime.weekday(.wide).day().month(.wide).year())
      let suggestion = NativeDailyPageSuggestion(
        date: date,
        title: title,
        subtitle: "\(relative) · Daily note"
      )
      let haystack = "\(title) \(suggestion.subtitle) \(suggestion.id)"
      return query.isEmpty || haystack.localizedStandardContains(query) ? suggestion : nil
    }
  }

  @discardableResult
  func flush() async -> Bool {
    saveTask?.cancel()
    saveTask = nil
    guard !isLoading, let pageID, hasUnsavedChanges else { return true }
    guard !isSaving else { return true }

    isSaving = true
    let titleToSave = title
    let bodyToSave = body
    do {
      _ = try await store.persistRichTextEditor(
        pageID: pageID,
        title: titleToSave,
        body: bodyToSave
      )
      persistedTitle = titleToSave
      persistedBody = bodyToSave
      errorMessage = nil
      isSaving = false
      if hasUnsavedChanges {
        return await flush()
      }
      return true
    } catch {
      isSaving = false
      errorMessage = error.localizedDescription
      return false
    }
  }

  private func scheduleSave() {
    saveTask?.cancel()
    saveTask = Task { [weak self] in
      do {
        try await Task.sleep(for: .milliseconds(600))
      } catch {
        return
      }
      _ = await self?.flush()
    }
  }

  private var hasUnsavedChanges: Bool {
    title != persistedTitle || body != persistedBody
  }

  private var selectedText: String {
    String(body[selection].characters)
  }

  private func cachedPageSuggestions() -> [PageSuggestion] {
    let query = referenceQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    return store.pages
      .filter { $0.id != pageID && $0.deletedAt == nil }
      .filter {
        query.isEmpty || $0.displayTitle.localizedStandardContains(query)
      }
      .sorted { $0.modifiedAt > $1.modifiedAt }
      .prefix(8)
      .map { PageSuggestion(id: $0.id, title: $0.title, kind: $0.kind) }
  }

  private func detectInlineShortcut() {
    guard !isPalettePresented,
      hasUnsavedChanges,
      case .insertionPoint(let caret) = selection.indices(in: body),
      caret > body.startIndex
    else { return }

    let finalCharacterStart = body.index(beforeCharacter: caret)
    let finalCharacter = String(body[finalCharacterStart..<caret].characters)
    let isStartOfLine = finalCharacterStart == body.startIndex
      || String(
        body[
          body.index(beforeCharacter: finalCharacterStart)..<finalCharacterStart
        ].characters
      ).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

    if finalCharacter == "/", isStartOfLine {
      shortcutRange = finalCharacterStart..<caret
      paletteKind = .commands
      isPalettePresented = true
      return
    }

    if finalCharacter == "@", isStartOfLine {
      shortcutRange = finalCharacterStart..<caret
      selectionForReference = nil
      referenceQuery = ""
      paletteKind = .references
      isPalettePresented = true
      return
    }

    guard finalCharacter == "[", finalCharacterStart > body.startIndex else { return }
    let openingBracketStart = body.index(beforeCharacter: finalCharacterStart)
    guard String(body[openingBracketStart..<caret].characters) == "[[" else { return }
    shortcutRange = openingBracketStart..<caret
    selectionForReference = nil
    referenceQuery = ""
    paletteKind = .references
    isPalettePresented = true
  }

  private func consumeShortcut() {
    guard let shortcutRange else { return }
    selection = AttributedTextSelection(range: shortcutRange)
    body.replaceSelection(&selection, with: AttributedString())
    self.shortcutRange = nil
  }

  private func insertReference(to pageID: PageID, label: String) {
    guard let mark = try? PageDocument.pageReferenceMark(to: pageID, label: label) else {
      errorMessage = "Could not create the page reference."
      return
    }

    let replacesShortcut = shortcutRange != nil
    if let shortcutRange {
      selection = AttributedTextSelection(range: shortcutRange)
      self.shortcutRange = nil
    } else if let selectionForReference {
      selection = selectionForReference
    }

    if hasSelectedText, !replacesShortcut {
      body.transformAttributes(in: &selection) { attributes in
        var marks = attributes[PageRichTextAttributes.AutomergeMarks.self] ?? []
        marks.removeAll { $0.name == PageDocument.pageReferenceMark }
        marks.append(mark)
        attributes[PageRichTextAttributes.AutomergeMarks.self] = marks
      }
    } else {
      var reference = AttributedString(label)
      reference[reference.startIndex..<reference.endIndex][PageRichTextAttributes.AutomergeMarks.self] = [mark]
      body.replaceSelection(&selection, with: reference)
    }
    contentDidChange()
  }
}

private struct RichPageEditor: View {
  private enum FocusedField: Hashable {
    case title
    case body
  }

  let page: PageSnapshot
  let calendarContext: CalendarPageContext?
  let store: LibraryStore
  let flushController: EditorFlushController
  let findController: EditorFindController
  let openPage: (PageID) -> Void

  @State private var editor: NativeRichPageEditorState
  @FocusState private var focusedField: FocusedField?

  init(
    page: PageSnapshot,
    calendarContext: CalendarPageContext?,
    store: LibraryStore,
    flushController: EditorFlushController,
    findController: EditorFindController,
    openPage: @escaping (PageID) -> Void
  ) {
    self.page = page
    self.calendarContext = calendarContext
    self.store = store
    self.flushController = flushController
    self.findController = findController
    self.openPage = openPage
    _editor = State(initialValue: NativeRichPageEditorState(store: store))
  }

  var body: some View {
    @Bindable var editor = editor

    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        calendarContextView

        TextField("Untitled", text: $editor.title, axis: .vertical)
          .font(.system(size: 34, weight: .bold, design: .default))
          .textFieldStyle(.plain)
          .focused($focusedField, equals: .title)
          .padding(.bottom, 20)
          .accessibilityLabel("Page title")

        ZStack(alignment: .topLeading) {
          if editor.body.characters.isEmpty {
            Text("Start writing...")
              .foregroundStyle(.tertiary)
              .padding(.top, 8)
              .allowsHitTesting(false)
          }

          TextEditor(text: $editor.body, selection: $editor.selection)
            .font(.body)
            .focused($focusedField, equals: .body)
            .scrollContentBackground(.hidden)
            .frame(minHeight: 440, alignment: .top)
            .accessibilityLabel("Page body")
        }

        if let errorMessage = editor.errorMessage {
          Label(errorMessage, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.red)
            .padding(.top, 12)
            .accessibilityIdentifier("page-editor-error")
        }
      }
      .frame(maxWidth: 760, alignment: .leading)
      .padding(.horizontal, 24)
      .padding(.vertical, 20)
    }
    .findNavigator(isPresented: $editor.showsFind)
    .safeAreaInset(edge: .bottom) {
      formattingBar
    }
    .sheet(isPresented: $editor.isPalettePresented, onDismiss: {
      editor.dismissPalette()
      focusedField = .body
    }) {
      NativeRichEditorPalette(editor: editor)
    }
    .onAppear {
      flushController.register(editor.registrationID) { [weak editor] in
        await editor?.flush() ?? true
      }
      findController.register(editor.registrationID) { [weak editor] in
        editor?.showsFind = true
      }
    }
    .onDisappear {
      flushController.unregister(editor.registrationID)
      findController.unregister(editor.registrationID)
      Task { _ = await editor.flush() }
    }
    .task(id: page.id) {
      editor.load(page)
      focusedField = .body
    }
    .onChange(of: editor.title) { _, _ in
      editor.contentDidChange(bodyDidChange: false)
    }
    .onChange(of: editor.body) { _, _ in
      editor.contentDidChange()
    }
    .onChange(of: focusedField) { _, field in
      #if os(iOS)
      NotificationCenter.default.post(
        name: .enchiridionEditorFocusDidChange,
        object: nil,
        userInfo: ["isFocused": field != nil]
      )
      #endif
    }
  }

  @ViewBuilder
  private var calendarContextView: some View {
    if let calendarContext {
      VStack(alignment: .leading, spacing: 7) {
        switch calendarContext.kind {
        case .occurrence:
          if let event = calendarContext.event {
            Text(event.startDate.formatted(date: .long, time: event.isAllDay ? .omitted : .shortened))
              .font(.subheadline.weight(.semibold))
            Text([event.calendarTitle, event.location].compactMap { $0 }.joined(separator: " · "))
              .font(.subheadline)
              .foregroundStyle(.secondary)
            if let seriesPageID = calendarContext.seriesPageID {
              Button("Open Series Notes") {
                openPage(seriesPageID)
              }
              .font(.subheadline.weight(.semibold))
            }
          }
        case .series:
          Text("Recurring event")
            .font(.subheadline.weight(.semibold))
          if let calendarTitle = calendarContext.calendarTitle {
            Text(calendarTitle)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          ForEach(calendarContext.occurrences) { occurrence in
            Button {
              openPage(occurrence.pageID)
            } label: {
              Text(occurrence.startDate.formatted(date: .abbreviated, time: occurrence.isAllDay ? .omitted : .shortened))
            }
            .font(.subheadline)
          }
        }

        if calendarContext.sourceUnavailable {
          Label(
            "This event is no longer available from its calendar source.",
            systemImage: "exclamationmark.triangle"
          )
          .font(.footnote)
          .foregroundStyle(.orange)
        }
      }
      .padding(.bottom, 20)
    }
  }

  private var formattingBar: some View {
    HStack(spacing: 4) {
      formattingButton("Bold", symbol: "bold", intent: .stronglyEmphasized)
      formattingButton("Italic", symbol: "italic", intent: .emphasized)
      formattingButton("Strikethrough", symbol: "strikethrough", intent: .strikethrough)
      formattingButton("Code", symbol: "chevron.left.forwardslash.chevron.right", intent: .code)

      Divider()
        .frame(height: 24)
        .padding(.horizontal, 4)

      Button {
        editor.showReferencePicker()
      } label: {
        Label("Insert Page Reference", systemImage: "at")
      }
      .help("Insert page or daily-note reference")
      .disabled(editor.isLoading)

      Button {
        editor.showSupertagPicker()
      } label: {
        Label("Apply Supertag", systemImage: "number")
      }
      .help("Apply a supertag to selected text")
      .disabled(editor.isLoading || !editor.hasSelectedText)
      .keyboardShortcut("9", modifiers: [.command, .shift])

      Button {
        editor.showCommandPalette()
      } label: {
        Label("Editor Commands", systemImage: "command")
      }
      .help("Open editor commands")
      .disabled(editor.isLoading)
    }
    .labelStyle(.iconOnly)
    .buttonStyle(.borderless)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.bar)
  }

  private func formattingButton(
    _ title: String,
    symbol: String,
    intent: InlinePresentationIntent
  ) -> some View {
    Button {
      editor.toggle(intent)
    } label: {
      Label(title, systemImage: symbol)
    }
    .disabled(editor.isLoading)
  }
}

private struct NativeRichEditorPalette: View {
  @Bindable var editor: NativeRichPageEditorState
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      switch editor.paletteKind {
      case .commands:
        commandList
      case .references:
        referenceList
      case .supertags:
        supertagList
      case .taggedPages:
        taggedPageList
      }
    }
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel") {
          dismiss()
        }
      }
    }
  }

  private var commandList: some View {
    List {
      Section("Format") {
        commandButton(.bold)
        commandButton(.italic)
        commandButton(.strikethrough)
        commandButton(.code)
      }

      Section("Insert") {
        commandButton(.pageReference)
        commandButton(.supertag)
      }
    }
    .navigationTitle("Editor Commands")
  }

  private var referenceList: some View {
    List {
      Section("Pages") {
        if editor.referenceSuggestions.isEmpty {
          Text("No matching pages")
            .foregroundStyle(.secondary)
        } else {
          ForEach(editor.referenceSuggestions) { suggestion in
            Button {
              editor.chooseReference(suggestion)
            } label: {
              suggestionLabel(
                title: suggestion.title.isEmpty ? "Untitled" : suggestion.title,
                subtitle: suggestion.displaySubtitle
              )
            }
          }
        }
      }

      let dates = editor.dailyReferenceSuggestions()
      if !dates.isEmpty {
        Section("Daily Notes") {
          ForEach(dates) { suggestion in
            Button {
              editor.chooseDailyReference(suggestion)
            } label: {
              suggestionLabel(title: suggestion.title, subtitle: suggestion.subtitle)
            }
          }
        }
      }
    }
    .navigationTitle("Insert Reference")
    .searchable(text: $editor.referenceQuery, prompt: "Find a page or date")
    .task(id: editor.referenceQuery) {
      await editor.refreshReferenceSuggestions()
    }
  }

  private var supertagList: some View {
    List {
      if editor.supertags.isEmpty {
        ContentUnavailableView(
          "No Supertags",
          systemImage: "number",
          description: Text("Create a supertag from the Library before applying one here.")
        )
      } else {
        Section("Apply to Selected Text") {
          ForEach(editor.supertags) { supertag in
            Button {
              editor.chooseSupertag(supertag)
            } label: {
              Label(supertag.name, systemImage: supertag.symbol)
            }
          }
        }
      }
    }
    .navigationTitle("Apply Supertag")
  }

  @ViewBuilder
  private var taggedPageList: some View {
    if let supertag = editor.activeSupertag {
      List {
        Section {
          Button {
            Task { await editor.createTaggedPage() }
          } label: {
            Label(
              supertag.id == BuiltInSupertags.task
                ? "Create Task “\(editor.taggedPageQuery)”"
                : "Create “\(editor.taggedPageQuery)” as #\(supertag.name)",
              systemImage: "plus"
            )
          }
          .disabled(editor.taggedPageQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        Section("Existing #\(supertag.name) Pages") {
          if editor.taggedPageSuggestions.isEmpty {
            Text("No matching pages")
              .foregroundStyle(.secondary)
          } else {
            ForEach(editor.taggedPageSuggestions) { suggestion in
              Button {
                editor.chooseTaggedPage(suggestion)
              } label: {
                suggestionLabel(
                  title: suggestion.title.isEmpty ? "Untitled" : suggestion.title,
                  subtitle: suggestion.displaySubtitle
                )
              }
            }
          }
        }
      }
      .navigationTitle("#\(supertag.name)")
      .searchable(text: $editor.taggedPageQuery, prompt: "Find or create a page")
      .task(id: editor.taggedPageQuery) {
        await editor.refreshTaggedPageSuggestions()
      }
    } else {
      ContentUnavailableView(
        "Choose a Supertag",
        systemImage: "number",
        description: Text("Select a supertag before finding or creating a typed page.")
      )
    }
  }

  private func commandButton(_ command: NativeRichEditorCommand) -> some View {
    Button {
      editor.runCommand(command)
    } label: {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(command.title)
          Text(command.detail)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      } icon: {
        Image(systemName: command.symbol)
      }
    }
    .disabled(command == .supertag && !editor.hasSelectedText)
  }

  private func suggestionLabel(title: String, subtitle: String?) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title)
      if let subtitle {
        Text(subtitle)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
  }
}
