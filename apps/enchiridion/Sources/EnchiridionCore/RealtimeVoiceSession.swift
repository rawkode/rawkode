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
  /// Teardown commands must never hold the terminal state hostage. This is
  /// deliberately short: the real bridge owns longer network shutdown work.
  public nonisolated static let transportOperationTimeout: Duration = .milliseconds(250)

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
    Task { @MainActor in
      // Do not serialize these from deinit: a suspended bridge command must
      // not prevent close or audio deactivation from being initiated.
      Task { @MainActor in try? await transport.setInputEnabled(false) }
      Task { @MainActor in try? await transport.send(.responseCancel(responseID: nil)) }
      Task { @MainActor in try? await transport.send(.outputAudioBufferClear) }
      Task { @MainActor in await transport.close() }
      if shouldDeactivateAudio {
        Task { await audioSession.deactivate() }
      }
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
  /// method then enforces permission -> native key read -> validated SDP/WebRTC
  /// handshake -> system audio activation. The transport keeps the microphone
  /// track disabled until all handshake stages have completed.
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
      let established = try await transport.start(
        generation: currentGeneration,
        route: route,
        configuration: configuration,
        credential: credential
      )
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        if !isSessionCurrent(currentGeneration) {
          await performBoundedTeardown { await self.transport.close() }
        }
        return
      }
      do {
        try configuration.validateActual(
          modelID: established.modelID,
          voiceID: established.voiceID
        )
      } catch {
        await fail(
          RealtimeVoiceFailure(
            code: "route_mismatch",
            message: "OpenAI Voice did not establish the selected route."
          ),
          generation: currentGeneration
        )
        return
      }
      // `start` only succeeds after the transport has decoded and validated the
      // server's `session.created` event. Feed that established identity into
      // the reducer before enabling either the system audio session or the
      // WebRTC input track. A later copy of the server event is harmless and
      // still receives its server-assigned event ID for deduplication.
      _ = reducer.reduce(
        RealtimeServerEvent(
          eventID: nil,
          payload: .sessionCreated(established)
        )
      )
      // Keep the session in the startup phase until audio activation and the
      // input-track transition have both completed. This makes an interruption
      // during either stage terminal rather than treating it as a resumable
      // live conversation, while retaining the validated session identity.
      setPhase(.connecting)
      transportStartedGeneration = currentGeneration
      try await audioSession.activate()
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        await performBoundedTeardown { await self.audioSession.deactivate() }
        if !isSessionCurrent(currentGeneration) {
          await performBoundedTeardown { await self.transport.close() }
        }
        return
      }
      audioOwnerGeneration = currentGeneration
      guard await confirmInputTransition(true) else {
        guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
        await terminalFailure(
          RealtimeVoiceFailure(
            code: "input_enable_failed",
            message: "Could not enable the OpenAI Voice microphone."
          ),
          generation: currentGeneration
        )
        return
      }
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        await performBoundedTeardown { try? await self.transport.setInputEnabled(false) }
        await performBoundedTeardown { await self.audioSession.deactivate() }
        if !isSessionCurrent(currentGeneration) {
          await performBoundedTeardown { await self.transport.close() }
        }
        return
      }
      setPhase(.listening)
    } catch {
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      await fail(
        RealtimeVoiceFailure(
          code: "connection_failed",
          message: "Could not connect to OpenAI Voice."
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
      guard await confirmInputTransition(false) else {
        guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
        await terminalFailure(
          RealtimeVoiceFailure(
            code: "input_disable_failed",
            message: "Could not disable the OpenAI Voice microphone."
          ),
          generation: currentGeneration
        )
        return
      }
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      do {
        try await transport.send(.inputAudioBufferClear)
        guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      } catch {
        await fail(
          RealtimeVoiceFailure(
            code: "mute_failed",
            message: "Could not update the microphone state."
          ),
          generation: currentGeneration
        )
        return
      }
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      setPhase(.muted)
    } else {
      guard await confirmInputTransition(true) else {
        guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
        await terminalFailure(
          RealtimeVoiceFailure(
            code: "input_enable_failed",
            message: "Could not enable the OpenAI Voice microphone."
          ),
          generation: currentGeneration
        )
        return
      }
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        await performBoundedTeardown { try? await self.transport.setInputEnabled(false) }
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
      await terminalFailure(failure, generation: currentGeneration)
      return
    }
    do {
      try await audioSession.activate()
      guard isPauseResumeCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch
      ) else {
        await performBoundedTeardown { await self.audioSession.deactivate() }
        return
      }
      audioOwnerGeneration = currentGeneration
      guard await confirmInputTransition(true) else {
        guard isPauseResumeCurrent(
          generation: currentGeneration,
          operation: currentOperation,
          pauseEpoch: pause.epoch
        ) else { return }
        await terminalFailure(
          RealtimeVoiceFailure(
            code: "input_enable_failed",
            message: "Could not enable the OpenAI Voice microphone."
          ),
          generation: currentGeneration
        )
        return
      }
      guard isPauseResumeCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch
      ) else {
        await performBoundedTeardown { try? await self.transport.setInputEnabled(false) }
        await performBoundedTeardown { await self.audioSession.deactivate() }
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
      await terminalFailure(
        RealtimeVoiceFailure(
          code: "audio_resume_failed",
          message: "Could not resume OpenAI Voice audio."
        ),
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
                message: "Could not update the OpenAI Voice connection."
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
    // A paused session still owns a live peer and audio route. Once its event
    // stream ends there is no connection to resume, so fail terminally rather
    // than leaving a stuck paused UI.
    await terminalFailure(failure, generation: currentGeneration)
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

    // Do not expose a resumable pause until the microphone track is confirmed
    // disabled. A safety pause with uncertain input state is terminal.
    guard await confirmInputTransition(false) else {
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      await terminalFailure(
        RealtimeVoiceFailure(
          code: "input_disable_failed",
          message: "Could not disable the OpenAI Voice microphone."
        ),
        generation: currentGeneration
      )
      return
    }
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
      // `activePause` is deliberately not set yet, so operation cancellation
      // cannot create a resumable state before input disable confirmation.
      return
    }
    activePause = pause
    setPhase(.paused(reason))

    await performBoundedTeardown {
      try? await self.transport.send(.responseCancel(responseID: self.state.activeResponseID))
    }
    guard isPauseCurrent(
      generation: currentGeneration,
      operation: currentOperation,
      pauseEpoch: pause.epoch
    ) else { return }
    await performBoundedTeardown { try? await self.transport.send(.outputAudioBufferClear) }
    guard isPauseCurrent(
      generation: currentGeneration,
      operation: currentOperation,
      pauseEpoch: pause.epoch
    ) else { return }
    reducer.finishActiveResponse(as: .cancelled)
    synchronizeReducerState()
    if audioOwnerGeneration == currentGeneration {
      await performBoundedTeardown { await self.audioSession.deactivate() }
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

  /// Bypasses the resumable-pause path. Use this when the input transition or
  /// event stream can no longer prove that the peer is safe to resume.
  private func terminalFailure(
    _ failure: RealtimeVoiceFailure,
    generation currentGeneration: UInt64
  ) async {
    guard isSessionCurrent(currentGeneration), receipt == nil else { return }
    activePause = nil
    pendingPausedFailure = nil
    reducer.markLocalFailure(failure)
    synchronizeReducerState()
    await finish(completion: .failed, failure: failure)
  }

  /// Starts the input transition in a separately cancellable task and waits
  /// only for a bounded confirmation. This prevents a wedged bridge from
  /// leaving a session in a live or resumable state with uncertain microphone
  /// delivery.
  private func confirmInputTransition(_ enabled: Bool) async -> Bool {
    let gate = RealtimeVoiceOperationGate()
    let transport = transport
    let operation = Task { @MainActor in
      do {
        try await transport.setInputEnabled(enabled)
        await gate.resolve(.succeeded)
      } catch {
        await gate.resolve(.failed)
      }
    }
    let timeout = Task {
      do {
        try await Task.sleep(for: Self.transportOperationTimeout)
      } catch {
        return
      }
      await gate.resolve(.timedOut)
    }
    let result = await gate.wait()
    operation.cancel()
    timeout.cancel()
    return result == .succeeded
  }

  /// Begins a teardown operation but never waits indefinitely for it. The
  /// caller continues to close the transport and deactivate audio even when a
  /// preceding operation has failed, ignored cancellation, or wedged.
  private func performBoundedTeardown(
    _ work: @escaping @MainActor () async -> Void
  ) async {
    let gate = RealtimeVoiceOperationGate()
    let operation = Task { @MainActor in
      await work()
      await gate.resolve(.succeeded)
    }
    let timeout = Task {
      do {
        try await Task.sleep(for: Self.transportOperationTimeout)
      } catch {
        return
      }
      await gate.resolve(.timedOut)
    }
    _ = await gate.wait()
    operation.cancel()
    timeout.cancel()
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
      await performBoundedTeardown { try? await self.transport.setInputEnabled(false) }
    }
    if startedTransport {
      await performBoundedTeardown {
        try? await self.transport.send(.responseCancel(responseID: self.state.activeResponseID))
      }
      await performBoundedTeardown { try? await self.transport.send(.outputAudioBufferClear) }
    }
    reducer.finishActiveResponse(as: completion == .failed ? .failed : .cancelled)
    synchronizeReducerState()
    if attemptedTransport {
      await performBoundedTeardown { await self.transport.close() }
    }
    if ownedAudio {
      await performBoundedTeardown { await self.audioSession.deactivate() }
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

}

private enum RealtimeVoiceOperationResult: Equatable, Sendable {
  case succeeded
  case failed
  case timedOut
}

private actor RealtimeVoiceOperationGate {
  private var result: RealtimeVoiceOperationResult?
  private var continuation: CheckedContinuation<RealtimeVoiceOperationResult, Never>?

  func resolve(_ candidate: RealtimeVoiceOperationResult) {
    guard result == nil else { return }
    result = candidate
    let continuation = continuation
    self.continuation = nil
    continuation?.resume(returning: candidate)
  }

  func wait() async -> RealtimeVoiceOperationResult {
    if let result { return result }
    return await withCheckedContinuation { continuation in
      if let result {
        continuation.resume(returning: result)
      } else {
        self.continuation = continuation
      }
    }
  }
}
