import EnchiridionCore
import SwiftUI

struct LiveViewScreen: View {
  let store: LibraryStore
  let definition: LiveQueryDefinition
  let openPage: (PageID) -> Void
  @State private var editingView: LiveQueryDefinition?
  @State private var showingDeleteConfirmation = false

  private var items: [LiveQueryItem] { store.liveViewItems[definition.id] ?? [] }

  var body: some View {
    Group {
      switch definition.viewKind {
      case .list: list
      case .table: table
      case .board: board
      case .calendar: calendar
      }
    }
    .navigationTitle(definition.name)
    .toolbar {
      Menu {
        Button { editingView = definition } label: {
          Label("Edit View", systemImage: "line.3.horizontal.decrease.circle")
        }
        Button { store.duplicateView(definition) } label: {
          Label("Duplicate View", systemImage: "plus.square.on.square")
        }
        Divider()
        Button(role: .destructive) { showingDeleteConfirmation = true } label: {
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

  private var board: some View {
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
              let item = items.first(where: { $0.id == itemID }),
              case .page(let page) = item,
              let fieldID = definition.groupFieldID,
              case .supertag(let tagID) = definition.source
            else { return false }
            store.setProperty(
              pageID: page.id,
              supertagID: tagID,
              fieldID: fieldID,
              values: option.id == "__unset" ? [] : [.select(option.id)]
            )
            return true
          }
        }
      }
      .padding()
    }
  }

