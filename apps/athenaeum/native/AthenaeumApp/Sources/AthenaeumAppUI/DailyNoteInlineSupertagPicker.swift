import Foundation
import SwiftUI
import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

/// An existing Supertag that can be inserted as a typed inline reference. Inline selection is
/// intentionally lookup-only: creating a tag, defining fields, and changing note membership are
/// separate provenance-bearing operations owned by the workspace model.
struct DailyNoteInlineSupertagCandidate: Identifiable, Equatable {
    let id: EntityId
    let title: String

    var reference: LoroCanonicalSemanticValueV1.InlineReference {
        .init(kind: .supertag, id: id, label: title)
    }
}

protocol DailyNoteInlineSupertagCatalogClient: Sendable {
    func listTags() async throws -> [RPCTag]
}

extension WorkspaceRPCClient: DailyNoteInlineSupertagCatalogClient {}

@MainActor
final class DailyNoteInlineSupertagSearchModel: ObservableObject {
    @Published private(set) var candidates: [DailyNoteInlineSupertagCandidate] = []
    @Published private(set) var isSearching = false
    @Published private(set) var errorMessage: String?

    private let client: (any DailyNoteInlineSupertagCatalogClient)?
    private var searchTask: Task<Void, Never>?

    init(client: (any DailyNoteInlineSupertagCatalogClient)?) {
        self.client = client
    }

    deinit {
        searchTask?.cancel()
    }

    /// Loads the authoritative catalog and filters it locally, preserving the server's order.
    /// Catalog completion is fenced by cancellation and the SwiftUI context identity; the host
    /// also revalidates the selected range before it ever emits an insertion command.
    func search(query: String) {
        searchTask?.cancel()
        candidates = []
        errorMessage = nil
        guard let client else {
            isSearching = false
            return
        }

        isSearching = true
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 180_000_000)
            guard !Task.isCancelled, let self else { return }
            do {
                let tags = try await client.listTags()
                guard !Task.isCancelled else { return }
                let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                var resolved: [DailyNoteInlineSupertagCandidate] = []
                for tag in tags {
                    guard let id = try? EntityId(validating: tag.id) else {
                        self.candidates = []
                        self.errorMessage = "Supertag search returned an invalid catalog entry."
                        self.isSearching = false
                        return
                    }
                    guard normalized.isEmpty || tag.name.lowercased().contains(normalized) else { continue }
                    resolved.append(.init(id: id, title: tag.name))
                    if resolved.count == 8 { break }
                }
                self.candidates = resolved
                self.errorMessage = nil
            } catch {
                guard !Task.isCancelled else { return }
                self.candidates = []
                self.errorMessage = "Supertags are unavailable right now."
            }
            self.isSearching = false
        }
    }
}

/// Small, keyboard-friendly native picker for an existing typed Supertag. It stays attached to
/// the writing surface and never offers an inline create path, so an accidental `#` cannot mint a
/// new durable schema object.
struct DailyNoteInlineSupertagPicker: View {
    let context: LoroNativeRichTextSupertagContext
    @ObservedObject var model: DailyNoteInlineSupertagSearchModel
    let isApplying: Bool
    let onSelect: (DailyNoteInlineSupertagCandidate) -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "number")
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reference a Supertag")
                        .font(.headline)
                    Text(context.query.isEmpty ? "Type a tag name from this workspace" : "Choose an existing Supertag")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button("Dismiss", action: onDismiss)
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("Dismiss Supertag picker")
            }

            Group {
                if isApplying {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Confirming Supertag membership…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if model.isSearching {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Searching Supertags…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if let errorMessage = model.errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(errorMessage)
                } else if model.candidates.isEmpty {
                    Text(context.query.isEmpty ? "Start typing to find an existing Supertag." : "No existing Supertags match this name.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    VStack(spacing: 2) {
                        ForEach(model.candidates) { candidate in
                            Button {
                                onSelect(candidate)
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "number")
                                        .foregroundStyle(.tint)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("#\(candidate.title)")
                                            .foregroundStyle(.primary)
                                            .lineLimit(1)
                                        Text("Existing workspace Supertag")
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
                            .disabled(isApplying)
                            .accessibilityLabel("Reference #\(candidate.title)")
                            .accessibilityHint("Links this existing Supertag at the captured hash query")
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
        .accessibilityLabel("Supertag reference picker")
    }
}
