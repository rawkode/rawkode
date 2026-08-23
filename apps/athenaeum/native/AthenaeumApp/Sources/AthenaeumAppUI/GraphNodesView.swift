import SwiftUI

/// Native mirror of `web/src/GraphView.tsx`: renders the real `graph_nodes` read-only view
/// (`runView`), with a toggle between "all nodes" and a `hasTag`-filtered "only Person" view, plus
/// an "assign Person tag" affordance (`assignTag`) so the filter has something to show — task
/// item 3's "at least one read-only graph view UI... e.g. 'all nodes tagged Person'", satisfied by
/// reusing the exact same server-side `runView` compiler the web client exercises.
public struct GraphNodesView: View {
    @ObservedObject var model: AthenaeumViewModel

    public init(model: AthenaeumViewModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Graph view — graph_nodes (via runView)").font(.headline)

            Toggle("Only nodes tagged \u{201C}Person\u{201D}", isOn: $model.onlyPerson)
                #if os(macOS)
                .toggleStyle(.checkbox)
                #endif

            if model.graphRows.isEmpty {
                Text("No nodes\(model.onlyPerson ? " tagged Person" : "") yet.")
                    .foregroundStyle(.secondary).font(.callout)
            } else {
                ForEach(model.graphRows) { row in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(row.title)
                            Text(row.createdAt).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("+ Person tag") {
                            Task { await model.assignPersonTag(nodeId: row.id) }
                        }
                    }
                }
            }
        }
    }
}
