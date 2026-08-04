import EnchiridionCore
import SwiftUI

/// Compiled renderers are opt-in. The caller always retains `LiveViewKind` as a safe fallback.
@MainActor
public final class ModuleViewRendererRegistry {
  public typealias Renderer = @MainActor (ModuleViewContext) -> AnyView
  public static let shared = ModuleViewRendererRegistry()
  private var renderers: [ViewTypeID: Renderer] = [:]

  public func register(_ typeID: ViewTypeID, renderer: @escaping Renderer) throws {
    guard renderers[typeID] == nil else { throw ModuleViewRendererRegistryError.duplicate(typeID) }
    renderers[typeID] = renderer
  }

  func renderer(for typeID: ViewTypeID?) -> Renderer? {
    typeID.flatMap { renderers[$0] }
  }
}

public enum ModuleViewRendererRegistryError: Error, Equatable {
  case duplicate(ViewTypeID)
}

struct LiveViewScreen: View {
  let store: LibraryStore
  let definition: LiveQueryDefinition
  let openPage: (PageID) -> Void
  @State private var editingView: LiveQueryDefinition?
  @State private var showingDeleteConfirmation = false
  @State private var selectedBoardColumnID: String?
  @State private var previousBoardColumnIDs: [String] = []

  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
  #endif

  private var items: [LiveQueryItem] { store.liveViewItems[definition.id] ?? [] }

  var body: some View {
    Group {
      if let renderer = ModuleViewRendererRegistry.shared.renderer(for: definition.viewTypeID) {
        renderer(ModuleViewContext(vaultID: store.vaultID, definition: definition, items: items) { command in
          switch command {
          case .openPage(let scopedID) where scopedID.vaultID == store.vaultID:
            openPage(PageID(rawValue: scopedID.nodeID.rawValue))
          case .openPage:
            break
          }
        })
      } else {
        switch definition.viewKind {
        case .list: list
        case .table: table
        case .board: board
        case .calendar: calendar
        case .canvas: canvas
        }
      }
    }
    .navigationTitle(definition.name)
    .toolbar {
      Menu {
        Button {
          editingView = definition
        } label: {
          Label("Edit View", systemImage: "line.3.horizontal.decrease.circle")
        }
        Button {
          store.duplicateView(definition)
        } label: {
          Label("Duplicate View", systemImage: "plus.square.on.square")
        }
        Divider()
        Button(role: .destructive) {
          showingDeleteConfirmation = true
        } label: {
          Label("Delete View", systemImage: "trash")
        }
      } label: {
        Label("View Options", systemImage: "ellipsis.circle")
      }
    }
    .sheet(item: $editingView) { view in
      LiveViewEditor(store: store, definition: view)
    }
    .confirmationDialog(
      "Delete \(definition.name)?",
      isPresented: $showingDeleteConfirmation,
      titleVisibility: .visible
    ) {
      Button("Delete View", role: .destructive) { store.deleteView(definition.id) }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("The saved view will disappear on every synced device. Your pages are not deleted.")
    }
  }

  private var list: some View {
    List(items) { item in itemButton(item) }
  }

