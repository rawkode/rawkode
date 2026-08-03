import EnchiridionCore
import Foundation

/// Native orchestration for the intentionally narrow WebRTC bridge. WebKit owns
/// media plumbing only: the API credential is consumed by `bootstrap` on the
/// native side and is never serialised into JavaScript.
@MainActor
final class RealtimeWebRTCVoiceTransport: RealtimeVoiceTransport {
  private enum TransportError: Error {
    case bridgeClosed
    case bridgeFailure
    case controlTimedOut
    case handshakeTimedOut
    case unavailable
  }

  private struct ActiveAttempt: Equatable {
    let identifier: UUID
    let generation: UInt64
  }

  private enum Lifecycle: Equatable {
    case idle
    case starting(UUID)
    case active(ActiveAttempt)
    case closed
  }

  private struct EstablishedHandshake {
    let session: RealtimeSessionCreated
    let bufferedEvents: [RealtimeServerEvent]
  }

  /// A single local pump owns the mutable AsyncStream iterator. Consumers use
  /// this bounded mailbox instead, so no mutable iterator crosses an actor
  /// suspension point or has more than one reader.
  actor BridgeEventQueue {
    private static let maximumBufferedControlEvents = 256

    private var controlEvents: [RealtimeWebRTCBridgeEvent] = []
    private var waiter: CheckedContinuation<RealtimeWebRTCBridgeEvent?, Never>?
    private var isFinished = false
    private var pumpTask: Task<Void, Never>?
    private let activityEvents: AsyncStream<RealtimeWebRTCBridgeEvent>
    private let activityContinuation: AsyncStream<RealtimeWebRTCBridgeEvent>.Continuation

    init() {
      let stream = AsyncStream<RealtimeWebRTCBridgeEvent>.makeStream(
        bufferingPolicy: .bufferingNewest(1)
      )
      activityEvents = stream.stream
      activityContinuation = stream.continuation
    }

    func start(stream: AsyncStream<RealtimeWebRTCBridgeEvent>) {
      guard pumpTask == nil, !isFinished else { return }
      pumpTask = Task { [weak self] in
        for await event in stream {
          guard let self, await self.enqueue(event) else { return }
        }
        await self?.finish()
      }
    }

    /// Narrow test seam: exercises the same pre-FIFO demultiplexing used by
    /// the single bridge stream pump without exposing transport lifecycle.
    func feedForTesting(_ event: RealtimeWebRTCBridgeEvent) -> Bool {
      enqueue(event)
    }

    func next() async -> RealtimeWebRTCBridgeEvent? {
      if !controlEvents.isEmpty {
        return controlEvents.removeFirst()
      }
      guard !isFinished else { return nil }
      return await withCheckedContinuation { continuation in
        precondition(waiter == nil, "Realtime bridge event queue has multiple readers")
        waiter = continuation
      }
    }

    func activity() -> AsyncStream<RealtimeWebRTCBridgeEvent> {
      activityEvents
    }

    func finish() {
      guard !isFinished else { return }
      isFinished = true
      pumpTask?.cancel()
      pumpTask = nil
      controlEvents.removeAll()
      activityContinuation.finish()
      let waiter = waiter
      self.waiter = nil
      waiter?.resume(returning: nil)
    }

    private func enqueue(_ event: RealtimeWebRTCBridgeEvent) -> Bool {
      guard !isFinished else { return false }
      // Metering never enters the control mailbox or wakes its waiter. The
      // newest-only stream is visual-only and cannot delay handshake/control.
      if case .audioActivity = event {
        activityContinuation.yield(event)
        return true
      }
      if let waiter {
        self.waiter = nil
        waiter.resume(returning: event)
        return true
      }
      guard controlEvents.count < Self.maximumBufferedControlEvents else {
        finish()
        return false
      }
      controlEvents.append(event)
      return true
    }
  }

  /// An unstructured deadline race intentionally does not wait for an
  /// uncooperative WKWebView operation after cancellation. The bridge is
  /// destroyed immediately by the caller that receives the timeout.
  @MainActor
  private final class DeadlineRace<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, Error>?
    private var operationTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var isResolved = false

    func begin(
      continuation: CheckedContinuation<Value, Error>,
      duration: Duration,
      timeoutError: TransportError,
      operation: @escaping @MainActor () async throws -> Value
    ) {
      self.continuation = continuation
      operationTask = Task { @MainActor [weak self] in
        do {
          let value = try await operation()
          self?.resolve(.success(value))
        } catch {
          self?.resolve(.failure(error))
        }
      }
      timeoutTask = Task { @MainActor [weak self] in
        do {
          try await Task.sleep(for: duration)
        } catch {
          return
        }
        self?.resolve(.failure(timeoutError))
      }
    }

