import SwiftUI

struct NoteEditorView: View {
    let document: NoteDocument
    let savedQueryViews: [SavedQueryView]
    let documentContext: DocumentContext
    let onOpenPreviousDailyNote: () -> Void
    let onOpenToday: () -> Void
    let onOpenNextDailyNote: () -> Void
    let onChange: (_ documentID: UUID, _ title: String, _ contentJSON: String, _ plainText: String) -> Void
    let onEntityUpsert: (_ name: String, _ supertagNames: [String], _ properties: [String: String]?) throws -> EntityReference
    let onQueryRun: (_ query: String) throws -> QueryResult
    let onOpenDocument: (_ documentID: UUID) -> Void
    let onOpenEntity: (_ entityID: UUID) -> Void
    @State private var editorStatus: EditorStatus = .loading

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            editorAndContext
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

    private var editorAndContext: some View {
        GeometryReader { proxy in
            if proxy.size.width >= 920 {
                HStack(spacing: 0) {
                    editorPane

                    Divider()

                    DocumentContextPanel(
                        context: documentContext,
                        onOpenDocument: onOpenDocument,
                        onOpenEntity: onOpenEntity
                    )
                        .frame(width: min(340, max(292, proxy.size.width * 0.28)))
                }
            } else {
                VStack(spacing: 0) {
                    editorPane

                    Divider()

                    DocumentContextPanel(
                        context: documentContext,
                        onOpenDocument: onOpenDocument,
                        onOpenEntity: onOpenEntity
                    )
                        .frame(height: 230)
                }
            }
        }
    }

    private var editorPane: some View {
        ZStack(alignment: .top) {
            WebEditorView(
                document: document,
                savedQueryViews: savedQueryViews,
                onChange: onChange,
                onEntityUpsert: onEntityUpsert,
                onQueryRun: onQueryRun,
                onOpenDocument: onOpenDocument,
                onOpenEntity: onOpenEntity,
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

private struct DocumentContextPanel: View {
    let context: DocumentContext
    let onOpenDocument: (_ documentID: UUID) -> Void
    let onOpenEntity: (_ entityID: UUID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()

            if context.isEmpty {
                ContentUnavailableView("No Linked Context", systemImage: "link")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    if !context.backlinks.isEmpty {
                        Section("Mentioned Entities") {
                            ForEach(context.backlinks) { backlink in
                                BacklinkContextRow(
                                    backlink: backlink,
                                    onOpenDocument: onOpenDocument,
                                    onOpenEntity: onOpenEntity
                                )
                            }
                        }
                    }

                    if !context.outgoingRelationships.isEmpty {
                        Section("Outgoing Relationships") {
                            ForEach(context.outgoingRelationships) { relationship in
                                RelationshipContextRow(
                                    relationship: relationship,
                                    direction: .outgoing,
                                    onOpenEntity: onOpenEntity
                                )
                            }
                        }
                    }

                    if !context.incomingRelationships.isEmpty {
                        Section("Incoming Relationships") {
                            ForEach(context.incomingRelationships) { relationship in
                                RelationshipContextRow(
                                    relationship: relationship,
                                    direction: .incoming,
                                    onOpenEntity: onOpenEntity
                                )
                            }
                        }
                    }
                }
                .listStyle(.inset)
            }
        }
        .background(.background)
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Context", systemImage: "point.3.connected.trianglepath.dotted")
                .font(.headline)

            HStack(spacing: 10) {
                Label("\(context.backlinks.count)", systemImage: "at")
                    .accessibilityLabel("\(context.backlinks.count) mentioned entities")

                Label("\(context.relationshipCount)", systemImage: "arrow.left.and.right")
                    .accessibilityLabel("\(context.relationshipCount) relationships")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BacklinkContextRow: View {
    let backlink: DocumentBacklink
    let onOpenDocument: (_ documentID: UUID) -> Void
    let onOpenEntity: (_ entityID: UUID) -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Button {
                onOpenEntity(backlink.entityID)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "tag")
                        .foregroundStyle(.secondary)
                        .frame(width: 16)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(backlink.entityName)
                            .font(.callout.weight(.semibold))
                            .lineLimit(1)

                        Text(documentLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .buttonStyle(.plain)

            Spacer(minLength: 8)

            Button {
                onOpenDocument(backlink.documentID)
            } label: {
                Label("Open Note", systemImage: backlink.documentKind == .daily ? "calendar" : "note.text")
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .help("Open Note")
        }
        .padding(.vertical, 3)
    }

    private var documentLabel: String {
        if backlink.documentKind == .daily, let documentDate = backlink.documentDate {
            return DailyNoteDateFormatter.displayTitle(for: documentDate)
        }

        return backlink.documentTitle
    }
}

private enum RelationshipContextDirection {
    case outgoing
    case incoming
}

private struct RelationshipContextRow: View {
    let relationship: EntityRelationship
    let direction: RelationshipContextDirection
    let onOpenEntity: (_ entityID: UUID) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Button(primaryName) {
                    onOpenEntity(primaryEntityID)
                }
                .font(.callout.weight(.semibold))
                .lineLimit(1)
                .buttonStyle(.plain)

                Image(systemName: direction == .outgoing ? "arrow.right" : "arrow.left")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button(secondaryName) {
                    onOpenEntity(secondaryEntityID)
                }
                .font(.callout)
                .lineLimit(1)
                .buttonStyle(.plain)
            }

            HStack(spacing: 6) {
                Label(propertyLabel, systemImage: "slider.horizontal.3")

                Text(relationship.updatedAt, format: .dateTime.month().day().hour().minute())
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .padding(.vertical, 3)
    }

    private var primaryName: String {
        switch direction {
        case .outgoing:
            relationship.sourceName
        case .incoming:
            relationship.targetName
        }
    }

    private var primaryEntityID: UUID {
        switch direction {
        case .outgoing:
            relationship.sourceEntityID
        case .incoming:
            relationship.targetEntityID
        }
    }

    private var secondaryName: String {
        switch direction {
        case .outgoing:
            relationship.targetName
        case .incoming:
            relationship.sourceName
        }
    }

    private var secondaryEntityID: UUID {
        switch direction {
        case .outgoing:
            relationship.targetEntityID
        case .incoming:
            relationship.sourceEntityID
        }
    }

    private var propertyLabel: String {
        relationship.property
            .split(separator: "_")
            .map { $0.capitalized }
            .joined(separator: " ")
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
            savedQueryViews: [],
            documentContext: .empty,
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
            onOpenDocument: { _ in },
            onOpenEntity: { _ in }
        )
    }
}
