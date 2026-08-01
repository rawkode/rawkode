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

struct PageEditorPresentation<Header: View> {
  let showsEditableTitle: Bool
  @ViewBuilder let header: () -> Header

  init(showsEditableTitle: Bool = true, @ViewBuilder header: @escaping () -> Header) {
    self.showsEditableTitle = showsEditableTitle
    self.header = header
  }

  static func dailyWorkspace(@ViewBuilder header: @escaping () -> Header) -> Self {
    Self(showsEditableTitle: false, header: header)
  }
}

extension PageEditorPresentation where Header == EmptyView {
  static var standard: Self { Self { EmptyView() } }
}

struct PageEditorView<Header: View>: View {
  let store: LibraryStore
  let pageID: PageID
  private let onOpenPage: ((PageID) -> Void)?
  private let showsPropertiesAction: Bool
  private let showsPageActions: Bool
  private let presentation: PageEditorPresentation<Header>
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
    presentation: PageEditorPresentation<Header>,
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
    self.presentation = presentation
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
        presentation: presentation,
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

extension PageEditorView where Header == EmptyView {
  init(
    store: LibraryStore, pageID: PageID,
    flushController: EditorFlushController? = nil,
    findController: EditorFindController? = nil,
    onOpenPage: ((PageID) -> Void)? = nil,
    showsPropertiesAction: Bool = true, showsPageActions: Bool = true
  ) {
    self.init(
      store: store, pageID: pageID, presentation: .standard,
      flushController: flushController, findController: findController,
      onOpenPage: onOpenPage, showsPropertiesAction: showsPropertiesAction,
      showsPageActions: showsPageActions
    )
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

private enum NativeRichEditorPaletteKind: Equatable {
  case commands
  case references
  case supertags
  case taggedPages
}

/// The iPhone editor keeps short-lived commands in the writing context instead
/// of navigating away from it. macOS continues to use `paletteKind` in a sheet.
private enum NativeRichEditorInlinePicker: Equatable {
  case references
  case supertags
  case taggedPages
}

private extension NativeRichEditorPaletteKind {
  init(_ picker: NativeRichEditorInlinePicker) {
    switch picker {
    case .references: self = .references
    case .supertags: self = .supertags
    case .taggedPages: self = .taggedPages
    }
  }
}

private enum NativeRichEditorReferenceInsertionMode {
  case insertAtCaret
  case replaceTrigger
  case applyToSelectedText
}

private struct NativeRichEditorReferenceInsertionContext {
  let pickerID: UUID
  let snapshot: NativeRichEditorSelectionSnapshot
  let mode: NativeRichEditorReferenceInsertionMode
}

private struct NativeRichEditorPickerSession {
  let id: UUID
  let sourcePageID: PageID
  let referenceInsertionContext: NativeRichEditorReferenceInsertionContext
}

private struct NativeRichEditorTaggedPageCommit {
  let id: UUID
  let sourcePageID: PageID
  let loadGeneration: UInt64
}

/// A selection expressed as character offsets so it can be recreated after
/// the committed document is decoded into a distinct AttributedString value.
private enum NativeRichEditorCommittedSelection {
  case insertionPoint(offset: Int)
  case ranges([Range<Int>])

  init?(from selection: AttributedTextSelection, in body: AttributedString) {
    switch selection.indices(in: body) {
    case .insertionPoint(let index):
      self = .insertionPoint(offset: body.characterOffset(of: index))
    case .ranges(let ranges):
      self = .ranges(
        ranges.ranges.map {
          body.characterOffset(of: $0.lowerBound)..<body.characterOffset(of: $0.upperBound)
        }
      )
    }
  }

  func selection(in body: AttributedString) -> AttributedTextSelection? {
    switch self {
    case .insertionPoint(let offset):
      guard let index = body.characterIndex(at: offset) else { return nil }
      return AttributedTextSelection(insertionPoint: index)
    case .ranges(let offsets):
      var ranges = RangeSet<AttributedString.Index>()
      for offset in offsets {
        guard let lowerBound = body.characterIndex(at: offset.lowerBound),
          let upperBound = body.characterIndex(at: offset.upperBound)
        else {
          return nil
        }
        ranges.insert(contentsOf: lowerBound..<upperBound)
      }
      return AttributedTextSelection(ranges: ranges)
    }
  }
}

private struct NativeRichEditorReferenceInsertionCandidate {
  let body: AttributedString
  let selection: NativeRichEditorCommittedSelection
}

private extension PageSuggestion {
  var editorDisplayTitle: String {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmedTitle.isEmpty ? "Untitled" : trimmedTitle
  }
}

private extension AttributedString {
  func characterOffset(of index: Index) -> Int {
    var offset = 0
    var cursor = startIndex
    while cursor < index {
      cursor = self.index(afterCharacter: cursor)
      offset += 1
    }
    return offset
  }

  func characterIndex(at offset: Int) -> Index? {
    guard offset >= 0 else { return nil }
    var cursor = startIndex
    for _ in 0..<offset {
      guard cursor < endIndex else { return nil }
      cursor = self.index(afterCharacter: cursor)
    }
    return cursor
  }
}

private enum NativeRichEditorPickerDismissalReason {
  case userCancelled
  case inserted
  case invalidated
  case pageLoad
}

private enum NativeRichEditorReferenceInsertionResult {
  case inserted
  case invalidContext
  case unavailable
}

private struct NativeRichEditorPickerRequest: Equatable {
  let id: UUID
  let picker: NativeRichEditorInlinePicker
  let pageID: PageID
  let query: String
}

private enum NativeRichEditorFormattingState: String {
  case off, on, mixed
  var accessibilityValue: String { rawValue.capitalized }
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
  var interactionErrorMessage: String?
  var isPalettePresented = false
  var paletteKind: NativeRichEditorPaletteKind = .commands
  var inlinePicker: NativeRichEditorInlinePicker?
  var referenceQuery = ""
  var referenceSuggestions: [PageSuggestion] = []
  var supertagQuery = ""
  var activeSupertag: SupertagDefinition?
  var taggedPageQuery = ""
  var taggedPageSuggestions: [PageSuggestion] = []
  var pickerDismissalReason: NativeRichEditorPickerDismissalReason = .pageLoad

  var isCreatingTaggedPage: Bool { taggedPageCommit != nil }
  var isMutationLocked: Bool { taggedPageCommit != nil }

  private let store: LibraryStore
  private var pageID: PageID?
  private var loadGeneration: UInt64 = 0
  private var durableSnapshot: PageSnapshot?
  private var persistedTitle = ""
  private var persistedBody = AttributedString()
  private var observedTitle = ""
  private var observedBody = AttributedString()
  private var saveTask: Task<Void, Never>?
  private var saveTaskToken: UUID?
  private var activeSaveOperation: NativeRichEditorSaveOperation?
  private var editRevision: UInt64 = 0
  private var durableRevision: UInt64 = 0
  private var commandShortcutSnapshot: NativeRichEditorSelectionSnapshot?
  private var pickerSession: NativeRichEditorPickerSession?
  private var taggedPageCommit: NativeRichEditorTaggedPageCommit?

  init(store: LibraryStore) {
    self.store = store
  }

  func load(_ page: PageSnapshot) {
    loadGeneration &+= 1
    cancelQueuedSave()
    activeSaveOperation = nil
    pageID = page.id
    durableSnapshot = page
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
    observedTitle = title
    observedBody = body
    editRevision = 0
    durableRevision = 0
    interactionErrorMessage = nil
    resetPickerState(reason: .pageLoad)
    isLoading = false
  }

  func contentDidChange(bodyDidChange: Bool = true) {
    guard !isLoading, !isMutationLocked else { return }
    guard title != observedTitle || body != observedBody else { return }
    observedTitle = title
    observedBody = body
    editRevision &+= 1
    cancelQueuedSave()
    guard hasUnsavedChanges else { return }
    scheduleSave()
    if bodyDidChange {
      detectInlineShortcut()
    }
  }

  func toggle(_ intent: InlinePresentationIntent) {
    guard !isMutationLocked else { return }
    let shouldEnable = formattingState(for: intent) != .on
    body.transformAttributes(in: &selection) { attributes in
      var current = attributes.inlinePresentationIntent ?? []
      if shouldEnable {
        current.insert(intent)
      } else {
        current.remove(intent)
      }
      attributes.inlinePresentationIntent = current
    }
    contentDidChange()
  }

  var hasSelectedText: Bool {
    !selectedRanges.isEmpty
  }

  func formattingState(for intent: InlinePresentationIntent) -> NativeRichEditorFormattingState {
    let ranges = selectedRanges
    guard !ranges.isEmpty else {
      return formattingStateAtInsertionPoint(for: intent)
    }
    var hasOn = false
    var hasOff = false
    for range in ranges {
      for run in body[range].runs {
        if run.inlinePresentationIntent?.contains(intent) == true { hasOn = true } else { hasOff = true }
        if hasOn && hasOff { return .mixed }
      }
    }
    return hasOn ? .on : .off
  }

  private func formattingStateAtInsertionPoint(
    for intent: InlinePresentationIntent
  ) -> NativeRichEditorFormattingState {
    guard case .insertionPoint(let caret) = selection.indices(in: body),
      !body.characters.isEmpty
    else {
      return .off
    }

    let characterRange: Range<AttributedString.Index>
    if caret > body.startIndex {
      characterRange = body.index(beforeCharacter: caret)..<caret
    } else if caret < body.endIndex {
      characterRange = caret..<body.index(afterCharacter: caret)
    } else {
      return .off
    }

    return body[characterRange].runs.contains {
      $0.inlinePresentationIntent?.contains(intent) == true
    } ? .on : .off
  }

  var supertags: [SupertagDefinition] {
    store.supertags
  }

  func showCommandPalette() {
    guard !isMutationLocked else { return }
    commandShortcutSnapshot = nil
    paletteKind = .commands
    isPalettePresented = true
  }

  func showReferencePicker() {
    guard !isMutationLocked else { return }
    guard let snapshot = selectionSnapshot else {
      setInteractionError("The insertion point is no longer available. Try again.")
      return
    }
    let mode: NativeRichEditorReferenceInsertionMode = hasSelectedText
      ? .applyToSelectedText
      : .insertAtCaret
    commandShortcutSnapshot = nil
    referenceQuery = selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
    beginPicker(.references, snapshot: snapshot, mode: mode)
  }

  func showSupertagPicker() {
    guard !isMutationLocked else { return }
    guard hasSelectedText else {
      setInteractionError("Select text before applying a supertag.")
      return
    }
    guard let selectionSnapshot else {
      setInteractionError("The text selection is no longer available. Select text and try again.")
      return
    }
    commandShortcutSnapshot = nil
    taggedPageQuery = selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
    activeSupertag = nil
    supertagQuery = ""
    beginPicker(.supertags, snapshot: selectionSnapshot, mode: .applyToSelectedText)
  }

  func chooseSupertag(_ supertag: SupertagDefinition) {
    guard !isMutationLocked else { return }
    guard pickerSession != nil, isPickerPresented(.supertags) else {
      setInteractionError("The supertag selection is no longer available. Try again.")
      return
    }
    activeSupertag = supertag
    taggedPageSuggestions = []
    #if os(iOS)
    inlinePicker = .taggedPages
    #else
    paletteKind = .taggedPages
    #endif
  }

  var matchingSupertags: [SupertagDefinition] {
    let query = supertagQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return supertags }
    return supertags.filter { $0.name.localizedStandardContains(query) }
  }

  var inlinePickerSourcePageID: PageID? {
    pickerSession?.sourcePageID
  }

  var referencePickerRequestID: NativeRichEditorPickerRequest? {
    pickerContext(for: .references)
  }

  var taggedPagePickerRequestID: NativeRichEditorPickerRequest? {
    pickerContext(for: .taggedPages)
  }

  func refreshReferenceSuggestions() async {
    guard let context = pickerContext(for: .references) else { return }
    let suggestions = await store.suggestions(matching: referenceQuery)
    guard pickerContext(for: .references) == context else { return }
    referenceSuggestions = suggestions.isEmpty ? cachedPageSuggestions() : suggestions
  }

  func refreshTaggedPageSuggestions() async {
    guard let context = pickerContext(for: .taggedPages) else { return }
    guard let activeSupertag else {
      taggedPageSuggestions = []
      return
    }
    let suggestions = await store.taggedSuggestions(
      matching: taggedPageQuery,
      supertagID: activeSupertag.id
    )
    guard pickerContext(for: .taggedPages) == context else { return }
    taggedPageSuggestions = suggestions
  }

  func chooseReference(_ suggestion: PageSuggestion) {
    guard !isMutationLocked else { return }
    completeReferenceInsertion(to: suggestion.id, label: suggestion.editorDisplayTitle)
  }

  func chooseDailyReference(_ suggestion: NativeDailyPageSuggestion) {
    guard !isMutationLocked else { return }
    let day = DayKey(date: suggestion.date, calendar: .current)
    completeReferenceInsertion(to: .daily(day), label: suggestion.title)
  }

  func chooseTaggedPage(_ suggestion: PageSuggestion) {
    guard !isMutationLocked else { return }
    completeReferenceInsertion(to: suggestion.id, label: suggestion.editorDisplayTitle)
  }

  func createTaggedPage() async {
    guard taggedPageCommit == nil,
      let activeSupertag,
      let session = pickerSession,
      isPickerPresented(.taggedPages),
      let sourcePageID = pageID,
      sourcePageID == session.sourcePageID,
      let capturedSelection = validSelection(from: session.referenceInsertionContext.snapshot),
      isSelection(capturedSelection, validFor: session.referenceInsertionContext.mode)
    else { return }
    let title = taggedPageQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else {
      setInteractionError("Select text with a title before creating a tagged page.")
      return
    }
    let commit = NativeRichEditorTaggedPageCommit(
      id: UUID(),
      sourcePageID: sourcePageID,
      loadGeneration: loadGeneration
    )
    let sourceTitle = self.title
    let sourceBody = body
    taggedPageCommit = commit
    cancelQueuedSave()

    guard let durableSource = await flushDurableSnapshot(
      pageID: sourcePageID,
      title: sourceTitle,
      body: sourceBody
    ) else {
      finishTaggedPageCommit(commit, error: "Could not save this page before creating the tagged page.")
      return
    }

    let targetPageID = PageID.free()
    guard let reference = bodyByInsertingReference(
      to: targetPageID,
      label: title,
      in: sourceBody,
      selection: capturedSelection,
      mode: session.referenceInsertionContext.mode
    ) else {
      finishTaggedPageCommit(commit, error: "Could not create the page reference.")
      return
    }

    do {
      let result = try await store.createTaggedPageAndPersistReference(
        TaggedPageReferenceInsertionRequest(
          sourcePageID: sourcePageID,
          expectedSourceHeads: durableSource.heads,
          sourceTitle: sourceTitle,
          sourceBody: reference.body,
          targetPageID: targetPageID,
          targetTitle: title,
          supertagID: activeSupertag.id
        )
      )
      finishTaggedPageCommit(
        commit,
        result: result,
        reference: reference,
        pickerID: session.id
      )
    } catch let error as TaggedPageReferenceInsertionError {
      finishTaggedPageCommit(commit, error: error.localizedDescription)
    } catch {
      finishTaggedPageCommit(commit, error: error.localizedDescription)
    }
  }

  func runCommand(_ command: NativeRichEditorCommand) {
    guard !isMutationLocked else { return }
    switch command {
    case .bold:
      consumeCommandShortcut()
      toggle(.stronglyEmphasized)
      dismissPicker()
    case .italic:
      consumeCommandShortcut()
      toggle(.emphasized)
      dismissPicker()
    case .strikethrough:
      consumeCommandShortcut()
      toggle(.strikethrough)
      dismissPicker()
    case .code:
      consumeCommandShortcut()
      toggle(.code)
      dismissPicker()
    case .pageReference:
      consumeCommandShortcut()
      showReferencePicker()
    case .supertag:
      consumeCommandShortcut()
      showSupertagPicker()
    }
  }

  func dismissPicker(reason: NativeRichEditorPickerDismissalReason = .userCancelled) {
    resetPickerState(reason: reason)
  }

  func dismissPalette() {
    dismissPicker()
  }

  private func resetPickerState(reason: NativeRichEditorPickerDismissalReason) {
    isPalettePresented = false
    inlinePicker = nil
    pickerSession = nil
    pickerDismissalReason = reason
    paletteKind = .commands
    referenceQuery = ""
    referenceSuggestions = []
    supertagQuery = ""
    taggedPageSuggestions = []
    activeSupertag = nil
    taggedPageQuery = ""
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
    // A tagged-page commit owns the next durable source revision. Background
    // flush callers (including the shared flush controller and disappearance)
    // must not race it with the pre-insertion editor value.
    guard !isMutationLocked else {
      cancelQueuedSave()
      return true
    }
    guard !isLoading, let pageID else { return true }
    return await flushBackgroundSnapshot(pageID: pageID, title: title, body: body)
  }

  /// Routes public and scheduled flushes through the tracked save operation.
  /// If one began immediately before a tagged-page commit acquired its lock,
  /// the commit's exact flush waits for it before using the resulting heads.
  private func flushBackgroundSnapshot(
    pageID requestedPageID: PageID,
    title requestedTitle: String,
    body requestedBody: AttributedString
  ) async -> Bool {
    cancelQueuedSave()
    if let activeSaveOperation, activeSaveOperation.pageID == requestedPageID,
      let task = activeSaveOperation.task
    {
      guard case .success = await task.value else { return false }
      return true
    }

    if let durableSnapshot,
      durableSnapshot.id == requestedPageID,
      persistedTitle == requestedTitle,
      persistedBody == requestedBody
    {
      return true
    }

    startSaveOperation(
      pageID: requestedPageID,
      revision: editRevision,
      title: requestedTitle,
      body: requestedBody
    )
    guard let task = activeSaveOperation?.task else { return false }
    guard case .success = await task.value else { return false }
    return true
  }

  /// Flushes this exact editor value and returns the committed snapshot. Tagged
  /// page creation uses this instead of the cache so its atomic transaction is
  /// guarded by the durable Automerge heads it just observed.
  private func flushDurableSnapshot(
    pageID requestedPageID: PageID,
    title requestedTitle: String,
    body requestedBody: AttributedString
  ) async -> PageSnapshot? {
    cancelQueuedSave()
    if let activeSaveOperation, activeSaveOperation.pageID == requestedPageID,
      let task = activeSaveOperation.task
    {
      guard case .success = await task.value else { return nil }
    }

    if let durableSnapshot,
      durableSnapshot.id == requestedPageID,
      persistedTitle == requestedTitle,
      persistedBody == requestedBody
    {
      return durableSnapshot
    }

    do {
      let snapshot = try await store.persistRichTextEditor(
        pageID: requestedPageID,
        title: requestedTitle,
        body: requestedBody
      )
      guard pageID == requestedPageID else { return snapshot }
      durableSnapshot = snapshot
      persistedTitle = requestedTitle
      persistedBody = requestedBody
      durableRevision = editRevision
      errorMessage = nil
      return snapshot
    } catch {
      guard pageID == requestedPageID else { return nil }
      errorMessage = error.localizedDescription
      return nil
    }
  }

  private func scheduleSave() {
    cancelQueuedSave()
    let token = UUID()
    saveTaskToken = token
    saveTask = Task { [weak self] in
      do {
        try await Task.sleep(for: .milliseconds(600))
      } catch {
        return
      }
      await self?.fireScheduledSave(token: token)
    }
  }

  private func cancelQueuedSave() {
    saveTask?.cancel()
    saveTask = nil
    saveTaskToken = nil
  }

  private func fireScheduledSave(token: UUID) async {
    guard saveTaskToken == token else { return }
    saveTask = nil
    saveTaskToken = nil
    // The commit acquires its lock before awaiting its exact durable flush.
    // A timer that wakes afterward must be a harmless no-op instead of writing
    // the old, reference-free body.
    guard !isMutationLocked else { return }
    _ = await flush()
  }

  private func startSaveOperation(
    pageID: PageID,
    revision: UInt64,
    title: String,
    body: AttributedString
  ) {
    let operation = NativeRichEditorSaveOperation(
      token: UUID(),
      pageID: pageID,
      revision: revision,
      title: title,
      body: body
    )
    activeSaveOperation = operation

    let token = operation.token
    operation.task = Task { @MainActor [weak self, store] in
      let result: NativeRichEditorSaveResult
      do {
        result = .success(try await store.persistRichTextEditor(pageID: pageID, title: title, body: body))
      } catch {
        result = .failure(error.localizedDescription)
      }
      _ = self?.settleSaveOperation(
        token: token,
        result: result
      )
      return result
    }
  }

  private func settleSaveOperation(
    token: UUID,
    result: NativeRichEditorSaveResult
  ) -> NativeRichEditorSaveResult {
    guard let activeSaveOperation,
      activeSaveOperation.token == token,
      self.pageID == activeSaveOperation.pageID
    else {
      return .stale
    }

    switch result {
    case .success(let snapshot):
      persistedTitle = activeSaveOperation.title
      persistedBody = activeSaveOperation.body
      durableSnapshot = snapshot
      durableRevision = max(durableRevision, activeSaveOperation.revision)
      errorMessage = nil
    case .failure(let message):
      errorMessage = message
    case .stale:
      return .stale
    }
    self.activeSaveOperation = nil
    return result
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
    guard !isMutationLocked,
      !isPalettePresented,
      inlinePicker == nil,
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
      #if os(macOS)
      commandShortcutSnapshot = selectionSnapshot(for: finalCharacterStart..<caret)
      paletteKind = .commands
      isPalettePresented = true
      #endif
      return
    }

    if finalCharacter == "@" {
      referenceQuery = ""
      guard let snapshot = selectionSnapshot(for: finalCharacterStart..<caret) else { return }
      beginPicker(.references, snapshot: snapshot, mode: .replaceTrigger)
      return
    }

    guard finalCharacter == "[", finalCharacterStart > body.startIndex else { return }
    let openingBracketStart = body.index(beforeCharacter: finalCharacterStart)
    guard String(body[openingBracketStart..<caret].characters) == "[[" else { return }
    referenceQuery = ""
    guard let snapshot = selectionSnapshot(for: openingBracketStart..<caret) else { return }
    beginPicker(.references, snapshot: snapshot, mode: .replaceTrigger)
  }

