import EnchiridionCore
import SwiftUI

#if os(iOS)
import AVFoundation
#elseif os(macOS)
import AppKit
#endif

struct RealtimeVoiceLobbyRoute: Identifiable {
  let id = UUID()
  let snapshot: RealtimeVoiceRouteSnapshot
}

struct RealtimeVoiceLobbyView: View {
  private enum Stage {
    case active
    case unavailable
  }

  let route: RealtimeVoiceRouteSnapshot
  let routeID: UUID
  let onKeepApple: () async -> Void
  let onOpenSettings: () -> Void

  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var stage: Stage = .active
  @State private var coordinator: RealtimeVoiceCoordinator?
  @State private var startedRouteID: UUID?

  var body: some View {
    NavigationStack {
      Group {
        switch stage {
        case .active:
          active
        case .unavailable:
          unavailable
        }
      }
      .navigationTitle("OpenAI Voice")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      coordinator?.handleLifecycleChange(lifecycleState(for: phase))
    }
    .task(id: routeID) {
      guard startedRouteID != routeID else { return }
      startedRouteID = routeID
      startOpenAIVoice()
    }
    .onDisappear { coordinator?.stop() }
    #if os(macOS)
      .frame(minWidth: 480, idealWidth: 560, minHeight: 580, idealHeight: 680)
    #endif
  }

  private var unavailable: some View {
    ContentUnavailableView {
      Label("OpenAI Voice Connection Unavailable", systemImage: "antenna.radiowaves.left.and.right.slash")
    } description: {
      Text(
        coordinator?.setupFailure
          ?? "OpenAI Voice could not start the selected direct-device route. Review Assistant Settings or use Apple On Device now."
      )
    } actions: {
      VStack(spacing: 10) {
        Button("Try Again") { restartOpenAIVoice() }
          .frame(minHeight: 44)
        Button("Open Assistant Settings") {
          dismiss()
          onOpenSettings()
        }
          .frame(minHeight: 44)
        Button("Start a New Apple On Device Conversation") {
          Task {
            await onKeepApple()
            dismiss()
          }
        }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: 44)
      }
    }
    .padding(24)
  }

  @ViewBuilder
  private var directBYOKDisclosure: some View {
    Label {
      Text(
        "After you start, Enchiridion requests microphone access and uses your saved Platform key only in native code, only in the Authorization header, and only for the pinned OpenAI endpoint. This audio-only session sends live audio and transcripts; it never sends notes, tasks, calendars, or local tools. API use is billed separately from ChatGPT. A compromised or unlocked device may expose the key."
      )
    } icon: {
      Image(systemName: "key.fill")
        .foregroundStyle(.orange)
    }
    .font(.callout)
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private var active: some View {
    if let session = coordinator?.session {
      VStack(spacing: 0) {
        RealtimeVoiceActiveView(
          state: RealtimeVoiceDisplayState(
            route: route,
            phase: session.state.phase,
            captions: session.state.captions,
            activity: session.voiceActivity,
            isMuted: session.state.phase == .muted,
            warning: session.warningMessage,
            failureMessage: session.state.failure?.message
          ),
          onToggleMute: {
            Task { await session.setMuted(session.state.phase != .muted) }
          },
          onResume: {
            Task { await session.resumeAfterSafetyPause() }
          },
          onEnd: {
            coordinator?.stop()
            dismiss()
          },
          onTryAgain: { coordinator?.retry() },
          onOpenSettings: {
            coordinator?.stop()
            dismiss()
            onOpenSettings()
          },
          onStartApple: startAppleConversation
        )
        directBYOKDisclosure
          .padding(.horizontal, 24)
          .padding(.vertical, 16)
      }
    } else {
      unavailable
    }
  }

  private func startOpenAIVoice() {
    let coordinator = RealtimeVoiceCoordinator(route: route)
    self.coordinator = coordinator
    stage = .active
    coordinator.start(initialLifecycleState: lifecycleState(for: scenePhase))
  }

  private func restartOpenAIVoice() {
    stage = .active
    if coordinator?.session != nil {
      coordinator?.retry()
    } else {
      startOpenAIVoice()
    }
  }

  private func lifecycleState(for phase: ScenePhase) -> RealtimeVoiceLifecycleState {
    switch phase {
    case .active: .active
    case .inactive: .inactive
    case .background: .background
    @unknown default: .background
    }
  }

  private func startAppleConversation() {
    Task {
      await coordinator?.session?.stop()
      await onKeepApple()
      dismiss()
    }
  }
}

