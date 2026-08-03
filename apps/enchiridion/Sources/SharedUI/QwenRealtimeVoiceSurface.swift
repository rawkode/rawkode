import EnchiridionCore
import SwiftUI

/// Owns one frozen Qwen route. Provider setup was completed when its token was
/// saved; this surface deliberately does not introduce another consent step.
@MainActor
@Observable
final class QwenRealtimeVoiceCoordinator {
  private(set) var session: QwenRealtimeVoiceSession?
  private(set) var setupFailure: String?
  private let route: QwenVoiceRouteSnapshot
  private let toolCoordinator: AssistantRealtimeToolCoordinator?

  init(
    route: QwenVoiceRouteSnapshot,
    toolCoordinator: AssistantRealtimeToolCoordinator?
  ) {
    self.route = route
    self.toolCoordinator = toolCoordinator
  }

  func start() {
    guard route.isAuthorized else {
      setupFailure = "Qwen Voice needs a verified token, workspace, tier, and voice."
      return
    }
    guard session == nil || isTerminal(session?.phase) else { return }
    setupFailure = nil
    let session = QwenRealtimeVoiceSession(
      route: route,
      credentialReader: QwenCredentialStore(),
      transport: URLSessionQwenRealtimeVoiceTransport(),
      microphone: SystemRealtimeMicrophoneAuthorizer(),
      audioSession: realtimeAudioSessionController(),
      transcriptAuthorizer: toolCoordinator.map { _ in
        QwenTranscriptAuthorizationPolicy()
      },
      ledger: toolCoordinator.map { _ in QwenVoiceAuthorizationLedger() },
      toolCoordinator: toolCoordinator
    )
    self.session = session
    Task { await session.start() }
  }

  func stop() { Task { await session?.stop() } }

  private func isTerminal(_ phase: QwenRealtimePhase?) -> Bool {
    switch phase {
    case .ended, .failed: true
    default: false
    }
  }
}

struct QwenRealtimeVoiceLobbyRoute: Identifiable {
  let id = UUID()
  let snapshot: QwenVoiceRouteSnapshot
}

struct QwenRealtimeVoiceLobbyView: View {
  let route: QwenVoiceRouteSnapshot
  let toolCoordinator: AssistantRealtimeToolCoordinator?
  let onKeepApple: () async -> Void
  let onOpenSettings: () -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var coordinator: QwenRealtimeVoiceCoordinator?
  @State private var pendingMutation: QwenPendingMutation?

  var body: some View {
    NavigationStack {
      Group {
        if let session = coordinator?.session {
          active(session)
        } else {
          lobby
        }
      }
      .navigationTitle("Qwen Audio Realtime")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }
    .onDisappear { coordinator?.stop() }
    .confirmationDialog(
      "Confirm proposed local change",
      isPresented: Binding(
        get: { pendingMutation != nil },
        set: { if !$0, pendingMutation != nil { rejectPendingMutation() } }
      ),
      titleVisibility: .visible
    ) {
      Button("Confirm") { confirmPendingMutation() }
      Button("Cancel", role: .cancel) { rejectPendingMutation() }
    } message: {
      Text(pendingMutation.map(mutationDescription) ?? "")
    }
  }

  private var lobby: some View {
    VStack(alignment: .leading, spacing: 20) {
      Label("Qwen Audio 3.0 Realtime", systemImage: "waveform.circle.fill")
        .font(.title2.weight(.semibold))
      Text("Start the saved Qwen route. Your saved token is the complete opt-in to Qwen and Beijing processing; no additional provider or location prompt is shown.")
        .foregroundStyle(.secondary)
      VoiceActivityOrb(activity: .inactive, diameter: 56)
        .accessibilityHidden(true)
      Button("Start Qwen Voice") { start() }
        .buttonStyle(.borderedProminent)
        .frame(minHeight: 44)
      Button("Use Apple On Device") { Task { await onKeepApple(); dismiss() } }
        .frame(minHeight: 44)
      Button("Open Assistant Settings") { dismiss(); onOpenSettings() }
        .frame(minHeight: 44)
    }
    .frame(maxWidth: 600, alignment: .leading)
    .padding(24)
  }

  private func active(_ session: QwenRealtimeVoiceSession) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        VoiceActivityOrb(activity: session.voiceActivity, diameter: 56)
        Text(VoiceActivityOrb.semanticDescription(session.voiceActivity))
          .foregroundStyle(.secondary)
      }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(session.captions) { caption in
            Text(caption.text).frame(maxWidth: .infinity, alignment: caption.role == .user ? .trailing : .leading)
          }
        }
      }
      if let failure = failureText(session.phase) {
        Label(failure, systemImage: "exclamationmark.circle").foregroundStyle(.orange)
      }
      HStack {
        Button(session.phase == .muted ? "Unmute" : "Mute") { Task { await session.setMuted(session.phase != .muted) } }
        Button("End", role: .destructive) { coordinator?.stop() }
      }
      .buttonStyle(.bordered)
    }
    .padding(24)
    .onChange(of: session.pendingMutations) { _, proposals in
      guard pendingMutation == nil,
        let proposal = proposals.first(where: isSupportedMutation)
      else { return }
      pendingMutation = proposal
    }
  }

  private func start() {
    let coordinator = QwenRealtimeVoiceCoordinator(
      route: route,
      toolCoordinator: toolCoordinator
    )
    self.coordinator = coordinator
    coordinator.start()
  }

  private func isSupportedMutation(_ proposal: QwenPendingMutation) -> Bool {
    ["create_task", "update_task", "complete_task"].contains(proposal.name)
  }

  private func mutationDescription(_ proposal: QwenPendingMutation) -> String {
    "Qwen proposes \(proposal.name). The exact immutable proposal is: \(proposal.argumentsJSON)"
  }

  private func confirmPendingMutation() {
    guard let mutation = pendingMutation, let session = coordinator?.session else { return }
    pendingMutation = nil
    Task { await session.confirmMutation(id: mutation.id) }
  }

  private func rejectPendingMutation() {
    guard let mutation = pendingMutation, let session = coordinator?.session else {
      pendingMutation = nil
      return
    }
    pendingMutation = nil
    Task { await session.rejectMutation(id: mutation.id) }
  }

  private func failureText(_ phase: QwenRealtimePhase) -> String? {
    if case let .failed(message) = phase { return message }
    return nil
  }
}
