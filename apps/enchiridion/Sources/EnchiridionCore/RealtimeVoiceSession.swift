import Foundation
import Observation

/// A duplex Realtime session that is intentionally separate from the serial
/// Apple transcription/text/synthesis conversation session.
@MainActor
@Observable
public final class RealtimeVoiceSession {
  private struct ActivePause {
    let epoch: UInt64
    let reason: AssistantVoicePauseReason
  }

  public nonisolated static let warningDelay: Duration = .seconds(13 * 60)
  public nonisolated static let hardLimit: Duration = .seconds(15 * 60)

  public let route: RealtimeVoiceRouteSnapshot
  public let configuration: RealtimeVoiceConfiguration
  public private(set) var state: RealtimeVoiceReducerState
  public private(set) var warningMessage: String?
  public private(set) var receipt: RealtimeVoiceReceipt?

  @ObservationIgnored private let microphone: any RealtimeMicrophoneAuthorizing
  @ObservationIgnored private let credentialReader: any RealtimeCredentialReading
  @ObservationIgnored private let transport: any RealtimeVoiceTransport
  @ObservationIgnored private let audioSession: any RealtimeAudioSessionControlling
  @ObservationIgnored private let safetyEvents: (any AssistantVoiceSafetyEventSource)?
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored private let limitWarningDelay: Duration
  @ObservationIgnored private let hardLimitDelay: Duration
  @ObservationIgnored private var reducer: RealtimeVoiceReducer
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var operationEpoch: UInt64 = 0
  @ObservationIgnored private var pauseEpoch: UInt64 = 0
  @ObservationIgnored private var activePause: ActivePause?
  @ObservationIgnored private var pendingPausedFailure: RealtimeVoiceFailure?
  @ObservationIgnored private var startedAt: Date?
  @ObservationIgnored private var eventTask: Task<Void, Never>?
  @ObservationIgnored private var limitTask: Task<Void, Never>?
  @ObservationIgnored private var safetyTask: Task<Void, Never>?
  @ObservationIgnored private var audioOwnerGeneration: UInt64?
  @ObservationIgnored private var transportAttemptGeneration: UInt64?
  @ObservationIgnored private var transportStartedGeneration: UInt64?
  @ObservationIgnored private var isStopping = false

  public init(
    route: RealtimeVoiceRouteSnapshot,
    microphone: any RealtimeMicrophoneAuthorizing,
    credentialReader: any RealtimeCredentialReading,
    transport: any RealtimeVoiceTransport,
    audioSession: any RealtimeAudioSessionControlling,
    safetyEvents: (any AssistantVoiceSafetyEventSource)? = nil,
    now: @escaping @Sendable () -> Date = { Date() },
    sleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    limitWarningDelay: Duration = RealtimeVoiceSession.warningDelay,
    hardLimitDelay: Duration = RealtimeVoiceSession.hardLimit
  ) throws {
    precondition(limitWarningDelay >= .zero)
    precondition(hardLimitDelay > limitWarningDelay)
    let configuration = try RealtimeVoiceConfiguration(route: route)
    self.route = route
    self.configuration = configuration
    self.microphone = microphone
    self.credentialReader = credentialReader
    self.transport = transport
    self.audioSession = audioSession
    self.safetyEvents = safetyEvents
    self.now = now
    self.sleep = sleep
    self.limitWarningDelay = limitWarningDelay
    self.hardLimitDelay = hardLimitDelay
    reducer = RealtimeVoiceReducer(configuration: configuration)
    state = reducer.state

    if let safetyEvents {
      safetyTask = Task { [weak self] in
        for await event in safetyEvents.events() {
          guard !Task.isCancelled else { return }
          await self?.handleSafetyEvent(event)
        }
      }
    }
  }

  deinit {
    eventTask?.cancel()
    limitTask?.cancel()
    safetyTask?.cancel()
    guard transportAttemptGeneration != nil else { return }
    let transport = transport
    let audioSession = audioSession
    let shouldDeactivateAudio = audioOwnerGeneration != nil
    Task {
      await transport.setInputEnabled(false)
      try? await transport.send(.responseCancel(responseID: nil))
      try? await transport.send(.outputAudioBufferClear)
      await transport.close()
      if shouldDeactivateAudio { await audioSession.deactivate() }
    }
  }

  public var isActive: Bool {
    switch state.phase {
    case .requestingMicrophone, .readingCredential, .connecting, .listening,
      .userSpeaking, .responding, .assistantSpeaking, .muted, .paused, .ending:
      true
    case .idle, .ended, .failed:
      false
    }
  }

