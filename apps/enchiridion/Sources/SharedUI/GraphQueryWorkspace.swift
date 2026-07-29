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
  @State private var result: GraphQueryResult?
  @State private var errorMessage: String?

  var body: some View {
    VStack(spacing: 0) {
      Picker("Query editor", selection: $mode) {
        ForEach(GraphQueryEditorMode.allCases) { mode in Text(mode.title).tag(mode) }
      }
      .pickerStyle(.segmented)
      .frame(maxWidth: 320)
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
    }
    .alert("Query Error", isPresented: errorBinding) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "The query could not be run.")
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
        if traversalRelationID != nil {
          Picker("Target type", selection: $targetTagID) {
            Text("Any type").tag(nil as TagID?)
            ForEach(store.supertags) { tag in Text(tag.name).tag(tag.id as TagID?) }
          }
          Stepper("Maximum depth: \(maximumDepth)", value: $maximumDepth, in: 1...8)
        }
      }
      Section {
        Button("Run Query", systemImage: "play.fill", action: runVisualQuery)
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
        Button("Run SQL", systemImage: "play.fill", action: runSQL)
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

  private func runVisualQuery() {
    var expressions: [GraphExpression] = []
    if let selectedTagID { expressions.append(.tag(selectedTagID)) }
    if traversalRelationID != nil || targetTagID != nil {
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
    perform { try store.runGraphQuery(.init(expression: expression)) }
  }

  private func runSQL() {
    perform { try store.runGraphSQL(sql) }
  }

  private func perform(_ query: () throws -> GraphQueryResult) {
    do {
      result = try query()
      errorMessage = nil
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

private enum GraphQueryEditorMode: String, CaseIterable, Identifiable {
  case visual
  case sql
  var id: Self { self }
  var title: String { self == .visual ? "Visual" : "SQL" }
}
