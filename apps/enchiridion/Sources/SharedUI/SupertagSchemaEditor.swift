import EnchiridionCore
import SwiftUI

struct SupertagSchemaEditor: View {
  let store: LibraryStore
  let definition: SupertagDefinition
  @Environment(\.dismiss) private var dismiss
  @State private var draft: SupertagDefinition
  @State private var isSaving = false
  @State private var errorMessage: String?

  init(store: LibraryStore, definition: SupertagDefinition) {
    self.store = store
    self.definition = definition
    _draft = State(initialValue: definition)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Supertag") {
          TextField("Name", text: $draft.name)
          TextField("Symbol", text: $draft.symbol)
        }

        Section("Inheritance") {
          if definition.isBuiltIn {
            if draft.parentIDs.isEmpty {
              Text("Base Tag")
                .foregroundStyle(.secondary)
            } else {
              ForEach(draft.parentIDs) { parentID in
                Label(parentName(parentID), systemImage: "arrow.up.right")
              }
            }
            Text("Base Tag inheritance is fixed by Enchiridion.")
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            Menu("Inherits From", systemImage: "arrow.triangle.branch") {
              ForEach(store.supertags.filter { $0.id != draft.id }) { candidate in
                Toggle(
                  candidate.name,
                  isOn: Binding(
                    get: { draft.parentIDs.contains(candidate.id) },
                    set: { enabled in
                      if enabled { draft.parentIDs.append(candidate.id) }
                      else { draft.parentIDs.removeAll { $0 == candidate.id } }
                    }
                  )
                )
              }
            }
            if draft.parentIDs.isEmpty {
              Text("This type does not inherit properties from another type.")
                .foregroundStyle(.secondary)
            } else {
              ForEach(draft.parentIDs) { parentID in
                HStack {
                  Label(parentName(parentID), systemImage: "arrow.up.right")
                  Spacer()
                  Button(role: .destructive) {
                    draft.parentIDs.removeAll { $0 == parentID }
                  } label: {
                    Label("Remove Parent", systemImage: "minus.circle")
                      .labelStyle(.iconOnly)
                  }
                  .buttonStyle(.borderless)
                }
              }
            }
            Text("Multiple inheritance is allowed. Cycles are rejected when you save.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }

        Section("Fields") {
          ForEach($draft.fields) { $field in
            DisclosureGroup {
              TextField("Name", text: $field.name)
              Picker("Type", selection: $field.type) {
                ForEach(SupertagFieldType.allCases, id: \.self) { type in
                  Text(type.title).tag(type)
                }
              }
              .disabled(valueCount(for: field.id) > 0)
              Toggle("Allow multiple values", isOn: $field.allowsMultiple)
                .disabled(valueCount(for: field.id) > 0)
              Toggle("Required", isOn: $field.isRequired)
              if field.type == .text { Toggle("Multiline", isOn: $field.isMultiline) }
              if field.type == .select {
                ForEach($field.options) { $option in
                  TextField("Option", text: $option.name)
                }
                Button("Add option") {
                  field.options.append(.init(id: UUID().uuidString.lowercased(), name: "New option"))
                }
              }
              if field.type == .entityReference {
                Menu("Allowed types") {
                  ForEach(store.supertags.filter { $0.id != draft.id }) { candidate in
                    Toggle(
                      candidate.name,
                      isOn: Binding(
                        get: { field.allowedSupertagIDs.contains(candidate.id) },
                        set: { enabled in
                          if enabled { field.allowedSupertagIDs.append(candidate.id) }
                          else { field.allowedSupertagIDs.removeAll { $0 == candidate.id } }
                        }
                      )
                    )
                  }
                }
              }
              Button("Delete field", role: .destructive) { field.isDeleted = true }
            } label: {
              HStack {
                Text(field.name)
                Spacer()
                Text(field.type.title).foregroundStyle(.secondary)
                if valueCount(for: field.id) > 0 {
                  Text("\(valueCount(for: field.id)) values").foregroundStyle(.secondary)
                }
              }
            }
          }
          .onMove { draft.fields.move(fromOffsets: $0, toOffset: $1) }

          Button("Add field", systemImage: "plus") {
            draft.fields.append(.init(
              id: .init(rawValue: "field-\(UUID().uuidString.lowercased())"),
              name: "New field",
              type: .text
            ))
          }
        }

        Section("Impact") {
          LabeledContent("Tagged pages", value: taggedPages.count.formatted())
          Text("Changing names is safe. Field types and cardinality are locked once values exist; delete a field to retain its values for recovery.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .formStyle(.grouped)
      .navigationTitle(isNew ? "New Supertag" : "Edit \(definition.name)")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task { await save() }
          }
          .disabled(
            draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving
          )
        }
      }
      .disabled(isSaving)
      .alert("Cannot Save Supertag", isPresented: errorBinding) {
        Button("Dismiss Error", role: .cancel) {}
      } message: {
        Text(errorMessage ?? "Check the inheritance and field definitions, then try again.")
      }
    }
    #if os(macOS)
    .frame(minWidth: 480, minHeight: 560)
    #endif
  }

  private var taggedPages: [PageSnapshot] { store.pages(with: definition.id) }
  private var isNew: Bool { !store.supertags.contains { $0.id == definition.id } }

  private func valueCount(for fieldID: SupertagFieldID) -> Int {
    let key = SupertagPropertyKey(supertagID: definition.id, fieldID: fieldID)
    return taggedPages.reduce(0) { $0 + ($1.objectMetadata.properties[key]?.count ?? 0) }
  }

  private func parentName(_ id: TagID) -> String {
    store.supertags.first(where: { $0.id == id })?.name ?? id.rawValue
  }

  private func save() async {
    isSaving = true
    defer { isSaving = false }
    do {
      try await store.saveSupertag(draft)
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
