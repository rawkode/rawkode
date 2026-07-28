import AVFoundation
import CarPlay
import EnchiridionCore
import Foundation
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
  private let synthesizer = AVSpeechSynthesizer()
  private let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion",
    category: "CarPlayVoice"
  )

  private weak var interfaceController: CPInterfaceController?
  private var voiceTemplate: CPVoiceControlTemplate?
  private var operation: Task<Void, Never>?
  private var operationGeneration: UInt64 = 0
  private var speechContinuation: CheckedContinuation<Void, Never>?
  private var isConnected = false

  init(assistant: FoundationModelAssistant?, repositoryError: String?) {
    self.assistant = assistant
    self.repositoryError = repositoryError
    super.init()
    synthesizer.delegate = self
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
        await self.preflightAndListen()
      }
    }
  }

  func disconnect() {
    guard isConnected || operation != nil else { return }
    invalidateOperation()
    finishSpeechWait()
    synthesizer.stopSpeaking(at: .immediate)
    deactivateAudioSession()
    transition(to: .idle)
    isConnected = false
    interfaceController = nil
    voiceTemplate = nil
    logger.info("carplay_disconnected")
  }

  func pauseForSafety(reason: CarPlaySafetyPauseReason) {
    guard isConnected else { return }
    invalidateOperation()
    finishSpeechWait()
    synthesizer.stopSpeaking(at: .immediate)
    deactivateAudioSession()
    transition(to: .idle)
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
      if case .unavailable(let reason) = speechAvailability {
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
    guard isConnected, operation == nil else { return }
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
    operationGeneration &+= 1
    let generation = operationGeneration
    operation = Task { [weak self] in
      guard let self else { return }
      await self.runTurn(generation: generation)
    }
  }

  @available(iOS 26.4, *)
  private func runTurn(generation: UInt64) async {
    let startedAt = ContinuousClock.now
    do {
      guard CarPlayAssistantPrivacySettings.isEnabled() else {
        showAssistantDisabled()
        return
      }
      try configureConversationalAudioSession()
      transition(to: .listening)
      logger.info("turn_started")

      let request = try await OnDeviceSpeechTranscriber().transcribe()
      try Task.checkCancellation()
      guard CarPlayAssistantPrivacySettings.isEnabled() else {
        showAssistantDisabled()
        return
      }
      transition(to: .thinking)

      guard let assistant else {
        showUnavailable(
          reasonCode: "repository_unavailable",
          message: repositoryError ?? "Your local Enchiridion library is unavailable."
        )
        return
      }
      let response = await assistant.respond(to: request, locale: .current, now: Date())
      try Task.checkCancellation()
      logger.info(
        "assistant_response status=\(response.status.rawValue, privacy: .public) source_count=\(response.sources.count, privacy: .public)"
      )
      if response.status == .unavailable || response.status == .ungrounded {
        showUnavailable(
          reasonCode: "assistant_\(response.status.rawValue)",
          message: response.answer
        )
        return
      }

      transition(to: .speaking)
      try await speak(spokenText(for: response))
      logger.info("turn_finished elapsed_ms=\(startedAt.duration(to: .now).milliseconds, privacy: .public)")

      if isConnected {
        try await Task.sleep(for: .milliseconds(500))
        try Task.checkCancellation()
        if clearOperation(ifCurrent: generation) {
          startListening()
        }
      } else {
        _ = clearOperation(ifCurrent: generation)
      }
    } catch is CancellationError {
      logger.info("turn_cancelled")
      _ = clearOperation(ifCurrent: generation)
    } catch {
      guard clearOperation(ifCurrent: generation) else { return }
      deactivateAudioSession()
      transition(to: .error)
      logger.error("turn_failed error_type=\(String(reflecting: type(of: error)), privacy: .public)")
    }
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

  private func speak(_ text: String) async throws {
    guard !text.isEmpty else { return }
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate

    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        speechContinuation = continuation
        synthesizer.speak(utterance)
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.synthesizer.stopSpeaking(at: .immediate)
        self?.finishSpeechWait()
      }
    }
  }

  private func finishSpeechWait() {
    speechContinuation?.resume()
    speechContinuation = nil
  }

  private func invalidateOperation() {
    operationGeneration &+= 1
    operation?.cancel()
    operation = nil
  }

  @discardableResult
  private func clearOperation(ifCurrent generation: UInt64) -> Bool {
    guard generation == operationGeneration else { return false }
    operation = nil
    return true
  }

  private func spokenText(for response: GroundedAssistantResponse) -> String {
    let caveat: String
    switch response.status {
    case .ambiguous:
      caveat = "I found more than one possible match. "
    case .stale:
      caveat = "Your local calendar information may be out of date. "
    case .conflicting:
      caveat = "Your local notes contain conflicting information. "
    default:
      caveat = ""
    }
    let titles = response.sources.reduce(into: [String]()) { result, source in
      if !result.contains(source.title) { result.append(source.title) }
    }
    guard !titles.isEmpty else { return caveat + response.answer }
    return "\(caveat)\(response.answer) Sources: \(titles.joined(separator: ", "))."
  }

  private func showUnavailable(reasonCode: String, message: String) {
    invalidateOperation()
    finishSpeechWait()
    synthesizer.stopSpeaking(at: .immediate)
    deactivateAudioSession()
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
        titleVariants: ["Ready", "Ready when you are. Tap Try Again to ask."],
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
      let retry = CPButton(image: UIImage(systemName: "arrow.clockwise")!) { [weak self] _ in
        Task { @MainActor in await self?.preflightAndListen() }
      }
      retry.title = "Try Again"
      let setter = NSSelectorFromString("setActionButtons:")
      if template.responds(to: setter) {
        template.setValue([retry], forKey: "actionButtons")
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

extension CarPlayVoiceCoordinator: @preconcurrency AVSpeechSynthesizerDelegate {
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finishSpeechWait()
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finishSpeechWait()
  }
}

private extension Duration {
  var milliseconds: Int64 {
    let components = self.components
    return components.seconds * 1_000 + Int64(components.attoseconds / 1_000_000_000_000_000)
  }
}
