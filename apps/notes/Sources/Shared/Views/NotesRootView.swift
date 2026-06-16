import SwiftUI

struct NotesRootView: View {
    let store: NotesStore

    @State private var dailyNoteDate = Date.now

    private var selectedDocumentID: Binding<UUID?> {
        Binding {
            store.selectedDocument?.id
        } set: { newValue in
            store.selectDocument(id: newValue)
        }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selectedDocumentID) {
                Section("Daily Notes") {
                    Button {
                        store.selectToday()
                    } label: {
                        Label("Today", systemImage: "calendar")
                    }

                    DailyNoteDatePicker(date: $dailyNoteDate) {
                        store.createDailyNote(for: dailyNoteDate)
                    }

                    ForEach(store.dailyNotes) { document in
                        NavigationLink(value: document.id) {
                            NoteRow(document: document)
                        }
                    }
                }

                Section("Notes") {
                    ForEach(store.standaloneNotes) { document in
                        NavigationLink(value: document.id) {
                            NoteRow(document: document)
                        }
                    }
                    .onDelete(perform: deleteStandaloneNotes)
                }
            }
            .navigationTitle("Notes")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: store.selectToday) {
                        Label("Today", systemImage: "calendar.badge.clock")
                    }
                    .keyboardShortcut("t", modifiers: [.command])
                }

                ToolbarItem {
                    Menu {
                        Button(action: store.selectToday) {
                            Label("Open Today", systemImage: "calendar")
                        }

                        Button(action: store.createStandaloneNote) {
                            Label("New Note", systemImage: "square.and.pencil")
                        }
                        .keyboardShortcut("n", modifiers: [.command])
                    } label: {
                        Label("Create", systemImage: "plus")
                    }
                }
            }
        } detail: {
            if let selectedDocument = store.selectedDocument {
                NoteEditorView(document: selectedDocument) { documentID, title, contentJSON, plainText in
                    store.saveEditorChange(
                        documentID: documentID,
                        title: title,
                        contentJSON: contentJSON,
                        plainText: plainText
                    )
                } onEntityUpsert: { name, supertagNames, properties in
                    try store.upsertEntity(named: name, supertagNames: supertagNames, properties: properties)
                } onQueryRun: { query in
                    try store.runQuery(query)
                }
            } else {
                ContentUnavailableView(
                    "No Daily Note Selected",
                    systemImage: "calendar",
                    description: Text("Open today or select an earlier daily note.")
                )
            }
        }
        .task {
            store.load()
        }
        .alert("Notes Database", isPresented: errorBinding) {
            Button("OK") {
                store.clearError()
            }
        } message: {
            Text(store.lastErrorMessage ?? "Unknown database error.")
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding {
            store.lastErrorMessage != nil
        } set: { isPresented in
            if !isPresented {
                store.clearError()
            }
        }
    }

    private func deleteStandaloneNotes(at offsets: IndexSet) {
        deleteDocuments(store.standaloneNotes, at: offsets)
    }

    private func deleteDocuments(_ documents: [NoteDocument], at offsets: IndexSet) {
        for offset in offsets {
            store.deleteDocument(id: documents[offset].id)
        }
    }
}

private struct DailyNoteDatePicker: View {
    @Binding var date: Date
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            DatePicker("Open Daily Note", selection: $date, displayedComponents: .date)
                .datePickerStyle(.compact)

            Button(action: onOpen) {
                Label("Open Date", systemImage: "calendar.badge.plus")
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }
}

private struct NoteRow: View {
    let document: NoteDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(document.displayTitle)
                    .font(.headline)
                    .lineLimit(1)

                if document.isToday {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 7))
                        .foregroundStyle(.green)
                }
            }

            if document.kind == .daily, let date = document.date {
                Text(DailyNoteDateFormatter.subtitle(for: date))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            if !document.previewText.isEmpty {
                Text(document.previewText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Text(document.updatedAt, format: .dateTime.month().day().hour().minute())
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}

#Preview {
    NotesRootView(store: NotesStore())
}
