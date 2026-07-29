import EnchiridionCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum AssistantConversationPresentation: Equatable, Sendable {
  case dismissible
  case embedded
}

struct AssistantConversationView: View {
  let session: AssistantConversationSession?
  let unavailableReason: String?
  let presentation: AssistantConversationPresentation

  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var surfaceID = UUID()
  @State private var draft = ""
  @FocusState private var composerIsFocused: Bool

  init(
    session: AssistantConversationSession?,
    unavailableReason: String?,
    presentation: AssistantConversationPresentation = .dismissible
  ) {
    self.session = session
    self.unavailableReason = unavailableReason
    self.presentation = presentation
  }

  var body: some View {
    NavigationStack {
      Group {
        if let session {
          conversation(session)
        } else {
          ContentUnavailableView(
            "Assistant Unavailable",
            systemImage: "sparkles",
            description: Text(unavailableReason ?? "The on-device assistant is not available.")
          )
        }
      }
      .navigationTitle("Assistant")
      .toolbar {
        if presentation == .dismissible {
          ToolbarItem(placement: .cancellationAction) {
            Button("Close") { dismiss() }
          }
        }
      }
    }
    .task(id: surfaceID) { await prepareSurface() }
    .onDisappear(perform: stopSurface)
    .onChange(of: scenePhase) { _, phase in
      guard phase != .active, let session else { return }
      Task { await session.stop() }
    }
  }

  private func conversation(_ session: AssistantConversationSession) -> some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 18) {
            if session.turns.isEmpty {
              introduction
            } else {
              ForEach(Array(session.turns.enumerated()), id: \.offset) { index, turn in
                AssistantTurnView(turn: turn)
                  .id(index)
              }
            }
          }
          .frame(maxWidth: 680, alignment: .leading)
          .padding(24)
          .frame(maxWidth: .infinity)
        }
        .onChange(of: session.turns.count) { _, count in
          guard count > 0 else { return }
          withAnimation(.smooth) { proxy.scrollTo(count - 1, anchor: .bottom) }
        }
      }

      Divider()
      voiceControls(session)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      composer(session)
    }
  }

  private func composer(_ session: AssistantConversationSession) -> some View {
    HStack(alignment: .bottom, spacing: 10) {
      TextField("Ask anything", text: $draft, axis: .vertical)
        .lineLimit(1...5)
        .textFieldStyle(.plain)
        .focused($composerIsFocused)
        .onSubmit { submit(draft, to: session) }

      Button {
        submit(draft, to: session)
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.title2)
      }
      .buttonStyle(.plain)
      .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.isRunning)
      .accessibilityLabel("Send")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(.bar)
  }

  private func voiceControls(_ session: AssistantConversationSession) -> some View {
    VStack(spacing: 12) {
      HStack(spacing: 12) {
        Label(statusText(session.state), systemImage: statusSymbol(session.state))
          .font(.subheadline.weight(.medium))
          .foregroundStyle(statusColor(session.state))
          .contentTransition(.symbolEffect(.replace))

        Spacer()

        Button {
          if session.isVoiceRunning {
            Task { await session.stop() }
          } else {
            Task { await session.startVoice() }
          }
        } label: {
          Label(
            session.isVoiceRunning ? "Stop" : "Listen",
            systemImage: session.isVoiceRunning ? "stop.fill" : "mic.fill"
          )
        }
        .buttonStyle(.borderedProminent)
        .tint(session.isVoiceRunning ? .red : .accentColor)
        .disabled(!canStartVoice(session.voiceAvailability) && !session.isVoiceRunning)
      }

      voiceAvailabilityView(session)

      Text(privacyDescription)
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 14)
  }

  @ViewBuilder
  private func voiceAvailabilityView(_ session: AssistantConversationSession) -> some View {
    switch session.voiceAvailability {
    case .checking:
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Checking on-device voice…")
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    case .available:
      EmptyView()
    case .permissionRequired:
      Text("Microphone access will be requested when you tap Listen.")
        .font(.caption)
        .foregroundStyle(.secondary)
    case .permissionDenied:
      HStack {
        Text("Microphone access is off. Typed chat is still available.")
        Button("Open Settings") { openMicrophoneSettings() }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    case .installationRequired:
      HStack {
        Text("Install Apple's on-device speech model to use the microphone.")
        Button("Install Model") { Task { await session.installVoiceAssets() } }
          .buttonStyle(.bordered)
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    case .installing:
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Installing on-device speech model…")
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    case .unavailable(let message):
      HStack {
        Text(message)
          .lineLimit(2)
        Button("Retry") { Task { await session.refreshVoiceAvailability() } }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }

  private var introduction: some View {
    ContentUnavailableView {
      Label("Ask Enchiridion", systemImage: "sparkles")
    } description: {
      Text("Ask about tasks, your calendar, notes, or anything else. If on-device speech is ready, you can also tap Listen.")
    }
  }

  private func submit(_ value: String, to session: AssistantConversationSession) {
    let utterance = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !utterance.isEmpty, !session.isRunning else { return }
    draft = ""
    Task {
      await session.submit(utterance)
      composerIsFocused = true
    }
  }

  private func canStartVoice(_ availability: AssistantVoiceAvailability) -> Bool {
    availability == .available || availability == .permissionRequired
  }

  private func statusText(_ state: AssistantConversationState) -> String {
    switch state {
    case .idle: "Ready"
    case .listening: "Listening…"
    case .thinking: "Thinking…"
    case .speaking: "Speaking…"
    case .stopped: "Stopped"
    case .error(let failure): failure.message
    }
  }

  private func statusSymbol(_ state: AssistantConversationState) -> String {
    switch state {
    case .idle, .stopped: "sparkles"
    case .listening: "mic.fill"
    case .thinking: "ellipsis.bubble"
    case .speaking: "speaker.wave.2.fill"
    case .error: "exclamationmark.triangle.fill"
    }
  }

  private func statusColor(_ state: AssistantConversationState) -> Color {
    if case .error = state { return .orange }
    return .primary
  }

  private func prepareSurface() async {
    guard let session else { return }
    if presentation == .dismissible {
      await session.activateSurface(surfaceID)
    }
    await session.refreshVoiceAvailability()
  }

  private func stopSurface() {
    guard let session else { return }
    let closingSurfaceID = surfaceID
    Task {
      switch presentation {
      case .dismissible:
        await session.stopSurface(closingSurfaceID)
      case .embedded:
        await session.stop()
      }
    }
  }

  private var privacyDescription: String {
    switch presentation {
    case .dismissible:
      "Typed and spoken questions are answered on this device. Conversation context is discarded when you close the assistant."
    case .embedded:
      "Typed and spoken questions are answered on this device. Conversation context stays available while you move between tabs."
    }
  }

  private func openMicrophoneSettings() {
    #if os(macOS)
    guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") else { return }
    NSWorkspace.shared.open(url)
    #else
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
    #endif
  }
}

private struct AssistantTurnView: View {
  let turn: AssistantConversationTurn

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(turn.utterance)
        .font(.body.weight(.medium))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.tint.opacity(0.12), in: .rect(cornerRadius: 14))
        .frame(maxWidth: .infinity, alignment: .trailing)

      Text(turn.answer)
        .font(.body)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.quaternary, in: .rect(cornerRadius: 14))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
