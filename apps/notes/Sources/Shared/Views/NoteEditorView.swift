import SwiftUI

struct NoteEditorView: View {
    let document: NoteDocument
    let onOpenPreviousDailyNote: () -> Void
    let onOpenToday: () -> Void
    let onOpenNextDailyNote: () -> Void
    let onChange: (_ documentID: UUID, _ title: String, _ contentJSON: String, _ plainText: String) -> Void
    let onEntityUpsert: (_ name: String, _ supertagNames: [String], _ properties: [String: String]?) throws -> EntityReference
    let onQueryRun: (_ query: String) throws -> QueryResult
    let onOpenDocument: (_ documentID: UUID) -> Void
    @State private var editorStatus: EditorStatus = .loading

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ZStack(alignment: .top) {
                WebEditorView(
                    document: document,
                    onChange: onChange,
                    onEntityUpsert: onEntityUpsert,
                    onQueryRun: onQueryRun,
                    onOpenDocument: onOpenDocument,
                    onReady: {
                        editorStatus = .ready
                    },
                    onError: { message in
                        editorStatus = .failed(message)
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if editorStatus != .ready {
                    EditorStatusBanner(status: editorStatus)
                        .padding(.top, 14)
                        .padding(.horizontal, 18)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(document.displayTitle)
#if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
#endif
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(document.displayTitle)
                .font(.title.weight(.semibold))
                .lineLimit(2)

            HStack(spacing: 10) {
                if document.kind == .daily, let date = document.date {
                    Label(DailyNoteDateFormatter.subtitle(for: date), systemImage: "calendar")
                } else {
                    Label("Note", systemImage: "note.text")
                }

                Label {
                    Text(document.updatedAt, format: .dateTime.month().day().hour().minute())
                } icon: {
                    Image(systemName: "clock")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if document.kind == .daily {
                dailyNavigationControls
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var dailyNavigationControls: some View {
        HStack(spacing: 8) {
            Button(action: onOpenPreviousDailyNote) {
                Label("Previous Day", systemImage: "chevron.left")
            }

            Button(action: onOpenToday) {
                Label("Today", systemImage: "calendar")
            }

            Button(action: onOpenNextDailyNote) {
                Label("Next Day", systemImage: "chevron.right")
            }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .font(.caption)
    }
}

private enum EditorStatus: Equatable {
    case loading
    case ready
    case failed(String)
}

private struct EditorStatusBanner: View {
    let status: EditorStatus

    var body: some View {
        HStack(spacing: 10) {
            switch status {
            case .loading:
                ProgressView()
                    .controlSize(.small)
                Text("Loading editor")
                    .font(.callout)

            case .ready:
                EmptyView()

            case .failed(let message):
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text(message)
                    .font(.callout)
                    .lineLimit(3)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(.secondary.opacity(0.18))
        }
    }
}

#Preview {
    NavigationStack {
        NoteEditorView(
            document: NoteDocument(
                id: UUID(),
                kind: .daily,
                date: DailyNoteDateFormatter.storageString(from: .now),
                title: "Today",
                tiptapJSON: SQLiteNotesRepository.defaultDailyNoteJSON(title: "Today"),
                plainText: "Preview text",
                createdAt: .now,
                updatedAt: .now
            ),
            onOpenPreviousDailyNote: {},
            onOpenToday: {},
            onOpenNextDailyNote: {},
            onChange: { _, _, _, _ in },
            onEntityUpsert: { name, supertagNames, properties in
                EntityReference(id: UUID(), label: name, supertags: supertagNames, properties: properties ?? [:])
            },
            onQueryRun: { _ in
                QueryResult(columns: ["name"], rows: [["name": "Preview"]])
            },
            onOpenDocument: { _ in }
        )
    }
}
