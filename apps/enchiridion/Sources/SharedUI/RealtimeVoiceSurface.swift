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
    case lobby
    case unavailable
  }

  let route: RealtimeVoiceRouteSnapshot
  let onKeepApple: () -> Void
  let onOpenSettings: () -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var stage: Stage = .lobby

  var body: some View {
    NavigationStack {
      Group {
        switch stage {
        case .lobby:
          lobby
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
    #if os(macOS)
      .frame(minWidth: 480, idealWidth: 560, minHeight: 580, idealHeight: 680)
    #endif
  }

  private var lobby: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VoiceRouteSummary(route: route)

        VStack(alignment: .leading, spacing: 10) {
          Label(OpenAIRealtimeVoiceConsentCopy.title, systemImage: "waveform.badge.mic")
            .font(.title2.weight(.semibold))
          Text(OpenAIRealtimeVoiceConsentCopy.body)
            .font(.body)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)

        Label {
          Text(
            "OpenAI Voice connection is unavailable in this build. This action did not request microphone access, use the saved key for a connection, or send anything."
          )
        } icon: {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)

        VStack(spacing: 12) {
          Button(OpenAIRealtimeVoiceConsentCopy.startActionTitle) {
            stage = .unavailable
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .frame(maxWidth: .infinity, minHeight: 56)
          .accessibilityHint(
            "Shows the unavailable connection state without requesting microphone access, using the saved key for a connection, or sending anything."
          )

          Button(OpenAIRealtimeVoiceConsentCopy.keepAppleActionTitle) {
            onKeepApple()
            dismiss()
          }
          .buttonStyle(.bordered)
          .frame(maxWidth: .infinity, minHeight: 44)
          .accessibilityHint("Selects Apple On Device voice and closes this lobby")
        }
      }
      .frame(maxWidth: 640, alignment: .leading)
      .padding(24)
      .frame(maxWidth: .infinity)
    }
  }

  private var unavailable: some View {
    ContentUnavailableView {
      Label("OpenAI Voice Connection Unavailable", systemImage: "antenna.radiowaves.left.and.right.slash")
    } description: {
      Text(
        "This action did not request microphone access, use the saved key for a connection, or send anything. Use Apple On Device now, or review Assistant Settings."
      )
    } actions: {
      VStack(spacing: 10) {
        Button("Try Again") { stage = .lobby }
          .frame(minHeight: 44)
        Button("Open Assistant Settings") {
          dismiss()
          onOpenSettings()
        }
          .frame(minHeight: 44)
        Button("Start a New Apple On Device Conversation") {
          onKeepApple()
          dismiss()
        }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: 44)
      }
    }
    .padding(24)
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
    case .consentRequired: "Current voice consent is required."
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
  let isMuted: Bool
  let warning: String?
  let failureMessage: String?
}

/// The active surface is intentionally data-only until the native calls
/// executor is authorized and available. It performs no media or transport work.
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
          Text(phaseLabel)
            .font(.caption.weight(.semibold))
            .accessibilityLabel("Voice state, \(phaseLabel)")
        }

        if !reduceMotion {
          VoiceActivityGlyph()
            .accessibilityHidden(true)
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
}

private struct VoiceActivityGlyph: View {
  var body: some View {
    HStack(alignment: .center, spacing: 4) {
      ForEach([12.0, 22.0, 30.0, 18.0, 26.0, 14.0], id: \.self) { height in
        Capsule()
          .fill(.tint)
          .frame(width: 4, height: height)
      }
    }
    .frame(height: 36)
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
