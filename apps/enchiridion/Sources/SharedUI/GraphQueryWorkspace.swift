import EnchiridionCore
import SwiftUI

struct GraphQueryWorkspace: View {
  let store: LibraryStore
  let onOpenPage: ((PageID) -> Void)?

  @State private var mode = GraphQueryEditorMode.visual
  @State private var selectedTagID: TagID?
  @State private var traversalRelationID: RelationID?
  @State private var targetTagID: TagID?
  @State private var maximumDepth = 1
  @State private var sql = "SELECT node_id, title, kind FROM graph_nodes WHERE deleted_at IS NULL ORDER BY modified_at DESC LIMIT 100"
  @State private var relations: [RelationDefinition] = []
  @State private var savedQueries: [SavedGraphQuery] = []
  @State private var selectedSavedQueryID: GraphQueryID?
  @State private var result: GraphQueryResult?
  @State private var errorMessage: String?
  @State private var showsSaveQuery = false
  @State private var queryName = ""
  @State private var isRunning = false

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Picker("Query editor", selection: $mode) {
          ForEach(GraphQueryEditorMode.allCases) { mode in Text(mode.title).tag(mode) }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 320)

        savedQueryMenu

        Button("Save", systemImage: "square.and.arrow.down") {
          queryName = ""
          showsSaveQuery = true
        }
        .disabled(mode == .sql && sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      .padding()

      Divider()

      if mode == .visual {
        visualEditor
      } else {
        sqlEditor
      }

      Divider()
      resultView
    }
    .navigationTitle("Graph Query")
    .task {
      relations = (try? await store.graphRelationDefinitions()) ?? []
      await reloadSavedQueries()
    }
    .alert("Save Graph Query", isPresented: $showsSaveQuery) {
      TextField("Name", text: $queryName)
      Button("Cancel", role: .cancel) {}
      Button("Save") {
        let name = queryName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task { await saveCurrentQuery(name: name) }
      }
        .disabled(queryName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    } message: {
      Text("Saved queries belong to this vault and retain their visual or SQL definition.")
    }
    .alert("Query Error", isPresented: errorBinding) {
      Button("Dismiss Error", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "The query could not be run.")
    }
  }

  private var savedQueryMenu: some View {
    Menu {
      if savedQueries.isEmpty {
        Text("No saved queries")
      } else {
        ForEach(savedQueries) { query in
          Button {
            selectedSavedQueryID = query.id
            Task { await perform { try await store.runGraphQueryAsync(query) } }
          } label: {
            Label(query.name, systemImage: query.source.systemImage)
          }
        }
        if let selectedSavedQueryID,
          let selected = savedQueries.first(where: { $0.id == selectedSavedQueryID })
        {
          Divider()
          Button("Delete \(selected.name)", systemImage: "trash", role: .destructive) {
            Task { await deleteSavedQuery(selected) }
          }
        }
      }
    } label: {
      Label(
        selectedSavedQueryID.flatMap { id in
          savedQueries.first(where: { $0.id == id })?.name
        } ?? "Saved Queries",
        systemImage: "tray.full"
      )
    }
  }

  private var visualEditor: some View {
    Form {
      Section("Match") {
        Picker("Type", selection: $selectedTagID) {
          Text("Any type").tag(nil as TagID?)
          ForEach(store.supertags) { tag in Text(tag.name).tag(tag.id as TagID?) }
        }
      }
      Section("Traverse") {
        Picker("Relationship", selection: $traversalRelationID) {
          Text("No traversal").tag(nil as RelationID?)
          ForEach(relations) { relation in
            Text(relation.forwardName).tag(relation.id as RelationID?)
          }
        }
        .onChange(of: traversalRelationID) { _, relationID in
          if relationID == nil { targetTagID = nil }
        }
        if traversalRelationID != nil {
          Picker("Target type", selection: $targetTagID) {
            Text("Any type").tag(nil as TagID?)
            ForEach(store.supertags) { tag in Text(tag.name).tag(tag.id as TagID?) }
          }
          Stepper("Maximum depth: \(maximumDepth)", value: $maximumDepth, in: 1...8)
        }
      }
      Section {
        Button("Run Query", systemImage: "play.fill") {
          Task { await runVisualQuery() }
        }
        .disabled(isRunning)
      }
    }
    .formStyle(.grouped)
    .frame(maxHeight: 300)
  }

