import EnchiridionCore
import SwiftUI

struct GraphRelationDefinitionsView: View {
  let store: LibraryStore

  @State private var definitions: [RelationDefinition] = []
  @State private var editingDefinition: RelationDefinition?
  @State private var definitionPendingDeletion: RelationDefinition?
  @State private var errorMessage: String?

  var body: some View {
    List {
      Section {
        Text("Relationships are directed in storage and named in both directions. Endpoint types and cardinality are enforced for every edit.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      if !customDefinitions.isEmpty {
        Section("Custom") {
          ForEach(customDefinitions) { definition in
            definitionButton(definition)
              .swipeActions {
                Button("Delete", systemImage: "trash", role: .destructive) {
                  definitionPendingDeletion = definition
                }
              }
          }
        }
      }

      Section("Base Relationships") {
        ForEach(systemDefinitions) { definition in
          definitionButton(definition)
        }
      }
    }
    .navigationTitle("Relationship Types")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          editingDefinition = .draft
        } label: {
          Label("New Relationship Type", systemImage: "plus")
        }
      }
    }
    .task { await load() }
    .refreshable { await load() }
    .sheet(item: $editingDefinition, onDismiss: { Task { await load() } }) { definition in
      GraphRelationDefinitionEditor(
        store: store,
        definition: definition,
        isNew: !definitions.contains { $0.id == definition.id }
      )
    }
    .confirmationDialog(
      "Delete \(definitionPendingDeletion?.forwardName ?? "relationship")?",
      isPresented: deletionBinding,
      titleVisibility: .visible
    ) {
      Button("Delete Relationship Type", role: .destructive) {
        Task { await deletePendingDefinition() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("The custom definition will no longer be available for new relationships.")
    }
    .alert("Relationship Type Error", isPresented: errorBinding) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "The relationship type could not be changed.")
    }
  }

  private var customDefinitions: [RelationDefinition] {
    definitions.filter { !$0.isSystem }
  }

  private var systemDefinitions: [RelationDefinition] {
    definitions.filter(\.isSystem)
  }

  private func definitionButton(_ definition: RelationDefinition) -> some View {
    Button {
      editingDefinition = definition
    } label: {
      HStack(spacing: 12) {
        Image(systemName: definition.isSystem ? "lock" : "arrow.left.arrow.right")
          .foregroundStyle(.secondary)
          .frame(width: 20)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text("\(definition.forwardName) / \(definition.inverseName)")
            .foregroundStyle(.primary)
          Text(definition.summary(using: store.supertags))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private func load() async {
    do {
      definitions = try await store.graphRelationDefinitions()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func deletePendingDefinition() async {
    guard let definition = definitionPendingDeletion else { return }
    do {
      try await store.deleteGraphRelationDefinition(definition.id)
      definitionPendingDeletion = nil
      await load()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var deletionBinding: Binding<Bool> {
    Binding(
      get: { definitionPendingDeletion != nil },
      set: { if !$0 { definitionPendingDeletion = nil } }
    )
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}

private struct GraphRelationDefinitionEditor: View {
  let store: LibraryStore
  let definition: RelationDefinition
  let isNew: Bool

  @Environment(\.dismiss) private var dismiss
  @State private var draft: RelationDefinition
  @State private var isSaving = false
  @State private var errorMessage: String?

  init(store: LibraryStore, definition: RelationDefinition, isNew: Bool) {
    self.store = store
    self.definition = definition
    self.isNew = isNew
    _draft = State(initialValue: definition)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Names") {
          TextField("Forward name", text: $draft.forwardName)
          TextField("Backlink name", text: $draft.inverseName)
          Text("For example, Person “works at” Company appears on the Company as “people”.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Section("Endpoints") {
          typePicker("Source types", selection: $draft.sourceTagIDs)
          typePicker("Target types", selection: $draft.targetTagIDs)
          Text("Leaving an endpoint unrestricted allows any page type. Inherited types are accepted.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Section("Cardinality") {
          Picker("Targets per source", selection: $draft.cardinality.targetsPerSource) {
            ForEach(EndpointMaximum.allCases, id: \.self) { maximum in
              Text(maximum.title).tag(maximum)
            }
          }
          Picker("Sources per target", selection: $draft.cardinality.sourcesPerTarget) {
            ForEach(EndpointMaximum.allCases, id: \.self) { maximum in
              Text(maximum.title).tag(maximum)
            }
          }
          LabeledContent("Shape", value: draft.cardinality.title)
        }

        if definition.isSystem {
          Section {
            Text("This relationship is part of Enchiridion’s Base Tag ontology and cannot be changed.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      .formStyle(.grouped)
      .disabled(definition.isSystem || isSaving)
      .navigationTitle(navigationTitle)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(definition.isSystem ? "Done" : "Cancel") { dismiss() }
            .disabled(false)
        }
        if !definition.isSystem {
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") { Task { await save() } }
              .disabled(!canSave || isSaving)
          }
        }
      }
      .alert("Cannot Save Relationship", isPresented: errorBinding) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(errorMessage ?? "Check the relationship definition and try again.")
      }
    }
    #if os(macOS)
    .frame(minWidth: 500, minHeight: 520)
    #endif
  }

  private var navigationTitle: String {
    if definition.isSystem { return "Base Relationship" }
    return isNew ? "New Relationship" : "Edit Relationship"
  }

  private var canSave: Bool {
    !draft.forwardName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !draft.inverseName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func typePicker(_ title: String, selection: Binding<[TagID]>) -> some View {
    Menu {
      ForEach(store.supertags) { tag in
        Toggle(tag.name, isOn: Binding(
          get: { selection.wrappedValue.contains(tag.id) },
          set: { enabled in
            if enabled {
              if !selection.wrappedValue.contains(tag.id) {
                selection.wrappedValue.append(tag.id)
              }
            } else {
              selection.wrappedValue.removeAll { $0 == tag.id }
            }
          }
        ))
      }
    } label: {
      LabeledContent(title, value: typeNames(selection.wrappedValue))
    }
  }

  private func typeNames(_ ids: [TagID]) -> String {
    guard !ids.isEmpty else { return "Any type" }
    return ids.compactMap { id in
      store.supertags.first(where: { $0.id == id })?.name
    }.joined(separator: ", ")
  }

  private func save() async {
    isSaving = true
    defer { isSaving = false }
    do {
      try await store.saveGraphRelationDefinition(draft)
      dismiss()
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

private extension RelationDefinition {
  static var draft: Self {
    .init(
      id: .random(),
      forwardName: "relates to",
      inverseName: "related from"
    )
  }

  func summary(using tags: [SupertagDefinition]) -> String {
    let sources = endpointNames(sourceTagIDs, tags: tags)
    let targets = endpointNames(targetTagIDs, tags: tags)
    return "\(sources) → \(targets) · \(cardinality.title)"
  }

  private func endpointNames(_ ids: [TagID], tags: [SupertagDefinition]) -> String {
    guard !ids.isEmpty else { return "Any page" }
    return ids.compactMap { id in tags.first(where: { $0.id == id })?.name }
      .joined(separator: ", ")
  }
}

private extension RelationCardinality {
  var title: String {
    switch (targetsPerSource, sourcesPerTarget) {
    case (.one, .one): "One to one"
    case (.many, .one): "One to many"
    case (.one, .many): "Many to one"
    case (.many, .many): "Many to many"
    }
  }
}

private extension EndpointMaximum {
  var title: String { self == .one ? "One" : "Many" }
}
