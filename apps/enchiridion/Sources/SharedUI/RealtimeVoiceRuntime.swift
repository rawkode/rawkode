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
    } catch {
      setupFailure = "OpenAI Voice could not prepare the selected route."
    }
  }

  func retry() {
    guard let session, Self.canRetry(phase: session.state.phase, receipt: session.receipt) else {
      return
    }
    let retryGeneration = coordinatorLifecycle.generation
    Task { @MainActor [weak self] in
      guard let self else { return }
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
    receipt: RealtimeVoiceReceipt?
  ) -> Bool {
    phase == .failed && receipt?.completion == .failed
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