  private var sqlEditor: some View {
    VStack(alignment: .leading, spacing: 10) {
      TextEditor(text: $sql)
        .font(.system(.body, design: .monospaced))
        .frame(minHeight: 150)
        .accessibilityLabel("Read-only graph SQL")
      HStack {
        Text("Queries can read the stable graph_* views only.")
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer()
        Button("Run SQL", systemImage: "play.fill") {
          Task { await runSQL() }
        }
          .disabled(isRunning)
          .keyboardShortcut(.return, modifiers: [.command])
      }
    }
    .padding()
    .frame(maxHeight: 300)
  }

  @ViewBuilder
  private var resultView: some View {
    if let result {
      if result.rows.isEmpty {
        ContentUnavailableView(
          "No matches",
          systemImage: "line.3.horizontal.decrease.circle",
          description: Text("Adjust the query and run it again.")
        )
      } else {
        List(result.rows) { row in
          let nodeID = textValue("node_id", row: row).map(NodeID.init(rawValue:))
          Button {
            if let nodeID { onOpenPage?(nodeID) }
          } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text(textValue("title", row: row) ?? rowSummary(row, result: result))
                .foregroundStyle(.primary)
              if let nodeID {
                Text(nodeID.rawValue)
                  .font(.caption.monospaced())
                  .foregroundStyle(.secondary)
              }
            }
          }
          .buttonStyle(.plain)
        }
      }
    } else {
      ContentUnavailableView(
        "Run a query",
        systemImage: "point.3.connected.trianglepath.dotted",
        description: Text("Build a graph traversal visually or write read-only SQLite SQL.")
      )
    }
  }

  private func runVisualQuery() async {
    let definition = currentVisualDefinition
    await perform { try await store.runGraphQueryAsync(definition) }
  }

  private var currentVisualDefinition: GraphQueryDefinition {
    var expressions: [GraphExpression] = []
    if let selectedTagID { expressions.append(.tag(selectedTagID)) }
    if traversalRelationID != nil {
      expressions.append(.traversal(.init(
        relationID: traversalRelationID,
        maximumDepth: maximumDepth,
        targetTagID: targetTagID
      )))
    }
    let expression: GraphExpression? = switch expressions.count {
    case 0: nil
    case 1: expressions[0]
    default: .and(expressions)
    }
    return .init(expression: expression)
  }

  private func runSQL() async {
    let sql = sql
    await perform { try await store.runGraphSQLAsync(sql) }
  }

  private func perform(_ query: () async throws -> GraphQueryResult) async {
    guard !isRunning else { return }
    isRunning = true
    defer { isRunning = false }
    do {
      result = try await query()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func saveCurrentQuery(name: String) async {
    let source: SavedGraphQuery.Source = switch mode {
    case .visual: .builder(currentVisualDefinition)
    case .sql: .sql(sql)
    }
    let query = SavedGraphQuery(
      name: name,
      source: source,
      presentation: .init(kind: mode == .visual ? .list : .table)
    )
    do {
      try await store.saveGraphQuery(query)
      selectedSavedQueryID = query.id
      await reloadSavedQueries()
      await perform { try await store.runGraphQueryAsync(query) }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func deleteSavedQuery(_ query: SavedGraphQuery) async {
    do {
      try await store.deleteGraphQuery(query.id)
      if selectedSavedQueryID == query.id { selectedSavedQueryID = nil }
      await reloadSavedQueries()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func reloadSavedQueries() async {
    do {
      savedQueries = try await store.savedGraphQueries()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func textValue(_ column: String, row: GraphQueryRow) -> String? {
    guard let result, case .text(let value) = result.value(column: column, in: row) else {
      return nil
    }
    return value
  }

  private func rowSummary(_ row: GraphQueryRow, result: GraphQueryResult) -> String {
    zip(result.columns, row.values).map { column, value in
      "\(column.name): \(display(value))"
    }.joined(separator: " · ")
  }

  private func display(_ value: GraphSQLValue) -> String {
    switch value {
    case .null: "—"
    case .integer(let value): value.formatted()
    case .real(let value): value.formatted()
    case .text(let value): value
    case .blob(let value): "\(value.count) bytes"
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}

private extension SavedGraphQuery.Source {
  var systemImage: String {
    switch self {
    case .builder: "point.3.connected.trianglepath.dotted"
    case .sql: "text.page"
    }
  }
}

private enum GraphQueryEditorMode: String, CaseIterable, Identifiable {
  case visual
  case sql
  var id: Self { self }
  var title: String { self == .visual ? "Visual" : "SQL" }
}