  private var table: some View {
    ScrollView([.horizontal, .vertical]) {
      Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 10) {
        GridRow {
          Text("Name").bold()
          ForEach(definition.visibleFieldIDs) { fieldID in
            Text(fieldName(fieldID)).bold()
          }
        }
        Divider()
        ForEach(items) { item in
          GridRow {
            itemButton(item)
            ForEach(definition.visibleFieldIDs) { fieldID in
              Text(value(for: item, fieldID: fieldID)).foregroundStyle(.secondary)
            }
          }
        }
      }
      .padding()
    }
  }

  @ViewBuilder
  private var board: some View {
    #if os(iOS)
      if horizontalSizeClass == .compact {
        compactBoard
      } else {
        regularBoard
      }
    #else
      regularBoard
    #endif
  }

  private var regularBoard: some View {
    ScrollView(.horizontal) {
      HStack(alignment: .top, spacing: 12) {
        ForEach(boardOptions, id: \.id) { option in
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text(option.name).font(.headline)
              Spacer()
              Text(boardItems(option.id).count.formatted()).foregroundStyle(.secondary)
            }
            ForEach(boardItems(option.id)) { item in
              itemButton(item)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                .draggable(item.id)
            }
          }
          .padding(12)
          .frame(width: 240, alignment: .topLeading)
          .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
          .dropDestination(for: String.self) { identifiers, _ in
            guard let itemID = identifiers.first,
              let item = items.first(where: { $0.id == itemID })
            else { return false }
            return moveBoardItem(item, to: option.id)
          }
        }
      }
      .padding()
    }
  }

  #if os(iOS)
    private var compactBoard: some View {
      GeometryReader { proxy in
        if boardOptions.isEmpty {
          ContentUnavailableView(
            "Board Unavailable",
            systemImage: "rectangle.3.group",
            description: Text("Choose a select field with columns to use this board on iPhone."))
        } else {
          TabView(selection: compactBoardSelection) {
            ForEach(boardOptions, id: \.id) { option in
              compactBoardColumn(option)
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
                .tag(option.id)
            }
          }
          .tabViewStyle(.page(indexDisplayMode: .never))
          .onAppear(perform: reconcileBoardColumnSelection)
          .onChange(of: boardColumnIdentity) { _, _ in resetBoardColumnSelection() }
          .onChange(of: boardOptionIDs) { _, _ in reconcileBoardColumnSelection() }
        }
      }
      .background(EnchiridionRosePine.base)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var compactBoardSelection: Binding<String?> {
      Binding(
        get: { selectedBoardColumnID },
        set: { newValue in
          withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.24)) {
            selectedBoardColumnID = newValue
          }
        }
      )
    }

    private func compactBoardColumn(_ option: SupertagSelectOption) -> some View {
      let columnIndex = boardOptionIDs.firstIndex(of: option.id).map { $0 + 1 } ?? 1
      return ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
              Text(option.name)
                .font(.title2.weight(.semibold))
                .foregroundStyle(EnchiridionRosePine.text)
              Text("Column \(columnIndex) of \(boardOptions.count)")
                .font(.subheadline)
                .foregroundStyle(EnchiridionRosePine.secondary)
            }
            Spacer(minLength: 12)
            Text(boardItems(option.id).count.formatted())
              .font(.title3.monospacedDigit().weight(.semibold))
              .foregroundStyle(EnchiridionRosePine.iris)
              .accessibilityLabel("\(boardItems(option.id).count) items")
          }

          Picker("Board column", selection: compactBoardSelection) {
            ForEach(boardOptions, id: \.id) { candidate in
              Text(candidate.name).tag(Optional(candidate.id))
            }
          }
          .pickerStyle(.menu)
          .frame(minHeight: 44, alignment: .leading)
          .accessibilityHint("Select a board column")

          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(boardItems(option.id)) { item in
              compactBoardCard(item, currentColumnID: option.id)
            }
          }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(EnchiridionRosePine.base)
    }

    @ViewBuilder
    private func compactBoardCard(_ item: LiveQueryItem, currentColumnID: String) -> some View {
      HStack(alignment: .top, spacing: 12) {
        itemButton(item)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)

        if boardOptions.contains(where: { $0.id != currentColumnID }) {
          Menu {
            ForEach(boardOptions.filter { $0.id != currentColumnID }, id: \.id) { destination in
              Button("Move to \(destination.name)") {
                _ = moveBoardItem(item, to: destination.id)
              }
            }
          } label: {
            Label("Move item", systemImage: "arrow.right.circle")
              .labelStyle(.iconOnly)
              .frame(minWidth: 44, minHeight: 44)
          }
          .accessibilityLabel("Move \(item.title)")
        }
      }
      .padding(14)
      .background(EnchiridionRosePine.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(EnchiridionRosePine.overlay, lineWidth: 1)
      }
    }
  #endif

  private var calendar: some View {
    List {
      ForEach(
        Dictionary(grouping: datedItems, by: { Calendar.current.startOfDay(for: $0.date) })
          .keys.sorted(), id: \.self
      ) { day in
        Section(day.formatted(date: .complete, time: .omitted)) {
          ForEach(
            datedItems.filter { Calendar.current.isDate($0.date, inSameDayAs: day) }, id: \.item.id
          ) { dated in
            HStack {
              itemButton(dated.item)
              Spacer()
              if case .event = dated.item {
                VStack(alignment: .trailing) {
                  Text(timeRange(start: dated.date, end: dated.endDate))
                  Label("Calendar", systemImage: "lock")
                }
                .font(.caption).foregroundStyle(.secondary)
              } else {
                Text(timeRange(start: dated.date, end: dated.endDate))
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private var canvas: some View {
    switch definition.source {
    case .pages, .supertag:
      WhiteboardCanvasView(
        store: store,
        definition: definition,
        items: items,
        openPage: openPage
      )
    case .calendarEvents, .workCalendar:
      ContentUnavailableView(
        "Canvas Unavailable",
        systemImage: "calendar.badge.exclamationmark",
        description: Text(
          "Calendar events are read-only. Choose Pages or a Supertag as this view’s source.")
      )
    }
  }

  @ViewBuilder
  private func itemButton(_ item: LiveQueryItem) -> some View {
    switch item {
    case .page(let page):
      Button(page.displayTitle) { openPage(page.id) }.buttonStyle(.plain)
    case .event(let event):
      VStack(alignment: .leading) {
        Text(event.title)
        Text(event.startDate.formatted(date: .abbreviated, time: .shortened))
          .font(.caption).foregroundStyle(.secondary)
      }
    }
  }

  private var sourceTag: SupertagDefinition? {
    guard case .supertag(let id) = definition.source else { return nil }
    return store.supertags.first { $0.id == id }
  }

  private var boardOptions: [SupertagSelectOption] {
    guard let fieldID = definition.groupFieldID,
      let field = sourceTag?.fields.first(where: {
        $0.id == fieldID && !$0.isDeleted && $0.type == .select
      })
    else { return [] }
    let options = field.options
    return [.init(id: "__unset", name: "No status", color: "gray")] + options
  }

  private var boardOptionIDs: [String] { boardOptions.map(\.id) }

  private var boardColumnIdentity: String {
    let source: String
    switch definition.source {
    case .pages: source = "pages"
    case .supertag(let id): source = "supertag:\(id.rawValue)"
    case .calendarEvents: source = "calendar-events"
    case .workCalendar: source = "work-calendar"
    }
    return "\(definition.id.rawValue)|\(source)|\(definition.groupFieldID?.rawValue ?? "none")"
  }

  private func moveBoardItem(_ item: LiveQueryItem, to destinationID: String) -> Bool {
    guard let mutation = LiveViewBoardMove.mutation(
      item: item,
      source: definition.source,
      groupFieldID: definition.groupFieldID,
      destinationID: destinationID,
      validDestinationIDs: Set(boardOptionIDs)
    ) else { return false }

    store.setProperty(
      pageID: mutation.pageID,
      supertagID: mutation.supertagID,
      fieldID: mutation.fieldID,
      values: mutation.values
    )
    return true
  }

  #if os(iOS)
    private func reconcileBoardColumnSelection() {
      let reconciled = LiveViewBoardColumnSelection.reconciled(
        currentSelection: selectedBoardColumnID,
        previousOptionIDs: previousBoardColumnIDs,
        optionIDs: boardOptionIDs
      )
      selectedBoardColumnID = reconciled
      previousBoardColumnIDs = boardOptionIDs
    }

    private func resetBoardColumnSelection() {
      selectedBoardColumnID = nil
      previousBoardColumnIDs = []
      reconcileBoardColumnSelection()
    }
  #endif

  private func boardItems(_ optionID: String) -> [LiveQueryItem] {
    guard let fieldID = definition.groupFieldID, case .supertag(let tagID) = definition.source
    else { return [] }
    let key = SupertagPropertyKey(supertagID: tagID, fieldID: fieldID)
    return items.filter { item in
      guard case .page(let page) = item else { return false }
      if optionID == "__unset" { return page.objectMetadata.properties[key]?.isEmpty != false }
      return page.objectMetadata.properties[key]?.contains(.select(optionID)) == true
    }
  }

  private func fieldName(_ id: SupertagFieldID) -> String {
    sourceTag?.fields.first(where: { $0.id == id })?.name ?? id.rawValue
  }

  private func value(for item: LiveQueryItem, fieldID: SupertagFieldID) -> String {
    guard case .page(let page) = item, case .supertag(let tagID) = definition.source else {
      return "—"
    }
    let key = SupertagPropertyKey(supertagID: tagID, fieldID: fieldID)
    return page.objectMetadata.properties[key]?.map { value in
      if case .page(let id) = value { return store.page(id: id)?.displayTitle ?? "Missing page" }
      if case .select(let optionID) = value {
        return sourceTag?.fields.first(where: { $0.id == fieldID })?
          .options.first(where: { $0.id == optionID })?.name ?? optionID
      }
      return value.displayValue
    }.joined(separator: ", ") ?? "—"
  }

  private var datedItems: [(item: LiveQueryItem, date: Date, endDate: Date?)] {
    items.compactMap { item in
      switch item {
      case .event(let event): return (item, event.startDate, event.endDate)
      case .page(let page):
        let preferredFields: [SupertagFieldID] = [
          definition.startFieldID,
          .init(rawValue: "due"),
          .init(rawValue: "due-date"),
          .init(rawValue: "start-date"),
        ].compactMap { $0 }
        for fieldID in preferredFields {
          if let start = dateValue(page: page, fieldID: fieldID) {
            let end = definition.endFieldID.flatMap { dateValue(page: page, fieldID: $0) }
            return (item, start, end)
          }
        }
        return nil
      }
    }.sorted { $0.date < $1.date }
  }

  private func dateValue(page: PageSnapshot, fieldID: SupertagFieldID) -> Date? {
    for (key, values) in page.objectMetadata.properties where key.fieldID == fieldID {
      if case .date(let value)? = values.first { return value }
      if case .dateTime(let value)? = values.first { return value }
    }
    return nil
  }

  private func timeRange(start: Date, end: Date?) -> String {
    let startText = start.formatted(date: .omitted, time: .shortened)
    guard let end, end > start else { return startText }
    return "\(startText)–\(end.formatted(date: .omitted, time: .shortened))"
  }
}

enum LiveViewEditorPurpose {
  case libraryView
  case taskPerspective
}

struct LiveViewEditor: View {
  let store: LibraryStore
  let definition: LiveQueryDefinition
  let purpose: LiveViewEditorPurpose
  @Environment(\.dismiss) private var dismiss
  @State private var draft: LiveQueryDefinition
  @State private var sql: String
  @State private var error: String?
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  #endif

  init(
    store: LibraryStore,
    definition: LiveQueryDefinition,
    purpose: LiveViewEditorPurpose = .libraryView
  ) {
    self.store = store
    self.definition = definition
    self.purpose = purpose
    _draft = State(initialValue: definition)
    _sql = State(initialValue: definition.domainSQL)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("View") {
          TextField("Name", text: $draft.name)
          if purpose == .taskPerspective {
            LabeledContent("Source", value: "Tasks")
            LabeledContent("Layout") {
              Label(LiveViewKind.list.title, systemImage: LiveViewKind.list.systemImage)
            }
          } else {
            Picker("Source", selection: $draft.source) {
              Text("All Pages").tag(LiveQuerySource.pages)
              Text("Calendar Events").tag(LiveQuerySource.calendarEvents)
              Text("Work Calendar").tag(LiveQuerySource.workCalendar)
              ForEach(store.supertags) { tag in
                Text(tag.name).tag(LiveQuerySource.supertag(tag.id))
              }
            }
            Picker("Layout", selection: $draft.viewKind) {
              ForEach(availableViewKinds, id: \.self) { kind in
                Label(kind.title, systemImage: kind.systemImage).tag(kind)
              }
            }
          }
          Stepper("Limit: \(draft.limit)", value: $draft.limit, in: 1...maximumLimit, step: 25)
          if canReturnPeople {
            Toggle("Include Other People", isOn: includeOthersBinding)
            Text(
              "Other People come from calendar events and stay out of views and mentions until you promote them."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
          }
          if draft.viewKind == .canvas {
            Text(
              "Canvas views place up to \(WhiteboardLimits.maximumPageCards) live-query page cards."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
          }
        }

        if !queryFields.isEmpty {
          Section("Filters") {
            ForEach($draft.filters) { $filter in
              AdaptiveQueryEditorRow(
                removeLabel: "Remove Filter",
                usesVerticalLayout: usesVerticalQueryLayout
              ) {
                draft.filters.removeAll { $0.id == filter.id }
              } content: {
                LiveQueryFilterRow(
                  filter: $filter,
                  fields: queryFields,
                  usesVerticalLayout: usesVerticalQueryLayout
                )
              }
            }
            .onDelete { draft.filters.remove(atOffsets: $0) }
            Button("Add Filter", systemImage: "plus") {
              draft.filters.append(
                .init(systemField: "title", operation: .contains, value: .text("")))
            }
          }

          Section("Sort") {
            ForEach(Array(draft.sorts.indices), id: \.self) { index in
              AdaptiveQueryEditorRow(
                removeLabel: "Remove Sort",
                usesVerticalLayout: usesVerticalQueryLayout
              ) {
                guard draft.sorts.indices.contains(index) else { return }
                draft.sorts.remove(at: index)
              } content: {
                LiveQuerySortRow(
                  sort: $draft.sorts[index],
                  fields: queryFields,
                  usesVerticalLayout: usesVerticalQueryLayout
                )
              }
            }
            .onDelete { draft.sorts.remove(atOffsets: $0) }
            Button("Add Sort", systemImage: "plus") {
              draft.sorts.append(.init(systemField: "title"))
            }
          }
        }

        if let sourceTag {
          Section("Display") {
            if draft.viewKind == .table {
              ForEach(sourceTag.fields.filter { !$0.isDeleted }) { field in
                Toggle(field.name, isOn: visibleBinding(field.id))
              }
            }
            if draft.viewKind == .board {
              Picker("Group by", selection: optionalFieldBinding(\LiveQueryDefinition.groupFieldID))
              {
                Text("Choose a field").tag("")
                ForEach(sourceTag.fields.filter { !$0.isDeleted && $0.type == .select }) { field in
                  Text(field.name).tag(field.id.rawValue)
                }
              }
            }
            if draft.viewKind == .calendar {
              Picker(
                "Start date", selection: optionalFieldBinding(\LiveQueryDefinition.startFieldID)
              ) {
                Text("Choose a field").tag("")
                ForEach(dateFields) { field in Text(field.name).tag(field.id.rawValue) }
              }
              Picker("End date", selection: optionalFieldBinding(\LiveQueryDefinition.endFieldID)) {
                Text("None").tag("")
                ForEach(dateFields) { field in Text(field.name).tag(field.id.rawValue) }
              }
            }
          }
        }

        Section("Advanced Query") {
          TextEditor(text: $sql).font(.system(.body, design: .monospaced)).frame(minHeight: 140)
          HStack {
            Button("Reset from Builder") {
              sql = draft.domainSQL
              error = nil
            }
            Button("Apply to Builder") { applySQL() }
          }
          Text(
            "Safe clauses: WHERE, SHOW, INCLUDE OTHERS, GROUP BY, DATES, ORDER BY, LIMIT, and VIEW. This language cannot execute raw SQLite."
          )
          .font(.caption).foregroundStyle(.secondary)
          if let error { Text(error).foregroundStyle(.red) }
        }
      }
      .formStyle(.grouped)
      .navigationTitle(editorTitle)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            save()
          }
          .disabled(draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    .onChange(of: draft.source) { _, _ in normalizeDisplayConfiguration() }
    .onChange(of: draft.viewKind) { _, _ in normalizeDisplayConfiguration() }
    .onChange(of: draft) { _, definition in sql = definition.domainSQL }
    #if os(macOS)
      .frame(minWidth: 520, minHeight: 620)
    #endif
  }

  private var sourceTag: SupertagDefinition? {
    guard case .supertag(let id) = draft.source else { return nil }
    return store.supertags.first { $0.id == id }
  }

  private var editorTitle: String {
    switch purpose {
    case .libraryView:
      definition.name == "New View" ? "New View" : "Edit View"
    case .taskPerspective:
      definition.name == "New Perspective" ? "New Perspective" : "Edit Perspective"
    }
  }

  private var dateFields: [SupertagFieldDefinition] {
    sourceTag?.fields.filter { !$0.isDeleted && ($0.type == .date || $0.type == .dateTime) } ?? []
  }

  private var availableViewKinds: [LiveViewKind] {
    switch draft.source {
    case .pages: return [.list, .table, .canvas]
    case .calendarEvents, .workCalendar: return [.list, .calendar]
    case .supertag:
      var kinds: [LiveViewKind] = [.list, .table, .canvas]
      if sourceTag?.fields.contains(where: { !$0.isDeleted && $0.type == .select }) == true {
        kinds.append(.board)
      }
      if !dateFields.isEmpty { kinds.append(.calendar) }
      return kinds
    }
  }

  private var maximumLimit: Int {
    draft.viewKind == .canvas ? WhiteboardLimits.maximumPageCards : 5_000
  }

  private var canReturnPeople: Bool {
    switch draft.source {
    case .pages, .supertag: true
    case .calendarEvents, .workCalendar: false
    }
  }

  private var includeOthersBinding: Binding<Bool> {
    Binding(
      get: { draft.peopleScope == .includeOthers },
      set: { draft.peopleScope = $0 ? .includeOthers : .promotedOnly }
    )
  }

  private var usesVerticalQueryLayout: Bool {
    #if os(iOS)
      horizontalSizeClass == .compact || dynamicTypeSize.isAccessibilitySize
    #else
      false
    #endif
  }

  private var queryFields: [LiveQueryFieldChoice] {
    var choices = [
      LiveQueryFieldChoice(id: "title", name: "Title", type: .text, isSystem: true),
      LiveQueryFieldChoice(id: "created", name: "Created", type: .dateTime, isSystem: true),
      LiveQueryFieldChoice(id: "modified", name: "Modified", type: .dateTime, isSystem: true),
      LiveQueryFieldChoice(id: "kind", name: "Kind", type: .text, isSystem: true),
    ]
    if draft.source == .calendarEvents || draft.source == .workCalendar {
      choices += [
        .init(id: "start", name: "Start", type: .dateTime, isSystem: true),
        .init(id: "end", name: "End", type: .dateTime, isSystem: true),
        .init(id: "calendar", name: "Calendar", type: .text, isSystem: true),
        .init(id: "source", name: "Source", type: .text, isSystem: true),
      ]
    }
    choices +=
      sourceTag?.fields.filter { !$0.isDeleted }.map {
        .init(id: $0.id.rawValue, name: $0.name, type: $0.type, options: $0.options)
      } ?? []
    return choices
  }

  private func visibleBinding(_ id: SupertagFieldID) -> Binding<Bool> {
    Binding(
      get: { draft.visibleFieldIDs.contains(id) },
      set: { visible in
        if visible, !draft.visibleFieldIDs.contains(id) { draft.visibleFieldIDs.append(id) }
        if !visible { draft.visibleFieldIDs.removeAll { $0 == id } }
      }
    )
  }

  private func optionalFieldBinding(
    _ keyPath: WritableKeyPath<LiveQueryDefinition, SupertagFieldID?>
  ) -> Binding<String> {
    Binding(
      get: { draft[keyPath: keyPath]?.rawValue ?? "" },
      set: { draft[keyPath: keyPath] = $0.isEmpty ? nil : .init(rawValue: $0) }
    )
  }

  private func normalizeDisplayConfiguration() {
    if !availableViewKinds.contains(draft.viewKind) {
      draft.viewKind = availableViewKinds.first ?? .list
    }
    let validQueryFieldIDs = Set(queryFields.map(\.id))
    draft.filters.removeAll {
      !validQueryFieldIDs.contains($0.systemField ?? $0.fieldID?.rawValue ?? "")
    }
    draft.sorts.removeAll {
      !validQueryFieldIDs.contains($0.systemField ?? $0.fieldID?.rawValue ?? "")
    }
    if draft.sorts.isEmpty {
      let field =
        (draft.source == .calendarEvents || draft.source == .workCalendar) ? "start" : "title"
      draft.sorts = [.init(systemField: field)]
    }
    if draft.viewKind == .canvas {
      draft.limit = min(draft.limit, WhiteboardLimits.maximumPageCards)
    }
    guard let sourceTag else {
      draft.visibleFieldIDs = []
      draft.groupFieldID = nil
      draft.startFieldID = nil
      draft.endFieldID = nil
      sql = draft.domainSQL
      return
    }
    let valid = Set(sourceTag.fields.filter { !$0.isDeleted }.map(\.id))
    draft.visibleFieldIDs.removeAll { !valid.contains($0) }
    if draft.viewKind == .board,
      draft.groupFieldID == nil || !valid.contains(draft.groupFieldID!)
    {
      draft.groupFieldID = sourceTag.fields.first { !$0.isDeleted && $0.type == .select }?.id
    }
    if draft.viewKind == .calendar,
      draft.startFieldID == nil || !valid.contains(draft.startFieldID!)
    {
      draft.startFieldID = dateFields.first?.id
    }
    sql = draft.domainSQL
  }

  private func applySQL() {
    do {
      let parsed = try DomainQueryCodec.parse(sql, id: draft.id, name: draft.name)
      try validatePurpose(parsed)
      draft = parsed
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  private func save() {
    do {
      draft.name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
      if draft.viewKind == .canvas {
        draft.limit = min(draft.limit, WhiteboardLimits.maximumPageCards)
      }
      if draft.viewKind == .board && draft.groupFieldID == nil {
        throw DomainQueryError.unsupported("A board needs a Select field to group by.")
      }
      if draft.viewKind == .calendar, case .supertag = draft.source, draft.startFieldID == nil {
        throw DomainQueryError.unsupported("A calendar needs a Date or Date & Time start field.")
      }
      try validatePurpose(draft)
      _ = try DomainQueryCodec.parse(draft.domainSQL, id: draft.id, name: draft.name)
      store.saveView(draft)
      dismiss()
    } catch { self.error = error.localizedDescription }
  }

  private func validatePurpose(_ definition: LiveQueryDefinition) throws {
    guard purpose != .taskPerspective || definition.isTaskListPerspective else {
      throw DomainQueryError.unsupported(
        "A task perspective must use the Tasks source and List layout."
      )
    }
  }
}

private struct LiveQueryFieldChoice: Identifiable, Hashable {
  let id: String
  let name: String
  let type: SupertagFieldType
  var options: [SupertagSelectOption] = []
  var isSystem = false
}

private struct AdaptiveQueryEditorRow<Content: View>: View {
  let removeLabel: String
  let usesVerticalLayout: Bool
  let remove: () -> Void
  let content: Content

  init(
    removeLabel: String,
    usesVerticalLayout: Bool,
    remove: @escaping () -> Void,
    @ViewBuilder content: () -> Content
  ) {
    self.removeLabel = removeLabel
    self.usesVerticalLayout = usesVerticalLayout
    self.remove = remove
    self.content = content()
  }

  var body: some View {
    if usesVerticalLayout {
      VStack(alignment: .leading, spacing: 10) {
        content
        removeButton
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      }
    } else {
      HStack {
        content
        removeButton.labelStyle(.iconOnly)
      }
    }
  }

  private var removeButton: some View {
    Button(role: .destructive, action: remove) {
      Label(removeLabel, systemImage: "minus.circle")
    }
    .buttonStyle(.borderless)
  }
}

private struct LiveQueryFilterRow: View {
  @Binding var filter: LiveQueryFilter
  let fields: [LiveQueryFieldChoice]
  let usesVerticalLayout: Bool

  private var choice: LiveQueryFieldChoice {
    fields.first { $0.id == fieldID.wrappedValue } ?? fields[0]
  }

  private var fieldID: Binding<String> {
    Binding(
      get: { filter.systemField ?? filter.fieldID?.rawValue ?? fields[0].id },
      set: { value in
        let selected = fields.first { $0.id == value } ?? fields[0]
        filter.systemField = selected.isSystem ? selected.id : nil
        filter.fieldID = selected.isSystem ? nil : .init(rawValue: selected.id)
        let validOperations = operations(for: selected.type)
        if !validOperations.contains(filter.operation) {
          filter.operation = validOperations.first ?? .equals
        }
        filter.value = defaultValue(for: selected)
      }
    )
  }

  var body: some View {
    if usesVerticalLayout {
      VStack(alignment: .leading, spacing: 8) {
        fieldPicker
        operatorPicker
        if filter.operation.needsValue { valueEditor }
      }
    } else {
      HStack {
        fieldPicker.labelsHidden()
        operatorPicker.labelsHidden()
        if filter.operation.needsValue { valueEditor.labelsHidden() }
      }
    }
  }

  private var fieldPicker: some View {
    Picker("Field", selection: fieldID) {
      ForEach(fields) { Text($0.name).tag($0.id) }
    }
  }

  private var operatorPicker: some View {
    Picker("Operator", selection: $filter.operation) {
      ForEach(operators, id: \.self) { Text($0.title).tag($0) }
    }
  }

  private var operators: [LiveQueryOperator] {
    operations(for: choice.type)
  }

  private func operations(for type: SupertagFieldType) -> [LiveQueryOperator] {
    switch type {
    case .date, .dateTime: [.equals, .notEquals, .before, .after, .isEmpty, .isNotEmpty]
    case .text, .url, .email, .phone: [.equals, .notEquals, .contains, .isEmpty, .isNotEmpty]
    default: [.equals, .notEquals, .isEmpty, .isNotEmpty]
    }
  }

  @ViewBuilder private var valueEditor: some View {
    switch choice.type {
    case .boolean:
      Toggle("Value", isOn: boolValue)
    case .date:
      DatePicker("Value", selection: dateValue, displayedComponents: .date)
    case .dateTime:
      DatePicker("Value", selection: dateValue, displayedComponents: [.date, .hourAndMinute])
    case .select:
      Picker("Value", selection: stringValue) {
        ForEach(choice.options) { Text($0.name).tag($0.id) }
      }
    default:
      TextField("Value", text: stringValue).textFieldStyle(.roundedBorder)
    }
  }

  private var stringValue: Binding<String> {
    Binding(
      get: {
        guard let value = filter.value else { return "" }
        return switch value {
        case .text(let value), .select(let value), .url(let value), .email(let value),
          .phone(let value):
          value
        case .number(let value): String(value)
        case .page(let value): value.rawValue
        default: value.displayValue
        }
      },
      set: { value in
        switch choice.type {
        case .number: filter.value = .number(Double(value) ?? 0)
        case .select: filter.value = .select(value)
        case .url: filter.value = .url(value)
        case .email: filter.value = .email(value)
        case .phone: filter.value = .phone(value)
        case .entityReference: filter.value = .page(.init(rawValue: value))
        default: filter.value = .text(value)
        }
      }
    )
  }

  private var boolValue: Binding<Bool> {
    Binding(
      get: {
        if case .boolean(let value) = filter.value { return value }
        return false
      },
      set: { filter.value = .boolean($0) }
    )
  }

  private var dateValue: Binding<Date> {
    Binding(
      get: {
        switch filter.value {
        case .date(let value), .dateTime(let value): value
        default: Date()
        }
      },
      set: { filter.value = choice.type == .date ? .date($0) : .dateTime($0) }
    )
  }

  private func defaultValue(for field: LiveQueryFieldChoice) -> SupertagValue {
    switch field.type {
    case .number: .number(0)
    case .boolean: .boolean(false)
    case .date: .date(Date())
    case .dateTime: .dateTime(Date())
    case .select: .select(field.options.first?.id ?? "")
    case .url: .url("")
    case .email: .email("")
    case .phone: .phone("")
    case .entityReference: .page(.init(rawValue: ""))
    case .text: .text("")
    }
  }
}

private struct LiveQuerySortRow: View {
  @Binding var sort: LiveQuerySort
  let fields: [LiveQueryFieldChoice]
  let usesVerticalLayout: Bool

  private var fieldID: Binding<String> {
    Binding(
      get: { sort.systemField ?? sort.fieldID?.rawValue ?? fields[0].id },
      set: { value in
        let choice = fields.first { $0.id == value } ?? fields[0]
        sort.systemField = choice.isSystem ? choice.id : nil
        sort.fieldID = choice.isSystem ? nil : .init(rawValue: choice.id)
      }
    )
  }

  var body: some View {
    if usesVerticalLayout {
      VStack(alignment: .leading, spacing: 8) {
        fieldPicker
        directionPicker
      }
    } else {
      HStack {
        fieldPicker.labelsHidden()
        directionPicker.labelsHidden()
      }
    }
  }

  private var fieldPicker: some View {
    Picker("Field", selection: fieldID) {
      ForEach(fields) { Text($0.name).tag($0.id) }
    }
  }

  private var directionPicker: some View {
    Picker("Direction", selection: $sort.ascending) {
      #if os(iOS)
        Text("↑ Asc").accessibilityLabel("Ascending").tag(true)
        Text("↓ Desc").accessibilityLabel("Descending").tag(false)
      #else
        Text("Ascending").tag(true)
        Text("Descending").tag(false)
      #endif
    }
  }
}