  private func consumeCommandShortcut() {
    guard !isMutationLocked else { return }
    guard let commandShortcutSnapshot,
      let selection = validSelection(from: commandShortcutSnapshot)
    else {
      self.commandShortcutSnapshot = nil
      return
    }
    self.selection = selection
    body.replaceSelection(&self.selection, with: AttributedString())
    self.commandShortcutSnapshot = nil
  }

  private func completeReferenceInsertion(to pageID: PageID, label: String) {
    guard !isMutationLocked else { return }
    guard let context = pickerSession?.referenceInsertionContext else {
      invalidatePicker("The insertion point changed. Insert the reference again.")
      return
    }

    switch insertReference(to: pageID, label: label, using: context) {
    case .inserted:
      interactionErrorMessage = nil
      dismissPicker(reason: .inserted)
    case .invalidContext:
      invalidatePicker("The insertion point changed. Insert the reference again.")
    case .unavailable:
      setInteractionError("Could not create the page reference.")
    }
  }

  private func insertReference(
    to pageID: PageID,
    label: String,
    using context: NativeRichEditorReferenceInsertionContext
  ) -> NativeRichEditorReferenceInsertionResult {
    guard !isMutationLocked else { return .invalidContext }
    guard pickerSession?.id == context.pickerID,
      let capturedSelection = validSelection(from: context.snapshot)
    else {
      return .invalidContext
    }

    guard isSelection(capturedSelection, validFor: context.mode) else {
      return .invalidContext
    }
    guard let candidate = bodyByInsertingReference(
      to: pageID,
      label: label,
      in: body,
      selection: capturedSelection,
      mode: context.mode
    ), let candidateSelection = candidate.selection.selection(in: candidate.body) else {
      return .unavailable
    }

    body = candidate.body
    selection = candidateSelection
    contentDidChange()
    return .inserted
  }

