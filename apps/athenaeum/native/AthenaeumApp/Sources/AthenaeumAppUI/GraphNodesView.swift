import SwiftUI

/// Native mirror of `web/src/GraphView.tsx`: renders the real `graph_nodes` read-only view
/// (`runView`), with a toggle between "all nodes" and a `hasTag`-filtered "only Person" view, plus
/// an "assign Person tag" affordance (`assignTag`) so the filter has something to show — task
/// item 3's "at least one read-only graph view UI... e.g. 'all nodes tagged Person'", satisfied by
/// reusing the exact same server-side `runView` compiler the web client exercises.
public struct GraphNodesView: View {
    @ObservedObject var model: AthenaeumViewModel
    private let onSelectNode: ((String) -> Void)?
    // This is deliberately view-owned: it only prevents a second visible button activation while
    // the existing assignment task is awaiting its result. The graph model, request identity, and
    // mutation contract remain unchanged.
    @State private var assigningPersonTagNodeId: String?
    // This is deliberately view-owned: it closes the interval before SwiftUI re-renders the
    // existing read state, so a rapid second activation cannot start a concurrent graph refresh.
    @State private var isRefreshingGraph = false

    public init(model: AthenaeumViewModel, onSelectNode: ((String) -> Void)? = nil) {
        self.model = model
        self.onSelectNode = onSelectNode
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Entities").font(.headline)
                Spacer()
                if GraphRefreshPresentation.shouldShowControl(
                    hasLoadedGraph: model.hasLoadedGraph,
                    graphRowsOnlyPerson: model.graphRowsOnlyPerson,
                    onlyPerson: model.onlyPerson,
                    errorMessage: model.graphLoadErrorMessage
                ) {
                    Button(GraphRefreshPresentation.actionTitle(isRefreshing: isRefreshingGraph)) {
                        refreshGraph()
                    }
                    .buttonStyle(.bordered)
                    .disabled(!GraphRefreshPresentation.canStartRefresh(
                        hasLoadedGraph: model.hasLoadedGraph,
                        graphRowsOnlyPerson: model.graphRowsOnlyPerson,
                        onlyPerson: model.onlyPerson,
                        isLoadingGraph: model.isLoadingGraph,
                        errorMessage: model.graphLoadErrorMessage,
                        isRefreshing: isRefreshingGraph
                    ))
                    .accessibilityHint("Refreshes the current graph filter without changing it.")
                }
            }
            Text("Browse and open the typed nodes connected to this workspace.")
                .font(.callout)
                .foregroundStyle(.secondary)

            Toggle("Show people only", isOn: $model.onlyPerson)
                #if os(macOS)
                .toggleStyle(.checkbox)
                #endif

            if AthenaeumViewModel.shouldShowGraphLoading(
                hasLoadedGraph: model.hasLoadedGraph,
                graphRowsOnlyPerson: model.graphRowsOnlyPerson,
                onlyPerson: model.onlyPerson,
                isLoadingGraph: model.isLoadingGraph,
                errorMessage: model.graphLoadErrorMessage
            ) {
                ProgressView("Loading entities…")
                    .foregroundStyle(.secondary)
            } else if let error = model.graphLoadErrorMessage {
                VStack(alignment: .leading, spacing: 8) {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                    if AthenaeumViewModel.canRetryGraphLoad(
                        errorMessage: error,
                        isLoadingGraph: model.isLoadingGraph
                    ) {
                        Button(
                            GraphLoadRetryPresentation.actionTitle(
                                isRetrying: isRefreshingGraph
                            )
                        ) {
                            retryGraphLoad()
                        }
                        .buttonStyle(.bordered)
                        .disabled(!GraphLoadRetryPresentation.canStartRetry(
                            errorMessage: error,
                            isLoadingGraph: model.isLoadingGraph,
                            isRetrying: isRefreshingGraph
                        ))
                        .accessibilityHint("Retries loading the current graph view.")
                    }
                }
            } else if AthenaeumViewModel.shouldShowEmptyGraph(
                isEmpty: model.graphRows.isEmpty,
                hasLoadedGraph: model.hasLoadedGraph,
                graphRowsOnlyPerson: model.graphRowsOnlyPerson,
                onlyPerson: model.onlyPerson,
                isLoadingGraph: model.isLoadingGraph,
                errorMessage: model.graphLoadErrorMessage
            ) {
                Text("No nodes\(model.onlyPerson ? " tagged Person" : "") yet.")
                    .foregroundStyle(.secondary).font(.callout)
            }