    func cancel() {
      resolve(.failure(CancellationError()))
    }

    private func resolve(_ result: Result<Value, Error>) {
      guard !isResolved else { return }
      isResolved = true
      operationTask?.cancel()
      timeoutTask?.cancel()
      operationTask = nil
      timeoutTask = nil
      let continuation = continuation
      self.continuation = nil
      continuation?.resume(with: result)
    }
  }

  private static let handshakeDeadline: Duration = .seconds(30)
  private static let bridgeControlDeadline: Duration = .seconds(8)
  private static let teardownDeadline: Duration = .seconds(2)

  private let bridge: any RealtimeWebRTCBridging
  private let bootstrap: any RealtimeSessionBootstrap
  private let codec: RealtimeProtocolCodec
  private let serverEvents: AsyncStream<RealtimeServerEvent>
  private let serverEventContinuation: AsyncStream<RealtimeServerEvent>.Continuation
  private let audioActivity: AsyncStream<RealtimeAudioActivitySample>
  private let audioActivityContinuation: AsyncStream<RealtimeAudioActivitySample>.Continuation

  private var lifecycle: Lifecycle = .idle
  private var bridgeConsumptionTask: Task<Void, Never>?
  private var bridgeActivityTask: Task<Void, Never>?
  private var eventQueue: BridgeEventQueue?

  init(
    bridge: any RealtimeWebRTCBridging = RealtimeWebRTCBridge(),
    bootstrap: any RealtimeSessionBootstrap = DirectBYOKBootstrap.personalDevelopment(),
    codec: RealtimeProtocolCodec = RealtimeProtocolCodec()
  ) {
    self.bridge = bridge
    self.bootstrap = bootstrap
    self.codec = codec
    let stream = AsyncStream<RealtimeServerEvent>.makeStream()
    serverEvents = stream.stream
    serverEventContinuation = stream.continuation
    let activity = AsyncStream<RealtimeAudioActivitySample>.makeStream(
      bufferingPolicy: .bufferingNewest(1)
    )
    audioActivity = activity.stream
    audioActivityContinuation = activity.continuation
  }

  deinit {
    bridgeConsumptionTask?.cancel()
    bridgeActivityTask?.cancel()
    serverEventContinuation.finish()
    audioActivityContinuation.finish()
  }

  func start(
    generation: UInt64,
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    credential: RealtimeCredentialLease
  ) async throws -> RealtimeSessionCreated {
    guard case .idle = lifecycle, RealtimeVoiceDevelopmentRoute.isEnabled else {
      throw TransportError.unavailable
    }
    let attempt = UUID()
    lifecycle = .starting(attempt)
    let eventQueue = BridgeEventQueue()
    self.eventQueue = eventQueue
    await eventQueue.start(stream: bridge.events())

    do {
      let handshake = try await withDeadline(
        Self.handshakeDeadline,
        timeoutError: .handshakeTimedOut
      ) { [weak self] in
        guard let self else { throw TransportError.bridgeClosed }
        return try await self.performHandshake(
          attempt: attempt,
          eventQueue: eventQueue,
          generation: generation,
          route: route,
          configuration: configuration,
          credential: credential
        )
      }
      try requireStarting(attempt)
      let active = ActiveAttempt(identifier: attempt, generation: generation)
      lifecycle = .active(active)
      for event in handshake.bufferedEvents {
        serverEventContinuation.yield(event)
      }
      beginConsumingRemainingBridgeEvents(eventQueue, active: active)
      beginConsumingActivity(eventQueue, active: active)
      return handshake.session
    } catch {
      await terminate()
      throw error
    }
  }

  func events() -> AsyncStream<RealtimeServerEvent> {
    serverEvents
  }

  func activity() -> AsyncStream<RealtimeAudioActivitySample> {
    audioActivity
  }

  func send(_ command: RealtimeClientCommand) async throws {
    let active = try requireActive()
    let encoded = try codec.encode(command)
    do {
      try await bridgeControl {
        try await self.bridge.sendEvent(encoded, generation: active.generation)
      }
      try requireActive(active)
    } catch {
      await terminate()
      throw error
    }
  }

  func setInputEnabled(_ enabled: Bool) async throws {
    let active = try requireActive()
    do {
      try await bridgeControl {
        try await self.bridge.setInputEnabled(enabled, generation: active.generation)
      }
      try requireActive(active)
    } catch {
      await terminate()
      throw error
    }
  }

  func close() async {
    await terminate()
  }

  private func performHandshake(
    attempt: UUID,
    eventQueue: BridgeEventQueue,
    generation: UInt64,
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    credential: RealtimeCredentialLease
  ) async throws -> EstablishedHandshake {
    try requireStarting(attempt)
    try bridge.load()
    try await waitForReady(eventQueue, attempt: attempt)

    try requireStarting(attempt)
    let capability = try RealtimeWebRTCBridgeAuthorization.issue(
      generation: generation,
      route: route,
      credential: credential
    )
    try await bridgeControl {
      try await self.bridge.authorize(capability, generation: generation)
    }

    try requireStarting(attempt)
    try await bridgeControl {
      try await self.bridge.start(generation: generation)
    }
    let offer = try await waitForOffer(eventQueue, attempt: attempt, generation: generation)

    try requireStarting(attempt)
    let bootstrapResult = try await bootstrap.bootstrap(
      offerSDP: offer,
      route: route,
      configuration: configuration,
      credential: credential
    )

    try requireStarting(attempt)
    try await bridgeControl {
      try await self.bridge.applyAnswer(bootstrapResult.answerSDP, generation: generation)
    }
    return try await waitForEstablishedSession(
      eventQueue,
      attempt: attempt,
      generation: generation,
      configuration: configuration,
      requestID: bootstrapResult.requestID
    )
  }

  private func waitForReady(
    _ eventQueue: BridgeEventQueue,
    attempt: UUID
  ) async throws {
    while let event = await eventQueue.next() {
      try requireStarting(attempt)
      switch event {
      case .ready:
        return
      case .failure:
        throw TransportError.bridgeFailure
      default:
        continue
      }
    }
    throw TransportError.bridgeClosed
  }

  private func waitForOffer(
    _ eventQueue: BridgeEventQueue,
    attempt: UUID,
    generation: UInt64
  ) async throws -> String {
    while let event = await eventQueue.next() {
      try requireStarting(attempt)
      switch event {
      case let .offer(eventGeneration, sdp) where eventGeneration == generation:
        return sdp
      case let .failure(eventGeneration, _) where eventGeneration == generation:
        throw TransportError.bridgeFailure
      case let .connectionState(eventGeneration, state)
        where eventGeneration == generation && (state == "failed" || state == "closed"):
        throw TransportError.bridgeFailure
      default:
        continue
      }
    }
    throw TransportError.bridgeClosed
  }

  private func waitForEstablishedSession(
    _ eventQueue: BridgeEventQueue,
    attempt: UUID,
    generation: UInt64,
    configuration: RealtimeVoiceConfiguration,
    requestID: String?
  ) async throws -> EstablishedHandshake {
    var answerApplied = false
    var dataChannelOpen = false
    var established: RealtimeSessionCreated?
    var bufferedEvents: [RealtimeServerEvent] = []

    while let event = await eventQueue.next() {
      try requireStarting(attempt)
      switch event {
      case let .answerApplied(eventGeneration) where eventGeneration == generation:
        answerApplied = true
      case let .dataChannelState(eventGeneration, "open") where eventGeneration == generation:
        dataChannelOpen = true
      case let .serverEvent(eventGeneration, json) where eventGeneration == generation:
        guard let decoded = try codec.decode(json) else { continue }
        if case let .sessionCreated(created) = decoded.payload {
          try configuration.validateActual(modelID: created.modelID, voiceID: created.voiceID)
          established = RealtimeSessionCreated(
            sessionID: created.sessionID,
            modelID: created.modelID,
            voiceID: created.voiceID,
            requestID: requestID
          )
        } else {
          bufferedEvents.append(decoded)
        }
      case let .failure(eventGeneration, _) where eventGeneration == generation:
        throw TransportError.bridgeFailure
      case let .dataChannelState(eventGeneration, "closed") where eventGeneration == generation:
        throw TransportError.bridgeFailure
      case let .connectionState(eventGeneration, state)
        where eventGeneration == generation && (state == "failed" || state == "closed"):
        throw TransportError.bridgeFailure
      default:
        continue
      }

      if answerApplied, dataChannelOpen, let established {
        return EstablishedHandshake(session: established, bufferedEvents: bufferedEvents)
      }
    }
    throw TransportError.bridgeClosed
  }

  private func beginConsumingRemainingBridgeEvents(
    _ eventQueue: BridgeEventQueue,
    active: ActiveAttempt
  ) {
    bridgeConsumptionTask = Task { @MainActor [weak self] in
      guard let self else { return }
      while let event = await eventQueue.next(), !Task.isCancelled {
        guard self.isActive(active) else { return }
        switch event {
        case let .serverEvent(eventGeneration, json) where eventGeneration == active.generation:
          do {
            if let decoded = try self.codec.decode(json) {
              if case .sessionCreated = decoded.payload {
                continue
              }
              self.serverEventContinuation.yield(decoded)
            }
          } catch {
            await self.terminate()
            return
          }
        case let .failure(eventGeneration, _) where eventGeneration == active.generation:
          await self.terminate()
          return
        case let .dataChannelState(eventGeneration, state)
          where eventGeneration == active.generation && state != "open":
          await self.terminate()
          return
        case let .connectionState(eventGeneration, state)
          where eventGeneration == active.generation && (state == "failed" || state == "closed"):
          await self.terminate()
          return
        default:
          continue
        }
      }
      if self.isActive(active) {
        await self.terminate()
      }
    }
  }

  private func beginConsumingActivity(
    _ eventQueue: BridgeEventQueue,
    active: ActiveAttempt
  ) {
    bridgeActivityTask = Task { @MainActor [weak self] in
      guard let self else { return }
      for await event in await eventQueue.activity() {
        guard !Task.isCancelled, self.isActive(active) else { return }
        guard case let .audioActivity(generation, inputLevel, outputLevel) = event,
          generation == active.generation
        else { continue }
        self.audioActivityContinuation.yield(
          RealtimeAudioActivitySample(
            generation: generation,
            inputLevel: inputLevel,
            outputLevel: outputLevel
          )
        )
      }
    }
  }

  private func bridgeControl(
    _ operation: @escaping @MainActor () async throws -> Void
  ) async throws {
    try await withDeadline(
      Self.bridgeControlDeadline,
      timeoutError: .controlTimedOut,
      operation: operation
    )
  }

  private func withDeadline<Value: Sendable>(
    _ duration: Duration,
    timeoutError: TransportError,
    operation: @escaping @MainActor () async throws -> Value
  ) async throws -> Value {
    let race = DeadlineRace<Value>()
    return try await withTaskCancellationHandler(
      operation: {
        try await withCheckedThrowingContinuation { continuation in
          race.begin(
            continuation: continuation,
            duration: duration,
            timeoutError: timeoutError,
            operation: operation
          )
        }
      },
      onCancel: {
        Task { @MainActor in race.cancel() }
      }
    )
  }

  private func requireStarting(_ attempt: UUID) throws {
    try Task.checkCancellation()
    guard case .starting(let currentAttempt) = lifecycle, currentAttempt == attempt else {
      throw TransportError.bridgeClosed
    }
  }

  private func requireActive() throws -> ActiveAttempt {
    try Task.checkCancellation()
    guard case .active(let active) = lifecycle else { throw TransportError.bridgeClosed }
    return active
  }

  private func requireActive(_ expected: ActiveAttempt) throws {
    try Task.checkCancellation()
    guard isActive(expected) else { throw TransportError.bridgeClosed }
  }

  private func isActive(_ expected: ActiveAttempt) -> Bool {
    guard case .active(let active) = lifecycle else { return false }
    return active == expected
  }

  private func terminate() async {
    guard lifecycle != .closed else { return }
    let activeGeneration: UInt64? = if case let .active(active) = lifecycle {
      active.generation
    } else {
      nil
    }
    lifecycle = .closed
    bridgeConsumptionTask?.cancel()
    bridgeConsumptionTask = nil
    bridgeActivityTask?.cancel()
    bridgeActivityTask = nil
    let eventQueue = eventQueue
    self.eventQueue = nil
    await eventQueue?.finish()
    serverEventContinuation.finish()
    if let activeGeneration {
      audioActivityContinuation.yield(
        RealtimeAudioActivitySample(generation: activeGeneration, inputLevel: 0, outputLevel: 0)
      )
    }
    audioActivityContinuation.finish()
    _ = try? await withDeadline(
      Self.teardownDeadline,
      timeoutError: .controlTimedOut
    ) {
      await self.bridge.stop()
    }
  }
}

enum RealtimeVoiceDevelopmentRoute {
  #if DEBUG
    static let isEnabled = true
  #else
    static let isEnabled = false
  #endif
}