  private func beginPicker(
    _ picker: NativeRichEditorInlinePicker,
    snapshot: NativeRichEditorSelectionSnapshot,
    mode: NativeRichEditorReferenceInsertionMode
  ) {
    guard !isMutationLocked else { return }
    let pickerID = UUID()
    let insertion = NativeRichEditorReferenceInsertionContext(
      pickerID: pickerID,
      snapshot: snapshot,
      mode: mode
    )
    pickerSession = NativeRichEditorPickerSession(
      id: pickerID,
      sourcePageID: snapshot.pageID,
      referenceInsertionContext: insertion
    )
    interactionErrorMessage = nil
    pickerDismissalReason = .pageLoad
    #if os(iOS)
    isPalettePresented = false
    inlinePicker = picker
    #else
    inlinePicker = nil
    paletteKind = NativeRichEditorPaletteKind(picker)
    isPalettePresented = true
    #endif
  }

  private func isPickerPresented(_ picker: NativeRichEditorInlinePicker) -> Bool {
    #if os(iOS)
    inlinePicker == picker
    #else
    isPalettePresented && paletteKind == NativeRichEditorPaletteKind(picker)
    #endif
  }

  private func bodyByInsertingReference(
    to pageID: PageID,
    label: String,
    in sourceBody: AttributedString,
    selection capturedSelection: AttributedTextSelection,
    mode: NativeRichEditorReferenceInsertionMode
  ) -> NativeRichEditorReferenceInsertionCandidate? {
    guard let mark = try? PageDocument.pageReferenceMark(to: pageID, label: label) else {
      return nil
    }

    var candidate = sourceBody
    var candidateSelection = capturedSelection
    switch mode {
    case .applyToSelectedText:
      candidate.transformAttributes(in: &candidateSelection) { attributes in
        var marks = attributes[PageRichTextAttributes.AutomergeMarks.self] ?? []
        marks.removeAll { $0.name == PageDocument.pageReferenceMark }
        marks.append(mark)
        attributes[PageRichTextAttributes.AutomergeMarks.self] = marks
      }
    case .insertAtCaret, .replaceTrigger:
      var reference = AttributedString(label)
      reference[reference.startIndex..<reference.endIndex][PageRichTextAttributes.AutomergeMarks.self] = [mark]
      candidate.replaceSelection(&candidateSelection, with: reference)
    }
    guard let committedSelection = NativeRichEditorCommittedSelection(
      from: candidateSelection,
      in: candidate
    ) else {
      return nil
    }
    return NativeRichEditorReferenceInsertionCandidate(
      body: candidate,
      selection: committedSelection
    )
  }

