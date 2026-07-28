import EnchiridionCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct AssistantConversationView: View {
  let session: AssistantConversationSession?
  let unavailableReason: String?

  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var surfaceID = UUID()
  @State private var speechSetup: AssistantSpeechSetupState = .checking

  var body: some View {
    NavigationStack {
      Group {
        if let session {
          conversation(session)
        } else {
          ContentUnavailableView(
            "Assistant Unavailable",
            systemImage: "waveform.slash",
            description: Text(unavailableReason ?? "The on-device assistant is not available.")
          )
        }
      }
      .navigationTitle("Assistant")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
    }
    .task(id: surfaceID) {
      await prepareSurface()
    }
    .onDisappear {
      guard let session else { return }
      let closingSurfaceID = surfaceID
      Task { await session.stopSurface(closingSurfaceID) }
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase != .active, let session else { return }
      let inactiveSurfaceID = surfaceID
      Task { await session.stopSurface(inactiveSurfaceID) }
    }
  }

  private func conversation(_ session: AssistantConversationSession) -> some View {
    Group {
      switch speechSetup {
      case .checking:
        ProgressView("Checking on-device speech…")
      case .ready:
        activeConversation(session)
      case .installationRequired:
        speechInstallation
      case .installing:
        ProgressView("Installing on-device speech model…")
      case .unavailable(let message):
        ContentUnavailableView(
          "Speech Unavailable",
          systemImage: "waveform.slash",
          description: Text(message)
        )
      }
    }
  }

  private func activeConversation(_ session: AssistantConversationSession) -> some View {
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

      VStack(spacing: 14) {
        Label(statusText(session.state), systemImage: statusSymbol(session.state))
          .font(.headline)
          .foregroundStyle(statusColor(session.state))
          .contentTransition(.symbolEffect(.replace))

        Button {
          if session.isRunning {
            Task { await session.stop() }
          } else {
            session.start()
          }
        } label: {
          Label(
            session.isRunning ? "Stop" : startButtonTitle(session.state),
            systemImage: session.isRunning ? "stop.fill" : "mic.fill"
          )
          .frame(minWidth: 150)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(session.isRunning ? .red : .accentColor)

        if case .error(let failure) = session.state,
          failure.message.localizedCaseInsensitiveContains("microphone")
        {
          Button("Open Microphone Settings") { openMicrophoneSettings() }
        }

        Text("Questions are transcribed and answered on this device. Conversation context is discarded when you close the assistant.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          .frame(maxWidth: 520)
      }
      .padding(20)
    }
  }

  private var speechInstallation: some View {
    ContentUnavailableView {
      Label("Install Speech Model", systemImage: "arrow.down.circle")
    } description: {
      Text("The current language needs an Apple on-device speech model before Enchiridion can listen.")
    } actions: {
      Button("Download and Install") {
        Task { await installSpeechAssets() }
      }
      .buttonStyle(.borderedProminent)
    }
  }

  private var introduction: some View {
    ContentUnavailableView {
      Label("Talk to Enchiridion", systemImage: "waveform.circle.fill")
    } description: {
      Text("Ask about your calendar or notes. Enchiridion verifies answers against local sources, then keeps listening for a follow-up.")
    }
  }

  private func statusText(_ state: AssistantConversationState) -> String {
    switch state {
    case .idle: "Ready"
    case .listening: "Listening…"
    case .thinking: "Checking your local sources…"
    case .speaking: "Speaking…"
    case .stopped: "Stopped"
    case .error(let failure): failure.message
    }
  }

  private func statusSymbol(_ state: AssistantConversationState) -> String {
    switch state {
    case .idle, .stopped: "waveform"
    case .listening: "mic.fill"
    case .thinking: "sparkles"
    case .speaking: "speaker.wave.2.fill"
    case .error: "exclamationmark.triangle.fill"
    }
  }

  private func statusColor(_ state: AssistantConversationState) -> Color {
    if case .error = state { return .orange }
    return .primary
  }

  private func startButtonTitle(_ state: AssistantConversationState) -> String {
    switch state {
    case .error: "Try Again"
    default: "Start Listening"
    }
  }

  private func prepareSurface() async {
    guard let session else { return }
    await session.activateSurface(surfaceID)
    if #available(iOS 26.0, macOS 26.0, *) {
      await refreshSpeechSetupUntilSettled()
    } else {
      speechSetup = .unavailable("The audio assistant requires iOS 26 or macOS 26, or later.")
    }
  }

  private func installSpeechAssets() async {
    guard #available(iOS 26.0, macOS 26.0, *) else { return }
    speechSetup = .installing
    do {
      try await AssistantSpeechAssets.shared.install()
      await refreshSpeechSetupUntilSettled()
    } catch {
      speechSetup = .unavailable(error.localizedDescription)
    }
  }

  @available(iOS 26.0, macOS 26.0, *)
  private func refreshSpeechSetupUntilSettled() async {
    repeat {
      speechSetup = await AssistantSpeechAssets.shared.setupState()
      guard speechSetup == .installing else { return }
      try? await Task.sleep(for: .seconds(1))
    } while !Task.isCancelled
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
