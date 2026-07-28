import AVFoundation
import CarPlay
import EnchiridionCore
import Foundation
import Observation
import OSLog
import UIKit

enum CarPlaySafetyPauseReason: String, Sendable {
  case audioInterruption
  case audioRouteChanged
  case deviceLocked
  case sceneInactive
  case disconnected
}

@MainActor
final class CarPlayVoiceCoordinator: NSObject {
  private enum VoiceState: String {
    case idle
    case listening
    case thinking
    case speaking
    case error
  }

  private let assistant: FoundationModelAssistant?
  private let repositoryError: String?
  private let audioSession = AVAudioSession.sharedInstance()
  private let speaker = AVSpeechSynthesizerConversationSpeaker()
  private let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion",
    category: "CarPlayVoice"
  )

  private weak var interfaceController: CPInterfaceController?
  private var voiceTemplate: CPVoiceControlTemplate?
  private var conversationSession: AssistantConversationSession?
  private var observationGeneration: UInt64 = 0
  private var isConnected = false

  init(assistant: FoundationModelAssistant?, repositoryError: String?) {
    self.assistant = assistant
    self.repositoryError = repositoryError
    super.init()
    observeSafetyEvents()
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  func connect(to interfaceController: CPInterfaceController) {
    disconnect()
    isConnected = true
    self.interfaceController = interfaceController

    let template = makeVoiceTemplate()
    voiceTemplate = template
    interfaceController.setRootTemplate(template, animated: false) { [weak self] success, error in
      Task { @MainActor in
        guard let self, self.isConnected else { return }
        guard success else {
          self.logger.error("template_presentation_failed code=\(error?._code ?? -1, privacy: .public)")
          self.transition(to: .error)
          return
        }
        self.logger.info("carplay_connected")
        self.transition(to: .idle)
      }
    }
  }

  func disconnect() {
    guard isConnected || conversationSession != nil else { return }
    stopConversation(transitionToIdle: true)
    isConnected = false
    interfaceController = nil
    voiceTemplate = nil
    logger.info("carplay_disconnected")
  }

  func pauseForSafety(reason: CarPlaySafetyPauseReason) {
    guard isConnected else { return }
    stopConversation(transitionToIdle: true)
    logger.notice("safe_idle reason=\(reason.rawValue, privacy: .public)")
  }

  private func preflightAndListen() async {
    guard isConnected else { return }
    guard CarPlayAssistantPrivacySettings.isEnabled() else {
      showAssistantDisabled()
      return
    }
    guard UIApplication.shared.isProtectedDataAvailable else {
      showUnavailable(
        reasonCode: "protected_data_unavailable",
        message: "Unlock your iPhone before using Enchiridion in CarPlay."
      )
      return
    }
    guard #available(iOS 26.4, *) else {
      showUnavailable(
        reasonCode: "requires_ios_26_4",
        message: "Enchiridion in CarPlay requires iOS 26.4 or later."
      )
      return
    }

    guard assistant != nil else {
      showUnavailable(
        reasonCode: "repository_unavailable",
        message: repositoryError ?? "Your local Enchiridion library is unavailable."
      )
      return
    }
    let assistantAvailability = FoundationModelAssistant.availability(for: .current)
    guard assistantAvailability == .available else {
      showUnavailable(
        reasonCode: "language_model_\(String(describing: assistantAvailability))",
        message: assistantAvailability.message
      )
      return
    }

    let transcriber = OnDeviceSpeechTranscriber()
    let speechAvailability = await transcriber.availability()
    guard case .available = speechAvailability else {
      let message: String
      if case .installationRequired = speechAvailability {
        message = "Open Enchiridion on your iPhone and install the on-device speech model first."
      } else if case .downloading = speechAvailability {
        message = "The on-device speech model is downloading on your iPhone."
      } else if case .unavailable(let reason) = speechAvailability {
        message = reason
      } else {
        message = "On-device speech transcription is unavailable."
      }
      showUnavailable(reasonCode: "speech_model_unavailable", message: message)
      return
    }
    guard await transcriber.requestMicrophonePermission() else {
      showUnavailable(
        reasonCode: "microphone_permission_denied",
        message: "Allow microphone access on your iPhone to use Enchiridion in CarPlay."
      )
      return
    }
    startListening()
  }

  private func startListening() {
    guard isConnected, conversationSession == nil else { return }
    guard CarPlayAssistantPrivacySettings.isEnabled() else {
      showAssistantDisabled()
      return
    }
    guard #available(iOS 26.4, *) else {
      showUnavailable(
        reasonCode: "requires_ios_26_4",
        message: "Enchiridion in CarPlay requires iOS 26.4 or later."
      )
      return
    }
    guard let assistant else {
      showUnavailable(
        reasonCode: "repository_unavailable",
        message: repositoryError ?? "Your local Enchiridion library is unavailable."
      )
      return
    }

    let transcriber = CarPlayConversationTranscriber { [weak self] in
      guard let self else { throw CancellationError() }
      guard CarPlayAssistantPrivacySettings.isEnabled() else {
        throw CarPlayConversationError.disabled
      }
      try self.configureConversationalAudioSession()
    }
    let answerer = CarPlayConversationAnswerer(assistant: assistant)
    let session = AssistantConversationSession(
      transcriber: transcriber,
      answerer: answerer,
      speaker: speaker,
      locale: .current
    )
    observationGeneration &+= 1
    conversationSession = session
    observe(session, generation: observationGeneration)
    session.start()
    present(session.state)
  }

  private func configureConversationalAudioSession() throws {
    try audioSession.setCategory(
      .playAndRecord,
      mode: .default,
      options: []
    )
    try audioSession.setActive(true)
  }

  private func deactivateAudioSession() {
    try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func stopConversation(transitionToIdle: Bool) {
    observationGeneration &+= 1
    let session = conversationSession
    conversationSession = nil
    speaker.stopImmediately()
    deactivateAudioSession()
    if let session {
      Task { @MainActor in await session.stop() }
    }
    if transitionToIdle {
      transition(to: .idle)
    }
  }

  private func observe(
    _ session: AssistantConversationSession,
    generation: UInt64
  ) {
    withObservationTracking {
      _ = session.state
    } onChange: { [weak self, weak session] in
      Task { @MainActor in
        guard let self, let session,
          self.conversationSession === session,
          self.observationGeneration == generation
        else { return }
        self.present(session.state)
        self.observe(session, generation: generation)
      }
    }
  }

  private func present(_ state: AssistantConversationState) {
    switch state {
    case .idle, .stopped:
      transition(to: .idle)
    case .listening:
      transition(to: .listening)
    case .thinking:
      transition(to: .thinking)
    case .speaking:
      transition(to: .speaking)
    case .error(let failure):
      showUnavailable(
        reasonCode: "session_\(failure.kind.rawValue)",
        message: failure.message
      )
    }
  }

  private func showUnavailable(reasonCode: String, message: String) {
    stopConversation(transitionToIdle: false)
    let unavailableTemplate = makeVoiceTemplate(errorMessage: message)
    voiceTemplate = unavailableTemplate
    interfaceController?.setRootTemplate(unavailableTemplate, animated: false) { [weak self] success, _ in
      Task { @MainActor in
        guard success else { return }
        self?.transition(to: .error)
      }
    }
    logger.notice("voice_unavailable reason=\(reasonCode, privacy: .public)")
  }

  private func showAssistantDisabled() {
    showUnavailable(
      reasonCode: "disabled_in_settings",
      message: "Enable CarPlay Assistant in Enchiridion Settings on your iPhone."
    )
  }

  private func transition(to state: VoiceState) {
    guard isConnected else { return }
    voiceTemplate?.activateVoiceControlState(withIdentifier: state.rawValue)
    logger.info("voice_state state=\(state.rawValue, privacy: .public)")
  }

  private func makeVoiceTemplate(
    errorMessage: String = "Something went wrong. Check your iPhone, then tap Try Again."
  ) -> CPVoiceControlTemplate {
    let states = [
      CPVoiceControlState(
        identifier: VoiceState.idle.rawValue,
        titleVariants: ["Ready", "Ready when you are. Tap Start to ask."],
        image: UIImage(systemName: "mic.circle"),
        repeats: false
      ),
      CPVoiceControlState(
        identifier: VoiceState.listening.rawValue,
        titleVariants: ["Listening…", "What would you like to know?"],
        image: UIImage(systemName: "waveform"),
        repeats: true
      ),
      CPVoiceControlState(
        identifier: VoiceState.thinking.rawValue,
        titleVariants: ["Thinking…", "Checking your local calendar and notes…"],
        image: UIImage(systemName: "sparkles"),
        repeats: true
      ),
      CPVoiceControlState(
        identifier: VoiceState.speaking.rawValue,
        titleVariants: ["Speaking…", "Here's what I found."],
        image: UIImage(systemName: "speaker.wave.2.fill"),
        repeats: true
      ),
      CPVoiceControlState(
        identifier: VoiceState.error.rawValue,
        titleVariants: ["Needs attention", errorMessage],
        image: UIImage(systemName: "exclamationmark.circle"),
        repeats: false
      ),
    ]
    let template = CPVoiceControlTemplate(voiceControlStates: states)
    if #available(iOS 26.4, *) {
      let start = CPButton(image: UIImage(systemName: "mic.fill")!) { [weak self] _ in
        Task { @MainActor in await self?.preflightAndListen() }
      }
      start.title = "Start"
      let stop = CPButton(image: UIImage(systemName: "stop.fill")!) { [weak self] _ in
        Task { @MainActor in self?.stopConversation(transitionToIdle: true) }
      }
      stop.title = "Stop"
      let setter = NSSelectorFromString("setActionButtons:")
      if template.responds(to: setter) {
        template.setValue([start, stop], forKey: "actionButtons")
      }
    }
    return template
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
      selector: #selector(deviceWillLock(_:)),
      name: UIApplication.protectedDataWillBecomeUnavailableNotification,
      object: nil
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
    guard let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason)
    else { return }
    switch reason {
    case .oldDeviceUnavailable, .noSuitableRouteForCategory:
      pauseForSafety(reason: .audioRouteChanged)
    case .routeConfigurationChange:
      let isStillUsingCarAudio = audioSession.currentRoute.outputs.contains {
        $0.portType == .carAudio
      }
      if !isStillUsingCarAudio {
        pauseForSafety(reason: .audioRouteChanged)
      }
    default:
      break
    }
  }

  @objc private func deviceWillLock(_ notification: Notification) {
    pauseForSafety(reason: .deviceLocked)
  }

  @objc private func settingsChanged(_ notification: Notification) {
    if isConnected, !CarPlayAssistantPrivacySettings.isEnabled() {
      showAssistantDisabled()
    }
  }
}

private enum CarPlayConversationError: LocalizedError {
  case disabled

  var errorDescription: String? {
    "Enable CarPlay Assistant in Enchiridion Settings on your iPhone."
  }
}

@available(iOS 26.0, *)
private struct CarPlayConversationTranscriber: AssistantConversationTranscribing {
  private let prepare: @MainActor @Sendable () throws -> Void

  init(prepare: @escaping @MainActor @Sendable () throws -> Void) {
    self.prepare = prepare
  }

  func transcribe() async throws -> String {
    try await prepare()
    return try await OnDeviceSpeechTranscriber(managesIOSAudioSession: false).transcribe()
  }
}

private struct CarPlayConversationAnswerer: AssistantConversationAnswering {
  let assistant: FoundationModelAssistant

  func respond(to request: AssistantConversationRequest) async -> GroundedAssistantResponse {
    guard CarPlayAssistantPrivacySettings.isEnabled() else {
      return GroundedAssistantResponse(
        answer: "Enable CarPlay Assistant in Enchiridion Settings on your iPhone.",
        status: .unavailable
      )
    }
    return await assistant.respond(to: request)
  }
}