  private func isSelection(
    _ selection: AttributedTextSelection,
    validFor mode: NativeRichEditorReferenceInsertionMode
  ) -> Bool {
    switch (mode, selection.indices(in: body)) {
    case (.insertAtCaret, .insertionPoint):
      return true

    case (.replaceTrigger, .ranges(let ranges)):
      let selectedRanges = ranges.ranges
      guard selectedRanges.count == 1, let range = selectedRanges.first else { return false }
      let trigger = String(body[range].characters)
      return trigger == "@" || trigger == "[["

    case (.applyToSelectedText, .ranges(let ranges)):
      let selectedRanges = ranges.ranges
      return !selectedRanges.isEmpty && selectedRanges.allSatisfy { !$0.isEmpty }

    default:
      return false
    }
  }

  private func finishTaggedPageCommit(
    _ commit: NativeRichEditorTaggedPageCommit,
    result: TaggedPageReferenceInsertionResult,
    reference: NativeRichEditorReferenceInsertionCandidate,
    pickerID: UUID
  ) {
    let isCurrentEditor = isCurrentTaggedPageCommit(commit)
    clearTaggedPageCommit(commit)
    guard isCurrentEditor else { return }

    do {
      let content = try PageDocument.richText(in: result.source.document)
      let restoredSelection = reference.selection.selection(in: content.body)
      installCommittedTaggedPageSource(
        result.source,
        title: content.title,
        body: content.body,
        selection: restoredSelection ?? AttributedTextSelection()
      )
      if restoredSelection == nil {
        setInteractionError("The page was created, but the insertion selection could not be restored.")
      } else {
        interactionErrorMessage = nil
      }
      if pickerSession?.id == pickerID, isPickerPresented(.taggedPages) {
        dismissPicker(reason: .inserted)
      }
    } catch {
      // The transaction already made the source and target durable. The exact
      // candidate body was committed with it, so retain its page-reference
      // mark rather than falling back to unmarked plain text.
      installCommittedTaggedPageSource(
        result.source,
        title: result.source.title,
        body: reference.body,
        selection: reference.selection.selection(in: reference.body) ?? AttributedTextSelection()
      )
      setInteractionError("The page was created, but its rich text could not be restored: \(error.localizedDescription)")
      if pickerSession?.id == pickerID, isPickerPresented(.taggedPages) {
        dismissPicker(reason: .inserted)
      }
    }
  }