  /// Must be called only after the voice lobby's explicit JIT acceptance. This
  /// method then enforces permission -> native key read -> SDP/WebRTC -> system
  /// audio activation; no earlier step can observe the key or microphone.
  public func start() async {
    guard state.phase == .idle, receipt == nil, !isStopping else { return }
    generation &+= 1
    operationEpoch &+= 1
    let currentGeneration = generation
    let currentOperation = operationEpoch
    startedAt = now()
    setPhase(.requestingMicrophone)

    let permission = await microphone.requestPermission()
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
    guard permission == .authorized else {
      let code = permission == .denied ? "microphone_denied" : "microphone_restricted"
      await fail(
        RealtimeVoiceFailure(code: code, message: "Microphone access is not available."),
        generation: currentGeneration
      )
      return
    }
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }

    setPhase(.readingCredential)
    let credential: RealtimeCredentialLease
    do {
      guard let binding = route.credentialBinding else {
        throw RealtimeVoiceContractError.unauthorizedRoute(.credentialVerificationRequired)
      }
      credential = try await credentialReader.realtimeCredential(matching: binding)
      guard credential.binding == binding else {
        throw OpenAICredentialStoreError.bindingMismatch
      }
    } catch {
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      await fail(
        RealtimeVoiceFailure(
          code: "credential_unavailable",
          message: "The verified OpenAI key is no longer available."
        ),
        generation: currentGeneration
      )
      return
    }
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }

    setPhase(.connecting)
    let stream = transport.events()
    do {
      transportAttemptGeneration = currentGeneration
      try await transport.start(
        route: route,
        configuration: configuration,
        credential: credential
      )
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        if !isSessionCurrent(currentGeneration) { await transport.close() }
        return
      }
      transportStartedGeneration = currentGeneration
      try await audioSession.activate()
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        await audioSession.deactivate()
        if !isSessionCurrent(currentGeneration) { await transport.close() }
        return
      }
      audioOwnerGeneration = currentGeneration
      await transport.setInputEnabled(true)
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        await transport.setInputEnabled(false)
        await audioSession.deactivate()
        if !isSessionCurrent(currentGeneration) { await transport.close() }
        return
      }
    } catch {
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      await fail(
        RealtimeVoiceFailure(
          code: "connection_failed",
          message: error.localizedDescription
        ),
        generation: currentGeneration
      )
      return
    }

    guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
    eventTask = Task { [weak self] in
      guard let self else { return }
      await self.consume(stream, generation: currentGeneration)
    }
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
      eventTask?.cancel()
      eventTask = nil
      return
    }
    limitTask = Task { [weak self] in
      guard let self else { return }
      await self.enforceLimits(generation: currentGeneration)
    }
  }

  public func setMuted(_ isMuted: Bool) async {
    guard isActive, !isStopping, activePause == nil else { return }
    if isMuted {
      switch state.phase {
      case .listening, .userSpeaking, .responding, .assistantSpeaking:
        break
      default:
        return
      }
    } else {
      guard state.phase == .muted else { return }
    }
    let currentGeneration = generation
    operationEpoch &+= 1
    let currentOperation = operationEpoch
    if isMuted {
      await transport.setInputEnabled(false)
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      do {
        try await transport.send(.inputAudioBufferClear)
        guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      } catch {
        await fail(
          RealtimeVoiceFailure(code: "mute_failed", message: error.localizedDescription),
          generation: currentGeneration
        )
        return
      }
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      setPhase(.muted)
    } else {
      await transport.setInputEnabled(true)
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        await transport.setInputEnabled(false)
        return
      }
      setPhase(.listening)
    }
  }

  public func stop() async {
    await finish(completion: .cancelled)
  }

  public func handleSafetyEvent(_ event: AssistantVoiceSafetyEvent) async {
    guard isActive, !isStopping else { return }
    let reason: AssistantVoicePauseReason?
    switch event {
    case .interruptionBegan:
      reason = .interruption
    case .routeChanged(let changeReason, let previous, let current):
      reason = AssistantAudioRouteSafetyClassifier.pauseReason(
        reason: changeReason,
        previous: previous,
        current: current
      )
    case .mediaServicesLost, .mediaServicesReset:
      reason = .mediaServicesRestarted
    case .appInactive:
      reason = .appInactive
    }
    guard let reason else { return }
    switch state.phase {
    case .requestingMicrophone, .readingCredential, .connecting:
      await finish(completion: .safetyPause)
      return
    default:
      break
    }
    await pause(for: reason)
  }

  /// Explicitly resumes the existing peer connection. It never reconnects or
  /// chooses a fallback provider.
  public func resumeAfterSafetyPause() async {
    guard let pause = activePause,
      case .paused = state.phase,
      transportStartedGeneration == generation,
      !isStopping
    else { return }
    let currentGeneration = generation
    operationEpoch &+= 1
    let currentOperation = operationEpoch
    if let failure = pendingPausedFailure {
      activePause = nil
      pendingPausedFailure = nil
      await fail(failure, generation: currentGeneration)
      return
    }
    do {
      try await audioSession.activate()
      guard isPauseResumeCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch
      ) else {
        await audioSession.deactivate()
        return
      }
      audioOwnerGeneration = currentGeneration
      await transport.setInputEnabled(true)
      guard isPauseResumeCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch
      ) else {
        await transport.setInputEnabled(false)
        await audioSession.deactivate()
        return
      }
      activePause = nil
      setPhase(.listening)
    } catch {
      guard isPauseResumeCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch
      ) else { return }
      await fail(
        RealtimeVoiceFailure(code: "audio_resume_failed", message: error.localizedDescription),
        generation: currentGeneration
      )
    }
  }

  private func consume(
    _ stream: AsyncStream<RealtimeServerEvent>,
    generation currentGeneration: UInt64
  ) async {
    for await event in stream {
      guard isSessionCurrent(currentGeneration), !Task.isCancelled else { return }
      let effects = reducer.reduce(event)
      synchronizeReducerState()
      if activePause != nil {
        if case .terminate(let failure) = effects.first {
          pendingPausedFailure = failure
        }
        continue
      }
      for effect in effects {
        guard isSessionCurrent(currentGeneration) else { return }
        switch effect {
        case .send(let command):
          do {
            try await transport.send(command)
            guard isSessionCurrent(currentGeneration) else { return }
          } catch {
            await fail(
              RealtimeVoiceFailure(
                code: "transport_command_failed",
                message: error.localizedDescription
              ),
              generation: currentGeneration
            )
            return
          }
        case .terminate(let failure):
          await fail(failure, generation: currentGeneration)
          return
        }
      }
    }
    guard isSessionCurrent(currentGeneration), !isStopping else { return }
    let failure = RealtimeVoiceFailure(
      code: "transport_closed",
      message: "The OpenAI Voice connection closed. Start a new conversation to try again."
    )
    if activePause != nil {
      pendingPausedFailure = failure
    } else {
      await fail(failure, generation: currentGeneration)
    }
  }

  private func enforceLimits(generation currentGeneration: UInt64) async {
    do {
      try await sleep(limitWarningDelay)
      guard isSessionCurrent(currentGeneration), !Task.isCancelled else { return }
      warningMessage = "OpenAI Voice will end in 2 minutes."
      try await sleep(hardLimitDelay - limitWarningDelay)
      guard isSessionCurrent(currentGeneration), !Task.isCancelled else { return }
      await finish(completion: .hardLimit)
    } catch {
      return
    }
  }

  private func pause(for reason: AssistantVoicePauseReason) async {
    guard !isStopping else { return }
    let currentGeneration = generation
    operationEpoch &+= 1
    let currentOperation = operationEpoch
    pauseEpoch &+= 1
    let pause = ActivePause(epoch: pauseEpoch, reason: reason)
    activePause = pause
    setPhase(.paused(reason))

    await transport.setInputEnabled(false)
    guard isPauseCurrent(
      generation: currentGeneration,
      operation: currentOperation,
      pauseEpoch: pause.epoch
    ) else { return }
    try? await transport.send(.responseCancel(responseID: state.activeResponseID))
    guard isPauseCurrent(
      generation: currentGeneration,
      operation: currentOperation,
      pauseEpoch: pause.epoch
    ) else { return }
    try? await transport.send(.outputAudioBufferClear)
    guard isPauseCurrent(
      generation: currentGeneration,
      operation: currentOperation,
      pauseEpoch: pause.epoch
    ) else { return }
    reducer.finishActiveResponse(as: .cancelled)
    synchronizeReducerState()
    if audioOwnerGeneration == currentGeneration {
      await audioSession.deactivate()
      guard isPauseCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch
      ) else { return }
      audioOwnerGeneration = nil
    }
  }

  private func fail(
    _ failure: RealtimeVoiceFailure,
    generation currentGeneration: UInt64
  ) async {
    guard isSessionCurrent(currentGeneration), receipt == nil else { return }
    if activePause != nil {
      pendingPausedFailure = failure
      return
    }
    reducer.markLocalFailure(failure)
    synchronizeReducerState()
    await finish(completion: .failed, failure: failure)
  }

  private func finish(
    completion: RealtimeVoiceSessionCompletion,
    failure: RealtimeVoiceFailure? = nil
  ) async {
    guard receipt == nil, !isStopping else { return }
    let finishingGeneration = generation
    isStopping = true
    generation &+= 1
    operationEpoch &+= 1
    let terminalGeneration = generation
    let terminalOperation = operationEpoch
    let attemptedTransport = transportAttemptGeneration == finishingGeneration
    let startedTransport = transportStartedGeneration == finishingGeneration
    let ownedAudio = audioOwnerGeneration == finishingGeneration
    transportAttemptGeneration = nil
    transportStartedGeneration = nil
    audioOwnerGeneration = nil
    activePause = nil
    pendingPausedFailure = nil
    eventTask?.cancel()
    eventTask = nil
    limitTask?.cancel()
    limitTask = nil
    safetyTask?.cancel()
    safetyTask = nil
    warningMessage = nil
    setPhase(.ending)

    if attemptedTransport {
      await transport.setInputEnabled(false)
      guard isTerminalCurrent(
        generation: terminalGeneration,
        operation: terminalOperation
      ) else { return }
    }
    if startedTransport {
      try? await transport.send(.responseCancel(responseID: state.activeResponseID))
      guard isTerminalCurrent(
        generation: terminalGeneration,
        operation: terminalOperation
      ) else { return }
      try? await transport.send(.outputAudioBufferClear)
      guard isTerminalCurrent(
        generation: terminalGeneration,
        operation: terminalOperation
      ) else { return }
    }
    reducer.finishActiveResponse(as: completion == .failed ? .failed : .cancelled)
    synchronizeReducerState()
    if attemptedTransport {
      await transport.close()
      guard isTerminalCurrent(
        generation: terminalGeneration,
        operation: terminalOperation
      ) else { return }
    }
    if ownedAudio {
      await audioSession.deactivate()
      guard isTerminalCurrent(
        generation: terminalGeneration,
        operation: terminalOperation
      ) else { return }
    }

    let end = now()
    receipt = RealtimeVoiceReceipt(
      requestedModelID: configuration.modelID,
      requestedVoiceID: configuration.voiceID,
      actualModelID: state.actualModelID,
      actualVoiceID: state.actualVoiceID,
      sessionID: state.sessionID,
      requestIDs: state.requestIDs,
      startedAt: startedAt ?? end,
      endedAt: end,
      completion: completion,
      failureCode: failure?.code,
      failureMessage: failure?.message,
      turns: state.turnReceipts
    )
    setPhase(completion == .failed ? .failed : .ended)
    isStopping = false
  }

  private func setPhase(_ phase: RealtimeVoicePhase) {
    reducer.setLocalPhase(phase)
    synchronizeReducerState()
  }

  private func synchronizeReducerState() {
    var synchronized = reducer.state
    if let activePause, receipt == nil, !isStopping {
      synchronized.phase = .paused(activePause.reason)
    }
    state = synchronized
  }

  private func isSessionCurrent(_ expectedGeneration: UInt64) -> Bool {
    expectedGeneration == generation && receipt == nil && !isStopping
  }

  private func isOperationCurrent(
    _ expectedGeneration: UInt64,
    operation expectedOperation: UInt64
  ) -> Bool {
    isSessionCurrent(expectedGeneration)
      && expectedOperation == operationEpoch
      && activePause == nil
  }

  private func isPauseCurrent(
    generation expectedGeneration: UInt64,
    operation expectedOperation: UInt64,
    pauseEpoch expectedPauseEpoch: UInt64
  ) -> Bool {
    isSessionCurrent(expectedGeneration)
      && expectedOperation == operationEpoch
      && activePause?.epoch == expectedPauseEpoch
  }

  private func isPauseResumeCurrent(
    generation expectedGeneration: UInt64,
    operation expectedOperation: UInt64,
    pauseEpoch expectedPauseEpoch: UInt64
  ) -> Bool {
    isPauseCurrent(
      generation: expectedGeneration,
      operation: expectedOperation,
      pauseEpoch: expectedPauseEpoch
    )
  }

  private func isTerminalCurrent(
    generation expectedGeneration: UInt64,
    operation expectedOperation: UInt64
  ) -> Bool {
    expectedGeneration == generation
      && expectedOperation == operationEpoch
      && receipt == nil
      && isStopping
  }
}
