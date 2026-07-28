import EnchiridionCore
import SwiftUI

struct SupertagSchemaEditor: View {
  let store: LibraryStore
  let definition: SupertagDefinition
  @Environment(\.dismiss) private var dismiss
  @State private var draft: SupertagDefinition

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
            store.saveSupertag(draft)
            dismiss()
          }
          .disabled(draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    .frame(minWidth: 480, minHeight: 560)
  }

  private var taggedPages: [PageSnapshot] { store.pages(with: definition.id) }
  private var isNew: Bool { !store.supertags.contains { $0.id == definition.id } }

  private func valueCount(for fieldID: SupertagFieldID) -> Int {
    let key = SupertagPropertyKey(supertagID: definition.id, fieldID: fieldID)
    return taggedPages.reduce(0) { $0 + ($1.objectMetadata.properties[key]?.count ?? 0) }
  }
}