  private func installCommittedTaggedPageSource(
    _ snapshot: PageSnapshot,
    title committedTitle: String,
    body committedBody: AttributedString,
    selection committedSelection: AttributedTextSelection
  ) {
    title = committedTitle
    body = committedBody
    selection = committedSelection
    persistedTitle = committedTitle
    persistedBody = committedBody
    observedTitle = committedTitle
    observedBody = committedBody
    durableSnapshot = snapshot
    editRevision &+= 1
    durableRevision = editRevision
    errorMessage = nil
  }

  private func finishTaggedPageCommit(
    _ commit: NativeRichEditorTaggedPageCommit,
    error: String
  ) {
    let isCurrentEditor = isCurrentTaggedPageCommit(commit)
    clearTaggedPageCommit(commit)
    guard isCurrentEditor else { return }
    setInteractionError(error)
  }

  private func isCurrentTaggedPageCommit(_ commit: NativeRichEditorTaggedPageCommit) -> Bool {
    taggedPageCommit?.id == commit.id
      && pageID == commit.sourcePageID
      && loadGeneration == commit.loadGeneration
  }

  private func clearTaggedPageCommit(_ commit: NativeRichEditorTaggedPageCommit) {
    guard taggedPageCommit?.id == commit.id else { return }
    taggedPageCommit = nil
  }

  private func invalidatePicker(_ message: String) {
    setInteractionError(message)
    dismissPicker(reason: .invalidated)
  }

  private func setInteractionError(_ message: String) {
    interactionErrorMessage = message
  }

  private func pickerContext(
    for picker: NativeRichEditorInlinePicker
  ) -> NativeRichEditorPickerRequest? {
    guard let session = pickerSession, isPickerPresented(picker) else { return nil }
    let query = picker == .references ? referenceQuery : taggedPageQuery
    return NativeRichEditorPickerRequest(
      id: session.id,
      picker: picker,
      pageID: session.sourcePageID,
      query: query
    )
  }

  private var selectedRanges: [Range<AttributedString.Index>] {
    guard case .ranges(let ranges) = selection.indices(in: body) else { return [] }
    return ranges.ranges.filter { !$0.isEmpty }
  }

  private var selectionSnapshot: NativeRichEditorSelectionSnapshot? {
    guard let pageID,
      let committedSelection = NativeRichEditorCommittedSelection(from: selection, in: body)
    else { return nil }
    return NativeRichEditorSelectionSnapshot(
      pageID: pageID,
      bodyRevision: editRevision,
      selection: committedSelection
    )
  }

  private func selectionSnapshot(for range: Range<AttributedString.Index>) -> NativeRichEditorSelectionSnapshot? {
    guard let pageID,
      let committedSelection = NativeRichEditorCommittedSelection(
        from: AttributedTextSelection(range: range),
        in: body
      )
    else { return nil }
    return NativeRichEditorSelectionSnapshot(
      pageID: pageID,
      bodyRevision: editRevision,
      selection: committedSelection
    )
  }

