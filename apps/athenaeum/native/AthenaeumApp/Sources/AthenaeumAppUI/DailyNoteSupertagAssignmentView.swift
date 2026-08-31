import SwiftUI

/// A note-level membership control, intentionally separate from text editing. It does not claim
/// typed-token or block ownership support: the view only reflects a confirmed server snapshot.
struct DailyNoteSupertagAssignmentView: View {
    @ObservedObject var model: AthenaeumViewModel

    var body: some View {
        switch model.dailyNoteSupertagAssignmentState {
        case .idle, .loading:
            Label("Loading Supertags…", systemImage: "tag")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.updatesFrequently)
        case .failed:
            HStack(spacing: 8) {
                Text("Supertags are unavailable. Nothing has been changed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Retry") { Task { await model.refreshDailyNoteSupertags() } }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        case .emptyCatalog:
            Text("No Supertags are available for this note yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .loaded(let tags, let appliedTagIds):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if model.isDailyNoteSupertagRetryAvailable {
                    Button("Retry tag assignment") {
                        Task { await model.retryDailyNoteSupertagAssignment() }
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .accessibilityHint("Retries the same pending tag assignment for this note.")
                }
                Menu("Tag this note") {
                    ForEach(tags, id: \.id) { tag in
                        Button {
                            Task { await model.applyDailyNoteSupertag(tagId: tag.id) }
                        } label: {
                            if appliedTagIds.contains(tag.id) {
                                Label(tag.name, systemImage: "checkmark")
                            } else {
                                Text(tag.name)
                            }
                        }
                        .disabled(appliedTagIds.contains(tag.id) || model.isEditorInputDisabled)
                    }
                }
                .disabled(model.isEditorInputDisabled || model.isDailyNoteSupertagRetryAvailable)
                .accessibilityHint("Applies a confirmed Supertag to this daily note without changing its text.")

                if !appliedTagIds.isEmpty {
                    Text("\(appliedTagIds.count) applied")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
