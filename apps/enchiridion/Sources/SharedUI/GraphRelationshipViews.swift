import EnchiridionCore
import SwiftUI

struct GraphRelationshipsView: View {
  let store: LibraryStore
  let pageID: NodeID
  let onOpenPage: ((PageID) -> Void)?

  @State private var relations: [RelationDefinition] = []
  @State private var outgoing: [KnowledgeEdge] = []
  @State private var backlinks: [GraphBacklink] = []
  @State private var issues: [GraphIssue] = []
  @State private var selectedRelation: RelationDefinition?
  @State private var errorMessage: String?

  var body: some View {
    List {
      if !pageIssues.isEmpty {
        Section("Needs Attention") {
          ForEach(pageIssues) { issue in
            Label(issue.message, systemImage: "exclamationmark.triangle")
              .foregroundStyle(.orange)
          }
        }
      }

      Section("Relationships") {
        if outgoing.isEmpty {
          Text("No relationships yet")
            .foregroundStyle(.secondary)
        }
        ForEach(outgoing) { edge in
          relationshipRow(edge)
        }
        Menu("Add Relationship", systemImage: "plus") {
          ForEach(availableRelations) { relation in
            Button(relation.forwardName) { selectedRelation = relation }
          }
        }
        .disabled(availableRelations.isEmpty)
      }

      Section("Backlinks") {
        if backlinks.isEmpty {
          Text("No pages point here")
            .foregroundStyle(.secondary)
        }
        ForEach(backlinks) { backlink in
          Button {
            onOpenPage?(backlink.edge.sourceNodeID)
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(backlink.sourceTitle)
                  .foregroundStyle(.primary)
                Text(backlink.relation.inverseName)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              Image(systemName: "arrow.up.left")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            }
          }
          .buttonStyle(.plain)
        }
      }
    }
    .formStyle(.grouped)
    .task(id: pageID) { await load() }
    .sheet(item: $selectedRelation) { relation in
      GraphRelationshipTargetPicker(
        store: store,
        sourceID: pageID,
        relation: relation
      ) {
        selectedRelation = nil
        Task { await load() }
      }
    }
    .alert("Relationship Error", isPresented: errorBinding) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "The relationship could not be changed.")
    }
  }

  private var availableRelations: [RelationDefinition] {
    guard let page = store.page(id: pageID) else { return [] }
    let directTags = Set(page.objectMetadata.supertagIDs)
    let effectiveTags = SupertagInheritance.effectiveTagIDs(
      for: directTags,
      definitions: store.supertags
    )
    return relations.filter {
      $0.sourceTagIDs.isEmpty || !effectiveTags.isDisjoint(with: $0.sourceTagIDs)
    }
  }

  private var pageIssues: [GraphIssue] {
    issues.filter { $0.nodeID == pageID }
  }

  @ViewBuilder
  private func relationshipRow(_ edge: KnowledgeEdge) -> some View {
    let relation = relations.first(where: { $0.id == edge.relationID })
    let target = store.page(id: edge.targetNodeID)
    HStack {
      Button {
        onOpenPage?(edge.targetNodeID)
      } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text(target?.displayTitle ?? "Unavailable page")
            .foregroundStyle(target == nil ? .secondary : .primary)
          Text(relation?.forwardName ?? edge.relationID.rawValue)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .buttonStyle(.plain)
      Spacer()
      if hasCardinalityConflict(edge) {
        Button("Keep This") {
          Task { await resolveConflict(keeping: edge) }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .help("Keep this relationship and remove the other conflicting values")
      }
      if edge.origin == .user {
        Button(role: .destructive) {
          Task { await remove(edge) }
        } label: {
          Label("Remove Relationship", systemImage: "minus.circle")
            .labelStyle(.iconOnly)
        }
        .buttonStyle(.borderless)
      }
    }
  }

  private func load() async {
    do {
      async let loadedRelations = store.graphRelationDefinitions()
      async let loadedOutgoing = store.graphOutgoingEdges(from: pageID)
      async let loadedBacklinks = store.graphBacklinks(to: pageID)
      async let loadedIssues = store.graphIssues()
      relations = try await loadedRelations
      outgoing = try await loadedOutgoing
      backlinks = try await loadedBacklinks
      issues = try await loadedIssues
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func remove(_ edge: KnowledgeEdge) async {
    do {
      try await store.removeGraphEdge(edge.id)
      await load()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func hasCardinalityConflict(_ edge: KnowledgeEdge) -> Bool {
    pageIssues.contains {
      $0.kind == .cardinalityViolation && $0.edgeID == edge.id
        && $0.relationID == edge.relationID
    }
  }

  private func resolveConflict(keeping edge: KnowledgeEdge) async {
    do {
      try await store.resolveGraphCardinalityConflict(
        relationID: edge.relationID,
        keeping: edge.id
      )
      await load()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}

private struct GraphRelationshipTargetPicker: View {
  let store: LibraryStore
  let sourceID: NodeID
  let relation: RelationDefinition
  let didCreate: () -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      List(candidates) { page in
        Button {
          Task { await create(targetID: page.id) }
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text(page.displayTitle)
              .foregroundStyle(.primary)
            Text(typeNames(for: page))
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .buttonStyle(.plain)
      }
      .overlay {
        if candidates.isEmpty {
          ContentUnavailableView.search(text: query)
        }
      }
      .navigationTitle("Add \(relation.forwardName)")
      .searchable(text: $query, prompt: "Find a page")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
      .alert("Cannot Add Relationship", isPresented: errorBinding) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(errorMessage ?? "Choose a compatible page.")
      }
    }
    #if os(macOS)
    .frame(minWidth: 420, minHeight: 480)
    #endif
  }

  private var candidates: [PageSnapshot] {
    store.pages.filter {
      $0.id != sourceID && $0.deletedAt == nil
        && (query.isEmpty || $0.displayTitle.localizedStandardContains(query))
        && isCompatibleTarget($0)
    }
  }

  private func isCompatibleTarget(_ page: PageSnapshot) -> Bool {
    guard !relation.targetTagIDs.isEmpty else { return true }
    let effectiveTags = SupertagInheritance.effectiveTagIDs(
      for: Set(page.objectMetadata.supertagIDs),
      definitions: store.supertags
    )
    return !effectiveTags.isDisjoint(with: relation.targetTagIDs)
  }

  private func typeNames(for page: PageSnapshot) -> String {
    let names = page.objectMetadata.supertagIDs.compactMap { id in
      store.supertags.first(where: { $0.id == id })?.name
    }
    return names.isEmpty ? "Page" : names.joined(separator: " · ")
  }

  private func create(targetID: NodeID) async {
    do {
      _ = try await store.createGraphEdge(
        relationID: relation.id,
        from: sourceID,
        to: targetID
      )
      dismiss()
      didCreate()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}

struct GraphIssuesView: View {
  let store: LibraryStore
  let onOpenPage: ((PageID) -> Void)?
  @State private var issues: [GraphIssue] = []
  @State private var errorMessage: String?

  var body: some View {
    List(issues) { issue in
      Button {
        onOpenPage?(issue.nodeID)
      } label: {
        VStack(alignment: .leading, spacing: 4) {
          Text(store.page(id: issue.nodeID)?.displayTitle ?? "Unavailable page")
            .foregroundStyle(.primary)
          Text(issue.message)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }
      .buttonStyle(.plain)
    }
    .overlay {
      if issues.isEmpty, errorMessage == nil {
        ContentUnavailableView(
          "Graph is consistent",
          systemImage: "checkmark.circle",
          description: Text("Relationship conflicts and unresolved targets appear here.")
        )
      }
    }
    .navigationTitle("Needs Attention")
    .task { await load() }
    .refreshable { await load() }
    .alert("Cannot Load Graph Issues", isPresented: errorBinding) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "Graph issues could not be loaded.")
    }
  }

  private func load() async {
    do {
      issues = try await store.graphIssues()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}