  private func validSelection(from snapshot: NativeRichEditorSelectionSnapshot) -> AttributedTextSelection? {
    guard snapshot.pageID == pageID, snapshot.bodyRevision == editRevision else { return nil }
    return snapshot.selection.selection(in: body)
  }
}

private struct NativeRichEditorSelectionSnapshot {
  let pageID: PageID
  let bodyRevision: UInt64
  let selection: NativeRichEditorCommittedSelection
}

@MainActor
private final class NativeRichEditorSaveOperation {
  let token: UUID
  let pageID: PageID
  let revision: UInt64
  let title: String
  let body: AttributedString
  var task: Task<NativeRichEditorSaveResult, Never>?

  init(token: UUID, pageID: PageID, revision: UInt64, title: String, body: AttributedString) {
    self.token = token
    self.pageID = pageID
    self.revision = revision
    self.title = title
    self.body = body
  }
}

private enum NativeRichEditorSaveResult {
  case success(PageSnapshot)
  case failure(String)
  case stale
}

private struct RichPageEditor<Header: View>: View {
  private enum FocusedField: Hashable {
    case title
    case body
    case inlinePickerSearch
  }

  private enum EditorMode {
    case browse
    case edit
  }

  let page: PageSnapshot
  let calendarContext: CalendarPageContext?
  let store: LibraryStore
  let flushController: EditorFlushController
  let findController: EditorFindController
  let presentation: PageEditorPresentation<Header>
  let openPage: (PageID) -> Void

  @State private var editor: NativeRichPageEditorState
  @FocusState private var focusedField: FocusedField?
  @Environment(\.colorSchemeContrast) private var colorSchemeContrast
  @State private var bodyWasFocusedBeforePicker = false
  @State private var pickerSourcePageID: PageID?
  @State private var editorMode: EditorMode = .browse
  @State private var isFinishingEditing = false

  init(
    page: PageSnapshot,
    calendarContext: CalendarPageContext?,
    store: LibraryStore,
    flushController: EditorFlushController,
    findController: EditorFindController,
    presentation: PageEditorPresentation<Header>,
    openPage: @escaping (PageID) -> Void
  ) {
    self.page = page
    self.calendarContext = calendarContext
    self.store = store
    self.flushController = flushController
    self.findController = findController
    self.presentation = presentation
    self.openPage = openPage
    _editor = State(initialValue: NativeRichPageEditorState(store: store))
  }

  var body: some View {
    @Bindable var editor = editor

    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        presentation.header()
        calendarContextView

        if presentation.showsEditableTitle {
          if editorMode == .browse {
            Text(editor.title.isEmpty ? "Untitled" : editor.title)
              .font(.system(size: 34, weight: .bold, design: .default))
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.bottom, 20)
              .accessibilityIdentifier("page-browser-title")
              .accessibilityLabel("Page title")
          } else {
            TextField("Untitled", text: $editor.title, axis: .vertical)
              .font(.system(size: 34, weight: .bold, design: .default))
              .textFieldStyle(.plain)
              .focused($focusedField, equals: .title)
              .padding(.bottom, 20)
              .accessibilityIdentifier("page-editor-title")
              .accessibilityLabel("Page title")
              .disabled(editor.isMutationLocked)
          }
        }

        if editorMode == .browse {
          if editor.body.characters.isEmpty {
            Text("Start writing...")
              .foregroundStyle(.tertiary)
              .padding(.top, 8)
              .frame(minHeight: 440, alignment: .topLeading)
              .accessibilityIdentifier("page-browser-empty-body")
          } else {
            Text(browseBody)
              .font(.body)
              .frame(maxWidth: .infinity, minHeight: 440, alignment: .topLeading)
              .accessibilityIdentifier("page-browser-body")
              .accessibilityLabel("Page body")
              .environment(
                \.openURL,
                OpenURLAction { url in
                  handleBrowseURL(url)
                }
              )
          }
        } else {
          ZStack(alignment: .topLeading) {
            if editor.body.characters.isEmpty {
              Text("Start writing...")
                .foregroundStyle(.tertiary)
                .padding(.top, 8)
                .allowsHitTesting(false)
            }

            TextEditor(text: $editor.body, selection: $editor.selection)
              .font(.body)
              .attributedTextFormattingDefinition(
                PageReferenceTextFormattingDefinition(
                  palette: PageReferencePalette(contrast: colorSchemeContrast)
                )
              )
              .focused($focusedField, equals: .body)
              .scrollContentBackground(.hidden)
              .frame(minHeight: 440, alignment: .top)
              .accessibilityIdentifier("page-editor-body")
              .accessibilityLabel("Page body")
              .disabled(editor.isMutationLocked)
          }
        }

