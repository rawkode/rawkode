import AVFoundation
import CarPlay
import EnchiridionCore
import Foundation
import OSLog
import Observation
import UIKit

enum CarPlaySafetyPauseReason: String, Sendable {
  case audioInterruption
  case audioRouteChanged
  case sceneInactive
  case disconnected
}

/// Presents the same ephemeral conversation session used by the iPhone app.
/// CarPlay owns only lifecycle, safety, and the constrained five-state UI.
@MainActor
final class CarPlayVoiceCoordinator: NSObject {
  private enum VoiceState: String {
    case ready
    case listening
    case thinking
    case speaking
    case error
  }

  private let session: AssistantConversationSession?
  private let unavailableReason: @MainActor () -> String?
  private let audioSession = AVAudioSession.sharedInstance()
  private let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion",
    category: "CarPlayVoice"
  )

  private weak var interfaceController: CPInterfaceController?
  private var voiceTemplate: CPVoiceControlTemplate?
  private var connectionID: UUID?
  private var surfaceID: UUID?
  private var observationGeneration: UInt64 = 0
  private var isConnected = false
  private var isTemplatePresented = false

  init(
    session: AssistantConversationSession?,
    unavailableReason: @escaping @MainActor () -> String?
  ) {
    self.session = session
    self.unavailableReason = unavailableReason
    super.init()
    observeSafetyEvents()
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  func connect(to interfaceController: CPInterfaceController) {
    disconnect()
    let connectionID = UUID()
    let surfaceID = UUID()
    self.connectionID = connectionID
    self.surfaceID = surfaceID
    isConnected = true
    self.interfaceController = interfaceController
    observationGeneration &+= 1

    let template = makeVoiceTemplate()
    voiceTemplate = template
    interfaceController.setRootTemplate(template, animated: false) { [weak self] success, error in
      Task { @MainActor in
        guard let self,
          self.isCurrentConnection(connectionID, surfaceID: surfaceID),
          self.voiceTemplate === template
        else { return }
        guard success else {
          self.logger.error(
            "template_presentation_failed code=\(error?._code ?? -1, privacy: .public)"
          )
          return
        }
        self.isTemplatePresented = true
        self.logger.info("carplay_connected")
        _ = await self.prepareConversation(connectionID: connectionID, surfaceID: surfaceID)
      }
    }
  }

  func disconnect() {
    guard isConnected || interfaceController != nil else { return }
    isConnected = false
    isTemplatePresented = false
    observationGeneration &+= 1
    connectionID = nil
    interfaceController = nil
    voiceTemplate = nil
    let closingSurfaceID = surfaceID
    surfaceID = nil
    deactivateCarPlayAudioSession()
    if let session, let closingSurfaceID {
      Task { await session.stopSurface(closingSurfaceID) }
    }
    logger.info("carplay_disconnected")
  }

  func resumeAfterBecomingActive() {
    guard let connectionID, let surfaceID, isTemplatePresented else { return }
    Task {
      _ = await prepareConversation(connectionID: connectionID, surfaceID: surfaceID)
    }
  }

  func pauseForSafety(reason: CarPlaySafetyPauseReason) {
    guard let connectionID, let surfaceID else { return }
    Task { [weak self] in
      guard let self else { return }
      guard self.isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
      await self.session?.stop()
      guard self.isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
      self.deactivateCarPlayAudioSession()
      self.transition(to: .ready, reason: "safe_idle_\(reason.rawValue)")
    }
  }

  private func prepareConversation(connectionID: UUID, surfaceID: UUID) async -> Bool {
    guard isCurrentConnection(connectionID, surfaceID: surfaceID), isTemplatePresented else {
      return false
    }
    guard #available(iOS 26.4, *) else {
      showError(reason: "requires_ios_26_4")
      return false
    }
    guard CarPlayAssistantPrivacySettings.isEnabled() else {
      showError(reason: "disabled_in_settings")
      return false
    }
    guard unavailableReason() == nil else {
      showError(reason: "assistant_unavailable")
      return false
    }
    guard let session else {
      showError(reason: "library_unavailable")
      return false
    }

    await session.activateSurface(surfaceID)
    guard isCurrentConnection(connectionID, surfaceID: surfaceID) else { return false }
    await session.refreshVoiceAvailability()
    guard isCurrentConnection(connectionID, surfaceID: surfaceID), isTemplatePresented else {
      return false
    }
    observationGeneration &+= 1
    observeSession(session, generation: observationGeneration)
    present(session.state, availability: session.voiceAvailability)
    switch session.voiceAvailability {
    case .available, .permissionRequired:
      return true
    case .checking, .installing, .installationRequired, .permissionDenied, .unavailable:
      return false
    }
  }

  private func startConversation(connectionID: UUID, surfaceID: UUID) async {
    guard isCurrentConnection(connectionID, surfaceID: surfaceID), isTemplatePresented else {
      return
    }
    guard CarPlayAssistantPrivacySettings.isEnabled() else {
      showError(reason: "disabled_in_settings")
      return
    }
    guard unavailableReason() == nil else {
      showError(reason: "assistant_unavailable")
      return
    }
    guard let session else {
      showError(reason: "assistant_unavailable")
      return
    }

    do {
      try configureCarPlayAudioSession()
    } catch {
      showError(reason: "audio_session_unavailable")
      return
    }
    await session.startVoice(greeting: "Hello. What can I help with?")
    guard isCurrentConnection(connectionID, surfaceID: surfaceID) else {
      deactivateCarPlayAudioSession()
      return
    }
    guard session.isVoiceRunning else {
      deactivateCarPlayAudioSession()
      present(session.state, availability: session.voiceAvailability)
      return
    }
    present(session.state, availability: session.voiceAvailability)
  }

  private func stopConversation(connectionID: UUID, surfaceID: UUID) {
    guard let session, isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
    Task { [weak self] in
      await session.stop()
      guard let self, self.isCurrentConnection(connectionID, surfaceID: surfaceID) else {
        return
      }
      self.deactivateCarPlayAudioSession()
      self.transition(to: .ready, reason: "stopped")
    }
  }

  private func retryConversation() {
    guard let connectionID, let surfaceID else { return }
    Task { [weak self] in
      guard let self else { return }
      guard await self.prepareConversation(connectionID: connectionID, surfaceID: surfaceID) else {
        return
      }
      guard self.isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
      await self.startConversation(connectionID: connectionID, surfaceID: surfaceID)
    }
  }

  private func observeSession(
    _ session: AssistantConversationSession,
    generation: UInt64
  ) {
    withObservationTracking {
      _ = session.state
      _ = session.voiceAvailability
    } onChange: { [weak self, weak session] in
      Task { @MainActor in
        guard let self, let session,
          self.isConnected,
          self.connectionID != nil,
          self.observationGeneration == generation,
          self.session === session
        else { return }
        self.present(session.state, availability: session.voiceAvailability)
        self.observeSession(session, generation: generation)
      }
    }
  }

  private func present(
    _ state: AssistantConversationState,
    availability: AssistantVoiceAvailability
  ) {
    guard CarPlayAssistantPrivacySettings.isEnabled() else {
      showError(reason: "disabled_in_settings")
      return
    }
    switch state {
    case .listening:
      transition(to: .listening, reason: "listening")
    case .thinking:
      transition(to: .thinking, reason: "thinking")
    case .speaking:
      transition(to: .speaking, reason: "speaking")
    case .error(let failure):
      deactivateCarPlayAudioSession()
      showError(reason: "session_\(failure.kind.rawValue)")
    case .idle, .stopped:
      presentIdle(availability)
    }
  }

  private func presentIdle(_ availability: AssistantVoiceAvailability) {
    switch availability {
    case .available, .permissionRequired:
      transition(to: .ready, reason: "ready")
    case .checking:
      transition(to: .thinking, reason: "checking_voice")
    case .installing:
      showError(reason: "speech_installing")
    case .installationRequired:
      showError(reason: "speech_installation_required")
    case .permissionDenied:
      showError(reason: "microphone_permission_denied")
    case .unavailable:
      showError(reason: "speech_unavailable")
    }
  }

  private func showError(reason: String) {
    transition(to: .error, reason: reason)
  }

  private func transition(to state: VoiceState, reason: String) {
    guard isConnected, isTemplatePresented else { return }
    guard voiceTemplate?.activeStateIdentifier != state.rawValue else { return }
    voiceTemplate?.activateVoiceControlState(withIdentifier: state.rawValue)
    logger.info(
      "voice_state state=\(state.rawValue, privacy: .public) reason=\(reason, privacy: .public)"
    )
  }

  private func makeVoiceTemplate() -> CPVoiceControlTemplate {
    let ready = CPVoiceControlState(
      identifier: VoiceState.ready.rawValue,
      titleVariants: ["Ready when you are", "Ready"],
      image: UIImage(systemName: "mic.circle"),
      repeats: false
    )
    let listening = CPVoiceControlState(
      identifier: VoiceState.listening.rawValue,
      titleVariants: ["Listening for your request", "Listening"],
      image: UIImage(systemName: "waveform"),
      repeats: true
    )
    let thinking = CPVoiceControlState(
      identifier: VoiceState.thinking.rawValue,
      titleVariants: ["Checking your private library", "Thinking"],
      image: UIImage(systemName: "sparkles"),
      repeats: true
    )
    let speaking = CPVoiceControlState(
      identifier: VoiceState.speaking.rawValue,
      titleVariants: ["Answering your request", "Answering"],
      image: UIImage(systemName: "speaker.wave.2.fill"),
      repeats: true
    )
    let error = CPVoiceControlState(
      identifier: VoiceState.error.rawValue,
      titleVariants: ["Check Enchiridion on your iPhone", "Check iPhone"],
      image: UIImage(systemName: "exclamationmark.circle"),
      repeats: false
    )

    if #available(iOS 26.4, *) {
      ready.actionButtons = [
        makeButton(title: "Start", symbol: "mic.fill") { [weak self] in
          guard let self, let connectionID = self.connectionID, let surfaceID = self.surfaceID
          else {
            return
          }
          Task { @MainActor in
            await self.startConversation(connectionID: connectionID, surfaceID: surfaceID)
          }
        }
      ]
      listening.actionButtons = [makeStopButton()]
      thinking.actionButtons = [makeStopButton()]
      speaking.actionButtons = [makeStopButton()]
      error.actionButtons = [
        makeButton(title: "Retry", symbol: "arrow.clockwise") { [weak self] in
          self?.retryConversation()
        }
      ]
    }

    return CPVoiceControlTemplate(
      voiceControlStates: [ready, listening, thinking, speaking, error]
    )
  }

  @available(iOS 26.4, *)
  private func makeStopButton() -> CPButton {
    makeButton(title: "Stop", symbol: "stop.fill") { [weak self] in
      guard let self, let connectionID = self.connectionID, let surfaceID = self.surfaceID else {
        return
      }
      self.stopConversation(connectionID: connectionID, surfaceID: surfaceID)
    }
  }

  @available(iOS 26.4, *)
  private func makeButton(
    title: String,
    symbol: String,
    action: @escaping @MainActor () -> Void
  ) -> CPButton {
    let button = CPButton(image: UIImage(systemName: symbol)!) { _ in
      Task { @MainActor in action() }
    }
    button.title = title
    return button
  }

  private func observeSafetyEvents() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(audioInterrupted(_:)),
      name: AVAudioSession.interruptionNotification,
      object: audioSession
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(audioRouteChanged(_:)),
      name: AVAudioSession.routeChangeNotification,
      object: audioSession
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(settingsChanged(_:)),
      name: UserDefaults.didChangeNotification,
      object: UserDefaults.standard
    )
  }

  @objc private func audioInterrupted(_ notification: Notification) {
    guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      AVAudioSession.InterruptionType(rawValue: rawType) == .began
    else { return }
    pauseForSafety(reason: .audioInterruption)
  }

  @objc private func audioRouteChanged(_ notification: Notification) {
    guard session?.isVoiceRunning == true,
      let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason)
    else { return }
    switch reason {
    case .oldDeviceUnavailable, .noSuitableRouteForCategory:
      pauseForSafety(reason: .audioRouteChanged)
    case .routeConfigurationChange:
      let isStillUsingCarAudio = audioSession.currentRoute.outputs.contains {
        $0.portType == .carAudio
      }
      if !isStillUsingCarAudio { pauseForSafety(reason: .audioRouteChanged) }
    default:
      break
    }
  }

  @objc private func settingsChanged(_ notification: Notification) {
    guard isConnected else { return }
    if CarPlayAssistantPrivacySettings.isEnabled() {
      if session?.isVoiceRunning != true { resumeAfterBecomingActive() }
    } else {
      Task { [weak self] in
        guard let self else { return }
        guard let connectionID = self.connectionID, let surfaceID = self.surfaceID else { return }
        await self.session?.stop()
        guard self.isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
        self.deactivateCarPlayAudioSession()
        self.showError(reason: "disabled_in_settings")
      }
    }
  }

  private func isCurrentConnection(_ connectionID: UUID, surfaceID: UUID) -> Bool {
    isConnected && self.connectionID == connectionID && self.surfaceID == surfaceID
  }

  private func configureCarPlayAudioSession() throws {
    try audioSession.setCategory(.playAndRecord, mode: .default, options: [])
    try audioSession.setActive(true)
  }

  private func deactivateCarPlayAudioSession() {
    try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
  }
}