            if let error = model.graphPersonTagError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
            }

            if AthenaeumViewModel.shouldShowCachedGraphRows(
                isEmpty: model.graphRows.isEmpty,
                hasLoadedGraph: model.hasLoadedGraph,
                graphRowsOnlyPerson: model.graphRowsOnlyPerson,
                onlyPerson: model.onlyPerson
            ) {
                ForEach(model.graphRows) { row in
                    HStack {
                        if let onSelectNode {
                            Button {
                                onSelectNode(row.id)
                            } label: {
                                GraphNodeRowLabel(row: row, showsChevron: true)
                            }
                            .buttonStyle(.plain)
                            .contentShape(Rectangle())
                            .help("Open \(row.title)")
                        } else {
                            GraphNodeRowLabel(row: row, showsChevron: false)
                        }
                        Spacer()
                        if GraphPersonTagPresentation.shouldShowAssignmentAction(onlyPerson: model.onlyPerson) {
                            let label = GraphPersonTagPresentation.assignmentActionLabel(
                                rowId: row.id,
                                assigningNodeId: assigningPersonTagNodeId
                            )
                            Button(label) {
                                guard GraphPersonTagPresentation.canStartAssignment(
                                    assigningNodeId: assigningPersonTagNodeId
                                ) else { return }
                                assigningPersonTagNodeId = row.id
                                Task {
                                    await model.assignPersonTag(nodeId: row.id)
                                    if assigningPersonTagNodeId == row.id {
                                        assigningPersonTagNodeId = nil
                                    }
                                }
                            }
                            .disabled(!GraphPersonTagPresentation.canStartAssignment(
                                assigningNodeId: assigningPersonTagNodeId
                            ))
                        }
                    }
                }
            }
        }
    }

    private func retryGraphLoad() {
        guard GraphLoadRetryPresentation.canStartRetry(
            errorMessage: model.graphLoadErrorMessage,
            isLoadingGraph: model.isLoadingGraph,
            isRetrying: isRefreshingGraph
        ) else { return }

        isRefreshingGraph = true
        Task { @MainActor in
            defer { isRefreshingGraph = false }
            await model.reloadGraphView()
        }
    }

    private func refreshGraph() {
        guard GraphRefreshPresentation.canStartRefresh(
            hasLoadedGraph: model.hasLoadedGraph,
            graphRowsOnlyPerson: model.graphRowsOnlyPerson,
            onlyPerson: model.onlyPerson,
            isLoadingGraph: model.isLoadingGraph,
            errorMessage: model.graphLoadErrorMessage,
            isRefreshing: isRefreshingGraph
        ) else { return }

        isRefreshingGraph = true
        Task {
            await model.reloadGraphView()
            isRefreshingGraph = false
        }
    }
}

enum GraphRefreshPresentation {
    /// A failure retains the existing Retry action, while initial and filter-transition loads
    /// already have their own loading state. Manual refresh belongs only to settled current data.
    static func shouldShowControl(
        hasLoadedGraph: Bool,
        graphRowsOnlyPerson: Bool?,
        onlyPerson: Bool,
        errorMessage: String?
    ) -> Bool {
        hasLoadedGraph && graphRowsOnlyPerson == onlyPerson && errorMessage == nil
    }

    static func canStartRefresh(
        hasLoadedGraph: Bool,
        graphRowsOnlyPerson: Bool?,
        onlyPerson: Bool,
        isLoadingGraph: Bool,
        errorMessage: String?,
        isRefreshing: Bool
    ) -> Bool {
        shouldShowControl(
            hasLoadedGraph: hasLoadedGraph,
            graphRowsOnlyPerson: graphRowsOnlyPerson,
            onlyPerson: onlyPerson,
            errorMessage: errorMessage
        ) && !isLoadingGraph && !isRefreshing
    }

    static func actionTitle(isRefreshing: Bool) -> String {
        isRefreshing ? "Refreshing…" : "Refresh"
    }
}

/// The failed graph read is immutable, but its Retry starts in a new Task. Share the existing
/// view-local graph-read claim so repeated Retry activations cannot overlap before model loading
/// state is published.
enum GraphLoadRetryPresentation {
    static func canStartRetry(
        errorMessage: String?,
        isLoadingGraph: Bool,
        isRetrying: Bool
    ) -> Bool {
        errorMessage != nil && !isLoadingGraph && !isRetrying
    }

    static func actionTitle(isRetrying: Bool) -> String {
        isRetrying ? "Retrying…" : "Retry"
    }
}

enum GraphPersonTagPresentation {
    /// The current People-only graph query is the canonical `hasTag(Person)` filter, so each
    /// returned row already has the tag and must not offer the same mutation again.
    static func shouldShowAssignmentAction(onlyPerson: Bool) -> Bool {
        !onlyPerson
    }

    /// Assignment actions are deliberately one-at-a-time in this view: every tap would otherwise
    /// mint another independently identified ledger request before the first result is known.
    static func canStartAssignment(assigningNodeId: String?) -> Bool {
        assigningNodeId == nil
    }

    static func assignmentActionLabel(rowId: String, assigningNodeId: String?) -> String {
        assigningNodeId == rowId ? "Tagging…" : "+ Person tag"
    }
}

private struct GraphNodeRowLabel: View {
    let row: AthenaeumViewModel.GraphNodeRow
    let showsChevron: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "circle.hexagongrid")
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .lineLimit(1)
                Text(row.createdAt)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}