        if let errorMessage = editor.interactionErrorMessage ?? editor.errorMessage {
          Label(errorMessage, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.red)
            .padding(.top, 12)
            .accessibilityIdentifier("page-editor-error")
            .accessibilityLabel("Editor error: \(errorMessage)")
        }
      }
      .frame(maxWidth: 760, alignment: .leading)
      .padding(.horizontal, 24)
      .padding(.vertical, 20)
    }
    .findNavigator(isPresented: $editor.showsFind)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        editorModeButton
      }
    }
    #if os(iOS)
    .toolbar {
      ToolbarItemGroup(placement: .keyboard) {
        if focusedField == .body, editor.inlinePicker == nil {
          Menu {
            formattingMenuToggle("Bold", symbol: "bold", intent: .stronglyEmphasized)
            formattingMenuToggle("Italic", symbol: "italic", intent: .emphasized)
            formattingMenuToggle("Strikethrough", symbol: "strikethrough", intent: .strikethrough)
            formattingMenuToggle("Inline Code", symbol: "chevron.left.forwardslash.chevron.right", intent: .code)
          } label: {
            Label("Format", systemImage: "textformat")
          }
          .accessibilityIdentifier("page-editor-format-menu")
          .accessibilityLabel("Format")
          .disabled(editor.isMutationLocked)

          Button {
            editor.showReferencePicker()
          } label: {
            Label("Insert Page or Date", systemImage: "at")
          }
          .accessibilityIdentifier("page-editor-reference")
          .accessibilityLabel("Insert page or date")
          .disabled(editor.isLoading || editor.isMutationLocked)

          if editor.hasSelectedText {
            Menu {
              Button {
                editor.showSupertagPicker()
              } label: {
                Label("Apply Supertag", systemImage: "number")
              }
              .accessibilityIdentifier("page-editor-supertag")
            } label: {
              Label("Insert", systemImage: "plus")
            }
            .accessibilityIdentifier("page-editor-insert-menu")
            .accessibilityLabel("Insert")
            .disabled(editor.isLoading || editor.isMutationLocked)
          }
        }

        if editorMode == .edit, focusedField != nil {
          Spacer()

          Button {
            focusedField = nil
          } label: {
            Label("Dismiss Keyboard", systemImage: "keyboard.chevron.compact.down")
          }
          .accessibilityIdentifier("page-editor-dismiss-keyboard")
          .accessibilityLabel("Dismiss Keyboard")
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if editor.inlinePicker != nil {
        inlinePickerTray
      }
    }
    #else
    .safeAreaInset(edge: .bottom) {
      if editorMode == .edit {
        formattingBar
      }
    }
    .sheet(isPresented: $editor.isPalettePresented, onDismiss: {
      editor.dismissPalette()
    }) {
      NativeRichEditorPalette(editor: editor)
    }
    #endif
    .onAppear {
      flushController.register(editor.registrationID) { [weak editor] in
        await editor?.flush() ?? true
      }
      findController.register(editor.registrationID) { [weak editor] in
        editorMode = .edit
        editor?.showsFind = true
      }
    }
    .onDisappear {
      flushController.unregister(editor.registrationID)
      findController.unregister(editor.registrationID)
      Task { _ = await editor.flush() }
    }
    .task(id: page.id) {
      focusedField = nil
      bodyWasFocusedBeforePicker = false
      pickerSourcePageID = nil
      editorMode = .browse
      isFinishingEditing = false
      editor.load(page)
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
    #if os(iOS)
    .onChange(of: editor.inlinePicker) { wasPresented, isPresented in
      if wasPresented == nil, isPresented != nil {
        bodyWasFocusedBeforePicker = focusedField == .body
        pickerSourcePageID = editor.inlinePickerSourcePageID
        focusedField = .inlinePickerSearch
      } else if wasPresented != nil, isPresented == nil {
        let shouldRestoreBody = bodyWasFocusedBeforePicker
          && pickerSourcePageID == page.id
          && (editor.pickerDismissalReason == .userCancelled || editor.pickerDismissalReason == .inserted)
        if !editor.isMutationLocked {
          focusedField = shouldRestoreBody ? .body : nil
        }
        bodyWasFocusedBeforePicker = false
        pickerSourcePageID = nil
      }
    }
    #else
    .onChange(of: editor.isPalettePresented) { wasPresented, isPresented in
      if !wasPresented, isPresented {
        bodyWasFocusedBeforePicker = focusedField == .body
      } else if wasPresented, !isPresented {
        editor.dismissPalette()
        if bodyWasFocusedBeforePicker, !editor.isMutationLocked { focusedField = .body }
        bodyWasFocusedBeforePicker = false
      }
    }
    #endif
  }

  private var browseBody: AttributedString {
    PageReferenceBrowseProjection.make(
      from: editor.body,
      vaultID: store.vaultID,
      palette: PageReferencePalette(contrast: colorSchemeContrast)
    ) { pageID in
      store.page(id: pageID)?.deletedAt == nil
    }
  }

  @ViewBuilder
  private var editorModeButton: some View {
    switch editorMode {
    case .browse:
      Button {
        editorMode = .edit
        focusedField = .body
      } label: {
        Label("Edit", systemImage: "pencil")
      }
      .accessibilityIdentifier("page-editor-edit")
      .accessibilityLabel("Edit page")
      .disabled(editor.isLoading || editor.isMutationLocked)
    case .edit:
      Button {
        finishEditing()
      } label: {
        Label("Done", systemImage: "checkmark")
      }
      .accessibilityIdentifier("page-editor-done")
      .accessibilityLabel("Finish editing")
      .disabled(
        editor.isLoading
          || editor.isMutationLocked
          || editor.inlinePicker != nil
          || isFinishingEditing
      )
    }
  }

  private func finishEditing() {
    guard editor.inlinePicker == nil, !isFinishingEditing else { return }
    isFinishingEditing = true
    Task { @MainActor in
      guard await editor.flush() else {
        isFinishingEditing = false
        return
      }
      focusedField = nil
      editorMode = .browse
      isFinishingEditing = false
    }
  }

  private func handleBrowseURL(_ url: URL) -> OpenURLAction.Result {
    guard let destination = PageReferenceBrowseLink.destination(from: url),
      destination.vaultID == store.vaultID,
      let page = store.page(id: destination.pageID),
      page.deletedAt == nil
    else { return .discarded }

    openPage(destination.pageID)
    return .handled
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

  #if os(macOS)
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
      .accessibilityIdentifier("page-editor-reference")
      .disabled(editor.isLoading || editor.isMutationLocked)

      Button {
        editor.showSupertagPicker()
      } label: {
        Label("Apply Supertag", systemImage: "number")
      }
      .help("Apply a supertag to selected text")
      .accessibilityIdentifier("page-editor-supertag")
      .disabled(editor.isLoading || editor.isMutationLocked || !editor.hasSelectedText)
      .keyboardShortcut("9", modifiers: [.command, .shift])

    }
    .labelStyle(.iconOnly)
    .buttonStyle(.borderless)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.bar)
    .accessibilityIdentifier("page-editor-keyboard-commands")
  }
  #endif

  private func formattingMenuToggle(
    _ title: String,
    symbol: String,
    intent: InlinePresentationIntent
  ) -> some View {
    Toggle(
      isOn: Binding(
        get: { editor.formattingState(for: intent) == .on },
        set: { _ in editor.toggle(intent) }
      )
    ) {
      Label(title, systemImage: symbol)
    }
    .accessibilityIdentifier("page-editor-format-\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
    .accessibilityValue(editor.formattingState(for: intent).accessibilityValue)
    .disabled(editor.isMutationLocked)
  }

  @ViewBuilder
  private var inlinePickerTray: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        TextField(inlinePickerPrompt, text: inlinePickerQuery)
          .textFieldStyle(.roundedBorder)
          .focused($focusedField, equals: .inlinePickerSearch)
          .frame(maxWidth: .infinity, minHeight: 44)
          .disabled(editor.isMutationLocked)
          .accessibilityIdentifier("page-editor-inline-picker-search")
          .accessibilityLabel(inlinePickerPrompt)

        Button("Cancel") {
          editor.dismissPicker()
        }
        .frame(minHeight: 44)
        .disabled(editor.isMutationLocked)
        .accessibilityIdentifier("page-editor-inline-picker-cancel")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)

      Divider()

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          switch editor.inlinePicker {
          case .references:
            inlineReferenceSuggestions
          case .supertags:
            inlineSupertagSuggestions
          case .taggedPages:
            inlineTaggedPageSuggestions
          case nil:
            EmptyView()
          }
        }
        .disabled(editor.isMutationLocked)
      }
      .frame(maxHeight: 264)
      .accessibilityIdentifier("page-editor-inline-picker-results")
    }
    .background(.bar)
    .accessibilityIdentifier("page-editor-inline-picker")
  }

  private var inlinePickerPrompt: String {
    switch editor.inlinePicker {
    case .references: "Find a page or date"
    case .supertags: "Find a supertag"
    case .taggedPages: "Find or create a page"
    case nil: "Search"
    }
  }

  private var inlinePickerQuery: Binding<String> {
    switch editor.inlinePicker {
    case .references:
      Binding(get: { editor.referenceQuery }, set: { editor.referenceQuery = $0 })
    case .supertags:
      Binding(get: { editor.supertagQuery }, set: { editor.supertagQuery = $0 })
    case .taggedPages:
      Binding(get: { editor.taggedPageQuery }, set: { editor.taggedPageQuery = $0 })
    case nil: .constant("")
    }
  }

  @ViewBuilder
  private var inlineReferenceSuggestions: some View {
    Group {
      if editor.referenceSuggestions.isEmpty && editor.dailyReferenceSuggestions().isEmpty {
        inlinePickerEmptyState("No matching pages or daily notes")
      } else {
        ForEach(editor.referenceSuggestions.prefix(6)) { suggestion in
          inlinePickerRow(
            title: suggestion.editorDisplayTitle,
            subtitle: suggestion.displaySubtitle
          ) {
            editor.chooseReference(suggestion)
          }
        }
        ForEach(editor.dailyReferenceSuggestions().prefix(4)) { suggestion in
          inlinePickerRow(title: suggestion.title, subtitle: suggestion.subtitle) {
            editor.chooseDailyReference(suggestion)
          }
        }
      }
    }
    .task(id: editor.referencePickerRequestID) {
      await editor.refreshReferenceSuggestions()
    }
  }

  @ViewBuilder
  private var inlineSupertagSuggestions: some View {
    if editor.matchingSupertags.isEmpty {
      inlinePickerEmptyState("No matching supertags")
    } else {
      ForEach(editor.matchingSupertags) { supertag in
        inlinePickerRow(title: supertag.name, subtitle: "Apply to selected text") {
          editor.chooseSupertag(supertag)
        }
      }
    }
  }

  @ViewBuilder
  private var inlineTaggedPageSuggestions: some View {
    Group {
      if let supertag = editor.activeSupertag {
        if !editor.taggedPageQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          inlinePickerRow(
            title: supertag.id == BuiltInSupertags.task
              ? "Create Task “\(editor.taggedPageQuery)”"
              : "Create “\(editor.taggedPageQuery)” as #\(supertag.name)",
            subtitle: "New tagged page"
          ) {
            Task { await editor.createTaggedPage() }
          }
          .accessibilityIdentifier("page-editor-inline-picker-create")
          .disabled(editor.isMutationLocked)
        }
        ForEach(editor.taggedPageSuggestions.prefix(6)) { suggestion in
          inlinePickerRow(
            title: suggestion.editorDisplayTitle,
            subtitle: suggestion.displaySubtitle
          ) {
            editor.chooseTaggedPage(suggestion)
          }
        }
        if editor.taggedPageSuggestions.isEmpty,
          editor.taggedPageQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
          inlinePickerEmptyState("Type a page name to find or create one")
        }
      } else {
        inlinePickerEmptyState("Choose a supertag first")
      }
    }
    .task(id: editor.taggedPagePickerRequestID) {
      await editor.refreshTaggedPageSuggestions()
    }
  }

  private func inlinePickerEmptyState(_ title: String) -> some View {
    Text(title)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .padding(.horizontal, 16)
  }

  private func inlinePickerRow(
    title: String,
    subtitle: String?,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .foregroundStyle(.primary)
        if let subtitle {
          Text(subtitle)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .padding(.horizontal, 16)
      .padding(.vertical, 4)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("page-editor-inline-picker-result-\(title)")
  }

  #if os(macOS)
  private func formattingButton(
    _ title: String,
    symbol: String,
    intent: InlinePresentationIntent
  ) -> some View {
    Button {
      editor.toggle(intent)
    } label: {
      let state = editor.formattingState(for: intent)
      ZStack(alignment: .bottomTrailing) {
        Image(systemName: symbol)

        if state != .off {
          Image(systemName: state == .on ? "checkmark" : "minus")
            .font(.system(size: 7, weight: .bold))
            .frame(width: 12, height: 12)
            .background(Circle().fill(.background))
            .overlay {
              Circle()
                .stroke(.secondary, lineWidth: 1)
            }
            .offset(x: 4, y: 4)
            .accessibilityHidden(true)
        }
      }
    }
    .disabled(editor.isLoading || editor.isMutationLocked)
    .accessibilityIdentifier("page-editor-format-\(title.lowercased())")
    .accessibilityValue(editor.formattingState(for: intent).accessibilityValue)
    .tint(editor.formattingState(for: intent) == .on ? .accentColor : nil)
  }
  #endif
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
        .disabled(editor.isMutationLocked)
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
                title: suggestion.editorDisplayTitle,
                subtitle: suggestion.displaySubtitle
              )
            }
            .disabled(editor.isMutationLocked)
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
            .disabled(editor.isMutationLocked)
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
            .disabled(editor.isMutationLocked)
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
          .disabled(
            editor.taggedPageQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || editor.isMutationLocked
          )
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
                  title: suggestion.editorDisplayTitle,
                  subtitle: suggestion.displaySubtitle
                )
              }
              .disabled(editor.isMutationLocked)
            }
          }
        }
      }
      .navigationTitle("#\(supertag.name)")
      .searchable(text: $editor.taggedPageQuery, prompt: "Find or create a page")
      .disabled(editor.isMutationLocked)
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
    .disabled(editor.isMutationLocked || (command == .supertag && !editor.hasSelectedText))
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
