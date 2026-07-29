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

/// CarPlay presents the system-spoken Siri shortcut rather than running a
/// second speech or intelligence loop. `AskEnchiridionIntent` calls the same
/// FoundationModelAssistant used by the iOS and macOS conversation surfaces.
@MainActor
final class CarPlayVoiceCoordinator: NSObject {
  private enum VoiceState: String {
    case idle
    case error
  }

  private let assistant: FoundationModelAssistant?
  private let repositoryError: String?
  private let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion",
    category: "CarPlayVoice"
  )

  private weak var interfaceController: CPInterfaceController?
  private var voiceTemplate: CPVoiceControlTemplate?
  private var isConnected = false

  init(assistant: FoundationModelAssistant?, repositoryError: String?) {
    self.assistant = assistant
    self.repositoryError = repositoryError
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(settingsChanged(_:)),
      name: UserDefaults.didChangeNotification,
      object: UserDefaults.standard
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  func connect(to interfaceController: CPInterfaceController) {
    disconnect()
    isConnected = true
    self.interfaceController = interfaceController
    presentCurrentState()
  }

  func disconnect() {
    guard isConnected else { return }
    isConnected = false
    interfaceController = nil
    voiceTemplate = nil
    logger.info("carplay_disconnected")
  }

  func pauseForSafety(reason: CarPlaySafetyPauseReason) {
    guard isConnected else { return }
    logger.notice("safe_idle reason=\(reason.rawValue, privacy: .public)")
  }

  private func presentCurrentState() {
    guard isConnected else { return }
    let presentation: (message: String, isError: Bool, reason: String)
    if !CarPlayAssistantPrivacySettings.isEnabled() {
      presentation = (
        "Enable CarPlay Assistant in Enchiridion Settings on your iPhone.",
        true,
        "disabled_in_settings"
      )
    } else if !UIApplication.shared.isProtectedDataAvailable {
      presentation = (
        "Unlock your iPhone, then ask Siri to ask Enchiridion.",
        true,
        "protected_data_unavailable"
      )
    } else if assistant == nil {
      presentation = (
        repositoryError ?? "Your local Enchiridion library is unavailable.",
        true,
        "repository_unavailable"
      )
    } else {
      let availability = FoundationModelAssistant.availability(for: .current)
      presentation = availability == .available
        ? ("Say “Siri, ask Enchiridion” to begin.", false, "ready")
        : (availability.message, true, "model_unavailable")
    }

    let template = makeVoiceTemplate(
      message: presentation.message,
      isError: presentation.isError
    )
    voiceTemplate = template
    interfaceController?.setRootTemplate(template, animated: false) { [weak self] success, error in
      Task { @MainActor in
        guard let self, self.isConnected else { return }
        if success {
          template.activateVoiceControlState(
            withIdentifier: presentation.isError ? VoiceState.error.rawValue : VoiceState.idle.rawValue
          )
          self.logger.info("carplay_state reason=\(presentation.reason, privacy: .public)")
        } else {
          self.logger.error(
            "template_presentation_failed code=\(error?._code ?? -1, privacy: .public)"
          )
        }
      }
    }
  }

  private func makeVoiceTemplate(message: String, isError: Bool) -> CPVoiceControlTemplate {
    CPVoiceControlTemplate(
      voiceControlStates: [
        CPVoiceControlState(
          identifier: VoiceState.idle.rawValue,
          titleVariants: ["Ask Enchiridion with Siri", message],
          image: UIImage(systemName: "sparkles"),
          repeats: false
        ),
        CPVoiceControlState(
          identifier: VoiceState.error.rawValue,
          titleVariants: ["Needs attention", message],
          image: UIImage(systemName: "exclamationmark.circle"),
          repeats: false
        ),
      ]
    )
  }

  @objc private func settingsChanged(_ notification: Notification) {
    presentCurrentState()
  }
}
