import SwiftUI
import AthenaeumDomain

/// Native voice-UI task's own minimal surface: a start/stop control, a live transcript, and —
/// reusing Phase 3's `PendingChangesView` directly, per this task's own instruction — the same
/// accept/revert UI a text chat already uses, pointed at this voice session's own chat.
///
/// Owns its `VoiceAssistantViewModel` as a `@StateObject` constructed from plain params
/// (`backendURL`/`workspaceId`/`bearerCredential`) — same convention `CalendarDayView` already
/// establishes, deliberately NOT `PendingChangesView`'s "take an already-built `@ObservedObject`"
/// shape: `VoiceAssistantView` is instantiated inline inside `WorkspaceCommandCenterView`'s detail,
/// which
/// SwiftUI recomputes on any sibling panel's state change — a pre-built model handed in as a plain
/// value would be silently reconstructed (and its live mic capture + background poll/pump `Task`s
/// orphaned, never cancelled) on every one of those re-renders; `@StateObject` is specifically the
/// primitive that survives that.
enum VoiceTurnSendPresentation {
    static func canStartSend(isSending: Bool) -> Bool {
        !isSending
    }
}

public struct VoiceAssistantView: View {
    @StateObject private var model: VoiceAssistantViewModel
    @State private var isSendingTurn = false

    public init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        _model = StateObject(
            wrappedValue: VoiceAssistantViewModel(baseURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Voice assistant").font(.headline)

            controls

            if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            if model.state != .idle {
                Divider()
                transcriptView
                Divider()
                PendingChangesView(model: model.agentEditModel)
            }
        }
    }

    private var controls: some View {
        HStack {
            switch model.state {
            case .idle:
                Button("Start voice session") { Task { await model.start() } }
                    .buttonStyle(.borderedProminent)
            case .starting:
                ProgressView().controlSize(.small)
                Text("Starting…").foregroundStyle(.secondary)
            case .active:
                Label("Listening", systemImage: "waveform")
                    .foregroundStyle(.green)
                Spacer()
                Button(isSendingTurn ? "Sending…" : "Send") { sendTurn() }
                    .buttonStyle(.bordered)
                    .disabled(!VoiceTurnSendPresentation.canStartSend(isSending: isSendingTurn))
                Button("End session") { Task { await model.endSession() } }
                    .buttonStyle(.bordered)
                    .tint(.red)
            case .stopping:
                ProgressView().controlSize(.small)
                Text("Ending…").foregroundStyle(.secondary)
            }
        }
    }

    private func sendTurn() {
        guard VoiceTurnSendPresentation.canStartSend(isSending: isSendingTurn) else {
            return
        }

        isSendingTurn = true
        Task { @MainActor in
            defer { isSendingTurn = false }
            await model.sendTurn()
        }
    }

    private var transcriptView: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Transcript").font(.subheadline.bold())
            if model.transcript.isEmpty {
                Text("Nothing said yet.").font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(model.transcript) { line in
                    HStack(alignment: .top, spacing: 6) {
                        Text(label(for: line.speaker)).bold().font(.caption)
                            .foregroundStyle(color(for: line.speaker))
                            .frame(width: 72, alignment: .leading)
                        Text(line.text).font(.callout).textSelection(.enabled)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func label(for speaker: VoiceAssistantViewModel.TranscriptLine.Speaker) -> String {
        switch speaker {
        case .user: return "You"
        case .assistant: return "Agent"
        case .system: return "System"
        }
    }

    private func color(for speaker: VoiceAssistantViewModel.TranscriptLine.Speaker) -> Color {
        switch speaker {
        case .user: return .primary
        case .assistant: return .blue
        case .system: return .secondary
        }
    }
}
