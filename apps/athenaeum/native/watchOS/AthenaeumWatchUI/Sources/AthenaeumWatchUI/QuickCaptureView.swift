import SwiftUI

// Minimal dictation-friendly quick-capture screen — the task's exact brief: "a single TextField,
// not a full editor." A watchOS `TextField` opens the system dictation/scribble/QWERTY-keyboard
// input sheet automatically on tap, so no extra dictation plumbing is needed here — that's a
// platform affordance, not something this view builds itself.
public struct QuickCaptureView: View {
    @ObservedObject var model: QuickCaptureViewModel

    public init(model: QuickCaptureViewModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("Quick capture")
                    .font(.headline)

                TextField("What's on your mind?", text: $model.draftText)
                    .textFieldStyle(.plain)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(.secondary.opacity(0.15)))
                    .disabled(model.state == .submitting)

                statusView

                Button(action: { Task { await model.submit() } }) {
                    if model.state == .submitting {
                        ProgressView()
                    } else {
                        Text("Save")
                    }
                }
                .disabled(model.draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.state == .submitting)
            }
            .padding(.horizontal, 4)
        }
    }

    @ViewBuilder
    private var statusView: some View {
        switch model.state {
        case .idle, .submitting:
            EmptyView()
        case .success(let title):
            Label("Saved as \u{201C}\(title)\u{201D}", systemImage: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.green)
                .task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    model.acknowledge()
                }
        case .error(let message):
            Label("Couldn't save: \(message)", systemImage: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(.orange)
        }
    }
}
