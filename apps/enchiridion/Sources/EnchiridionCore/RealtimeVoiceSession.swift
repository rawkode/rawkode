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

  private struct ActiveWaiter {
    let generation: UInt64
    let operation: UInt64
    let continuation: CheckedContinuation<Void, Never>
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
  public private(set) var voiceActivity = VoiceActivitySnapshot.inactive

  @ObservationIgnored private let microphone: any RealtimeMicrophoneAuthorizing
  @ObservationIgnored private let credentialReader: any RealtimeCredentialReading
  @ObservationIgnored private let transport: any RealtimeVoiceTransport
  @ObservationIgnored private let audioSession: any RealtimeAudioSessionControlling
  @ObservationIgnored private let safetyEvents: (any AssistantVoiceSafetyEventSource)?
  @ObservationIgnored private let diagnostics: any OpenAIRealtimeVoiceDiagnosticSinking
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored private let limitWarningDelay: Duration
  @ObservationIgnored private let hardLimitDelay: Duration
  @ObservationIgnored private var reducer: RealtimeVoiceReducer
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored private var operationEpoch: UInt64 = 0
  @ObservationIgnored private var inputEpoch: UInt64 = 0
  @ObservationIgnored private var pauseEpoch: UInt64 = 0
  @ObservationIgnored private var activePause: ActivePause?
  @ObservationIgnored private var pendingPause: ActivePause?
  @ObservationIgnored private var pendingPauseEpoch: UInt64?
  @ObservationIgnored private var lifecycleState: RealtimeVoiceLifecycleState
  @ObservationIgnored private var activeWaiter: ActiveWaiter?
  @ObservationIgnored private var pendingPausedFailure: RealtimeVoiceFailure?
  @ObservationIgnored private var resumeEpoch: UInt64 = 0
  @ObservationIgnored private var resumeInFlight = false
  @ObservationIgnored private var startedAt: Date?
  @ObservationIgnored private var eventTask: Task<Void, Never>?
  @ObservationIgnored private var activityTask: Task<Void, Never>?
  @ObservationIgnored private var limitTask: Task<Void, Never>?
  @ObservationIgnored private var safetyTask: Task<Void, Never>?
  @ObservationIgnored private var audioOwnerGeneration: UInt64?
  @ObservationIgnored private var transportAttemptGeneration: UInt64?
  @ObservationIgnored private var transportStartedGeneration: UInt64?
  @ObservationIgnored private var isStopping = false
  @ObservationIgnored private var respondingResponseID: String?
  @ObservationIgnored private var diagnosticAttemptToken: OpenAIRealtimeVoiceAttemptToken?
  @ObservationIgnored private var didEmitTerminalDiagnostic = false

  private static let responseAudibilityFloor = 0.015

  public init(
    route: RealtimeVoiceRouteSnapshot,
    microphone: any RealtimeMicrophoneAuthorizing,
    credentialReader: any RealtimeCredentialReading,
    transport: any RealtimeVoiceTransport,
    audioSession: any RealtimeAudioSessionControlling,
    safetyEvents: (any AssistantVoiceSafetyEventSource)? = nil,
    diagnostics: any OpenAIRealtimeVoiceDiagnosticSinking = OpenAIRealtimeVoiceOSLogDiagnosticSink(),
    now: @escaping @Sendable () -> Date = { Date() },
    sleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    initialLifecycleState: RealtimeVoiceLifecycleState = .active,
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
    self.diagnostics = diagnostics
    self.now = now
    self.sleep = sleep
    lifecycleState = initialLifecycleState
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

  isolated deinit {
    eventTask?.cancel()
    activityTask?.cancel()
    limitTask?.cancel()
    safetyTask?.cancel()
    guard transportAttemptGeneration != nil else { return }
    let transport = transport
    let audioSession = audioSession
    let shouldDeactivateAudio = audioOwnerGeneration != nil
    let lease = mintInputLease(for: transportAttemptGeneration ?? generation)
    Task { @MainActor in
      // Do not serialize these from deinit: a suspended bridge command must
      // not prevent close or audio deactivation from being initiated.
      Task { @MainActor in try? await transport.setInputEnabled(false, lease: lease) }
      Task { @MainActor in await transport.close() }
      if shouldDeactivateAudio {
        Task { await audioSession.deactivate() }
      }
    }
  }

  public var isActive: Bool {
    switch state.phase {
    case .requestingMicrophone, .readingCredential, .connecting, .listening,
      .userSpeaking, .responding, .assistantSpeaking, .muted, .pausing, .paused, .ending:
      true
    case .idle, .ended, .failed:
      false
    }
  }

  /// Starts the saved, verified BYOK route and enforces permission -> native
  /// key read -> validated SDP/WebRTC
  /// handshake -> system audio activation. The transport keeps the microphone
  /// track disabled until all handshake stages have completed.
  public func start() async {
    await withTaskCancellationHandler {
      await startOperation()
    } onCancel: {
      Task { @MainActor [weak self] in
        await self?.cancelStartupIfNeeded()
      }
    }
  }

  private func startOperation() async {
    guard state.phase == .idle, receipt == nil, !isStopping else { return }
    generation &+= 1
    operationEpoch &+= 1
    let currentGeneration = generation
    diagnosticAttemptToken = .make()
    didEmitTerminalDiagnostic = false
    diagnostics.record(.init(stage: .sessionStart, outcome: .started, generation: currentGeneration, attemptToken: diagnosticAttemptToken, modelID: configuration.modelID, voiceID: configuration.voiceID))
    let currentOperation = operationEpoch
    startedAt = now()
    setPhase(.requestingMicrophone)

    if await finishIfCancelled(generation: currentGeneration) { return }

    guard lifecycleState != .background else {
      await terminalFailure(startupInterruptedFailure, generation: currentGeneration)
      return
    }

    let permission = await microphone.requestPermission()
    diagnostics.record(.init(stage: .microphone, outcome: permission == .authorized ? .succeeded : .failed, generation: currentGeneration, attemptToken: diagnosticAttemptToken))
    if await finishIfCancelled(generation: currentGeneration) { return }
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
    guard permission == .authorized else {
      let code = permission == .denied ? "microphone_denied" : "microphone_restricted"
      await fail(
        RealtimeVoiceFailure(code: code, message: "Microphone access is not available."),
        generation: currentGeneration
      )
      return
    }
    guard await waitForActiveDuringStartup(
      generation: currentGeneration,
      operation: currentOperation
    ) else { return }
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }

    setPhase(.readingCredential)
    diagnostics.record(.init(stage: .credential, outcome: .started, generation: currentGeneration, attemptToken: diagnosticAttemptToken))
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
    guard await waitForActiveDuringStartup(
      generation: currentGeneration,
      operation: currentOperation
    ) else { return }
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }

    setPhase(.connecting)
    diagnostics.record(.init(stage: .transportStart, outcome: .started, generation: currentGeneration, attemptToken: diagnosticAttemptToken, modelID: configuration.modelID, voiceID: configuration.voiceID))
    let stream = transport.events()
    let activity = transport.activity()
    do {
      transportAttemptGeneration = currentGeneration
      let established = try await transport.start(
        generation: currentGeneration,
        diagnosticContext: OpenAIRealtimeVoiceDiagnosticContext(
          attemptToken: diagnosticAttemptToken!, generation: currentGeneration
        ),
        route: route,
        configuration: configuration,
        credential: credential
      )
      diagnostics.record(.init(stage: .transportStart, outcome: .succeeded, generation: currentGeneration, attemptToken: diagnosticAttemptToken, modelID: established.modelID, voiceID: established.voiceID, requestID: established.requestID))
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
      guard await waitForActiveDuringStartup(
        generation: currentGeneration,
        operation: currentOperation
      ) else {
        await performBoundedTeardown { await self.audioSession.deactivate() }
        if !isSessionCurrent(currentGeneration) {
          await performBoundedTeardown { await self.transport.close() }
        }
        return
      }
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      diagnostics.record(.init(stage: .audioSession, outcome: .started, generation: currentGeneration, attemptToken: diagnosticAttemptToken))
      do {
        try await audioSession.activate()
      } catch {
        guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
        diagnostics.record(.init(stage: .audioSession, outcome: .failed, generation: currentGeneration, attemptToken: diagnosticAttemptToken))
        await terminalFailure(
          RealtimeVoiceFailure(
            code: "audio_activate_failed",
            message: "Could not activate OpenAI Voice audio."
          ),
          generation: currentGeneration
        )
        return
      }
      diagnostics.record(.init(stage: .audioSession, outcome: .succeeded, generation: currentGeneration, attemptToken: diagnosticAttemptToken))
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        await performBoundedTeardown { await self.audioSession.deactivate() }
        if !isSessionCurrent(currentGeneration) {
          await performBoundedTeardown { await self.transport.close() }
        }
        return
      }
      audioOwnerGeneration = currentGeneration
      guard await waitForActiveDuringStartup(
        generation: currentGeneration,
        operation: currentOperation
      ) else {
        await performBoundedTeardown { try? await self.disableInput(for: currentGeneration) }
        await performBoundedTeardown { await self.audioSession.deactivate() }
        if !isSessionCurrent(currentGeneration) {
          await performBoundedTeardown { await self.transport.close() }
        }
        return
      }
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      guard case .succeeded = await confirmInputTransition(
        true,
        context: .unpaused(generation: currentGeneration, operation: currentOperation, attempt: diagnosticAttemptToken)
      ) else {
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
      guard await waitForActiveDuringStartup(
        generation: currentGeneration,
        operation: currentOperation
      ) else {
        await performBoundedTeardown { try? await self.disableInput(for: currentGeneration) }
        await performBoundedTeardown { await self.audioSession.deactivate() }
        if !isSessionCurrent(currentGeneration) {
          await performBoundedTeardown { await self.transport.close() }
        }
        return
      }
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
        await performBoundedTeardown { try? await self.disableInput(for: currentGeneration) }
        await performBoundedTeardown { await self.audioSession.deactivate() }
        if !isSessionCurrent(currentGeneration) {
          await performBoundedTeardown { await self.transport.close() }
        }
        return
      }
      setPhase(.listening)
      diagnostics.record(.init(stage: .listening, outcome: .succeeded, generation: currentGeneration,
                               attemptToken: diagnosticAttemptToken))
    } catch {
      guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
      await fail(connectionFailure(for: error), generation: currentGeneration)
      return
    }

    guard isOperationCurrent(currentGeneration, operation: currentOperation) else { return }
    eventTask = Task { [weak self] in
      guard let self else { return }
      await self.consume(stream, generation: currentGeneration)
    }
    activityTask = Task { [weak self] in
      guard let self else { return }
      await self.consume(activity, generation: currentGeneration)
    }
    guard isOperationCurrent(currentGeneration, operation: currentOperation) else {
      eventTask?.cancel()
      eventTask = nil
      activityTask?.cancel()
      activityTask = nil
      return
    }
    limitTask = Task { [weak self] in
      guard let self else { return }
      await self.enforceLimits(generation: currentGeneration)
    }
  }

  private func cancelStartupIfNeeded() async {
    guard receipt == nil, !isStopping, isStartupPhase else { return }
    await finish(completion: .cancelled)
  }

  private func finishIfCancelled(generation expectedGeneration: UInt64) async -> Bool {
    guard Task.isCancelled else { return false }
    guard
      expectedGeneration == generation,
      receipt == nil,
      !isStopping,
      isStartupPhase
    else { return true }
    await finish(completion: .cancelled)
    return true
  }

  public func setMuted(_ isMuted: Bool) async {
    guard isActive, !isStopping, activePause == nil, pendingPause == nil else { return }
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
      guard case .succeeded = await confirmInputTransition(
        false,
        context: .unpaused(generation: currentGeneration, operation: currentOperation, attempt: diagnosticAttemptToken)
      ) else {
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
      guard case .succeeded = await confirmInputTransition(
        true,
        context: .unpaused(generation: currentGeneration, operation: currentOperation, attempt: diagnosticAttemptToken)
      ) else {
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
        await performBoundedTeardown { try? await self.disableInput(for: currentGeneration) }
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
    if case .appInactive = event {
      await handleLifecycleChange(.inactive)
      return
    }
    let reason: AssistantVoicePauseReason?
    switch event {
    case .interruptionBegan:
      reason = .interruption
    case .interruptionEnded:
      // Advisory only. Resume remains an explicit user action bound to the
      // matching pause epoch; never re-enable the microphone automatically.
      guard (pendingPause ?? activePause)?.reason == .interruption else {
        diagnostics.record(.init(stage: .safety, outcome: .stale, generation: generation,
                                 attemptToken: diagnosticAttemptToken, reason: .safetyInterruption))
        return
      }
      diagnostics.record(.init(stage: .safety, outcome: .succeeded, generation: generation,
                               attemptToken: diagnosticAttemptToken, reason: .safetyInterruption))
      return
    case .routeChanged(let changeReason, let previous, let current):
      reason = AssistantAudioRouteSafetyClassifier.pauseReason(
        reason: changeReason,
        previous: previous,
        current: current
      )
    case .mediaServicesLost, .mediaServicesReset:
      await audioSession.resetAfterMediaServicesReset()
      reason = .mediaServicesRestarted
    case .appInactive:
      return
    }
    guard let reason else { return }
    diagnostics.record(.init(
      stage: .safety, outcome: .started, generation: generation,
      attemptToken: diagnosticAttemptToken,
      reason: reason == .mediaServicesRestarted ? .mediaServicesRestarted : .safetyInterruption
    ))
    switch state.phase {
    case .requestingMicrophone, .readingCredential, .connecting:
      // AVAudioSession emits these notifications while this session configures
      // its own play-and-record route. Ignore only known benign changes that
      // retain microphone and output IO; an unavailable or removed route,
      // interruption, and media-service failure remain retryable failures.
      if case .routeChanged(let changeReason, let previous, let current) = event,
        isBenignStartupRouteChange(changeReason, previous: previous, current: current)
      {
        return
      }
      await terminalFailure(startupInterruptedFailure, generation: generation)
      return
    default:
      break
    }
    await pause(for: reason)
  }

  /// Accepts a concrete scene lifecycle signal from the voice surface. The
  /// microphone permission prompt can transiently make the app inactive; that
  /// is not a completed conversation and must wait for an explicit return to
  /// active before native credential or WebRTC work begins.
  public func handleLifecycleChange(_ lifecycle: RealtimeVoiceLifecycleState) async {
    lifecycleState = lifecycle
    guard isActive, !isStopping else { return }

    switch lifecycle {
    case .active:
      resumeActiveWaiterIfNeeded()
    case .inactive:
      if !isStartupPhase {
        await pause(for: .appInactive)
      }
    case .background:
      if isStartupPhase {
        await terminalFailure(startupInterruptedFailure, generation: generation)
      } else {
        await pause(for: .appInactive)
      }
    }
  }

  /// Explicitly resumes the existing peer connection. It never reconnects or
  /// chooses a fallback provider.
  public func resumeAfterSafetyPause() async {
    guard let pause = activePause,
      case .paused = state.phase,
      transportStartedGeneration == generation,
      !isStopping,
      pendingPause == nil,
      !resumeInFlight
    else { return }
    resumeInFlight = true
    resumeEpoch &+= 1
    let claimedResumeEpoch = resumeEpoch
    defer {
      if resumeEpoch == claimedResumeEpoch { resumeInFlight = false }
    }
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
      guard isResumeCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch,
        resumeEpoch: claimedResumeEpoch
      ) else {
        await performBoundedTeardown { await self.audioSession.deactivate() }
        return
      }
      audioOwnerGeneration = currentGeneration
      guard case .succeeded = await confirmInputTransition(
        true,
        context: .resume(
          generation: currentGeneration,
          operation: currentOperation,
          attempt: diagnosticAttemptToken,
          pauseEpoch: pause.epoch,
          resumeEpoch: claimedResumeEpoch
        )
      ) else {
        guard isResumeCurrent(
          generation: currentGeneration,
          operation: currentOperation,
          pauseEpoch: pause.epoch,
          resumeEpoch: claimedResumeEpoch
        ) else {
          await performBoundedTeardown { try? await self.disableInput(for: currentGeneration) }
          await releaseAudioLeaseIfOwned(generation: currentGeneration)
          return
        }
        await releaseAudioLeaseIfOwned(generation: currentGeneration)
        await terminalFailure(
          RealtimeVoiceFailure(
            code: "input_enable_failed",
            message: "Could not enable the OpenAI Voice microphone."
          ),
          generation: currentGeneration
        )
        return
      }
      guard isResumeCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch,
        resumeEpoch: claimedResumeEpoch
      ) else {
        await performBoundedTeardown { try? await self.disableInput(for: currentGeneration) }
        await releaseAudioLeaseIfOwned(generation: currentGeneration)
        return
      }
      activePause = nil
      setPhase(.listening)
    } catch {
      guard isResumeCurrent(
        generation: currentGeneration,
        operation: currentOperation,
        pauseEpoch: pause.epoch,
        resumeEpoch: claimedResumeEpoch
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
      if pendingPauseEpoch != nil || pendingPause != nil || activePause != nil {
        if case .terminate(let failure) = effects.first {
          if pendingPausedFailure == nil { pendingPausedFailure = failure }
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
    let failure = transport.terminalFailure() ?? RealtimeVoiceFailure(
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

  private func consume(
    _ stream: AsyncStream<RealtimeAudioActivitySample>,
    generation currentGeneration: UInt64
  ) async {
    for await sample in stream {
      guard isSessionCurrent(currentGeneration), !Task.isCancelled else { return }
      guard sample.generation == currentGeneration,
        sample.inputLevel.isFinite,
        sample.outputLevel.isFinite
      else { continue }
      updateVoiceActivity(inputLevel: sample.inputLevel, outputLevel: sample.outputLevel)
    }
  }

  private func pause(for reason: AssistantVoicePauseReason) async {
    guard !isStopping, activePause == nil, pendingPauseEpoch == nil else {
      diagnostics.record(.init(stage: .safety, outcome: .stale, generation: generation,
                               attemptToken: diagnosticAttemptToken, reason: .safetyInterruption))
      return
    }
    let currentGeneration = generation
    operationEpoch &+= 1
    let currentOperation = operationEpoch
    pauseEpoch &+= 1
    let pause = ActivePause(epoch: pauseEpoch, reason: reason)
    let audibleResponseID = respondingResponseID
    pendingPauseEpoch = pause.epoch
    pendingPause = pause
    synchronizeReducerState()
    defer {
      if pendingPauseEpoch == pause.epoch { pendingPauseEpoch = nil }
      if pendingPause?.epoch == pause.epoch { pendingPause = nil }
    }

    // Do not expose a resumable pause until the microphone track is confirmed
    // disabled. A safety pause with uncertain input state is terminal.
    guard case .succeeded = await confirmInputTransition(
      false,
      context: .pauseDisable(
        generation: currentGeneration,
        operation: currentOperation,
        attempt: diagnosticAttemptToken,
        pauseEpoch: pause.epoch
      )
    ) else {
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
    let responseID = state.activeResponseID
    let wasAudible = responseID.map { audibleResponseID == $0 } ?? false
    if let responseID {
      // The response can complete while the bridge confirms input disable.
      // Never cancel or finalize a stale response snapshot.
      guard isPauseCurrent(generation: currentGeneration, operation: currentOperation, pauseEpoch: pause.epoch),
            state.activeResponseID == responseID else {
        let released = await deactivateAudioAfterPauseIfOwned(
          generation: currentGeneration, operation: currentOperation, pauseEpoch: pause.epoch
        )
        if !released {
          pendingPause = nil
          await terminalFailure(RealtimeVoiceFailure(code: "audio_deactivate_timed_out", message: "Could not safely pause OpenAI Voice audio."), generation: currentGeneration)
        }
        return
      }
      await performBoundedTeardown {
        try? await self.transport.send(.responseCancel(responseID: responseID))
      }
      if wasAudible {
        guard isPauseCurrent(generation: currentGeneration, operation: currentOperation, pauseEpoch: pause.epoch),
              state.activeResponseID == responseID else { return }
        await performBoundedTeardown { try? await self.transport.send(.outputAudioBufferClear) }
      }
    }
    guard isPauseCurrent(
      generation: currentGeneration,
      operation: currentOperation,
      pauseEpoch: pause.epoch
    ) else { return }
    if let responseID, state.activeResponseID == responseID {
      reducer.finishActiveResponse(as: .cancelled)
      synchronizeReducerState()
    }
    let released = await deactivateAudioAfterPauseIfOwned(
      generation: currentGeneration, operation: currentOperation, pauseEpoch: pause.epoch
    )
    if !released {
      pendingPause = nil
      await terminalFailure(RealtimeVoiceFailure(code: "audio_deactivate_timed_out", message: "Could not safely pause OpenAI Voice audio."), generation: currentGeneration)
      return
    }
    guard isPauseCurrent(generation: currentGeneration, operation: currentOperation, pauseEpoch: pause.epoch) else { return }
    if let deferred = pendingPausedFailure {
      pendingPause = nil
      pendingPausedFailure = nil
      await terminalFailure(deferred, generation: currentGeneration)
      return
    }
    pendingPause = nil
    activePause = pause
    setPhase(.paused(reason))
  }

  private func deactivateAudioAfterPauseIfOwned(
    generation: UInt64, operation: UInt64, pauseEpoch: UInt64
  ) async -> Bool {
    guard audioOwnerGeneration == generation else { return true }
    let result = await audioSession.deactivateWithResult()
    guard result == .completed || result == .reset else { return false }
    guard isPauseCurrent(generation: generation, operation: operation, pauseEpoch: pauseEpoch) else { return false }
    audioOwnerGeneration = nil
    return true
  }

  private func fail(
    _ failure: RealtimeVoiceFailure,
    generation currentGeneration: UInt64
  ) async {
    guard isSessionCurrent(currentGeneration), receipt == nil else { return }
    if activePause != nil || pendingPause != nil {
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
    if diagnosticReason(for: failure) == .webContentProcessTerminated {
      diagnostics.record(.init(
        stage: .webProcess, outcome: .failed, generation: currentGeneration,
        attemptToken: diagnosticAttemptToken, reason: .webContentProcessTerminated
      ))
    }
    activePause = nil
    pendingPause = nil
    pendingPausedFailure = nil
    resumeInFlight = false
    reducer.markLocalFailure(failure)
    synchronizeReducerState()
    await finish(completion: .failed, failure: failure)
  }

  /// The transport owns the eight-second bridge-control deadline. The 250ms
  /// deadline remains teardown-only; it must not reject a valid control ack.
  private func confirmInputTransition(
    _ enabled: Bool, context: RealtimeVoiceInputTransitionContext
  ) async -> RealtimeVoiceInputTransitionResult {
    let expectedGeneration = context.generation
    let expectedAttempt = context.attempt
    func isCurrent() -> Bool { isInputTransitionCurrent(context) }
    guard isCurrent() else { return .cancelled }
    diagnostics.record(.init(stage: .input, outcome: .started, generation: expectedGeneration,
                             attemptToken: diagnosticAttemptToken,
                             inputDirection: enabled ? .enable : .disable))
    do {
      let lease = mintInputLease(for: expectedGeneration)
      try await transport.setInputEnabled(enabled, lease: lease)
      guard isCurrent() else { return .cancelled }
      diagnostics.record(.init(stage: .input, outcome: .succeeded, generation: expectedGeneration,
                               attemptToken: diagnosticAttemptToken,
                               inputDirection: enabled ? .enable : .disable))
      return .succeeded
    } catch is CancellationError {
      guard isCurrent() else { return .cancelled }
      diagnostics.record(.init(stage: .input, outcome: .failed, generation: expectedGeneration,
                               attemptToken: expectedAttempt, reason: .bridgeFailure,
                               inputDirection: enabled ? .enable : .disable))
      return .bridgeClosed
    } catch let error as RealtimeVoiceTransportError {
      guard isCurrent() else { return .cancelled }
      let reason: OpenAIRealtimeVoiceDiagnosticReason = switch error {
      case .controlTimedOut: .controlTimedOut
      case .bridgeClosed: .bridgeClosed
      case .bridgeFailure: .bridgeFailure
      default: .other
      }
      diagnostics.record(.init(
        stage: .input, outcome: error == .controlTimedOut ? .timedOut : .failed,
        generation: expectedGeneration, attemptToken: diagnosticAttemptToken, reason: reason,
        inputDirection: enabled ? .enable : .disable
      ))
      return error == .controlTimedOut ? .controlTimedOut : .bridgeClosed
    } catch {
      guard isCurrent() else { return .cancelled }
      diagnostics.record(.init(stage: .input, outcome: .failed, generation: expectedGeneration,
                               attemptToken: diagnosticAttemptToken, reason: .other,
                               inputDirection: enabled ? .enable : .disable))
      return .other
    }
  }

  private func releaseAudioLeaseIfOwned(generation expectedGeneration: UInt64) async {
    guard audioOwnerGeneration == expectedGeneration else { return }
    await performBoundedTeardown { await self.audioSession.deactivate() }
    if audioOwnerGeneration == expectedGeneration { audioOwnerGeneration = nil }
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
    if !didEmitTerminalDiagnostic {
      didEmitTerminalDiagnostic = true
      diagnostics.record(.init(stage: .terminal, outcome: completion == .cancelled ? .cancelled : (completion == .failed ? .failed : .succeeded), generation: generation, attemptToken: diagnosticAttemptToken, modelID: configuration.modelID, voiceID: configuration.voiceID, requestID: failure?.responseID, reason: diagnosticReason(for: failure)))
    }
    guard receipt == nil, !isStopping else { return }
    let finishingGeneration = generation
    let responseID = state.activeResponseID
    let wasAudible = responseID.map { respondingResponseID == $0 } ?? false
    // Mint the terminal fence against the final transport attempt before
    // invalidating the session generation or entering any teardown await.
    let attemptedTransport = transportAttemptGeneration == finishingGeneration
    let terminalInputLease = attemptedTransport ? mintInputLease(for: finishingGeneration) : nil
    isStopping = true
    generation &+= 1
    operationEpoch &+= 1
    let startedTransport = transportStartedGeneration == finishingGeneration
    let ownedAudio = audioOwnerGeneration == finishingGeneration
    transportAttemptGeneration = nil
    transportStartedGeneration = nil
    audioOwnerGeneration = nil
    activePause = nil
    pendingPause = nil
    pendingPauseEpoch = nil
    resumeActiveWaiterIfNeeded()
    pendingPausedFailure = nil
    respondingResponseID = nil
    eventTask?.cancel()
    eventTask = nil
    activityTask?.cancel()
    activityTask = nil
    limitTask?.cancel()
    limitTask = nil
    safetyTask?.cancel()
    safetyTask = nil
    warningMessage = nil
    setPhase(.ending)

    if attemptedTransport {
      await performBoundedTeardown {
        try? await self.transport.setInputEnabled(false, lease: terminalInputLease!)
      }
    }
    if startedTransport {
      if let responseID {
        await performBoundedTeardown { try? await self.transport.send(.responseCancel(responseID: responseID)) }
        if wasAudible {
          await performBoundedTeardown { try? await self.transport.send(.outputAudioBufferClear) }
        }
      }
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

  private func diagnosticReason(
    for failure: RealtimeVoiceFailure?
  ) -> OpenAIRealtimeVoiceDiagnosticReason? {
    guard let code = failure?.code else { return nil }
    return switch code {
    case "microphone_denied": .microphoneDenied
    case "microphone_restricted": .microphoneRestricted
    case "credential_unavailable": .credentialUnavailable
    case "audio_activate_failed", "audio_resume_failed": .audioActivationFailed
    case "input_enable_failed": .inputEnableFailed
    case "input_disable_failed": .inputDisableFailed
    case "provider_error_other": .providerErrorOther
    case "route_mismatch": .routeMismatch
    case "transport_web_content_process_terminated": .webContentProcessTerminated
    default: .other
    }
  }

  private func setPhase(_ phase: RealtimeVoicePhase) {
    reducer.setLocalPhase(phase)
    synchronizeReducerState()
  }

  /// This is the only source of microphone-input ordering tokens. It is kept
  /// separate from lifecycle and pause counters because input transitions may
  /// race even while the enclosing operation is no longer current.
  private func mintInputLease(for transportGeneration: UInt64) -> RealtimeVoiceInputLease {
    inputEpoch &+= 1
    return RealtimeVoiceInputLease(
      transportGeneration: transportGeneration,
      inputEpoch: inputEpoch
    )
  }

  private func disableInput(for transportGeneration: UInt64) async throws {
    let lease = mintInputLease(for: transportGeneration)
    try await transport.setInputEnabled(false, lease: lease)
  }

  private func synchronizeReducerState() {
    var synchronized = reducer.state
    if let pendingPause, receipt == nil, !isStopping {
      synchronized.phase = .pausing(pendingPause.reason)
      if synchronized.failure?.provenance == .provider { synchronized.failure = nil }
    } else if let activePause, receipt == nil, !isStopping {
      synchronized.phase = .paused(activePause.reason)
      if synchronized.failure?.provenance == .provider { synchronized.failure = nil }
    }
    state = synchronized
    refreshVoiceActivitySemantics()
  }

  private func updateVoiceActivity(inputLevel: Double, outputLevel: Double) {
    guard isVoiceActivityAvailable else {
      voiceActivity = .inactive
      return
    }
    if outputLevel >= Self.responseAudibilityFloor,
      let responseID = state.activeResponseID
    {
      respondingResponseID = responseID
    }
    applyVoiceActivity(inputLevel: inputLevel, outputLevel: outputLevel)
  }

  private func refreshVoiceActivitySemantics() {
    guard isVoiceActivityAvailable else {
      respondingResponseID = nil
      voiceActivity = .inactive
      return
    }
    if state.activeResponseID != respondingResponseID {
      respondingResponseID = nil
    }
    applyVoiceActivity(
      inputLevel: voiceActivity.inputLevel,
      outputLevel: voiceActivity.outputLevel
    )
  }

  private var isVoiceActivityAvailable: Bool {
    guard receipt == nil, !isStopping, activePause == nil, pendingPause == nil else { return false }
    return switch state.phase {
    case .listening, .userSpeaking, .responding, .assistantSpeaking:
      true
    default:
      false
    }
  }

  private func applyVoiceActivity(inputLevel: Double, outputLevel: Double) {
    let activeResponseID = state.activeResponseID
    let isResponding = activeResponseID != nil && activeResponseID == respondingResponseID
    voiceActivity = VoiceActivitySnapshot(
      isListening: isVoiceActivityAvailable,
      isPreparingResponse: activeResponseID != nil,
      isResponding: isResponding,
      inputLevel: inputLevel,
      outputLevel: outputLevel
    )
  }

  private func isSessionCurrent(_ expectedGeneration: UInt64) -> Bool {
    expectedGeneration == generation && receipt == nil && !isStopping
  }

  private var isStartupPhase: Bool {
    switch state.phase {
    case .requestingMicrophone, .readingCredential, .connecting:
      true
    default:
      false
    }
  }

  private var startupInterruptedFailure: RealtimeVoiceFailure {
    RealtimeVoiceFailure(
      code: "startup_interrupted",
      message: "OpenAI Voice was interrupted while starting. Try again when Enchiridion is active."
    )
  }

  private func connectionFailure(for error: Error) -> RealtimeVoiceFailure {
    let message: String
    let code: String
    let requestID: String?
    switch error {
    case RealtimeSessionBootstrapError.rejected(let statusCode, let identifier):
      code = "bootstrap_http_\(statusCode)"
      requestID = identifier
      switch statusCode {
      case 401, 403:
        message = "OpenAI rejected the voice request. Re-verify the Platform key in Assistant Settings."
      case 429:
        message = "OpenAI is rate-limiting voice requests. Wait a moment, then try again."
      case 400..<500:
        message = "OpenAI rejected the voice setup (HTTP \(statusCode)). Check the selected model and voice."
      default:
        message = "OpenAI could not start the voice session (HTTP \(statusCode)). Try again shortly."
      }
    case RealtimeSessionBootstrapError.connectionFailed:
      code = "bootstrap_network"
      requestID = nil
      message = "Could not reach OpenAI Voice. Check your network connection, then try again."
    case RealtimeSessionBootstrapError.invalidAnswer:
      code = "bootstrap_answer"
      requestID = nil
      message = "OpenAI returned an invalid voice connection response. Try again."
    case RealtimeSessionBootstrapError.invalidEndpoint, RealtimeSessionBootstrapError.redirectBlocked:
      code = "bootstrap_endpoint"
      requestID = nil
      message = "The OpenAI Voice endpoint was rejected. Open Assistant Settings and verify the route."
    case RealtimeSessionBootstrapError.invalidHTTPResponse, RealtimeSessionBootstrapError.responseTooLarge:
      code = "bootstrap_response"
      requestID = nil
      message = "OpenAI returned an unusable voice connection response. Try again."
    case RealtimeVoiceTransportError.bridgeFailure:
      code = "webrtc_bridge_failure"
      requestID = nil
      message = "The local OpenAI Voice WebRTC bridge failed while starting. Try again."
    case RealtimeVoiceTransportError.bridgeClosed:
      code = "webrtc_bridge_closed"
      requestID = nil
      message = "The OpenAI Voice WebRTC bridge closed while starting. Try again."
    case RealtimeVoiceTransportError.controlTimedOut:
      code = "webrtc_control_timeout"
      requestID = nil
      message = "OpenAI Voice timed out while configuring WebRTC. Try again."
    case RealtimeVoiceTransportError.handshakeTimedOut:
      code = "webrtc_handshake_timeout"
      requestID = nil
      message = "OpenAI Voice timed out waiting for the WebRTC connection. Try again."
    case RealtimeVoiceTransportError.unavailable:
      code = "webrtc_unavailable"
      requestID = nil
      message = "OpenAI Voice is already starting or unavailable. Try again."
    default:
      code = "bootstrap_unknown"
      requestID = nil
      message = "Could not connect to OpenAI Voice. Try again."
    }
    let diagnostic = requestID.map { " Request ID: \($0)." } ?? ""
    return RealtimeVoiceFailure(code: code, message: message + diagnostic, responseID: requestID)
  }

  private func isBenignStartupRouteChange(
    _ reason: AssistantAudioRouteChangeReason,
    previous: AssistantAudioRouteSnapshot?,
    current: AssistantAudioRouteSnapshot
  ) -> Bool {
    guard current.hasRequiredVoiceIO else { return false }
    return switch reason {
    case .categoryChange, .newDeviceAvailable, .override, .wakeFromSleep:
      true
    case .routeConfigurationChange:
      // A configuration update while retaining the same public route is a
      // normal part of configuring WebRTC. Do not mask a private/external
      // output disappearing into the built-in speaker or receiver.
      previous?.outputs.contains(where: isPrivateOrExternalOutput) != true
    case .unknown, .oldDeviceUnavailable, .noSuitableRoute:
      false
    }
  }

  private func isPrivateOrExternalOutput(_ port: AssistantAudioPort) -> Bool {
    port != .builtInReceiver && port != .builtInSpeaker
  }

  private func waitForActiveDuringStartup(
    generation expectedGeneration: UInt64,
    operation expectedOperation: UInt64
  ) async -> Bool {
    if await finishIfCancelled(generation: expectedGeneration) { return false }
    guard
      isOperationCurrent(expectedGeneration, operation: expectedOperation)
    else { return false }
    guard lifecycleState != .background else {
      await terminalFailure(startupInterruptedFailure, generation: expectedGeneration)
      return false
    }
    guard lifecycleState == .inactive else { return true }
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        guard
          !Task.isCancelled,
          isOperationCurrent(expectedGeneration, operation: expectedOperation),
          lifecycleState == .inactive
        else {
          continuation.resume()
          return
        }
        activeWaiter = ActiveWaiter(
          generation: expectedGeneration,
          operation: expectedOperation,
          continuation: continuation
        )
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        await self?.cancelActiveWaiter(
          generation: expectedGeneration,
          operation: expectedOperation
        )
      }
    }
    return !Task.isCancelled
      && isOperationCurrent(expectedGeneration, operation: expectedOperation)
      && lifecycleState == .active
  }

  private func cancelActiveWaiter(
    generation expectedGeneration: UInt64,
    operation expectedOperation: UInt64
  ) async {
    guard
      let waiter = activeWaiter,
      waiter.generation == expectedGeneration,
      waiter.operation == expectedOperation
    else { return }
    activeWaiter = nil
    waiter.continuation.resume()
    await finish(completion: .cancelled)
  }

  private func resumeActiveWaiterIfNeeded() {
    guard let waiter = activeWaiter else { return }
    activeWaiter = nil
    // A superseded waiter cannot control a newer session, but must still be
    // released so a cancelled start never remains suspended.
    guard waiter.generation == generation || receipt != nil || isStopping else {
      waiter.continuation.resume()
      return
    }
    waiter.continuation.resume()
  }

  private func isOperationCurrent(
    _ expectedGeneration: UInt64,
    operation expectedOperation: UInt64
  ) -> Bool {
    !Task.isCancelled
      && isSessionCurrent(expectedGeneration)
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
      && (activePause?.epoch == expectedPauseEpoch || pendingPause?.epoch == expectedPauseEpoch)
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

  private func isResumeCurrent(
    generation expectedGeneration: UInt64,
    operation expectedOperation: UInt64,
    pauseEpoch expectedPauseEpoch: UInt64,
    resumeEpoch expectedResumeEpoch: UInt64
  ) -> Bool {
    !Task.isCancelled
      && isSessionCurrent(expectedGeneration)
      && expectedOperation == operationEpoch
      && activePause?.epoch == expectedPauseEpoch
      && pendingPause == nil
      && resumeInFlight
      && resumeEpoch == expectedResumeEpoch
  }

  private func isInputTransitionCurrent(_ context: RealtimeVoiceInputTransitionContext) -> Bool {
    guard !Task.isCancelled,
      isSessionCurrent(context.generation),
      context.operation == operationEpoch,
      diagnosticAttemptToken == context.attempt
    else { return false }

    switch context {
    case .unpaused:
      return activePause == nil && pendingPause == nil
    case .pauseDisable(_, _, _, let pauseEpoch):
      return activePause == nil
        && pendingPause?.epoch == pauseEpoch
        && pendingPauseEpoch == pauseEpoch
    case .resume(_, _, _, let pauseEpoch, let resumeEpoch):
      return activePause?.epoch == pauseEpoch
        && pendingPause == nil
        && resumeInFlight
        && self.resumeEpoch == resumeEpoch
    }
  }

}

private enum RealtimeVoiceInputTransitionContext: Sendable {
  case unpaused(
    generation: UInt64,
    operation: UInt64,
    attempt: OpenAIRealtimeVoiceAttemptToken?
  )
  case pauseDisable(
    generation: UInt64,
    operation: UInt64,
    attempt: OpenAIRealtimeVoiceAttemptToken?,
    pauseEpoch: UInt64
  )
  case resume(
    generation: UInt64,
    operation: UInt64,
    attempt: OpenAIRealtimeVoiceAttemptToken?,
    pauseEpoch: UInt64,
    resumeEpoch: UInt64
  )

  var generation: UInt64 {
    switch self {
    case .unpaused(let generation, _, _),
      .pauseDisable(let generation, _, _, _),
      .resume(let generation, _, _, _, _): generation
    }
  }

  var operation: UInt64 {
    switch self {
    case .unpaused(_, let operation, _),
      .pauseDisable(_, let operation, _, _),
      .resume(_, let operation, _, _, _): operation
    }
  }

  var attempt: OpenAIRealtimeVoiceAttemptToken? {
    switch self {
    case .unpaused(_, _, let attempt),
      .pauseDisable(_, _, let attempt, _),
      .resume(_, _, let attempt, _, _): attempt
    }
  }
}

private enum RealtimeVoiceInputTransitionResult: Equatable, Sendable {
  case succeeded, cancelled, controlTimedOut, bridgeClosed, other
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
