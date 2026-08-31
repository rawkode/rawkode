import SwiftUI
import AthenaeumRPC

private final class DailyNoteSupertagPickerActivation {
    var didCapturePreActivation = false
}

/// The concrete picker is kept separate from the server-backed state view so the focus boundary
/// is explicit: the opener captures the editor witness, while a later row action only submits the
/// selected tag. This same control is hosted by the macOS and iOS shells.
struct DailyNoteSupertagPicker: View {
    let tags: [RPCTag]
    let appliedTagIds: Set<String>
    let isDisabled: Bool
    let onWillAssign: () -> Void
    let onAssign: (String) -> Void
    @State private var isPickerPresented = false
    @State private var activation = DailyNoteSupertagPickerActivation()

    var body: some View {
        Button {
            // Keyboard activation may not deliver the gesture, so keep the outer action as a
            // fallback. Pointer activation is captured once by the high-priority edge below.
            if !activation.didCapturePreActivation {
                onWillAssign()
            }
            activation.didCapturePreActivation = false
            isPickerPresented = true
        } label: {
            Label("Tag this note", systemImage: "tag")
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("daily-note-supertag-picker")
        .highPriorityGesture(TapGesture().onEnded {
            // AppKit may make the button first responder before its action runs. The high
            // priority gesture is the pre-activation edge; the action below remains the keyboard
            // and platform fallback when no gesture is delivered.
            guard !activation.didCapturePreActivation else { return }
            activation.didCapturePreActivation = true
            onWillAssign()
        })
        .popover(isPresented: $isPickerPresented, attachmentAnchor: .point(.bottom), arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Choose a Supertag")
                    .font(.headline)
                ForEach(tags, id: \.id) { tag in
                    Button {
                        isPickerPresented = false
                        onAssign(tag.id)
                    } label: {
                        if appliedTagIds.contains(tag.id) {
                            Label(tag.name, systemImage: "checkmark")
                        } else {
                            Text(tag.name)
                        }
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("daily-note-supertag-\(tag.id)")
                    .disabled(appliedTagIds.contains(tag.id) || isDisabled)
                }
            }
            .padding()
            .frame(minWidth: 220, alignment: .leading)
        }
        .disabled(isDisabled)
        .accessibilityHint("Applies a confirmed Supertag to this daily note without changing its text.")
    }
}

/// A note-level membership control, intentionally separate from text editing. It does not claim
/// typed-token or block ownership support: the view only reflects a confirmed server snapshot.
struct DailyNoteSupertagAssignmentView: View {
    @ObservedObject var model: AthenaeumViewModel
    /// Called synchronously from the picker opener, before the popover can move keyboard or
    /// first-responder focus away from the editor.
    let onWillAssign: () -> Void

    init(model: AthenaeumViewModel, onWillAssign: @escaping () -> Void = {}) {
        self.model = model
        self.onWillAssign = onWillAssign
    }

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
                DailyNoteSupertagPicker(
                    tags: tags,
                    appliedTagIds: appliedTagIds,
                    isDisabled: model.isEditorInputDisabled || model.isDailyNoteSupertagRetryAvailable,
                    onWillAssign: onWillAssign,
                    onAssign: { tagId in
                        Task { await model.applyDailyNoteSupertag(tagId: tagId) }
                    }
                )

                if !appliedTagIds.isEmpty {
                    Text("\(appliedTagIds.count) applied")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