private struct VoiceRouteSummary: View {
  let route: RealtimeVoiceRouteSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label("OpenAI Realtime", systemImage: "waveform.circle.fill")
        .font(.headline)
      LabeledContent("Model", value: modelTitle)
      LabeledContent("Voice", value: voiceTitle)
      LabeledContent("Local audio route", value: LocalVoiceRouteLabel.current)
      if let failure = route.authorizationFailure {
        Label(failureMessage(failure), systemImage: "exclamationmark.circle")
          .font(.caption)
          .foregroundStyle(.orange)
      }
    }
    .padding(16)
    .background(.quaternary, in: .rect(cornerRadius: 16))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "Voice route. Provider OpenAI Realtime. Model \(modelTitle). Voice \(voiceTitle). Local route \(LocalVoiceRouteLabel.current)."
    )
  }

  private var modelTitle: String {
    guard let modelID = route.modelID else { return "Setup required" }
    return OpenAIModelCatalog.realtimeOptions.first(where: { $0.id == modelID })?.title ?? modelID
  }

  private var voiceTitle: String {
    route.voiceID.flatMap(OpenAIRealtimeVoice.init(rawValue:))?.title ?? "Setup required"
  }

  private func failureMessage(_ failure: OpenAIVoiceAuthorizationFailure) -> String {
    switch failure {
    case .credentialVerificationRequired: "The OpenAI key must be verified again."
    case .modelSelectionRequired: "Choose a verified Realtime model."
    case .modelUnavailable: "The selected Realtime model is unavailable."
    case .voiceUnavailable: "Choose an official OpenAI voice."
    }
  }
}

struct RealtimeVoiceDisplayState: Equatable {
  let route: RealtimeVoiceRouteSnapshot
  let phase: RealtimeVoicePhase
  let captions: [RealtimeCaption]
  let activity: VoiceActivitySnapshot
  let isMuted: Bool
  let warning: String?
  let failureMessage: String?
}

