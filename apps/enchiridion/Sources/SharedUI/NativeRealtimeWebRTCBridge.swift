#if DEBUG && os(iOS)
  import AVFoundation
  import EnchiridionCore
  import Foundation
  @preconcurrency import LiveKitWebRTC

  struct NativeBridgeToken: Sendable, Hashable { let generation: UInt64; let epoch: UInt64 }
  enum NativeBridgeReason: String, Sendable { case bridgeFailed = "bridge_failed", peerTerminal = "peer_terminal", peerUnknown = "peer_unknown", channelTerminal = "channel_terminal", channelUnknown = "channel_unknown", eventOverflow = "event_overflow" }
  private struct NativeSessionDescription: Sendable { enum Kind: Sendable { case offer, answer }; let kind: Kind; let sdp: String }
  /// A terminal is observed by several independently-cancellable tasks.  This
  /// deliberately broadcasts completion instead of retaining a single waiter.
  final class NativeRelayCompletion: @unchecked Sendable {
    private let lock = NSLock(); private var finished = false; private var waiters: [CheckedContinuation<Void, Never>] = []
    func finish() { lock.lock(); guard !finished else { lock.unlock(); return }; finished = true; let values = waiters; waiters.removeAll(); lock.unlock(); values.forEach { $0.resume() } }
    func wait() async { await withCheckedContinuation { continuation in lock.lock(); if finished { lock.unlock(); continuation.resume() } else { waiters.append(continuation); lock.unlock() } } }
  }

  /// Schedules the retained MainActor terminal driver. Production uses the
  /// standard task; tests can hold the exact action without substituting the
  /// bridge's terminal path.
  final class NativeTerminalDriverScheduler: @unchecked Sendable {
    typealias Action = @MainActor @Sendable () async -> Void
    private let schedule: @Sendable (@escaping Action) -> Task<Void, Never>
    init(schedule: @escaping @Sendable (@escaping Action) -> Task<Void, Never> = { action in Task { @MainActor in await action() } }) { self.schedule = schedule }
    func submit(_ action: @escaping Action) -> Task<Void, Never> { schedule(action) }
  }

  /// A production-used cleanup boundary. It is intentionally before resource
  /// release so a cancelled retained driver still has to complete its ticket.
  final class NativeTerminalCleanupOperation: @unchecked Sendable {
    private let perform: @Sendable () async -> Void
    init(perform: @escaping @Sendable () async -> Void = {}) { self.perform = perform }
    func run() async { await perform() }
  }

  /// The sole producer-facing authority for native callback facts. It makes a
  /// terminal ticket immutable before a driver can be scheduled and keeps the
  /// coordinator -> relay lock order for control overflow.
  private final class NativeBridgeIngress: @unchecked Sendable {
    enum Event {
      case terminal(NativeBridgeReason?)
      case control(RealtimeWebRTCBridgeEvent)
      case activity(RealtimeWebRTCBridgeEvent)
    }
    enum Result: Sendable {
      case accepted
      case driver(NativeBridgeLifecycleCoordinator.TerminalTicket)
      case join(NativeBridgeLifecycleCoordinator.TerminalTicket)
      case rejected
    }
    private let coordinator: NativeBridgeLifecycleCoordinator
    private let relay: NativeRealtimeWebRTCEventRelay
    init(coordinator: NativeBridgeLifecycleCoordinator, relay: NativeRealtimeWebRTCEventRelay) { self.coordinator = coordinator; self.relay = relay }
    func submit(_ token: NativeBridgeToken, _ event: Event) -> Result {
      switch event {
      case let .terminal(reason):
        switch coordinator.reserveAndClaimTerminal(token, failure: reason?.rawValue) {
        case let .driver(ticket): return .driver(ticket)
        case let .join(ticket): return .join(ticket)
        case .none: return .rejected
        }
      case let .control(event):
        switch coordinator.ingestControl(token, event, relay: relay) {
        case .accepted: return .accepted
        case let .driver(ticket): return .driver(ticket)
        case .rejected: return .rejected
        }
      case let .activity(event):
        return coordinator.ingestActivity(token, event, relay: relay) ? .accepted : .rejected
      }
    }
  }

  @MainActor
  final class NativeRealtimeWebRTCBridge: NSObject, RealtimeWebRTCBridging {
    private enum State: Equatable { case idle, loading(UInt64), active(NativeBridgeToken), terminal, stopped }
    private final class ResourceSnapshot: @unchecked Sendable {
      let peer: LKRTCPeerConnection; let transceiver: LKRTCRtpTransceiver; let channel: LKRTCDataChannel; let peerProxy: NativePeerProxy; let channelProxy: NativeChannelProxy
      init(peer: LKRTCPeerConnection, transceiver: LKRTCRtpTransceiver, channel: LKRTCDataChannel, peerProxy: NativePeerProxy, channelProxy: NativeChannelProxy) { self.peer = peer; self.transceiver = transceiver; self.channel = channel; self.peerProxy = peerProxy; self.channelProxy = channelProxy }
    }
    private enum ResourceState { case empty; case owned(NativeBridgeToken, ResourceSnapshot); case claimed(NativeBridgeToken) }
    private static let maximumSDPBytes = 128 * 1024
    private static let deadline = Duration.seconds(6)
    private let factory = LKRTCPeerConnectionFactory()
    private let coordinator = NativeBridgeLifecycleCoordinator()
    private let relay = NativeRealtimeWebRTCEventRelay()
    private let ingress: NativeBridgeIngress
    private let terminalDriverScheduler: NativeTerminalDriverScheduler
    private let terminalCleanupOperation: NativeTerminalCleanupOperation
    private var lifecycle = RealtimeWebRTCBridgeLifecycleState()
    private var state: State = .idle
    private var nextLoadNonce: UInt64 = 0
    private var resources: ResourceState = .empty
    private var authorization = RealtimeWebRTCBridgeAuthorizationState()
    private var inputSource: LKRTCAudioSource?
    private var inputTrack: LKRTCAudioTrack?
    private var newestLease: RealtimeVoiceInputLease?
    private var terminalDriverTask: Task<Void, Never>?
    init(terminalDriverScheduler: NativeTerminalDriverScheduler = .init(), terminalCleanupOperation: NativeTerminalCleanupOperation = .init()) {
      self.terminalDriverScheduler = terminalDriverScheduler
      self.terminalCleanupOperation = terminalCleanupOperation
      self.ingress = NativeBridgeIngress(coordinator: coordinator, relay: relay)
    }
    func load() throws {
      guard case .idle = state, lifecycle.currentEpoch != nil, nextLoadNonce < .max else { throw RealtimeVoiceTransportError.bridgeClosed }
      nextLoadNonce += 1
      state = .loading(nextLoadNonce)
      relay.storeReady(nextLoadNonce)
    }

    func authorize(_ capability: RealtimeWebRTCBridgeAuthorization, generation: UInt64) async throws {
      guard case let .loading(nonce) = state, let epoch = lifecycle.beginAuthorization(), capability.authorizes(generation: generation) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let token = NativeBridgeToken(generation: generation, epoch: epoch)
      authorization.revoke()
      do { try authorization.activate(capability, generation: generation) } catch { throw RealtimeVoiceTransportError.bridgeClosed }
      guard relay.bind(token, nonce: nonce) else { authorization.revoke(); state = .terminal; throw RealtimeVoiceTransportError.bridgeClosed }
      state = .active(token)
    }

    func events() -> AsyncStream<RealtimeWebRTCBridgeEvent> { relay.stream() }

    func start(generation: UInt64) async throws {
      guard case let .active(token) = state, token.generation == generation, authorization.authorizes(generation: generation) else { throw RealtimeVoiceTransportError.bridgeClosed }
      guard coordinator.beginPreinstall(token) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let configuration = LKRTCConfiguration(); configuration.sdpSemantics = .unifiedPlan
      let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
      let route = makeIngressRouter()
      // Proxies are deliberately constructed disarmed. No SDK callback is
      // allowed to observe a staged peer before this snapshot is owned.
      let proxy = NativePeerProxy(token: token, coordinator: coordinator, ingress: ingress, route: route, armed: false)
      guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: proxy) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let transceiverInit = LKRTCRtpTransceiverInit(); transceiverInit.direction = .sendRecv
      guard let transceiver = peer.addTransceiver(of: .audio, init: transceiverInit), transceiver.sender.track == nil else { peer.close(); throw RealtimeVoiceTransportError.bridgeClosed }
      let channelConfiguration = LKRTCDataChannelConfiguration(); channelConfiguration.isOrdered = true
      guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfiguration) else { peer.close(); throw RealtimeVoiceTransportError.bridgeClosed }
      let channelProxy = NativeChannelProxy(token: token, ingress: ingress, route: route, armed: false)
      let snapshot = ResourceSnapshot(peer: peer, transceiver: transceiver, channel: channel, peerProxy: proxy, channelProxy: channelProxy)
      guard installOwned(token, snapshot), coordinator.install(token, snapshot: snapshot) else { channel.close(); peer.close(); throw RealtimeVoiceTransportError.bridgeClosed }
      // A terminal observed while the SDK was constructing the peer wins over
      // every later callback and over offer generation.
      let preinstallTerminal = proxy.arm()
      let channelTerminal = channelProxy.arm()
      channel.delegate = channelProxy
      if let result = preinstallTerminal ?? channelTerminal { await awaitTerminalResult(result); throw RealtimeVoiceTransportError.bridgeClosed }
      // Callback facts were staged while the peer was not yet owned. The
      // fence only becomes visible after terminal priority has been decided.
      coordinator.activateCallbacks(token)
      proxy.replayStagedCallbacks()
      guard owns(token, snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let clock = ContinuousClock(); let start = clock.now
      do {
        let offerGate = NativeRealtimeWebRTCOperationGate<NativeSessionDescription>()
        coordinator.register(offerGate, token: token, snapshot: snapshot)
        guard coordinator.admit(token, snapshot: snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
        peer.offer(for: constraints) { description, _ in
          guard let description, description.sdp.utf8.count <= Self.maximumSDPBytes else { offerGate.fail(); return }
          offerGate.succeed(.init(kind: .offer, sdp: description.sdp))
        }
        coordinator.release()
        let offer = try await offerGate.wait(timeout: Self.remaining(from: start, clock: clock))
        guard owns(token, snapshot), offer.kind == .offer, NativeWebRTCOfferPreflight.validates(offer.sdp) else { throw RealtimeVoiceTransportError.bridgeClosed }
        let iceGate = NativeRealtimeWebRTCOperationGate<Void>(); proxy.installICE(iceGate); coordinator.register(iceGate, token: token, snapshot: snapshot)
        let localGate = NativeRealtimeWebRTCOperationGate<Void>(); coordinator.register(localGate, token: token, snapshot: snapshot)
        guard owns(token, snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
        guard coordinator.admit(token, snapshot: snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
        snapshot.peer.setLocalDescription(.init(type: .offer, sdp: offer.sdp)) { error in error == nil ? localGate.succeed(()) : localGate.fail() }
        coordinator.release()
        _ = try await localGate.wait(timeout: Self.remaining(from: start, clock: clock))
        if snapshot.peer.iceGatheringState != .complete { _ = try await iceGate.wait(timeout: Self.remaining(from: start, clock: clock)) }
        guard owns(token, snapshot), let final = snapshot.peer.localDescription?.sdp, final.utf8.count <= Self.maximumSDPBytes, NativeWebRTCOfferPreflight.validates(final) else { throw RealtimeVoiceTransportError.bridgeClosed }
        route(ingress.submit(token, .control(.offer(generation: generation, sdp: final))))
      } catch { await awaitTerminalResult(ingress.submit(token, .terminal(.bridgeFailed))); throw RealtimeVoiceTransportError.bridgeClosed }
    }

    func applyAnswer(_ sdp: String, generation: UInt64) async throws {
      guard case let .active(token) = state, token.generation == generation, sdp.utf8.count <= Self.maximumSDPBytes, let snapshot = ownedSnapshot(token) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let gate = NativeRealtimeWebRTCOperationGate<Void>(); coordinator.register(gate, token: token, snapshot: snapshot)
      guard coordinator.admit(token, snapshot: snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
      snapshot.peer.setRemoteDescription(.init(type: .answer, sdp: sdp)) { error in error == nil ? gate.succeed(()) : gate.fail() }
      coordinator.release()
      do { _ = try await gate.wait(timeout: Self.deadline) } catch { throw RealtimeVoiceTransportError.bridgeClosed }
      guard owns(token, snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
      route(ingress.submit(token, .control(.answerApplied(generation: generation))))
    }

    func sendEvent(_ json: String, generation: UInt64) async throws {
      guard case let .active(token) = state, token.generation == generation, let snapshot = ownedSnapshot(token), json.utf8.count <= RealtimeProtocolCodec.maximumEventBytes, coordinator.admit(token, snapshot: snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
      defer { coordinator.release() }
      guard snapshot.channel.readyState == .open, snapshot.channel.sendData(.init(data: Data(json.utf8), isBinary: false)) else { throw RealtimeVoiceTransportError.bridgeClosed }
    }

    func setInputEnabled(_ enabled: Bool, lease: RealtimeVoiceInputLease) async throws {
      guard case let .active(token) = state, token.generation == lease.transportGeneration, newestLease.map({ lease.inputEpoch > $0.inputEpoch }) ?? true, let snapshot = ownedSnapshot(token), coordinator.admit(token, snapshot: snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let sender = snapshot.transceiver.sender
      newestLease = lease
      if !enabled { sender.track = nil; let cleared = sender.track == nil; coordinator.release(); guard cleared, newestLease == lease, isCurrent(token) else { await awaitTerminalResult(ingress.submit(token, .terminal(.bridgeFailed))); throw RealtimeVoiceTransportError.bridgeClosed }; inputTrack = nil; inputSource = nil; return }
      let source = factory.audioSource(with: nil); let track = factory.audioTrack(with: source, trackId: "enchiridion-input")
      guard newestLease == lease, isCurrent(token) else { coordinator.release(); throw RealtimeVoiceTransportError.bridgeClosed }
      sender.track = track; let installed = sender.track === track; coordinator.release()
      guard installed, isCurrent(token), newestLease == lease else { throw RealtimeVoiceTransportError.bridgeClosed }; inputSource = source; inputTrack = track
    }

    func stop() async {
      guard state != .stopped, lifecycle.stop() != nil else { return }
      let token = ownedToken ?? relay.activeTokenForStop
      if let token { await awaitTerminalResult(ingress.submit(token, .terminal(nil))) }
      else { relay.finish() }
      authorization.revoke()
      state = .stopped
    }
    private static func remaining(from start: ContinuousClock.Instant, clock: ContinuousClock) -> Duration { let elapsed = start.duration(to: clock.now); return elapsed < deadline ? deadline - elapsed : .zero }
    private func isCurrent(_ token: NativeBridgeToken) -> Bool { state == .active(token) && lifecycle.isCurrent(token.epoch) && authorization.authorizes(generation: token.generation) }
    /// The bridge is the only router allowed to turn an ingress result into a
    /// retained terminal task. Joining and normal publication never schedule.
    private func route(_ result: NativeBridgeIngress.Result) {
      guard case let .driver(ticket) = result else { return }
      startTerminalDriver(ticket)
    }
    private func makeIngressRouter() -> @Sendable (NativeBridgeIngress.Result) -> Void {
      { [weak self] result in Task { @MainActor [weak self] in self?.route(result) } }
    }
    private func startTerminalDriver(_ ticket: NativeBridgeLifecycleCoordinator.TerminalTicket) { guard terminalDriverTask == nil else { return }; terminalDriverTask = terminalDriverScheduler.submit { [weak self] in await self?.driveTerminal(ticket) } }
    private func awaitTerminalResult(_ result: NativeBridgeIngress.Result, didClaim: (() -> Void)? = nil) async {
      route(result)
      switch result {
      case let .driver(ticket), let .join(ticket): didClaim?(); await ticket.completion.wait()
      case .accepted, .rejected: break
      }
    }
    private func driveTerminal(_ ticket: NativeBridgeLifecycleCoordinator.TerminalTicket) async {
      let token = ticket.token
      state = .terminal
      authorization.revoke()
      let snapshot = claimOwned(token)
      coordinator.invalidateGates()
      guard coordinator.beginTeardown(token) else { coordinator.complete(ticket); return }
      await coordinator.waitForAdmissionsToDrain()
      await terminalCleanupOperation.run()
      await finishTerminal(token, snapshot: snapshot)
      if let failure = ticket.failure { relay.terminal(.failure(generation: token.generation, code: failure)) } else { relay.finish() }
      coordinator.complete(ticket)
      terminalDriverTask = nil
    }
    private func finishTerminal(_ token: NativeBridgeToken, snapshot: ResourceSnapshot?) async {
      guard let snapshot else { return }
      await snapshot.peerProxy.detachOutput()
      guard coordinator.admitCleanup(token) else { return }
      snapshot.transceiver.sender.track = nil
      snapshot.channel.delegate = nil
      snapshot.channel.close()
      snapshot.peer.close()
      coordinator.release()
      resources = .empty
    }
    private var ownedToken: NativeBridgeToken? { if case let .owned(token, _) = resources { return token }; return nil }
    private func ownedSnapshot(_ token: NativeBridgeToken) -> ResourceSnapshot? { if case let .owned(owner, snapshot) = resources, owner == token { return snapshot }; return nil }
    private func owns(_ token: NativeBridgeToken, _ snapshot: ResourceSnapshot) -> Bool { guard isCurrent(token), coordinator.callbacksCurrent(token), coordinator.isCurrent(token, snapshot: snapshot), case let .owned(owner, current) = resources else { return false }; return owner == token && current === snapshot }
    private func installOwned(_ token: NativeBridgeToken, _ snapshot: ResourceSnapshot) -> Bool { guard case .empty = resources, isCurrent(token) else { return false }; resources = .owned(token, snapshot); return true }
    private func claimOwned(_ token: NativeBridgeToken) -> ResourceSnapshot? { guard case let .owned(owner, snapshot) = resources, owner == token else { return nil }; resources = .claimed(token); inputTrack = nil; inputSource = nil; newestLease = nil; return snapshot }
    // Internal deterministic-test hooks; each invokes the production ingress.
    func testPrepareTerminalIngress(_ token: NativeBridgeToken) -> Bool {
      state = .active(token)
      relay.storeReady(token.epoch)
      guard relay.bind(token, nonce: token.epoch), coordinator.beginPreinstall(token) else { return false }
      final class TestSnapshot {}
      let snapshot = TestSnapshot()
      guard coordinator.install(token, snapshot: snapshot) else { return false }
      coordinator.activateCallbacks(token)
      return true
    }
    func testMakePeerProxy(_ token: NativeBridgeToken, armed: Bool = true) -> NativePeerProxy { NativePeerProxy(token: token, coordinator: coordinator, ingress: ingress, route: makeIngressRouter(), armed: armed) }
    func testMakeChannelProxy(_ token: NativeBridgeToken, armed: Bool = true) -> NativeChannelProxy { NativeChannelProxy(token: token, ingress: ingress, route: makeIngressRouter(), armed: armed) }
    func testStopTerminalIngress(_ token: NativeBridgeToken, didClaim: @escaping () -> Void = {}) async { await awaitTerminalResult(ingress.submit(token, .terminal(nil)), didClaim: didClaim) }
    func testBeginTeardown(_ token: NativeBridgeToken) -> Bool { coordinator.beginTeardown(token) }
    var testTerminalDriverTask: Task<Void, Never>? { terminalDriverTask }
    var testTerminalFailure: String? { coordinator.testTerminalFailure }
  }

  protocol NativeGateInvalidating: AnyObject { func invalidate() }

  /// The sole cross-thread authority for a native peer generation.  In
  /// particular, terminal installation is synchronous: a callback wins the
  /// race before its MainActor cleanup task is even scheduled.
  final class NativeBridgeLifecycleCoordinator: @unchecked Sendable {
    enum Phase: Equatable { case idle, preinstall, installed, tearingDown, terminal, finished }
    final class TerminalTicket: @unchecked Sendable { let token: NativeBridgeToken; let failure: String?; let completion = NativeRelayCompletion(); init(token: NativeBridgeToken, failure: String?) { self.token = token; self.failure = failure } }
    enum TerminalClaim { case driver(TerminalTicket), join(TerminalTicket), none }
    enum ControlClaim { case accepted, driver(TerminalTicket), rejected }
    private let lock = NSLock()
    private var phase: Phase = .idle
    private var active: NativeBridgeToken?
    private var snapshotID: ObjectIdentifier?
    private var callbacksActive = false
    private var terminal: TerminalTicket?
    private var gates: [NativeGateInvalidating] = []
    private var admissions = 0
    private var drainWaiters: [CheckedContinuation<Void, Never>] = []

    func beginPreinstall(_ token: NativeBridgeToken) -> Bool { lock.withLock { guard phase == .idle else { return false }; phase = .preinstall; active = token; return true } }
    func install(_ token: NativeBridgeToken, snapshot: AnyObject) -> Bool { lock.withLock { guard phase == .preinstall, active == token, terminal == nil else { return false }; snapshotID = ObjectIdentifier(snapshot); phase = .installed; return true } }
    func activateCallbacks(_ token: NativeBridgeToken) { lock.withLock { guard phase == .installed, active == token, terminal == nil else { return }; callbacksActive = true } }
    func callbacksCurrent(_ token: NativeBridgeToken) -> Bool { lock.withLock { callbacksActive && phase == .installed && active == token && terminal == nil } }
    func invalidateGates() { lock.lock(); callbacksActive = false; let values = gates; gates.removeAll(); lock.unlock(); values.forEach { $0.invalidate() } }
    func isCurrent(_ token: NativeBridgeToken, snapshot: AnyObject? = nil) -> Bool { lock.withLock { guard phase == .installed, active == token, terminal == nil else { return false }; return snapshot.map { snapshotID == ObjectIdentifier($0) } ?? true } }
    func register(_ gate: NativeGateInvalidating, token: NativeBridgeToken, snapshot: AnyObject? = nil) { lock.lock(); guard phase == .installed, active == token, terminal == nil, snapshot.map({ snapshotID == ObjectIdentifier($0) }) ?? true else { lock.unlock(); gate.invalidate(); return }; gates.append(gate); lock.unlock() }
    /// Admission is intentionally synchronous and held only for the exact SDK
    /// invocation.  No await is permitted between `admit` and `release`.
    func admit(_ token: NativeBridgeToken, snapshot: AnyObject? = nil) -> Bool { lock.withLock { guard phase == .installed, active == token, terminal == nil, snapshot.map({ snapshotID == ObjectIdentifier($0) }) ?? true else { return false }; admissions += 1; return true } }
    func admitCleanup(_ token: NativeBridgeToken) -> Bool { lock.withLock { guard phase == .tearingDown, terminal?.token == token else { return false }; admissions += 1; return true } }
    /// Lock ordering is always coordinator -> relay.  On the 257th control,
    /// the coordinator reserves the overflow ticket before this returns.
    func ingestControl(_ token: NativeBridgeToken, _ event: RealtimeWebRTCBridgeEvent, relay: NativeRealtimeWebRTCEventRelay) -> ControlClaim {
      lock.lock(); guard phase == .installed, active == token, terminal == nil, callbacksActive else { lock.unlock(); return .rejected }
      guard relay.enqueue(token, event) else { lock.unlock(); return .accepted }
      let ticket = TerminalTicket(token: token, failure: NativeBridgeReason.eventOverflow.rawValue); terminal = ticket
      active = nil; snapshotID = nil; callbacksActive = false; phase = .terminal
      let values = gates; gates.removeAll(); lock.unlock(); values.forEach { $0.invalidate() }; return .driver(ticket)
    }
    func ingestActivity(_ token: NativeBridgeToken, _ event: RealtimeWebRTCBridgeEvent, relay: NativeRealtimeWebRTCEventRelay) -> Bool {
      lock.lock(); guard phase == .installed, active == token, terminal == nil, callbacksActive else { lock.unlock(); return false }; _ = relay.enqueue(token, event); lock.unlock(); return true
    }
    func release() { lock.lock(); precondition(admissions > 0); admissions -= 1; let waiters = admissions == 0 ? drainWaiters : []; if admissions == 0 { drainWaiters.removeAll() }; lock.unlock(); waiters.forEach { $0.resume() } }
    func waitForAdmissionsToDrain() async { await withCheckedContinuation { continuation in lock.lock(); if admissions == 0 { lock.unlock(); continuation.resume() } else { drainWaiters.append(continuation); lock.unlock() } } }
    /// Clears all authority under the lock, then invalidates every gate before
    /// returning to the caller.  This is the linearization point for terminal.
    func reserveAndClaimTerminal(_ token: NativeBridgeToken, failure: String?) -> TerminalClaim {
      lock.lock()
      if let terminal { guard terminal.token == token else { lock.unlock(); return .none }; lock.unlock(); return .join(terminal) }
      guard active == token, phase == .preinstall || phase == .installed else { lock.unlock(); return .none }
      let value = TerminalTicket(token: token, failure: failure); terminal = value; active = nil; snapshotID = nil; callbacksActive = false; phase = .terminal
      let values = gates; gates.removeAll()
      lock.unlock()
      values.forEach { $0.invalidate() }
      return .driver(value)
    }
    func beginTeardown(_ token: NativeBridgeToken) -> Bool { lock.withLock { guard terminal?.token == token, phase == .terminal else { return false }; phase = .tearingDown; return true } }
    func complete(_ ticket: TerminalTicket) { lock.withLock { guard terminal === ticket else { return }; active = nil; snapshotID = nil; phase = .finished }; ticket.completion.finish() }
    // Internal deterministic-test hooks.
    var testPhase: Phase { lock.withLock { phase } }
    var testTerminalFailure: String? { lock.withLock { terminal?.failure } }
  }
  final class NativeRealtimeWebRTCOperationGate<Value: Sendable>: NativeGateInvalidating, @unchecked Sendable {
    private enum Outcome { case value(Value), failed }
    private let lock = NSLock(); private var outcome: Outcome?; private var continuation: CheckedContinuation<Value, Error>?; private var timer: DispatchSourceTimer?
    func succeed(_ value: Value) { resolve(.value(value)) }; func fail() { resolve(.failed) }; func invalidate() { resolve(.failed) }
    private func resolve(_ outcome: Outcome) { lock.lock(); guard self.outcome == nil else { lock.unlock(); return }; self.outcome = outcome; let continuation = self.continuation; self.continuation = nil; let timer = self.timer; self.timer = nil; lock.unlock(); timer?.cancel(); guard let continuation else { return }; switch outcome { case let .value(value): continuation.resume(returning: value); case .failed: continuation.resume(throwing: RealtimeVoiceTransportError.bridgeClosed) } }
    func wait(timeout: Duration) async throws -> Value { try await withTaskCancellationHandler(operation: { try await withCheckedThrowingContinuation { continuation in lock.lock(); if let outcome { lock.unlock(); switch outcome { case let .value(value): continuation.resume(returning: value); case .failed: continuation.resume(throwing: RealtimeVoiceTransportError.bridgeClosed) }; return }; self.continuation = continuation; let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated)); timer.schedule(deadline: .now() + timeout.timeInterval); timer.setEventHandler { [self] in fail() }; self.timer = timer; lock.unlock(); timer.resume() } }, onCancel: { self.invalidate() }) }
  }
  private extension Duration { var timeInterval: DispatchTimeInterval { .nanoseconds(Int(components.seconds * 1_000_000_000) + Int(components.attoseconds / 1_000_000_000)) } }

  final class NativeRealtimeWebRTCEventRelay: @unchecked Sendable {
    private let lock = NSLock(); private var activeToken: NativeBridgeToken?; private var pendingReady: UInt64?; private var controls: [RealtimeWebRTCBridgeEvent] = []; private var terminal: RealtimeWebRTCBridgeEvent?; private var activity: RealtimeWebRTCBridgeEvent?; private var waiter: CheckedContinuation<RealtimeWebRTCBridgeEvent?, Never>?; private var consumer = false; private var finished = false
    var activeTokenForStop: NativeBridgeToken? { lock.withLock { activeToken } }
    func stream() -> AsyncStream<RealtimeWebRTCBridgeEvent> { lock.lock(); guard !consumer else { lock.unlock(); return AsyncStream(unfolding: { nil }) }; consumer = true; lock.unlock(); return AsyncStream(unfolding: { await self.next() }) }
    func storeReady(_ nonce: UInt64) { lock.lock(); guard !finished else { lock.unlock(); return }; pendingReady = nonce; lock.unlock() }
    func bind(_ token: NativeBridgeToken, nonce: UInt64) -> Bool { lock.lock(); guard !finished, activeToken == nil, pendingReady == nonce else { lock.unlock(); return false }; activeToken = token; pendingReady = nil; controls.append(.ready); let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value); return true }
    /// Publication only.  The coordinator reserves overflow before invoking
    /// this method; `true` asks it to install that terminal ticket.
    func enqueue(_ token: NativeBridgeToken, _ event: RealtimeWebRTCBridgeEvent) -> Bool { lock.lock(); guard !finished, activeToken == token else { lock.unlock(); return false }; if case .audioActivity = event { activity = event } else if controls.count < 256 { controls.append(event) } else { lock.unlock(); return true }; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value); return false }
    func terminal(_ event: RealtimeWebRTCBridgeEvent) { lock.lock(); guard terminal == nil else { lock.unlock(); return }; controls.removeAll(); activity = nil; terminal = event; finished = true; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value) }
    func finish() { lock.lock(); guard terminal == nil else { lock.unlock(); return }; activeToken = nil; controls.removeAll(); activity = nil; finished = true; let waiting = waiter; self.waiter = nil; lock.unlock(); waiting?.resume(returning: nil) }
    private func next() async -> RealtimeWebRTCBridgeEvent? { await withCheckedContinuation { continuation in lock.lock(); if let value = dequeue() { lock.unlock(); continuation.resume(returning: value) } else if finished { lock.unlock(); continuation.resume(returning: nil) } else { waiter = continuation; lock.unlock() } } }
    private func dequeue() -> RealtimeWebRTCBridgeEvent? { if let terminal { self.terminal = nil; return terminal }; if !controls.isEmpty { return controls.removeFirst() }; if let activity { self.activity = nil; return activity }; return nil }
  }

  final class NativeOutputAttachmentOperations: @unchecked Sendable {
    let add: () -> Void; let start: () -> Void; let stop: () -> Void; let remove: () -> Void
    init(add: @escaping () -> Void, start: @escaping () -> Void, stop: @escaping () -> Void, remove: @escaping () -> Void) { self.add = add; self.start = start; self.stop = stop; self.remove = remove }
  }
  final class NativePeerProxy: NSObject, LKRTCPeerConnectionDelegate, @unchecked Sendable {
    private final class Barrier: @unchecked Sendable { private let lock = NSLock(); private var resolved = false; private var continuation: CheckedContinuation<Void, Never>?; func resolve() { lock.lock(); guard !resolved else { lock.unlock(); return }; resolved = true; let c = continuation; continuation = nil; lock.unlock(); c?.resume() }; func wait() async { await withCheckedContinuation { c in lock.lock(); if resolved { lock.unlock(); c.resume() } else { continuation = c; lock.unlock() } } } }
    private final class Attachment: @unchecked Sendable { let operations: NativeOutputAttachmentOperations; let barrier = Barrier(); var added = false; var started = false; init(operations: NativeOutputAttachmentOperations) { self.operations = operations } }
    private enum OutputState { case empty; case attaching(Attachment); case attached(Attachment); case invalidated(Attachment?) }
    let token: NativeBridgeToken; let coordinator: NativeBridgeLifecycleCoordinator; private let ingress: NativeBridgeIngress; private let route: @Sendable (NativeBridgeIngress.Result) -> Void
    private let lock = NSLock(); private let output = NativeOutputActivityPublisher(); private let outputLane = DispatchQueue(label: "dev.rawkode.enchiridion.native-webrtc-output"); private var armed = false; private var pendingTerminal: NativeBridgeReason?; private var pendingRemoteTrack: LKRTCAudioTrack?; private var pendingTestOperations: NativeOutputAttachmentOperations?; private var outputState: OutputState = .empty; private var iceGate: NativeRealtimeWebRTCOperationGate<Void>?; private var iceComplete = false; private var terminalLatched = false
    fileprivate init(token: NativeBridgeToken, coordinator: NativeBridgeLifecycleCoordinator, ingress: NativeBridgeIngress, route: @escaping @Sendable (NativeBridgeIngress.Result) -> Void, armed: Bool) { self.token = token; self.coordinator = coordinator; self.ingress = ingress; self.route = route; self.armed = armed }
    /// Installs the callback snapshot synchronously. A latched terminal is
    /// returned rather than dispatched so the MainActor can claim teardown
    /// before ICE/output/offer work has a chance to run.
    fileprivate func arm() -> NativeBridgeIngress.Result? {
      lock.lock(); armed = true
      let terminal = pendingTerminal
      if terminal != nil { terminalLatched = true; pendingTerminal = nil; pendingRemoteTrack = nil; pendingTestOperations = nil }
      lock.unlock()
      return terminal.map { ingress.submit(token, .terminal($0)) }
    }
    /// Called only after the bridge owns the snapshot and has activated its
    /// fence. This deliberately separates staging from SDK side effects.
    func replayStagedCallbacks() {
      lock.lock(); guard armed, pendingTerminal == nil else { lock.unlock(); return }
      let track = pendingRemoteTrack; pendingRemoteTrack = nil; let operations = pendingTestOperations; pendingTestOperations = nil
      lock.unlock()
      if let track { beginOutputAttachment(track) } else if let operations { beginOutputAttachment(operations) }
    }
    private func isArmed() -> Bool { lock.lock(); defer { lock.unlock() }; return armed }
    func installICE(_ gate: NativeRealtimeWebRTCOperationGate<Void>) { lock.lock(); iceGate = gate; let complete = iceComplete; lock.unlock(); if complete { gate.succeed(()) } }
    func detachOutput() async {
      guard let attachment = beginDetach() else { return }
      await attachment.barrier.wait()
      await withCheckedContinuation { continuation in
        outputLane.async { [weak self, attachment] in
          if let self, self.coordinator.admitCleanup(self.token) { if attachment.started { attachment.operations.stop() }; if attachment.added { attachment.operations.remove() }; self.coordinator.release() }
          continuation.resume()
          _ = self
        }
      }
    }
    private func beginDetach() -> Attachment? {
      lock.lock()
      let attachment: Attachment?
      switch outputState { case .empty, .invalidated: lock.unlock(); return nil; case let .attaching(value), let .attached(value): attachment = value; outputState = .invalidated(value); lock.unlock() }
      return attachment
    }
    func peerConnection(_: LKRTCPeerConnection, didChange state: LKRTCIceConnectionState) { switch state { case .failed, .closed: latchTerminal(.peerTerminal); case .new, .checking, .connected, .completed, .count: break; default: latchTerminal(.peerUnknown) } }
    func peerConnection(_: LKRTCPeerConnection, didChange state: LKRTCIceGatheringState) { guard state == .complete else { return }; lock.lock(); iceComplete = true; let gate = armed ? iceGate : nil; lock.unlock(); gate?.succeed(()) }
    func peerConnection(_: LKRTCPeerConnection, didStartReceivingOn transceiver: LKRTCRtpTransceiver) {
      guard let track = transceiver.receiver.track as? LKRTCAudioTrack else { return }
      lock.lock()
      guard armed else { if pendingTerminal == nil { pendingRemoteTrack = track }; lock.unlock(); return }
      guard pendingTerminal == nil else { lock.unlock(); return }
      guard coordinator.callbacksCurrent(token) else { pendingRemoteTrack = track; lock.unlock(); return }
      lock.unlock()
      beginOutputAttachment(track)
    }
    private func beginOutputAttachment(_ track: LKRTCAudioTrack) {
      let renderer = NativeRemoteAudioRenderer(slot: output.slot); let output = output; let token = token; let ingress = ingress
      beginOutputAttachment(NativeOutputAttachmentOperations(add: { track.add(renderer) }, start: { output.start(token: token, ingress: ingress) }, stop: { output.stop() }, remove: { track.remove(renderer) }))
    }
    func testBeginOutputAttachment(_ operations: NativeOutputAttachmentOperations) { beginOutputAttachment(operations) }
    func testStageOutputAttachment(_ operations: NativeOutputAttachmentOperations) { lock.withLock { guard !armed, pendingTerminal == nil else { return }; pendingTestOperations = operations } }
    func testArmAndRoute() { if let result = arm() { route(result) } }
    func testReplayStagedOutput() { replayStagedCallbacks() }
    private func beginOutputAttachment(_ operations: NativeOutputAttachmentOperations) {
      let attachment = Attachment(operations: operations)
      lock.lock()
      guard armed, pendingTerminal == nil, case .empty = outputState, coordinator.callbacksCurrent(token) else { lock.unlock(); return }
      outputState = .attaching(attachment)
      outputLane.async { [weak self, attachment] in self?.finishAttach(attachment) }
      lock.unlock()
    }
    private func finishAttach(_ attachment: Attachment) {
      lock.lock()
      guard case let .attaching(current) = outputState, current === attachment, coordinator.callbacksCurrent(token) else { lock.unlock(); attachment.barrier.resolve(); return }
      lock.unlock()
      defer { attachment.barrier.resolve() }
      guard coordinator.admit(token) else { return }
      attachment.operations.add(); attachment.added = true
      attachment.operations.start(); attachment.started = true
      coordinator.release()
      lock.lock()
      if case let .attaching(current) = outputState, current === attachment { outputState = .attached(attachment) }
      lock.unlock()
    }
    private func latchTerminal(_ reason: NativeBridgeReason) { lock.lock(); guard !terminalLatched, pendingTerminal == nil else { lock.unlock(); return }; if !armed { pendingTerminal = reason; lock.unlock(); return }; terminalLatched = true; lock.unlock(); route(ingress.submit(token, .terminal(reason))) }
    func testTerminalIngress(_ reason: NativeBridgeReason) { latchTerminal(reason) }
    func testMeterActivity(_ value: Double) { output.publish(token, value: value, ingress: ingress) }
    func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCSignalingState) {}; func peerConnection(_: LKRTCPeerConnection, didAdd _: LKRTCMediaStream) {}; func peerConnection(_: LKRTCPeerConnection, didRemove _: LKRTCMediaStream) {}; func peerConnectionShouldNegotiate(_: LKRTCPeerConnection) {}; func peerConnection(_: LKRTCPeerConnection, didGenerate _: LKRTCIceCandidate) {}; func peerConnection(_: LKRTCPeerConnection, didRemove _: [LKRTCIceCandidate]) {}; func peerConnection(_: LKRTCPeerConnection, didOpen _: LKRTCDataChannel) {}
  }
  final class NativeChannelProxy: NSObject, LKRTCDataChannelDelegate, @unchecked Sendable {
    let token: NativeBridgeToken; private let ingress: NativeBridgeIngress; private let route: @Sendable (NativeBridgeIngress.Result) -> Void; private let lock = NSLock(); private var armed = false; private var pendingTerminal: NativeBridgeReason?
    fileprivate init(token: NativeBridgeToken, ingress: NativeBridgeIngress, route: @escaping @Sendable (NativeBridgeIngress.Result) -> Void, armed: Bool) { self.token = token; self.ingress = ingress; self.route = route; self.armed = armed }
    fileprivate func arm() -> NativeBridgeIngress.Result? { lock.lock(); armed = true; let terminal = pendingTerminal; pendingTerminal = nil; lock.unlock(); return terminal.map { ingress.submit(token, .terminal($0)) } }
    private func isArmed() -> Bool { lock.lock(); defer { lock.unlock() }; return armed }
    func dataChannelDidChangeState(_ channel: LKRTCDataChannel) { guard isArmed() else { return }; switch channel.readyState { case .connecting: enqueue(.dataChannelState(generation: token.generation, state: "connecting")); case .open: enqueue(.dataChannelState(generation: token.generation, state: "open")); case .closing, .closed: scheduleTerminal(.channelTerminal); default: scheduleTerminal(.channelUnknown) } }
    func dataChannel(_: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) { guard isArmed(), !buffer.isBinary, buffer.data.count <= RealtimeProtocolCodec.maximumEventBytes, let json = String(data: buffer.data, encoding: .utf8) else { return }; enqueue(.serverEvent(generation: token.generation, json: json)) }
    private func enqueue(_ event: RealtimeWebRTCBridgeEvent) { route(ingress.submit(token, .control(event))) }
    private func scheduleTerminal(_ reason: NativeBridgeReason) { lock.lock(); guard !armed else { lock.unlock(); route(ingress.submit(token, .terminal(reason))); return }; if pendingTerminal == nil { pendingTerminal = reason }; lock.unlock() }
    func testTerminalIngress(_ reason: NativeBridgeReason) { scheduleTerminal(reason) }
    func testControlIngress(_ event: RealtimeWebRTCBridgeEvent) { enqueue(event) }
    func testArmAndRoute() { if let result = arm() { route(result) } }
  }
  private final class NativeAudioLevelSlot: @unchecked Sendable { private let lock = NSLock(); private var level: Double = 0; func write(_ value: Double) { guard lock.try() else { return }; level = value; lock.unlock() }; func take() -> Double? { guard lock.try() else { return nil }; defer { lock.unlock() }; return level } }
  private final class NativeOutputActivityPublisher: @unchecked Sendable { let slot = NativeAudioLevelSlot(); private var timer: DispatchSourceTimer?; func start(token: NativeBridgeToken, ingress: NativeBridgeIngress) { guard timer == nil else { return }; let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "dev.rawkode.enchiridion.native-webrtc-meter")); timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50)); timer.setEventHandler { [slot, token, ingress] in guard let value = slot.take() else { return }; self.publish(token, value: value, ingress: ingress) }; self.timer = timer; timer.resume() }; fileprivate func publish(_ token: NativeBridgeToken, value: Double, ingress: NativeBridgeIngress) { _ = ingress.submit(token, .activity(.audioActivity(generation: token.generation, inputLevel: 0, outputLevel: value))) }; func stop() { timer?.cancel(); timer = nil } }
  private final class NativeRemoteAudioRenderer: NSObject, LKRTCAudioRenderer { let slot: NativeAudioLevelSlot; init(slot: NativeAudioLevelSlot) { self.slot = slot }; func render(pcmBuffer: AVAudioPCMBuffer) { guard let channels = pcmBuffer.floatChannelData, pcmBuffer.frameLength > 0 else { return }; let values = channels[0]; var sum: Float = 0; for index in 0..<Int(pcmBuffer.frameLength) { sum += values[index] * values[index] }; slot.write(Double((sum / Float(pcmBuffer.frameLength)).squareRoot())) } }

#endif
