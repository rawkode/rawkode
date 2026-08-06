#if DEBUG && os(iOS)
  import AVFoundation
  import EnchiridionCore
  import Foundation
  @preconcurrency import LiveKitWebRTC

  struct NativeBridgeToken: Sendable, Hashable { let generation: UInt64; let epoch: UInt64 }
  private enum NativeBridgeReason: String, Sendable { case bridgeFailed = "bridge_failed", peerTerminal = "peer_terminal", peerUnknown = "peer_unknown", channelTerminal = "channel_terminal", channelUnknown = "channel_unknown", eventOverflow = "event_overflow" }
  private struct NativeSessionDescription: Sendable { enum Kind: Sendable { case offer, answer }; let kind: Kind; let sdp: String }
  final class NativeRelayCompletion: @unchecked Sendable { private let lock = NSLock(); private var finished = false; private var waiter: CheckedContinuation<Void, Never>?; func finish() { lock.lock(); guard !finished else { lock.unlock(); return }; finished = true; let waiter = waiter; self.waiter = nil; lock.unlock(); waiter?.resume() }; func wait() async { await withCheckedContinuation { continuation in lock.lock(); if finished { lock.unlock(); continuation.resume() } else { waiter = continuation; lock.unlock() } } } }

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
    private let fence = NativeCallbackFence()
    private let relay = NativeRealtimeWebRTCEventRelay()
    private var lifecycle = RealtimeWebRTCBridgeLifecycleState()
    private var state: State = .idle
    private var nextLoadNonce: UInt64 = 0
    private var resources: ResourceState = .empty
    private var authorization = RealtimeWebRTCBridgeAuthorizationState()
    private var inputSource: LKRTCAudioSource?
    private var inputTrack: LKRTCAudioTrack?
    private var newestLease: RealtimeVoiceInputLease?
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
      await teardownIfOwned(token)
      let configuration = LKRTCConfiguration(); configuration.sdpSemantics = .unifiedPlan
      let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
      let terminal: @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void = { [weak self] token, reason in
        Task { @MainActor in await self?.terminal(token, outcome: reason) }
      }
      // Proxies are deliberately constructed disarmed. No SDK callback is
      // allowed to observe a staged peer before this snapshot is owned.
      let proxy = NativePeerProxy(token: token, fence: fence, relay: relay, terminal: terminal, armed: false)
      guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: proxy) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let transceiverInit = LKRTCRtpTransceiverInit(); transceiverInit.direction = .sendRecv
      guard let transceiver = peer.addTransceiver(of: .audio, init: transceiverInit), transceiver.sender.track == nil else { peer.close(); throw RealtimeVoiceTransportError.bridgeClosed }
      let channelConfiguration = LKRTCDataChannelConfiguration(); channelConfiguration.isOrdered = true
      guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfiguration) else { peer.close(); throw RealtimeVoiceTransportError.bridgeClosed }
      let channelProxy = NativeChannelProxy(token: token, fence: fence, relay: relay, terminal: terminal, armed: false)
      let snapshot = ResourceSnapshot(peer: peer, transceiver: transceiver, channel: channel, peerProxy: proxy, channelProxy: channelProxy)
      guard installOwned(token, snapshot) else { channel.close(); peer.close(); throw RealtimeVoiceTransportError.bridgeClosed }
      // A terminal observed while the SDK was constructing the peer wins over
      // every later callback and over offer generation.
      let preinstallTerminal = proxy.arm()
      let channelTerminal = channelProxy.arm()
      channel.delegate = channelProxy
      if let reason = preinstallTerminal ?? channelTerminal { await self.terminal(token, outcome: reason); throw RealtimeVoiceTransportError.bridgeClosed }
      // Callback facts were staged while the peer was not yet owned. The
      // fence only becomes visible after terminal priority has been decided.
      fence.activate(token)
      proxy.replayStagedCallbacks()
      guard owns(token, snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let clock = ContinuousClock(); let start = clock.now
      do {
        let offerGate = NativeRealtimeWebRTCOperationGate<NativeSessionDescription>()
        fence.register(offerGate, token: token)
        peer.offer(for: constraints) { description, _ in
          guard let description, description.sdp.utf8.count <= Self.maximumSDPBytes else { offerGate.fail(); return }
          offerGate.succeed(.init(kind: .offer, sdp: description.sdp))
        }
        let offer = try await offerGate.wait(timeout: Self.remaining(from: start, clock: clock))
        guard owns(token, snapshot), offer.kind == .offer, NativeWebRTCOfferPreflight.validates(offer.sdp) else { throw RealtimeVoiceTransportError.bridgeClosed }
        let iceGate = NativeRealtimeWebRTCOperationGate<Void>(); proxy.installICE(iceGate); fence.register(iceGate, token: token)
        let localGate = NativeRealtimeWebRTCOperationGate<Void>(); fence.register(localGate, token: token)
        guard owns(token, snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
        snapshot.peer.setLocalDescription(.init(type: .offer, sdp: offer.sdp)) { error in error == nil ? localGate.succeed(()) : localGate.fail() }
        _ = try await localGate.wait(timeout: Self.remaining(from: start, clock: clock))
        if snapshot.peer.iceGatheringState != .complete { _ = try await iceGate.wait(timeout: Self.remaining(from: start, clock: clock)) }
        guard owns(token, snapshot), let final = snapshot.peer.localDescription?.sdp, final.utf8.count <= Self.maximumSDPBytes, NativeWebRTCOfferPreflight.validates(final) else { throw RealtimeVoiceTransportError.bridgeClosed }
        enqueue(token, .offer(generation: generation, sdp: final))
      } catch { await self.terminal(token, outcome: .bridgeFailed); throw RealtimeVoiceTransportError.bridgeClosed }
    }

    func applyAnswer(_ sdp: String, generation: UInt64) async throws {
      guard case let .active(token) = state, token.generation == generation, sdp.utf8.count <= Self.maximumSDPBytes, let snapshot = ownedSnapshot(token) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let gate = NativeRealtimeWebRTCOperationGate<Void>(); fence.register(gate, token: token)
      snapshot.peer.setRemoteDescription(.init(type: .answer, sdp: sdp)) { error in error == nil ? gate.succeed(()) : gate.fail() }
      do { _ = try await gate.wait(timeout: Self.deadline) } catch { throw RealtimeVoiceTransportError.bridgeClosed }
      guard owns(token, snapshot) else { throw RealtimeVoiceTransportError.bridgeClosed }
      enqueue(token, .answerApplied(generation: generation))
    }

    func sendEvent(_ json: String, generation: UInt64) async throws {
      guard case let .active(token) = state, token.generation == generation, let snapshot = ownedSnapshot(token), json.utf8.count <= RealtimeProtocolCodec.maximumEventBytes, snapshot.channel.readyState == .open, snapshot.channel.sendData(.init(data: Data(json.utf8), isBinary: false)) else { throw RealtimeVoiceTransportError.bridgeClosed }
    }

    func setInputEnabled(_ enabled: Bool, lease: RealtimeVoiceInputLease) async throws {
      guard case let .active(token) = state, token.generation == lease.transportGeneration, newestLease.map({ lease.inputEpoch > $0.inputEpoch }) ?? true, let sender = ownedSnapshot(token)?.transceiver.sender else { throw RealtimeVoiceTransportError.bridgeClosed }
      newestLease = lease
      if !enabled { sender.track = nil; guard sender.track == nil, newestLease == lease, isCurrent(token) else { await terminal(token, outcome: .bridgeFailed); throw RealtimeVoiceTransportError.bridgeClosed }; inputTrack = nil; inputSource = nil; return }
      let source = factory.audioSource(with: nil); let track = factory.audioTrack(with: source, trackId: "enchiridion-input")
      guard newestLease == lease, isCurrent(token) else { throw RealtimeVoiceTransportError.bridgeClosed }
      sender.track = track; guard sender.track === track, isCurrent(token), newestLease == lease else { sender.track = nil; throw RealtimeVoiceTransportError.bridgeClosed }; inputSource = source; inputTrack = track
    }

    func stop() async {
      guard state != .stopped, lifecycle.stop() != nil else { return }
      let token = ownedToken ?? relay.terminalToken
      if let token { await terminal(token, outcome: nil) }
      else { relay.finish() }
      authorization.revoke()
      state = .stopped
    }
    private static func remaining(from start: ContinuousClock.Instant, clock: ContinuousClock) -> Duration { let elapsed = start.duration(to: clock.now); return elapsed < deadline ? deadline - elapsed : .zero }
    private func isCurrent(_ token: NativeBridgeToken) -> Bool { state == .active(token) && lifecycle.isCurrent(token.epoch) && authorization.authorizes(generation: token.generation) }
    private func enqueue(_ token: NativeBridgeToken, _ event: RealtimeWebRTCBridgeEvent) {
      if relay.enqueue(token, event) { Task { @MainActor [weak self, token] in await self?.terminal(token, outcome: .eventOverflow) } }
    }
    /// Claims the relay ticket and SDK snapshot before the first suspension.
    /// Every terminal source, including `stop`, comes through this path.
    private func terminal(_ token: NativeBridgeToken, outcome: NativeBridgeReason?) async {
      switch relay.claimOrJoinTerminal(token, failure: outcome.map(\.rawValue)) {
      case let .driver(completion):
        state = .terminal
        authorization.revoke()
        let snapshot = claimOwned(token)
        fence.invalidate(token.epoch)
        await finishTerminal(token, snapshot: snapshot, completion: completion)
      case let .join(completion):
        await completion.wait()
      case .none:
        break
      }
    }
    private func finishTerminal(_ token: NativeBridgeToken, snapshot: ResourceSnapshot?, completion: NativeRelayCompletion) async {
      defer { relay.completeTerminal(token, completion: completion) }
      guard let snapshot else { return }
      await snapshot.peerProxy.detachOutput()
      snapshot.transceiver.sender.track = nil
      snapshot.channel.delegate = nil
      snapshot.channel.close()
      snapshot.peer.close()
      resources = .empty
    }
    private var ownedToken: NativeBridgeToken? { if case let .owned(token, _) = resources { return token }; return nil }
    private func ownedSnapshot(_ token: NativeBridgeToken) -> ResourceSnapshot? { if case let .owned(owner, snapshot) = resources, owner == token { return snapshot }; return nil }
    private func owns(_ token: NativeBridgeToken, _ snapshot: ResourceSnapshot) -> Bool { guard isCurrent(token), fence.isCurrent(token), !relay.hasTerminalTicket(token), case let .owned(owner, current) = resources else { return false }; return owner == token && current === snapshot }
    private func installOwned(_ token: NativeBridgeToken, _ snapshot: ResourceSnapshot) -> Bool { guard case .empty = resources, isCurrent(token) else { return false }; resources = .owned(token, snapshot); return true }
    private func claimOwned(_ token: NativeBridgeToken) -> ResourceSnapshot? { guard case let .owned(owner, snapshot) = resources, owner == token else { return nil }; resources = .claimed(token); inputTrack = nil; inputSource = nil; newestLease = nil; return snapshot }
    private func teardownIfOwned(_ token: NativeBridgeToken) async {
      guard let snapshot = claimOwned(token) else { return }
      fence.invalidate(token.epoch)
      await snapshot.peerProxy.detachOutput()
      snapshot.transceiver.sender.track = nil
      snapshot.channel.delegate = nil; snapshot.channel.close(); snapshot.peer.close()
      resources = .empty
    }
  }

  final class NativeCallbackFence: @unchecked Sendable {
    private let lock = NSLock(); private var token: NativeBridgeToken?; private var cancelled: Set<NativeBridgeToken> = []; private var gates: [NativeGateInvalidating] = []
    func activate(_ token: NativeBridgeToken) { lock.lock(); guard !cancelled.contains(token), self.token == nil || self.token == token else { lock.unlock(); return }; self.token = token; lock.unlock() }
    func register(_ gate: NativeGateInvalidating, token: NativeBridgeToken) { lock.lock(); guard !cancelled.contains(token), self.token == nil || self.token == token else { lock.unlock(); gate.invalidate(); return }; self.token = token; gates.append(gate); lock.unlock() }
    func isCurrent(_ token: NativeBridgeToken) -> Bool { lock.lock(); defer { lock.unlock() }; return self.token == token }
    func invalidate(_ epoch: UInt64) { lock.lock(); token = nil; let values = gates; gates.removeAll(); lock.unlock(); values.forEach { $0.invalidate() } }
    func cancel(_ token: NativeBridgeToken) { lock.lock(); cancelled.insert(token); guard self.token == token else { lock.unlock(); return }; self.token = nil; let values = gates; gates.removeAll(); lock.unlock(); values.forEach { $0.invalidate() } }
  }
  protocol NativeGateInvalidating: AnyObject { func invalidate() }
  final class NativeRealtimeWebRTCOperationGate<Value: Sendable>: NativeGateInvalidating, @unchecked Sendable {
    private enum Outcome { case value(Value), failed }
    private let lock = NSLock(); private var outcome: Outcome?; private var continuation: CheckedContinuation<Value, Error>?; private var timer: DispatchSourceTimer?
    func succeed(_ value: Value) { resolve(.value(value)) }; func fail() { resolve(.failed) }; func invalidate() { resolve(.failed) }
    private func resolve(_ outcome: Outcome) { lock.lock(); guard self.outcome == nil else { lock.unlock(); return }; self.outcome = outcome; let continuation = self.continuation; self.continuation = nil; let timer = self.timer; self.timer = nil; lock.unlock(); timer?.cancel(); guard let continuation else { return }; switch outcome { case let .value(value): continuation.resume(returning: value); case .failed: continuation.resume(throwing: RealtimeVoiceTransportError.bridgeClosed) } }
    func wait(timeout: Duration) async throws -> Value { try await withTaskCancellationHandler(operation: { try await withCheckedThrowingContinuation { continuation in lock.lock(); if let outcome { lock.unlock(); switch outcome { case let .value(value): continuation.resume(returning: value); case .failed: continuation.resume(throwing: RealtimeVoiceTransportError.bridgeClosed) }; return }; self.continuation = continuation; let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated)); timer.schedule(deadline: .now() + timeout.timeInterval); timer.setEventHandler { [self] in fail() }; self.timer = timer; lock.unlock(); timer.resume() } }, onCancel: { self.invalidate() }) }
  }
  private extension Duration { var timeInterval: DispatchTimeInterval { .nanoseconds(Int(components.seconds * 1_000_000_000) + Int(components.attoseconds / 1_000_000_000)) } }

  final class NativeRealtimeWebRTCEventRelay: @unchecked Sendable {
    private final class TerminalTicket: @unchecked Sendable { let token: NativeBridgeToken; let event: RealtimeWebRTCBridgeEvent?; let completion = NativeRelayCompletion(); var claimed = false; init(token: NativeBridgeToken, event: RealtimeWebRTCBridgeEvent?) { self.token = token; self.event = event } }
    enum TerminalClaim { case driver(NativeRelayCompletion), join(NativeRelayCompletion), none }
    private let lock = NSLock(); private var activeToken: NativeBridgeToken?; private var pendingReady: UInt64?; private var ticket: TerminalTicket?; private var controls: [RealtimeWebRTCBridgeEvent] = []; private var terminal: RealtimeWebRTCBridgeEvent?; private var activity: RealtimeWebRTCBridgeEvent?; private var waiter: CheckedContinuation<RealtimeWebRTCBridgeEvent?, Never>?; private var consumer = false; private var finished = false
    var terminalToken: NativeBridgeToken? { lock.withLock { ticket?.token ?? activeToken } }
    func hasTerminalTicket(_ token: NativeBridgeToken) -> Bool { lock.withLock { ticket?.token == token } }
    func stream() -> AsyncStream<RealtimeWebRTCBridgeEvent> { lock.lock(); guard !consumer else { lock.unlock(); return AsyncStream(unfolding: { nil }) }; consumer = true; lock.unlock(); return AsyncStream(unfolding: { await self.next() }) }
    func storeReady(_ nonce: UInt64) { lock.lock(); guard !finished else { lock.unlock(); return }; pendingReady = nonce; lock.unlock() }
    func bind(_ token: NativeBridgeToken, nonce: UInt64) -> Bool { lock.lock(); guard !finished, activeToken == nil, pendingReady == nonce else { lock.unlock(); return false }; activeToken = token; pendingReady = nil; controls.append(.ready); let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value); return true }
    /// Returns true exactly for the atomic 257th-control transition. It creates
    /// a failure ticket before the producer is released, so EOF can never win.
    func enqueue(_ token: NativeBridgeToken, _ event: RealtimeWebRTCBridgeEvent) -> Bool { lock.lock(); guard !finished, ticket == nil, activeToken == token else { lock.unlock(); return false }; if case .audioActivity = event { activity = event } else if controls.count < 256 { controls.append(event) } else { activeToken = nil; controls.removeAll(); activity = nil; ticket = TerminalTicket(token: token, event: .failure(generation: token.generation, code: NativeBridgeReason.eventOverflow.rawValue)); lock.unlock(); return true }; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value); return false }
    /// Atomically creates or joins the one terminal ticket. A pre-existing
    /// failure ticket always wins over an ordinary stop/EOF request.
    func claimOrJoinTerminal(_ token: NativeBridgeToken, failure: String?) -> TerminalClaim { lock.lock(); defer { lock.unlock() }; guard !finished else { return .none }; let ticket: TerminalTicket
      if let existing = self.ticket { guard existing.token == token else { return .none }; ticket = existing }
      else { guard activeToken == token else { return .none }; let event = failure.map { RealtimeWebRTCBridgeEvent.failure(generation: token.generation, code: $0) }; ticket = TerminalTicket(token: token, event: event); self.ticket = ticket; activeToken = nil; controls.removeAll(); activity = nil }
      if ticket.claimed { return .join(ticket.completion) }; ticket.claimed = true; return .driver(ticket.completion) }
    func completeTerminal(_ token: NativeBridgeToken, completion: NativeRelayCompletion) { lock.lock(); guard !finished, let ticket, ticket.token == token, ticket.completion === completion, ticket.claimed else { lock.unlock(); return }; self.ticket = nil; controls.removeAll(); activity = nil; terminal = ticket.event; finished = true; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value); completion.finish() }
    func push(_ event: RealtimeWebRTCBridgeEvent) { lock.lock(); guard !finished else { lock.unlock(); return }; if case .audioActivity = event { activity = event } else if controls.count < 256 { controls.append(event) } else { controls.removeAll(); activity = nil; finished = true; terminal = .failure(generation: Self.generation(of: event), code: NativeBridgeReason.eventOverflow.rawValue) }; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value) }
    func terminal(_ event: RealtimeWebRTCBridgeEvent) { lock.lock(); guard terminal == nil else { lock.unlock(); return }; controls.removeAll(); activity = nil; terminal = event; finished = true; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value) }
    func finish() { lock.lock(); guard terminal == nil, ticket == nil else { lock.unlock(); return }; activeToken = nil; finished = true; let waiting = waiter; self.waiter = nil; lock.unlock(); waiting?.resume(returning: nil) }
    private func next() async -> RealtimeWebRTCBridgeEvent? { await withCheckedContinuation { continuation in lock.lock(); if let value = dequeue() { lock.unlock(); continuation.resume(returning: value) } else if finished { lock.unlock(); continuation.resume(returning: nil) } else { waiter = continuation; lock.unlock() } } }
    private func dequeue() -> RealtimeWebRTCBridgeEvent? { if let terminal { self.terminal = nil; return terminal }; if !controls.isEmpty { return controls.removeFirst() }; if let activity { self.activity = nil; return activity }; return nil }
    private static func generation(of event: RealtimeWebRTCBridgeEvent) -> UInt64 { switch event { case let .offer(generation, _), let .connectionState(generation, _), let .dataChannelState(generation, _), let .serverEvent(generation, _), let .audioActivity(generation, _, _), let .inputCaptureState(generation, _), let .answerApplied(generation), let .failure(generation, _): return generation; case .ready: return 0 } }
  }

  private final class NativePeerProxy: NSObject, LKRTCPeerConnectionDelegate, @unchecked Sendable {
    private final class Barrier: @unchecked Sendable { private let lock = NSLock(); private var resolved = false; private var continuation: CheckedContinuation<Void, Never>?; func resolve() { lock.lock(); guard !resolved else { lock.unlock(); return }; resolved = true; let c = continuation; continuation = nil; lock.unlock(); c?.resume() }; func wait() async { await withCheckedContinuation { c in lock.lock(); if resolved { lock.unlock(); c.resume() } else { continuation = c; lock.unlock() } } } }
    private final class Attachment: @unchecked Sendable { let track: LKRTCAudioTrack; let renderer: NativeRemoteAudioRenderer; let output: NativeOutputActivityPublisher; let barrier = Barrier(); var added = false; var started = false; init(track: LKRTCAudioTrack, renderer: NativeRemoteAudioRenderer, output: NativeOutputActivityPublisher) { self.track = track; self.renderer = renderer; self.output = output } }
    private enum OutputState { case empty; case attaching(Attachment); case attached(Attachment); case invalidated(Attachment?) }
    let token: NativeBridgeToken; let fence: NativeCallbackFence; let relay: NativeRealtimeWebRTCEventRelay; let terminal: @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void
    private let lock = NSLock(); private let output = NativeOutputActivityPublisher(); private let outputLane = DispatchQueue(label: "dev.rawkode.enchiridion.native-webrtc-output"); private var armed = false; private var pendingTerminal: NativeBridgeReason?; private var pendingRemoteTrack: LKRTCAudioTrack?; private var outputState: OutputState = .empty; private var iceGate: NativeRealtimeWebRTCOperationGate<Void>?; private var iceComplete = false; private var terminalLatched = false
    init(token: NativeBridgeToken, fence: NativeCallbackFence, relay: NativeRealtimeWebRTCEventRelay, terminal: @escaping @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void, armed: Bool) { self.token = token; self.fence = fence; self.relay = relay; self.terminal = terminal; self.armed = armed }
    /// Installs the callback snapshot synchronously. A latched terminal is
    /// returned rather than dispatched so the MainActor can claim teardown
    /// before ICE/output/offer work has a chance to run.
    func arm() -> NativeBridgeReason? {
      lock.lock(); armed = true
      let terminal = pendingTerminal
      if terminal != nil { terminalLatched = true; pendingRemoteTrack = nil }
      lock.unlock()
      return terminal
    }
    /// Called only after the bridge owns the snapshot and has activated its
    /// fence. This deliberately separates staging from SDK side effects.
    func replayStagedCallbacks() {
      lock.lock(); guard armed, pendingTerminal == nil else { lock.unlock(); return }
      let track = pendingRemoteTrack; pendingRemoteTrack = nil
      lock.unlock()
      if let track { beginOutputAttachment(track) }
    }
    private func isArmed() -> Bool { lock.lock(); defer { lock.unlock() }; return armed }
    func installICE(_ gate: NativeRealtimeWebRTCOperationGate<Void>) { lock.lock(); iceGate = gate; let complete = iceComplete; lock.unlock(); if complete { gate.succeed(()) } }
    func detachOutput() async {
      guard let attachment = beginDetach() else { return }
      await attachment.barrier.wait()
      await withCheckedContinuation { continuation in
        outputLane.async { [weak self, attachment] in
          if attachment.started { attachment.output.stop() }
          if attachment.added { attachment.track.remove(attachment.renderer) }
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
      guard pendingTerminal == nil, fence.isCurrent(token) else { lock.unlock(); return }
      lock.unlock()
      beginOutputAttachment(track)
    }
    private func beginOutputAttachment(_ track: LKRTCAudioTrack) {
      let attachment = Attachment(track: track, renderer: NativeRemoteAudioRenderer(slot: output.slot), output: output)
      lock.lock()
      guard armed, pendingTerminal == nil, case .empty = outputState, fence.isCurrent(token) else { lock.unlock(); return }
      outputState = .attaching(attachment)
      outputLane.async { [weak self, attachment] in self?.finishAttach(attachment) }
      lock.unlock()
    }
    private func finishAttach(_ attachment: Attachment) {
      lock.lock()
      guard case let .attaching(current) = outputState, current === attachment, fence.isCurrent(token) else { lock.unlock(); attachment.barrier.resolve(); return }
      lock.unlock()
      defer { attachment.barrier.resolve() }
      attachment.track.add(attachment.renderer); attachment.added = true
      attachment.output.start(token: token, fence: fence, relay: relay, terminal: terminal); attachment.started = true
      lock.lock()
      if case let .attaching(current) = outputState, current === attachment { outputState = .attached(attachment) }
      lock.unlock()
    }
    private func latchTerminal(_ reason: NativeBridgeReason) { lock.lock(); guard !terminalLatched, pendingTerminal == nil else { lock.unlock(); return }; if !armed { pendingTerminal = reason; lock.unlock(); return }; terminalLatched = true; lock.unlock(); fence.cancel(token); let token = token; let terminal = terminal; Task { @MainActor in terminal(token, reason) } }
    func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCSignalingState) {}; func peerConnection(_: LKRTCPeerConnection, didAdd _: LKRTCMediaStream) {}; func peerConnection(_: LKRTCPeerConnection, didRemove _: LKRTCMediaStream) {}; func peerConnectionShouldNegotiate(_: LKRTCPeerConnection) {}; func peerConnection(_: LKRTCPeerConnection, didGenerate _: LKRTCIceCandidate) {}; func peerConnection(_: LKRTCPeerConnection, didRemove _: [LKRTCIceCandidate]) {}; func peerConnection(_: LKRTCPeerConnection, didOpen _: LKRTCDataChannel) {}
  }
  private final class NativeChannelProxy: NSObject, LKRTCDataChannelDelegate, @unchecked Sendable {
    let token: NativeBridgeToken; let fence: NativeCallbackFence; let relay: NativeRealtimeWebRTCEventRelay; let terminal: @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void; private let lock = NSLock(); private var armed = false; private var pendingTerminal: NativeBridgeReason?
    init(token: NativeBridgeToken, fence: NativeCallbackFence, relay: NativeRealtimeWebRTCEventRelay, terminal: @escaping @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void, armed: Bool) { self.token = token; self.fence = fence; self.relay = relay; self.terminal = terminal; self.armed = armed }
    func arm() -> NativeBridgeReason? { lock.lock(); armed = true; let terminal = pendingTerminal; pendingTerminal = nil; lock.unlock(); return terminal }
    private func isArmed() -> Bool { lock.lock(); defer { lock.unlock() }; return armed }
    func dataChannelDidChangeState(_ channel: LKRTCDataChannel) { guard isArmed() else { return }; switch channel.readyState { case .connecting: enqueue(.dataChannelState(generation: token.generation, state: "connecting")); case .open: enqueue(.dataChannelState(generation: token.generation, state: "open")); case .closing, .closed: scheduleTerminal(.channelTerminal); default: scheduleTerminal(.channelUnknown) } }
    func dataChannel(_: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) { guard isArmed(), !buffer.isBinary, buffer.data.count <= RealtimeProtocolCodec.maximumEventBytes, let json = String(data: buffer.data, encoding: .utf8), fence.isCurrent(token) else { return }; enqueue(.serverEvent(generation: token.generation, json: json)) }
    private func enqueue(_ event: RealtimeWebRTCBridgeEvent) { if relay.enqueue(token, event) { scheduleTerminal(.eventOverflow) } }
    private func scheduleTerminal(_ reason: NativeBridgeReason) { lock.lock(); guard !armed else { lock.unlock(); fence.cancel(token); let token = token; let terminal = terminal; Task { @MainActor in terminal(token, reason) }; return }; if pendingTerminal == nil { pendingTerminal = reason }; lock.unlock() }
  }
  private final class NativeAudioLevelSlot: @unchecked Sendable { private let lock = NSLock(); private var level: Double = 0; func write(_ value: Double) { guard lock.try() else { return }; level = value; lock.unlock() }; func take() -> Double? { guard lock.try() else { return nil }; defer { lock.unlock() }; return level } }
  private final class NativeOutputActivityPublisher: @unchecked Sendable { let slot = NativeAudioLevelSlot(); private var timer: DispatchSourceTimer?; func start(token: NativeBridgeToken, fence: NativeCallbackFence, relay: NativeRealtimeWebRTCEventRelay, terminal: @escaping @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void) { guard timer == nil else { return }; let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "dev.rawkode.enchiridion.native-webrtc-meter")); timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50)); timer.setEventHandler { [slot, token, fence, relay] in guard fence.isCurrent(token), let value = slot.take() else { return }; if relay.enqueue(token, .audioActivity(generation: token.generation, inputLevel: 0, outputLevel: value)) { Task { @MainActor in terminal(token, .eventOverflow) } } }; self.timer = timer; timer.resume() }; func stop() { timer?.cancel(); timer = nil } }
  private final class NativeRemoteAudioRenderer: NSObject, LKRTCAudioRenderer { let slot: NativeAudioLevelSlot; init(slot: NativeAudioLevelSlot) { self.slot = slot }; func render(pcmBuffer: AVAudioPCMBuffer) { guard let channels = pcmBuffer.floatChannelData, pcmBuffer.frameLength > 0 else { return }; let values = channels[0]; var sum: Float = 0; for index in 0..<Int(pcmBuffer.frameLength) { sum += values[index] * values[index] }; slot.write(Double((sum / Float(pcmBuffer.frameLength)).squareRoot())) } }
#endif
