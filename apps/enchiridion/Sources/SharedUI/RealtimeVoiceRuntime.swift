import EnchiridionCore
import Foundation
import Observation

#if os(iOS)
import AVFoundation
#elseif os(macOS)
import AVFoundation
#endif

/// Owns one explicitly user-started OpenAI Voice session for the lobby. This
/// object deliberately has no access to the text-assistant context or tools.
struct RealtimeVoiceCoordinatorLifecycleState: Equatable {
  private(set) var generation: UInt64 = 0
  private(set) var isClosed = false

  mutating func close() {
    guard !isClosed else { return }
    isClosed = true
    generation &+= 1
  }

  func allowsRetry(requestGeneration: UInt64) -> Bool {
    !isClosed && requestGeneration == generation
  }
}

@MainActor
@Observable
final class RealtimeVoiceCoordinator {
  private(set) var session: RealtimeVoiceSession?
  private(set) var setupFailure: String?

  private let route: RealtimeVoiceRouteSnapshot
  private var lifecycleState: RealtimeVoiceLifecycleState = .active
  private var coordinatorLifecycle = RealtimeVoiceCoordinatorLifecycleState()

  init(route: RealtimeVoiceRouteSnapshot) {
    self.route = route
  }

  func start(initialLifecycleState: RealtimeVoiceLifecycleState) {
    guard
      !coordinatorLifecycle.isClosed,
      session == nil || session?.receipt != nil
    else { return }
    setupFailure = nil
    lifecycleState = initialLifecycleState

    do {
      let voiceSession = try RealtimeVoiceSession(
        route: route,
        microphone: SystemRealtimeMicrophoneAuthorizer(),
        credentialReader: OpenAICredentialStore(),
        transport: RealtimeWebRTCVoiceTransport(),
        audioSession: realtimeAudioSessionController(),
        safetyEvents: realtimeSafetyEventSource(),
        initialLifecycleState: initialLifecycleState
      )
      session = voiceSession
      Task { await voiceSession.start() }
    } catch let error as RealtimeVoiceContractError {
      setupFailure = Self.setupFailureMessage(for: error)
    } catch {
      setupFailure = "OpenAI Voice could not prepare the selected route. Try Assistant Settings, then try again."
    }
  }

  private static func setupFailureMessage(for error: RealtimeVoiceContractError) -> String {
    switch error {
    case .unauthorizedRoute(let failure):
      switch failure {
      case .credentialVerificationRequired:
        "Verify the OpenAI key again before starting OpenAI Voice."
      case .modelSelectionRequired:
        "Choose a verified Realtime model in Assistant Settings."
      case .modelUnavailable:
        "The selected Realtime model is no longer available. Verify the key and choose another model."
      case .voiceUnavailable:
        "Choose an official OpenAI voice in Assistant Settings."
      case nil:
        "OpenAI Voice is not configured yet. Review Assistant Settings."
      }
    case .modelNotAllowed:
      "The selected Realtime model is not in Enchiridion's reviewed catalog. Verify the key again."
    case .voiceNotAllowed:
      "The selected voice is not available. Choose an official OpenAI voice in Assistant Settings."
    case .modelMismatch, .voiceMismatch:
      "OpenAI returned a different voice route than the one you selected. Verify the key and try again."
    }
  }

  func retry() {
    guard let session,
      Self.canRetry(
        phase: session.state.phase,
        receipt: session.receipt,
        failure: session.state.failure
      )
    else {
      return
    }
    let retryGeneration = coordinatorLifecycle.generation
    Task { @MainActor [weak self] in
      guard let self else { return }
      guard
        self.coordinatorLifecycle.allowsRetry(requestGeneration: retryGeneration),
        self.session === session
      else { return }
      // A paused session may still own the peer connection and audio route.
      // Wait for its bounded teardown before constructing a replacement; doing
      // both concurrently races WebRTC and AVAudioSession ownership.
      await session.stop()
      guard
        self.coordinatorLifecycle.allowsRetry(requestGeneration: retryGeneration),
        self.session === session
      else { return }
      self.session = nil
      start(initialLifecycleState: lifecycleState)
    }
  }

  static func canRetry(
    phase: RealtimeVoicePhase,
    receipt: RealtimeVoiceReceipt?,
    failure: RealtimeVoiceFailure? = nil
  ) -> Bool {
    if phase == .failed && receipt?.completion == .failed { return true }
    if case .paused = phase, receipt == nil, failure != nil { return true }
    return false
  }

  func stop() {
    coordinatorLifecycle.close()
    let session = session
    Task { await session?.stop() }
  }

  func handleLifecycleChange(_ lifecycle: RealtimeVoiceLifecycleState) {
    lifecycleState = lifecycle
    Task { await session?.handleLifecycleChange(lifecycle) }
  }
}

@MainActor
final class SystemRealtimeMicrophoneAuthorizer: RealtimeMicrophoneAuthorizing {
  func requestPermission() async -> RealtimeMicrophonePermission {
    #if os(macOS)
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized:
        return .authorized
      case .denied:
        return .denied
      case .restricted:
        return .restricted
      case .notDetermined:
        return await AVCaptureDevice.requestAccess(for: .audio) ? .authorized : .denied
      @unknown default:
        return .restricted
      }
    #elseif os(iOS)
      switch AVAudioApplication.shared.recordPermission {
      case .granted:
        return .authorized
      case .denied:
        return .denied
      case .undetermined:
        let granted = await withCheckedContinuation { continuation in
          AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        return granted ? .authorized : .denied
      @unknown default:
        return .restricted
      }
    #else
      return .restricted
    #endif
  }
}

@MainActor
func realtimeAudioSessionController() -> any RealtimeAudioSessionControlling {
  #if os(iOS)
    HandheldConversationAudioSessionController()
  #else
    MacRealtimeAudioSessionController()
  #endif
}

@MainActor
private func realtimeSafetyEventSource() -> (any AssistantVoiceSafetyEventSource)? {
  #if os(iOS)
    HandheldConversationAudioEventSource()
  #elseif os(macOS)
    MacVoiceDeviceChangeEventSource()
  #else
    nil
  #endif
}

#if os(macOS)
@MainActor
private final class MacRealtimeAudioSessionController: RealtimeAudioSessionControlling {
  /// WebKit owns the macOS WebRTC audio graph. Permission is handled before
  /// the bridge starts, so there is no competing AVAudioSession to activate.
  func activate() async throws {}
  func deactivate() async {}
}
#endif
