import Foundation
import SwiftUI
import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

/// An existing workspace node that can be inserted as a typed inline entity reference. Native
/// deliberately does not create nodes from this surface: creation is a separate, provenance-bearing
/// workflow and the picker should never turn a mistyped name into a durable entity.
struct DailyNoteMentionCandidate: Identifiable, Equatable {
    let id: EntityId
    let title: String

    var reference: LoroCanonicalSemanticValueV1.InlineReference {
        .init(kind: .entity, id: id, label: title)
    }
}

@MainActor
final class DailyNoteMentionSearchModel: ObservableObject {
    @Published private(set) var candidates: [DailyNoteMentionCandidate] = []
    @Published private(set) var isSearching = false
    @Published private(set) var errorMessage: String?

    private let client: WorkspaceRPCClient?
    private var searchTask: Task<Void, Never>?

    init(client: WorkspaceRPCClient?) {
        self.client = client
    }

    deinit {
        searchTask?.cancel()
    }

    func search(query: String) {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        candidates = []
        errorMessage = nil
        guard let client, !trimmed.isEmpty else {
            isSearching = false
            return
        }

        isSearching = true
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 180_000_000)
            guard !Task.isCancelled, let self else { return }
            do {
                let results = try await client.searchNodes(query: trimmed, limit: 8)
                guard !Task.isCancelled else { return }
                self.candidates = results.map { .init(id: $0.nodeId, title: $0.title) }
                self.errorMessage = nil
            } catch {
                guard !Task.isCancelled else { return }
                self.candidates = []
                self.errorMessage = "Entity search is unavailable right now."
            }
            self.isSearching = false
        }
    }
}

/// Small, keyboard-friendly native picker for an existing typed entity. It is intentionally a
/// focused surface rather than a second command center: the daily note remains the primary place
/// where the user writes, while the picker only resolves the entity under the captured `@` range.
struct DailyNoteMentionPicker: View {
    let context: LoroNativeRichTextMentionContext
    @ObservedObject var model: DailyNoteMentionSearchModel
    let onSelect: (DailyNoteMentionCandidate) -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "at")
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Mention an entity")
                        .font(.headline)
                    Text(context.query.isEmpty ? "Type a name to search your workspace" : "Choose an existing entity")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button("Dismiss", action: onDismiss)
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("Dismiss entity picker")
            }

            Group {
                if model.isSearching {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Searching entities…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if let errorMessage = model.errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(errorMessage)
                } else if model.candidates.isEmpty {
                    Text(context.query.isEmpty ? "Start typing to find a person, project, or note." : "No existing entities match this name.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    VStack(spacing: 2) {
                        ForEach(model.candidates) { candidate in
                            Button {
                                onSelect(candidate)
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "person.crop.circle")
                                        .foregroundStyle(.tint)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(candidate.title)
                                            .foregroundStyle(.primary)
                                            .lineLimit(1)
                                        Text("Workspace entity")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 8)
                                    Image(systemName: "arrow.turn.down.left")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                                .padding(.vertical, 5)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Mention \(candidate.title)")
                            .accessibilityHint("Inserts this existing entity at the captured mention")
                        }
                    }
                }
            }
        }
        .padding(14)
        .frame(minWidth: 280, idealWidth: 320, maxWidth: 360)
        .task(id: context.query) {
            model.search(query: context.query)
        }
#if os(macOS)
        .onExitCommand(perform: onDismiss)
#endif
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Entity mention picker")
    }
}
