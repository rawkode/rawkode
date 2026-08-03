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

private final class CarPlayNotificationObserverBag: @unchecked Sendable {
  private var tokens: [NSObjectProtocol] = []

  func append(_ token: NSObjectProtocol) {
    tokens.append(token)
  }

  deinit {
    for token in tokens {
      NotificationCenter.default.removeObserver(token)
    }
  }
}

/// Presents the same ephemeral conversation session used by the iPhone app.
/// CarPlay owns only lifecycle, safety, and the constrained five-state UI.
@MainActor
final class CarPlayVoiceCoordinator: NSObject {
  private enum VoiceState: String {
    case ready
    case starting
    case listening
    case responding
    case setup
  }

  private var session: AssistantConversationSession?
  private var unavailableReason: @MainActor () -> String?
  private var qwenRoute: @MainActor () -> QwenVoiceRouteSnapshot?
  private var usesQwenVoice: @MainActor () -> Bool
  private var qwenTools: @MainActor () -> AssistantRealtimeToolCoordinator?
  private var qwenSession: QwenRealtimeVoiceSession?
  private let audioSession = AVAudioSession.sharedInstance()
  private let safetyObservers = CarPlayNotificationObserverBag()
  private let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion",
    category: "CarPlayVoice"
  )

  private weak var interfaceController: CPInterfaceController?
  private var voiceTemplate: CPVoiceControlTemplate?
  private var connectionID: UUID?
  private var surfaceID: UUID?
  private var observationGeneration: UInt64 = 0
  private var startAttemptID: UUID?
  private var setupReason: String?
  private var observedVoiceOperationCompletionGeneration: UInt64 = 0
  private var presentedQwenMutationID: String?
  private var ownsCarPlayAudioSession = false
  private var isConnected = false
  private var isTemplatePresented = false

  init(
    session: AssistantConversationSession?,
    unavailableReason: @escaping @MainActor () -> String?,
    qwenRoute: @escaping @MainActor () -> QwenVoiceRouteSnapshot? = { nil },
    usesQwenVoice: @escaping @MainActor () -> Bool = { false },
    qwenTools: @escaping @MainActor () -> AssistantRealtimeToolCoordinator? = { nil }
  ) {
    self.session = session
    self.unavailableReason = unavailableReason
    self.qwenRoute = qwenRoute
    self.usesQwenVoice = usesQwenVoice
    self.qwenTools = qwenTools
    super.init()
    observeSafetyEvents()
  }

  func update(
    session: AssistantConversationSession?,
    unavailableReason: @escaping @MainActor () -> String?,
    qwenRoute: @escaping @MainActor () -> QwenVoiceRouteSnapshot? = { nil },
    usesQwenVoice: @escaping @MainActor () -> Bool = { false },
    qwenTools: @escaping @MainActor () -> AssistantRealtimeToolCoordinator? = { nil }
  ) {
    let connectedController = interfaceController
    disconnect()
    self.session = session
    self.unavailableReason = unavailableReason
    self.qwenRoute = qwenRoute
    self.usesQwenVoice = usesQwenVoice
    self.qwenTools = qwenTools
    if let connectedController {
      connect(to: connectedController)
    }
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
    startAttemptID = nil
    setupReason = nil
    observedVoiceOperationCompletionGeneration = 0
    presentedQwenMutationID = nil

    let template = makeVoiceTemplate()
    voiceTemplate = template
    interfaceController.setRootTemplate(
      template,
      animated: false,
      completion: Self.makeNonisolatedTemplateCompletion {
        [weak self] success, errorCode in
        guard let self,
          self.isCurrentConnection(connectionID, surfaceID: surfaceID),
          self.voiceTemplate === template
        else { return }
        guard success else {
          self.logger.error(
            "template_presentation_failed code=\(errorCode, privacy: .public)"
          )
          return
        }
        self.isTemplatePresented = true
        self.logger.info("carplay_connected")
        _ = await self.prepareConversation(connectionID: connectionID, surfaceID: surfaceID)
      }
    )
  }

  func disconnect() {
    guard isConnected || interfaceController != nil else { return }
    isConnected = false
    isTemplatePresented = false
    observationGeneration &+= 1
    startAttemptID = nil
    setupReason = nil
    observedVoiceOperationCompletionGeneration = 0
    presentedQwenMutationID = nil
    connectionID = nil
    interfaceController = nil
    voiceTemplate = nil
    let closingSurfaceID = surfaceID
    let closingAppleSession = session
    let closingQwenSession = qwenSession
    surfaceID = nil
    qwenSession = nil
    if closingQwenSession != nil || (closingAppleSession != nil && closingSurfaceID != nil) {
      Task { [weak self] in
        if let closingQwenSession {
          await closingQwenSession.stop()
        }
        if let closingAppleSession, let closingSurfaceID {
          await closingAppleSession.stopSurface(closingSurfaceID)
        }
        guard let self, !self.isConnected else { return }
        self.deactivateCarPlayAudioSession()
      }
    } else {
      deactivateCarPlayAudioSession()
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
    startAttemptID = nil
    Task { [weak self] in
      guard let self else { return }
      guard self.isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
      if let qwenSession = self.qwenSession {
        await qwenSession.stop()
        guard self.isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
        self.qwenSession = nil
        self.presentedQwenMutationID = nil
        self.observationGeneration &+= 1
      } else {
        await self.session?.stop()
      }
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
    if usesQwenVoice() {
      guard qwenRoute()?.isAuthorized == true else {
        showError(reason: "qwen_route_unavailable")
        return false
      }
      transition(to: .ready, reason: "qwen_ready")
      return true
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
    switch session.voiceAvailability {
    case .available:
      setupReason = nil
      present(session.state, availability: session.voiceAvailability)
      return true
    case .permissionRequired:
      showError(reason: "microphone_permission_required")
      return false
    case .checking, .installing, .installationRequired, .permissionDenied, .unavailable:
      present(session.state, availability: session.voiceAvailability)
      return false
    }
  }

  private func startConversation(connectionID: UUID, surfaceID: UUID) async {
    guard isCurrentConnection(connectionID, surfaceID: surfaceID), isTemplatePresented else {
      return
    }
    guard startAttemptID == nil, session?.isVoiceRunning != true else { return }
    let attemptID = UUID()
    startAttemptID = attemptID
    defer {
      if startAttemptID == attemptID { startAttemptID = nil }
    }
    guard CarPlayAssistantPrivacySettings.isEnabled() else {
      showError(reason: "disabled_in_settings")
      return
    }
    if usesQwenVoice() {
      guard let route = qwenRoute(), route.isAuthorized else {
        showError(reason: "qwen_route_unavailable")
        return
      }
      await startQwenConversation(route: route, connectionID: connectionID, surfaceID: surfaceID)
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
    guard session.voiceAvailability == .available else {
      presentIdle(session.voiceAvailability)
      return
    }

    setupReason = nil
    transition(to: .starting, reason: "starting_conversation")
    do {
      try configureCarPlayAudioSession()
    } catch {
      showError(reason: "audio_session_unavailable")
      await session.stop()
      guard isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
      deactivateCarPlayAudioSession()
      return
    }
    guard !Task.isCancelled, startAttemptID == attemptID,
      isCurrentConnection(connectionID, surfaceID: surfaceID)
    else {
      if !isConnected { deactivateCarPlayAudioSession() }
      return
    }
    await session.startVoice(greeting: "Hello. What can I help with?")
    guard !Task.isCancelled, startAttemptID == attemptID,
      isCurrentConnection(connectionID, surfaceID: surfaceID)
    else {
      if !isConnected { deactivateCarPlayAudioSession() }
      return
    }
    guard session.isVoiceRunning else {
      await session.stop()
      guard isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
      deactivateCarPlayAudioSession()
      present(session.state, availability: session.voiceAvailability)
      return
    }
    present(session.state, availability: session.voiceAvailability)
  }

  private func startQwenConversation(
    route: QwenVoiceRouteSnapshot,
    connectionID: UUID,
    surfaceID: UUID
  ) async {
    guard isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
    transition(to: .starting, reason: "starting_qwen_conversation")
    do {
      try configureCarPlayAudioSession()
    } catch {
      showError(reason: "audio_session_unavailable")
      return
    }
    let toolCoordinator = qwenTools()
    let qwen = QwenRealtimeVoiceSession(
      route: route,
      credentialReader: QwenCredentialStore(),
      transport: URLSessionQwenRealtimeVoiceTransport(),
      microphone: SystemRealtimeMicrophoneAuthorizer(),
      // CarPlay owns the active audio route. The Qwen session must not
      // deactivate it independently during stop or a failed handshake.
      audioSession: CarPlayQwenAudioSessionController(),
      transcriptAuthorizer: toolCoordinator.map { _ in
        QwenTranscriptAuthorizationPolicy()
      },
      ledger: toolCoordinator.map { _ in QwenVoiceAuthorizationLedger() },
      toolCoordinator: toolCoordinator
    )
    qwenSession = qwen
    await qwen.start()
    guard isCurrentConnection(connectionID, surfaceID: surfaceID), qwenSession === qwen else {
      await qwen.stop()
      return
    }
    if case .failed = qwen.phase {
      deactivateCarPlayAudioSession()
      showError(reason: "qwen_connection_unavailable")
    } else {
      // Qwen's frozen route never falls back to Apple after a failed start.
      transition(to: .listening, reason: "qwen_listening")
      observationGeneration &+= 1
      observeQwenSession(qwen, generation: observationGeneration)
    }
  }

  private func observeQwenSession(
    _ session: QwenRealtimeVoiceSession,
    generation: UInt64
  ) {
    withObservationTracking(
      {
        _ = session.phase
        _ = session.pendingMutations
      },
      onChange: Self.makeNonisolatedVoidHandler { [weak self, weak session] in
        guard let self, let session, self.isConnected,
          self.observationGeneration == generation,
          self.qwenSession === session
        else { return }
        self.presentQwen(session.phase)
        if let proposal = session.pendingMutations.first {
          self.presentQwenMutation(proposal, session: session)
        }
        self.observeQwenSession(session, generation: generation)
      }
    )
  }

  private func presentQwen(_ phase: QwenRealtimePhase) {
    switch phase {
    case .connecting: transition(to: .starting, reason: "qwen_connecting")
    case .listening, .userSpeaking: transition(to: .listening, reason: "qwen_listening")
    case .responding: transition(to: .responding, reason: "qwen_responding")
    case .failed: showError(reason: "qwen_connection_unavailable")
    case .idle, .muted, .ending, .ended: break
    }
  }

  private func presentQwenMutation(
    _ proposal: QwenPendingMutation,
    session: QwenRealtimeVoiceSession
  ) {
    guard presentedQwenMutationID != proposal.id else { return }
    guard let interfaceController, isConnected, isTemplatePresented else {
      Task { await session.rejectMutation(id: proposal.id) }
      return
    }
    presentedQwenMutationID = proposal.id
    let confirm = CPAlertAction(
      title: "Confirm",
      style: .default,
      handler: Self.makeNonisolatedAlertHandler { [weak self, weak session] in
        guard let self, let session, self.isConnected,
          self.qwenSession === session,
          self.presentedQwenMutationID == proposal.id
        else { return }
        self.presentedQwenMutationID = nil
        await session.confirmMutation(id: proposal.id)
      }
    )
    let cancel = CPAlertAction(
      title: "Cancel",
      style: .cancel,
      handler: Self.makeNonisolatedAlertHandler { [weak self, weak session] in
        guard let self, let session else { return }
        self.presentedQwenMutationID = nil
        await session.rejectMutation(id: proposal.id)
      }
    )
    let actionName = proposal.name.replacingOccurrences(of: "_", with: " ")
    let alert = CPAlertTemplate(
      titleVariants: ["Confirm \(actionName)?"],
      actions: [confirm, cancel]
    )
    interfaceController.presentTemplate(
      alert,
      animated: true,
      completion: Self.makeNonisolatedTemplateCompletion { [weak self, weak session] success, _ in
        guard let self, let session, !success,
          self.presentedQwenMutationID == proposal.id
        else { return }
        self.presentedQwenMutationID = nil
        await session.rejectMutation(id: proposal.id)
      }
    )
  }

  private func stopConversation(connectionID: UUID, surfaceID: UUID) {
    guard isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
    startAttemptID = nil
    if let qwenSession {
      Task { [weak self] in
        await qwenSession.stop()
        guard let self, self.isCurrentConnection(connectionID, surfaceID: surfaceID) else { return }
        self.qwenSession = nil
        self.deactivateCarPlayAudioSession()
        self.transition(to: .ready, reason: "qwen_stopped")
      }
      return
    }
    guard let session else { return }
    Task { [weak self] in
      await session.stop()
      guard let self, self.isCurrentConnection(connectionID, surfaceID: surfaceID) else {
        return
      }
      self.deactivateCarPlayAudioSession()
      self.transition(to: .ready, reason: "stopped")
    }
  }

  private func observeSession(
    _ session: AssistantConversationSession,
    generation: UInt64,
    resettingVoiceBaseline: Bool = true
  ) {
    if resettingVoiceBaseline {
      observedVoiceOperationCompletionGeneration = session.voiceOperationCompletionGeneration
    }
    withObservationTracking(
      {
        _ = session.state
        _ = session.voiceAvailability
        _ = session.voiceOperationCompletionGeneration
      },
      onChange: Self.makeNonisolatedVoidHandler { [weak self, weak session] in
        guard let self, let session,
          self.isConnected,
          self.connectionID != nil,
          self.observationGeneration == generation,
          self.session === session
        else { return }
        let completionGeneration = session.voiceOperationCompletionGeneration
        let voiceOperationEnded =
          self.observedVoiceOperationCompletionGeneration != completionGeneration
        self.observedVoiceOperationCompletionGeneration = completionGeneration
        if voiceOperationEnded {
          self.deactivateCarPlayAudioSession()
        }
        self.present(session.state, availability: session.voiceAvailability)
        self.observeSession(
          session,
          generation: generation,
          resettingVoiceBaseline: false
        )
      }
    )
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
      transition(to: .responding, reason: "thinking")
    case .speaking:
      transition(to: .responding, reason: "speaking")
    case .error(let failure):
      stopForSetup(reason: "session_\(failure.kind.rawValue)")
    case .idle, .stopped:
      presentIdle(availability)
    }
  }

  private func presentIdle(_ availability: AssistantVoiceAvailability) {
    if let setupReason {
      transition(to: .setup, reason: setupReason)
      return
    }
    switch availability {
    case .available:
      transition(to: .ready, reason: "ready")
    case .permissionRequired:
      showError(reason: "microphone_permission_required")
    case .checking:
      transition(to: .starting, reason: "checking_voice")
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
    setupReason = reason
    startAttemptID = nil
    transition(to: .setup, reason: reason)
  }

  private func stopForSetup(reason: String) {
    let isNewFailure = setupReason != reason
    showError(reason: reason)
    guard isNewFailure, let connectionID, let surfaceID else { return }
    Task { [weak self] in
      guard let self else { return }
      await self.session?.stop()
      guard self.isCurrentConnection(connectionID, surfaceID: surfaceID),
        self.setupReason == reason
      else { return }
      self.deactivateCarPlayAudioSession()
      self.transition(to: .setup, reason: reason)
    }
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
    let ready = makeState(.ready, repeats: false)
    let starting = makeState(.starting, repeats: true)
    let listening = makeState(.listening, repeats: true)
    let responding = makeState(.responding, repeats: true)
    let setup = makeState(.setup, repeats: false)

    if #available(iOS 26.4, *) {
      ready.actionButtons = compactButtons(
        makeButton(title: CarPlayAssistantPhase.ready.actionTitle, symbol: "mic.fill") {
          [weak self] in
          guard let self, let connectionID = self.connectionID, let surfaceID = self.surfaceID
          else {
            return
          }
          Task { @MainActor in
            await self.startConversation(connectionID: connectionID, surfaceID: surfaceID)
          }
        }
      )
      listening.actionButtons = compactButtons(makeStopButton())
      starting.actionButtons = compactButtons(makeStopButton())
      responding.actionButtons = compactButtons(makeStopButton())
      setup.actionButtons = []
    }

    return CPVoiceControlTemplate(
      voiceControlStates: [ready, starting, listening, responding, setup]
    )
  }

  private func makeState(
    _ phase: CarPlayAssistantPhase,
    repeats: Bool
  ) -> CPVoiceControlState {
    CPVoiceControlState(
      identifier: phase.rawValue,
      titleVariants: phase.titleVariants,
      image: UIImage(systemName: phase.systemImageName),
      repeats: repeats
    )
  }

  @available(iOS 26.4, *)
  private func makeStopButton() -> CPButton? {
    makeButton(title: CarPlayAssistantPhase.listening.actionTitle, symbol: "stop.fill") {
      [weak self] in
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
    action: @escaping @MainActor @Sendable () -> Void
  ) -> CPButton? {
    guard let image = UIImage(systemName: symbol) else {
      logger.error("missing_system_image symbol=\(symbol, privacy: .public)")
      return nil
    }
    let button = CPButton(image: image, handler: Self.makeNonisolatedButtonHandler(action))
    button.title = title
    return button
  }

  nonisolated private static func makeNonisolatedButtonHandler(
    _ action: @escaping @MainActor @Sendable () -> Void
  ) -> (CPButton) -> Void {
    { _ in
      Task { @MainActor in action() }
    }
  }

  nonisolated private static func makeNonisolatedAlertHandler(
    _ action: @escaping @MainActor @Sendable () async -> Void
  ) -> (CPAlertAction) -> Void {
    { _ in Task { @MainActor in await action() } }
  }

  nonisolated private static func makeNonisolatedTemplateCompletion(
    _ action: @escaping @MainActor @Sendable (Bool, Int) async -> Void
  ) -> (Bool, (any Error)?) -> Void {
    { success, error in
      let errorCode = (error as NSError?)?.code ?? -1
      Task { @MainActor in await action(success, errorCode) }
    }
  }

  nonisolated private static func makeNonisolatedVoidHandler(
    _ action: @escaping @MainActor @Sendable () -> Void
  ) -> @Sendable () -> Void {
    { Task { @MainActor in action() } }
  }

  nonisolated private static func makeNonisolatedAudioInterruptionHandler(
    _ action: @escaping @MainActor @Sendable (UInt?) -> Void
  ) -> @Sendable (Notification) -> Void {
    { notification in
      let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      Task { @MainActor in action(rawType) }
    }
  }

  nonisolated private static func makeNonisolatedAudioRouteChangeHandler(
    _ action: @escaping @MainActor @Sendable (UInt?) -> Void
  ) -> @Sendable (Notification) -> Void {
    { notification in
      let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
      Task { @MainActor in action(rawReason) }
    }
  }

  nonisolated private static func makeNonisolatedNotificationHandler(
    _ action: @escaping @MainActor @Sendable () -> Void
  ) -> @Sendable (Notification) -> Void {
    { _ in
      Task { @MainActor in action() }
    }
  }

  @available(iOS 26.4, *)
  private func compactButtons(_ buttons: CPButton?...) -> [CPButton] {
    buttons.compactMap { $0 }
  }

  private func observeSafetyEvents() {
    safetyObservers.append(
      NotificationCenter.default.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: audioSession,
        queue: .main,
        using: Self.makeNonisolatedAudioInterruptionHandler { [weak self] rawType in
          self?.handleAudioInterruption(rawType: rawType)
        })
    )
    safetyObservers.append(
      NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: audioSession,
        queue: .main,
        using: Self.makeNonisolatedAudioRouteChangeHandler { [weak self] rawReason in
          self?.handleAudioRouteChange(rawReason: rawReason)
        })
    )
    safetyObservers.append(
      NotificationCenter.default.addObserver(
        forName: UserDefaults.didChangeNotification,
        object: UserDefaults.standard,
        queue: .main,
        using: Self.makeNonisolatedNotificationHandler { [weak self] in
          self?.handleSettingsChange()
        })
    )
  }

  private func handleAudioInterruption(rawType: UInt?) {
    guard let rawType,
      AVAudioSession.InterruptionType(rawValue: rawType) == .began
    else { return }
    pauseForSafety(reason: .audioInterruption)
  }

  private func handleAudioRouteChange(rawReason: UInt?) {
    guard session?.isVoiceRunning == true || startAttemptID != nil,
      let rawReason,
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

  private func handleSettingsChange() {
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
    ownsCarPlayAudioSession = true
  }

  private func deactivateCarPlayAudioSession() {
    guard ownsCarPlayAudioSession else { return }
    ownsCarPlayAudioSession = false
    try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
  }
}

@MainActor
private final class CarPlayQwenAudioSessionController: RealtimeAudioSessionControlling {
  func activate() async throws {}
  func deactivate() async {}
}