/// Presentation for a session owned by the voice lobby. It has no direct
/// credential, local-data, or WebKit access.
struct RealtimeVoiceActiveView: View {
  let state: RealtimeVoiceDisplayState
  let onToggleMute: () -> Void
  let onResume: () -> Void
  let onEnd: () -> Void
  let onTryAgain: () -> Void
  let onOpenSettings: () -> Void
  let onStartApple: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Text("OpenAI Realtime")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.quaternary, in: .capsule)
          Text(LocalVoiceRouteLabel.current)
            .font(.caption)
            .foregroundStyle(.secondary)
          Spacer()
          Text(activityLabel)
            .font(.caption.weight(.semibold))
            .accessibilityLabel("Voice state, \(activityLabel)")
        }

        VoiceActivityOrb(activity: state.activity, diameter: 54)
          .transaction { transaction in
            if reduceMotion { transaction.animation = nil }
          }

        if let warning = state.warning {
          Label(warning, systemImage: "clock.badge.exclamationmark")
            .font(.callout)
            .foregroundStyle(.orange)
        }
      }
      .padding(20)

      Divider()

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          if state.captions.isEmpty {
            ContentUnavailableView(
              "Captions will appear here",
              systemImage: "captions.bubble",
              description: Text("Live captions are on by default.")
            )
          } else {
            ForEach(state.captions) { caption in
              VStack(alignment: .leading, spacing: 4) {
                Text(caption.role == .user ? "You" : "Assistant")
                  .font(.caption)
                  .foregroundStyle(.secondary)
                Text(caption.text)
                  .font(.body)
                  .privacySensitive()
              }
              .accessibilityElement(children: .combine)
            }
          }

          if let failure = state.failureMessage {
            RealtimeVoiceRecoveryActions(
              message: failure,
              onTryAgain: onTryAgain,
              onOpenSettings: onOpenSettings,
              onStartApple: onStartApple
            )
          }
        }
        .frame(maxWidth: 640, alignment: .leading)
        .padding(24)
        .frame(maxWidth: .infinity)
      }

      Divider()

      HStack(spacing: 20) {
        Button(action: onToggleMute) {
          Label(state.isMuted ? "Unmute microphone" : "Mute microphone", systemImage: state.isMuted ? "mic.slash.fill" : "mic.fill")
            .labelStyle(.iconOnly)
            .frame(width: 56, height: 56)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.circle)
        .keyboardShortcut("m", modifiers: [.command, .shift])
        .accessibilityLabel(state.isMuted ? "Unmute microphone" : "Mute microphone")

        if case .paused = state.phase {
          Button("Resume", action: onResume)
            .buttonStyle(.borderedProminent)
            .frame(minHeight: 44)
            .accessibilityHint("Explicitly resumes the paused audio session")
        }

        Button(action: onEnd) {
          Label("End voice conversation", systemImage: "phone.down.fill")
            .labelStyle(.iconOnly)
            .frame(width: 64, height: 64)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.circle)
        .tint(.red)
        .keyboardShortcut(".", modifiers: .command)
        .accessibilityLabel("End voice conversation")
      }
      .padding(20)
      .frame(maxWidth: .infinity)
    }
  }

  private var phaseLabel: String {
    switch state.phase {
    case .idle: "Ready"
    case .requestingMicrophone: "Requesting microphone"
    case .readingCredential: "Preparing securely"
    case .connecting: "Connecting"
    case .listening: "Listening"
    case .userSpeaking: "You are speaking"
    case .responding: "Responding"
    case .assistantSpeaking: "Assistant speaking"
    case .muted: "Muted"
    case .paused(let reason): reason.message
    case .ending: "Ending"
    case .ended: "Ended"
    case .failed: "Connection failed"
    }
  }

  private var activityLabel: String {
    state.activity == .inactive ? phaseLabel : VoiceActivityOrb.semanticDescription(state.activity)
  }
}

private struct RealtimeVoiceRecoveryActions: View {
  let message: String
  let onTryAgain: () -> Void
  let onOpenSettings: () -> Void
  let onStartApple: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(message, systemImage: "exclamationmark.circle.fill")
        .foregroundStyle(.orange)
      ViewThatFits(in: .horizontal) {
        recoveryButtons(axis: .horizontal)
        recoveryButtons(axis: .vertical)
      }
      .buttonStyle(.bordered)
    }
    .accessibilityElement(children: .contain)
  }

  private func recoveryButtons(axis: Axis) -> some View {
    Group {
      if axis == .horizontal {
        HStack { recoveryButtons }
      } else {
        VStack(alignment: .leading) { recoveryButtons }
      }
    }
  }

  @ViewBuilder
  private var recoveryButtons: some View {
    Button("Try Again", action: onTryAgain)
    Button("Open Assistant Settings", action: onOpenSettings)
    #if os(macOS)
      Button("Open Sound Settings", action: openMacSoundSettings)
    #endif
    Button("Start New Apple Conversation", action: onStartApple)
  }
}

enum LocalVoiceRouteLabel {
  static var current: String {
    #if os(iOS)
      AVAudioSession.sharedInstance().currentRoute.outputs.first?.portName ?? "System audio"
    #else
      "System Default Input & Output"
    #endif
  }
}

#if os(macOS)
func openMacSoundSettings() {
  guard let url = URL(string: "x-apple.systempreferences:com.apple.Sound-Settings.extension")
  else { return }
  NSWorkspace.shared.open(url)
}
#endif