  private var calendar: some View {
    List {
      ForEach(Dictionary(grouping: datedItems, by: { Calendar.current.startOfDay(for: $0.date) })
        .keys.sorted(), id: \.self) { day in
        Section(day.formatted(date: .complete, time: .omitted)) {
          ForEach(datedItems.filter { Calendar.current.isDate($0.date, inSameDayAs: day) }, id: \.item.id) { dated in
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
    guard let fieldID = definition.groupFieldID else { return [] }
    let options = sourceTag?.fields.first(where: { $0.id == fieldID })?.options ?? []
    return [.init(id: "__unset", name: "No status", color: "gray")] + options
  }

  private func boardItems(_ optionID: String) -> [LiveQueryItem] {
    guard let fieldID = definition.groupFieldID, case .supertag(let tagID) = definition.source else { return [] }
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
    guard case .page(let page) = item, case .supertag(let tagID) = definition.source else { return "—" }
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

struct LiveViewEditor: View {
  let store: LibraryStore
  let definition: LiveQueryDefinition
  @Environment(\.dismiss) private var dismiss
  @State private var draft: LiveQueryDefinition
  @State private var sql: String
  @State private var error: String?

  init(store: LibraryStore, definition: LiveQueryDefinition) {
    self.store = store
    self.definition = definition
    _draft = State(initialValue: definition)
    _sql = State(initialValue: definition.domainSQL)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("View") {
          TextField("Name", text: $draft.name)
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
          Stepper("Limit: \(draft.limit)", value: $draft.limit, in: 1...5_000, step: 25)
        }

        if !queryFields.isEmpty {
          Section("Filters") {
            ForEach($draft.filters) { $filter in
              HStack {
                LiveQueryFilterRow(filter: $filter, fields: queryFields)
                Button(role: .destructive) {
                  draft.filters.removeAll { $0.id == filter.id }
                } label: {
                  Label("Remove Filter", systemImage: "minus.circle")
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
              }
            }
            .onDelete { draft.filters.remove(atOffsets: $0) }
            Button("Add Filter", systemImage: "plus") {
              draft.filters.append(.init(systemField: "title", operation: .contains, value: .text("")))
            }
          }

          Section("Sort") {
            ForEach(Array(draft.sorts.indices), id: \.self) { index in
              HStack {
                LiveQuerySortRow(sort: $draft.sorts[index], fields: queryFields)
                Button(role: .destructive) {
                  guard draft.sorts.indices.contains(index) else { return }
                  draft.sorts.remove(at: index)
                } label: {
                  Label("Remove Sort", systemImage: "minus.circle")
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
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
              Picker("Group by", selection: optionalFieldBinding(\LiveQueryDefinition.groupFieldID)) {
                Text("Choose a field").tag("")
                ForEach(sourceTag.fields.filter { !$0.isDeleted && $0.type == .select }) { field in
                  Text(field.name).tag(field.id.rawValue)
                }
              }
            }
            if draft.viewKind == .calendar {
              Picker("Start date", selection: optionalFieldBinding(\LiveQueryDefinition.startFieldID)) {
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
            Button("Reset from Builder") { sql = draft.domainSQL; error = nil }
            Button("Apply to Builder") { applySQL() }
          }
          Text("Safe clauses: WHERE, SHOW, GROUP BY, DATES, ORDER BY, LIMIT, and VIEW. This language cannot execute raw SQLite.")
            .font(.caption).foregroundStyle(.secondary)
          if let error { Text(error).foregroundStyle(.red) }
        }
      }
      .formStyle(.grouped)
      .navigationTitle(definition.name == "New View" ? "New View" : "Edit View")
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

  private var dateFields: [SupertagFieldDefinition] {
    sourceTag?.fields.filter { !$0.isDeleted && ($0.type == .date || $0.type == .dateTime) } ?? []
  }

  private var availableViewKinds: [LiveViewKind] {
    switch draft.source {
    case .pages: return [.list, .table]
    case .calendarEvents, .workCalendar: return [.list, .calendar]
    case .supertag:
      var kinds: [LiveViewKind] = [.list, .table]
      if sourceTag?.fields.contains(where: { !$0.isDeleted && $0.type == .select }) == true {
        kinds.append(.board)
      }
      if !dateFields.isEmpty { kinds.append(.calendar) }
      return kinds
    }
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
    choices += sourceTag?.fields.filter { !$0.isDeleted }.map {
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
      let field = (draft.source == .calendarEvents || draft.source == .workCalendar) ? "start" : "title"
      draft.sorts = [.init(systemField: field)]
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
      draft = try DomainQueryCodec.parse(sql, id: draft.id, name: draft.name)
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  private func save() {
    do {
      draft.name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
      if draft.viewKind == .board && draft.groupFieldID == nil {
        throw DomainQueryError.unsupported("A board needs a Select field to group by.")
      }
      if draft.viewKind == .calendar, case .supertag = draft.source, draft.startFieldID == nil {
        throw DomainQueryError.unsupported("A calendar needs a Date or Date & Time start field.")
      }
      _ = try DomainQueryCodec.parse(draft.domainSQL, id: draft.id, name: draft.name)
      store.saveView(draft)
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

private struct LiveQueryFieldChoice: Identifiable, Hashable {
  let id: String
  let name: String
  let type: SupertagFieldType
  var options: [SupertagSelectOption] = []
  var isSystem = false
}

private struct LiveQueryFilterRow: View {
  @Binding var filter: LiveQueryFilter
  let fields: [LiveQueryFieldChoice]

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
    HStack {
      Picker("Field", selection: fieldID) {
        ForEach(fields) { Text($0.name).tag($0.id) }
      }
      .labelsHidden()
      Picker("Operator", selection: $filter.operation) {
        ForEach(operators, id: \.self) { Text($0.title).tag($0) }
      }
      .labelsHidden()
      if filter.operation.needsValue { valueEditor }
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
      Toggle("Value", isOn: boolValue).labelsHidden()
    case .date:
      DatePicker("Value", selection: dateValue, displayedComponents: .date).labelsHidden()
    case .dateTime:
      DatePicker("Value", selection: dateValue, displayedComponents: [.date, .hourAndMinute]).labelsHidden()
    case .select:
      Picker("Value", selection: stringValue) {
        ForEach(choice.options) { Text($0.name).tag($0.id) }
      }
      .labelsHidden()
    default:
      TextField("Value", text: stringValue).textFieldStyle(.roundedBorder)
    }
  }

  private var stringValue: Binding<String> {
    Binding(
      get: {
        guard let value = filter.value else { return "" }
        return switch value {
        case .text(let value), .select(let value), .url(let value), .email(let value), .phone(let value): value
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
      get: { if case .boolean(let value) = filter.value { return value }; return false },
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
    HStack {
      Picker("Field", selection: fieldID) {
        ForEach(fields) { Text($0.name).tag($0.id) }
      }
      .labelsHidden()
      Picker("Direction", selection: $sort.ascending) {
        #if os(iOS)
        Text("↑ Asc").accessibilityLabel("Ascending").tag(true)
        Text("↓ Desc").accessibilityLabel("Descending").tag(false)
        #else
        Text("Ascending").tag(true)
        Text("Descending").tag(false)
        #endif
      }
      .labelsHidden()
    }
  }
}
