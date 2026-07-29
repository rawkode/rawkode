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
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var surfaceID = UUID()
  @State private var draft = ""
  @FocusState private var composerIsFocused: Bool

  private static let starterPrompts = [
    "Review today",
    "What is overdue?",
    "Find a note",
  ]

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
            systemImage: "exclamationmark.circle",
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
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if session.turns.isEmpty {
            introduction(session)
          } else {
            ForEach(Array(session.turns.enumerated()), id: \.offset) { index, turn in
              AssistantTurnView(turn: turn)
                .id(index)

              if index < session.turns.count - 1 {
                Divider()
                  .padding(.vertical, 28)
              }
            }
          }
        }
        .frame(maxWidth: 720, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity)
      }
      .onChange(of: session.turns.count) { _, count in
        guard count > 0 else { return }
        if reduceMotion {
          proxy.scrollTo(count - 1, anchor: .bottom)
        } else {
          withAnimation(.smooth(duration: 0.2)) {
            proxy.scrollTo(count - 1, anchor: .bottom)
          }
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      composer(session)
    }
  }

  private func composer(_ session: AssistantConversationSession) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      composerStatus(session)

      HStack(alignment: .bottom, spacing: 8) {
        TextField("Ask about tasks, notes, or your day", text: $draft, axis: .vertical)
          .lineLimit(1...5)
          .textFieldStyle(.plain)
          .focused($composerIsFocused)
          .onSubmit { submit(draft, to: session) }
          .accessibilityLabel("Message")

        voiceButton(session)

        Button {
          submit(draft, to: session)
        } label: {
          Label("Send", systemImage: "arrow.up")
            .labelStyle(.iconOnly)
            .frame(minWidth: 20, minHeight: 20)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.circle)
        .frame(minWidth: 44, minHeight: 44)
        .disabled(
          draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.isRunning
        )
        .accessibilityLabel("Send message")
      }
    }
    .frame(maxWidth: 720, alignment: .leading)
    .padding(.horizontal, 24)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity)
    .background(.background)
    .overlay(alignment: .top) { Divider() }
  }

  private func voiceButton(_ session: AssistantConversationSession) -> some View {
    Button {
      if session.isVoiceRunning {
        Task { await session.stop() }
      } else {
        Task { await session.startVoice() }
      }
    } label: {
      Group {
        if !session.isVoiceRunning
          && (session.voiceAvailability == .checking || session.voiceAvailability == .installing)
        {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: session.isVoiceRunning ? "stop.fill" : "mic.fill")
        }
      }
      .frame(minWidth: 20, minHeight: 20)
    }
    .buttonStyle(.bordered)
    .buttonBorderShape(.circle)
    .tint(session.isVoiceRunning ? .red : .accentColor)
    .frame(minWidth: 44, minHeight: 44)
    .disabled(voiceButtonIsDisabled(session))
    .accessibilityLabel(session.isVoiceRunning ? "Stop voice conversation" : "Listen")
    .accessibilityHint(
      session.isVoiceRunning
        ? "Stops listening and speech"
        : "Starts an on-device voice conversation"
    )
  }

  @ViewBuilder
  private func composerStatus(_ session: AssistantConversationSession) -> some View {
    switch session.state {
    case .listening:
      activityStatus("Listening…", systemImage: "mic.fill")
    case .thinking:
      activityStatus("Thinking…")
    case .speaking:
      activityStatus("Speaking…", systemImage: "speaker.fill")
    case .error(let failure):
      if session.turns.last?.answer != failure.message {
        Label(failure.message, systemImage: "exclamationmark.circle.fill")
          .font(.caption)
          .foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      }
    case .idle, .stopped:
      voiceAvailabilityStatus(session)
    }
  }

  @ViewBuilder
  private func activityStatus(_ text: String, systemImage: String? = nil) -> some View {
    HStack(spacing: 6) {
      if let systemImage {
        Image(systemName: systemImage)
      } else {
        ProgressView()
          .controlSize(.small)
      }
      Text(text)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private func voiceAvailabilityStatus(_ session: AssistantConversationSession) -> some View {
    switch session.voiceAvailability {
    case .permissionRequired:
      EmptyView()
    case .permissionDenied:
      availabilityAction("Microphone access is off.") {
        Button("Open Settings") { openMicrophoneSettings() }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
      }
    case .installationRequired:
      availabilityAction("Voice needs Apple's on-device speech model.") {
        Button("Install model") { Task { await session.installVoiceAssets() } }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
      }
    case .unavailable(let message):
      availabilityAction(message) {
        Button("Retry") { Task { await session.refreshVoiceAvailability() } }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
      }
    case .checking, .available, .installing:
      EmptyView()
    }
  }

  private func availabilityAction<Content: View>(
    _ message: String,
    @ViewBuilder action: () -> Content
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(message)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
      action()
        .fontWeight(.medium)
        .frame(minHeight: 44)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }

  private func introduction(_ session: AssistantConversationSession) -> some View {
    VStack(alignment: .leading, spacing: 28) {
      VStack(alignment: .leading, spacing: 8) {
        Text("How can I help?")
          .font(.title2.weight(.semibold))
        Text("Ask about your tasks, calendar, or notes.")
          .font(.body)
          .foregroundStyle(.secondary)
      }

      VStack(alignment: .leading, spacing: 0) {
        Text("Try asking")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.bottom, 6)

        ForEach(Array(Self.starterPrompts.enumerated()), id: \.offset) { index, prompt in
          Button {
            submit(prompt, to: session)
          } label: {
            HStack(spacing: 12) {
              Text(prompt)
              Spacer(minLength: 16)
              Image(systemName: "arrow.up.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .disabled(session.isRunning)
          .accessibilityHint("Submits this question")

          if index < Self.starterPrompts.count - 1 {
            Divider()
          }
        }
      }
    }
    .frame(maxWidth: 520, alignment: .leading)
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

  private func voiceButtonIsDisabled(_ session: AssistantConversationSession) -> Bool {
    if session.isVoiceRunning { return false }
    return session.isRunning || !canStartVoice(session.voiceAvailability)
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
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 5) {
        Text("You")
          .font(.caption)
          .foregroundStyle(.secondary)

        Text(turn.utterance)
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .accessibilityElement(children: .combine)

      Text(turn.answer)
        .font(.body)
        .lineSpacing(3)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Assistant: \(turn.answer)")
    }
  }
}
