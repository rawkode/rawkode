#if DEBUG && os(iOS)
  import AVFoundation
  import EnchiridionCore
  import Foundation
  @preconcurrency import LiveKitWebRTC

  struct NativeBridgeToken: Sendable, Equatable { let generation: UInt64; let epoch: UInt64 }
  private enum NativeBridgeReason: String, Sendable { case bridgeFailed = "bridge_failed", peerTerminal = "peer_terminal", peerUnknown = "peer_unknown", channelTerminal = "channel_terminal", channelUnknown = "channel_unknown", eventOverflow = "event_overflow" }
  private struct NativeSessionDescription: Sendable { enum Kind: Sendable { case offer, answer }; let kind: Kind; let sdp: String }

  @MainActor
  final class NativeRealtimeWebRTCBridge: NSObject, RealtimeWebRTCBridging {
    private enum State: Equatable { case idle, loading(UInt64), active(NativeBridgeToken), overflowPending(NativeBridgeToken), terminal, stopped }
    private static let maximumSDPBytes = 128 * 1024
    private static let deadline = Duration.seconds(6)
    private let factory = LKRTCPeerConnectionFactory()
    private let fence = NativeCallbackFence()
    private let relay = NativeRealtimeWebRTCEventRelay()
    private var lifecycle = RealtimeWebRTCBridgeLifecycleState()
    private var state: State = .idle
    private var nextLoadNonce: UInt64 = 0
    private var resourceOwner: NativeBridgeToken?
    private var authorization = RealtimeWebRTCBridgeAuthorizationState()
    private var peer: LKRTCPeerConnection?
    private var transceiver: LKRTCRtpTransceiver?
    private var channel: LKRTCDataChannel?
    private var peerProxy: NativePeerProxy?
    private var channelProxy: NativeChannelProxy?
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
      teardownIfOwned(token)
      let configuration = LKRTCConfiguration(); configuration.sdpSemantics = .unifiedPlan
      let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
      let terminal: @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void = { [weak self] token, reason in self?.terminal(token, reason) }
      let proxy = NativePeerProxy(token: token, fence: fence, relay: relay, terminal: terminal)
      guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: proxy) else { throw RealtimeVoiceTransportError.bridgeClosed }
      let transceiverInit = LKRTCRtpTransceiverInit(); transceiverInit.direction = .sendRecv
      guard let transceiver = peer.addTransceiver(of: .audio, init: transceiverInit), transceiver.sender.track == nil else { peer.close(); throw RealtimeVoiceTransportError.bridgeClosed }
      let channelConfiguration = LKRTCDataChannelConfiguration(); channelConfiguration.isOrdered = true
      guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfiguration) else { peer.close(); throw RealtimeVoiceTransportError.bridgeClosed }
      let channelProxy = NativeChannelProxy(token: token, fence: fence, relay: relay, terminal: terminal)
      channel.delegate = channelProxy
      self.peer = peer; self.transceiver = transceiver; self.channel = channel; self.peerProxy = proxy; self.channelProxy = channelProxy; resourceOwner = token
      let clock = ContinuousClock(); let start = clock.now
      do {
        let offerGate = NativeRealtimeWebRTCOperationGate<NativeSessionDescription>()
        fence.register(offerGate, token: token)
        peer.offer(for: constraints) { description, _ in
          guard let description, description.sdp.utf8.count <= Self.maximumSDPBytes else { offerGate.fail(); return }
          offerGate.succeed(.init(kind: .offer, sdp: description.sdp))
        }
        let offer = try await offerGate.wait(timeout: Self.remaining(from: start, clock: clock))
        guard isCurrent(token), self.peer === peer, offer.kind == .offer, NativeWebRTCOfferPreflight.validates(offer.sdp) else { throw RealtimeVoiceTransportError.bridgeClosed }
        let iceGate = NativeRealtimeWebRTCOperationGate<Void>(); proxy.installICE(iceGate); fence.register(iceGate, token: token)
        let localGate = NativeRealtimeWebRTCOperationGate<Void>(); fence.register(localGate, token: token)
        peer.setLocalDescription(.init(type: .offer, sdp: offer.sdp)) { error in error == nil ? localGate.succeed(()) : localGate.fail() }
        _ = try await localGate.wait(timeout: Self.remaining(from: start, clock: clock))
        if peer.iceGatheringState != .complete { _ = try await iceGate.wait(timeout: Self.remaining(from: start, clock: clock)) }
        guard isCurrent(token), self.peer === peer, let final = peer.localDescription?.sdp, final.utf8.count <= Self.maximumSDPBytes, NativeWebRTCOfferPreflight.validates(final) else { throw RealtimeVoiceTransportError.bridgeClosed }
        enqueue(token, .offer(generation: generation, sdp: final))
      } catch { terminal(token, .bridgeFailed); throw RealtimeVoiceTransportError.bridgeClosed }
    }

    func applyAnswer(_ sdp: String, generation: UInt64) async throws {
      guard case let .active(token) = state, token.generation == generation, sdp.utf8.count <= Self.maximumSDPBytes, let peer else { throw RealtimeVoiceTransportError.bridgeClosed }
      let gate = NativeRealtimeWebRTCOperationGate<Void>(); fence.register(gate, token: token)
      peer.setRemoteDescription(.init(type: .answer, sdp: sdp)) { error in error == nil ? gate.succeed(()) : gate.fail() }
      do { _ = try await gate.wait(timeout: Self.deadline) } catch { throw RealtimeVoiceTransportError.bridgeClosed }
      guard isCurrent(token), self.peer === peer else { throw RealtimeVoiceTransportError.bridgeClosed }
      enqueue(token, .answerApplied(generation: generation))
    }

    func sendEvent(_ json: String, generation: UInt64) async throws {
      guard case let .active(token) = state, token.generation == generation, json.utf8.count <= RealtimeProtocolCodec.maximumEventBytes, let channel, channel.readyState == .open, channel.sendData(.init(data: Data(json.utf8), isBinary: false)) else { throw RealtimeVoiceTransportError.bridgeClosed }
    }

    func setInputEnabled(_ enabled: Bool, lease: RealtimeVoiceInputLease) async throws {
      guard case let .active(token) = state, token.generation == lease.transportGeneration, newestLease.map({ lease.inputEpoch > $0.inputEpoch }) ?? true, let sender = transceiver?.sender else { throw RealtimeVoiceTransportError.bridgeClosed }
      newestLease = lease
      if !enabled { sender.track = nil; inputTrack = nil; inputSource = nil; guard newestLease == lease else { throw RealtimeVoiceTransportError.bridgeClosed }; return }
      let source = factory.audioSource(with: nil); let track = factory.audioTrack(with: source, trackId: "enchiridion-input")
      guard newestLease == lease, isCurrent(token) else { throw RealtimeVoiceTransportError.bridgeClosed }
      sender.track = track; guard sender.track === track, isCurrent(token), newestLease == lease else { sender.track = nil; throw RealtimeVoiceTransportError.bridgeClosed }; inputSource = source; inputTrack = track
    }

    func stop() async { guard state != .stopped, lifecycle.stop() != nil else { return }; if let resourceOwner { teardownIfOwned(resourceOwner) }; authorization.revoke(); state = .stopped; relay.finish() }
    private static func remaining(from start: ContinuousClock.Instant, clock: ContinuousClock) -> Duration { let elapsed = start.duration(to: clock.now); return elapsed < deadline ? deadline - elapsed : .zero }
    private func isCurrent(_ token: NativeBridgeToken) -> Bool { state == .active(token) && lifecycle.isCurrent(token.epoch) && authorization.authorizes(generation: token.generation) }
    private func enqueue(_ token: NativeBridgeToken, _ event: RealtimeWebRTCBridgeEvent) { if relay.enqueue(token, event) { state = .overflowPending(token); Task { @MainActor [weak self, token] in self?.terminal(token, .eventOverflow) } } }
    private func terminal(_ token: NativeBridgeToken, _ reason: NativeBridgeReason) { guard state == .active(token) || state == .overflowPending(token) else { return }; state = .terminal; authorization.revoke(); teardownIfOwned(token); relay.completeTerminal(token, event: .failure(generation: token.generation, code: reason.rawValue)) }
    private func teardownIfOwned(_ token: NativeBridgeToken) { guard resourceOwner == token else { return }; fence.invalidate(token.epoch); peerProxy?.detachOutput(); inputTrack = nil; inputSource = nil; transceiver?.sender.track = nil; channel?.delegate = nil; channel?.close(); channel = nil; channelProxy = nil; peer?.close(); peer = nil; peerProxy = nil; transceiver = nil; newestLease = nil; resourceOwner = nil }
  }

  private final class NativeCallbackFence: @unchecked Sendable {
    private let lock = NSLock(); private var token: NativeBridgeToken?; private var gates: [NativeGateInvalidating] = []
    func register(_ gate: NativeGateInvalidating, token: NativeBridgeToken) { lock.lock(); guard self.token == nil || self.token == token else { lock.unlock(); gate.invalidate(); return }; self.token = token; gates.append(gate); lock.unlock() }
    func isCurrent(_ token: NativeBridgeToken) -> Bool { lock.lock(); defer { lock.unlock() }; return self.token == token }
    func invalidate(_ epoch: UInt64) { lock.lock(); token = nil; let values = gates; gates.removeAll(); lock.unlock(); values.forEach { $0.invalidate() } }
  }
  private protocol NativeGateInvalidating: AnyObject { func invalidate() }
  final class NativeRealtimeWebRTCOperationGate<Value: Sendable>: NativeGateInvalidating, @unchecked Sendable {
    private enum Outcome { case value(Value), failed }
    private let lock = NSLock(); private var outcome: Outcome?; private var continuation: CheckedContinuation<Value, Error>?; private var timer: DispatchSourceTimer?
    func succeed(_ value: Value) { resolve(.value(value)) }; func fail() { resolve(.failed) }; func invalidate() { resolve(.failed) }
    private func resolve(_ outcome: Outcome) { lock.lock(); guard self.outcome == nil else { lock.unlock(); return }; self.outcome = outcome; let continuation = self.continuation; self.continuation = nil; let timer = self.timer; self.timer = nil; lock.unlock(); timer?.cancel(); guard let continuation else { return }; switch outcome { case let .value(value): continuation.resume(returning: value); case .failed: continuation.resume(throwing: RealtimeVoiceTransportError.bridgeClosed) } }
    func wait(timeout: Duration) async throws -> Value { try await withTaskCancellationHandler(operation: { try await withCheckedThrowingContinuation { continuation in lock.lock(); if let outcome { lock.unlock(); switch outcome { case let .value(value): continuation.resume(returning: value); case .failed: continuation.resume(throwing: RealtimeVoiceTransportError.bridgeClosed) }; return }; self.continuation = continuation; let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated)); timer.schedule(deadline: .now() + timeout.timeInterval); timer.setEventHandler { [self] in fail() }; self.timer = timer; lock.unlock(); timer.resume() } }, onCancel: { self.invalidate() }) }
  }
  private extension Duration { var timeInterval: DispatchTimeInterval { .nanoseconds(Int(components.seconds * 1_000_000_000) + Int(components.attoseconds / 1_000_000_000)) } }

  final class NativeRealtimeWebRTCEventRelay: @unchecked Sendable {
    private let lock = NSLock(); private var activeToken: NativeBridgeToken?; private var pendingReady: UInt64?; private var overflowPending = false; private var controls: [RealtimeWebRTCBridgeEvent] = []; private var terminal: RealtimeWebRTCBridgeEvent?; private var activity: RealtimeWebRTCBridgeEvent?; private var waiter: CheckedContinuation<RealtimeWebRTCBridgeEvent?, Never>?; private var consumer = false; private var finished = false
    func stream() -> AsyncStream<RealtimeWebRTCBridgeEvent> { lock.lock(); guard !consumer else { lock.unlock(); return AsyncStream(unfolding: { nil }) }; consumer = true; lock.unlock(); return AsyncStream(unfolding: { await self.next() }) }
    func storeReady(_ nonce: UInt64) { lock.lock(); guard !finished else { lock.unlock(); return }; pendingReady = nonce; lock.unlock() }
    func bind(_ token: NativeBridgeToken, nonce: UInt64) -> Bool { lock.lock(); guard !finished, activeToken == nil, pendingReady == nonce else { lock.unlock(); return false }; activeToken = token; pendingReady = nil; controls.append(.ready); let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value); return true }
    /// Returns true exactly for the atomic 257th-control transition. The caller
    /// must tear down resources before completing the reserved failure slot.
    func enqueue(_ token: NativeBridgeToken, _ event: RealtimeWebRTCBridgeEvent) -> Bool { lock.lock(); guard !finished, !overflowPending, activeToken == token else { lock.unlock(); return false }; if case .audioActivity = event { activity = event } else if controls.count < 256 { controls.append(event) } else { activeToken = nil; controls.removeAll(); activity = nil; overflowPending = true; lock.unlock(); return true }; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value); return false }
    func completeTerminal(_ token: NativeBridgeToken, event: RealtimeWebRTCBridgeEvent) { lock.lock(); guard !finished, (overflowPending || activeToken == token) else { lock.unlock(); return }; activeToken = nil; overflowPending = false; controls.removeAll(); activity = nil; terminal = event; finished = true; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value) }
    func push(_ event: RealtimeWebRTCBridgeEvent) { lock.lock(); guard !finished else { lock.unlock(); return }; if case .audioActivity = event { activity = event } else if controls.count < 256 { controls.append(event) } else { controls.removeAll(); activity = nil; finished = true; terminal = .failure(generation: Self.generation(of: event), code: NativeBridgeReason.eventOverflow.rawValue) }; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value) }
    func terminal(_ event: RealtimeWebRTCBridgeEvent) { lock.lock(); guard terminal == nil else { lock.unlock(); return }; controls.removeAll(); activity = nil; terminal = event; finished = true; let waiting = waiter; self.waiter = nil; let value = waiting == nil ? nil : dequeue(); lock.unlock(); waiting?.resume(returning: value) }
    func finish() { lock.lock(); guard terminal == nil else { lock.unlock(); return }; activeToken = nil; overflowPending = false; finished = true; let waiting = waiter; self.waiter = nil; lock.unlock(); waiting?.resume(returning: nil) }
    private func next() async -> RealtimeWebRTCBridgeEvent? { await withCheckedContinuation { continuation in lock.lock(); if let value = dequeue() { lock.unlock(); continuation.resume(returning: value) } else if finished { lock.unlock(); continuation.resume(returning: nil) } else { waiter = continuation; lock.unlock() } } }
    private func dequeue() -> RealtimeWebRTCBridgeEvent? { if let terminal { self.terminal = nil; return terminal }; if !controls.isEmpty { return controls.removeFirst() }; if let activity { self.activity = nil; return activity }; return nil }
    private static func generation(of event: RealtimeWebRTCBridgeEvent) -> UInt64 { switch event { case let .offer(generation, _), let .connectionState(generation, _), let .dataChannelState(generation, _), let .serverEvent(generation, _), let .audioActivity(generation, _, _), let .inputCaptureState(generation, _), let .answerApplied(generation), let .failure(generation, _): return generation; case .ready: return 0 } }
  }

  private final class NativePeerProxy: NSObject, LKRTCPeerConnectionDelegate, @unchecked Sendable {
    let token: NativeBridgeToken; let fence: NativeCallbackFence; let relay: NativeRealtimeWebRTCEventRelay; let terminal: @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void
    private let lock = NSLock(); private let output = NativeOutputActivityPublisher(); private var iceGate: NativeRealtimeWebRTCOperationGate<Void>?; private var iceComplete = false; private var terminalLatched = false; private var track: LKRTCAudioTrack?; private var renderer: NativeRemoteAudioRenderer?
    init(token: NativeBridgeToken, fence: NativeCallbackFence, relay: NativeRealtimeWebRTCEventRelay, terminal: @escaping @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void) { self.token = token; self.fence = fence; self.relay = relay; self.terminal = terminal }
    func installICE(_ gate: NativeRealtimeWebRTCOperationGate<Void>) { lock.lock(); iceGate = gate; let complete = iceComplete; lock.unlock(); if complete { gate.succeed(()) } }
    func detachOutput() { output.stop(); if let track, let renderer { track.remove(renderer) }; track = nil; renderer = nil }
    func peerConnection(_: LKRTCPeerConnection, didChange state: LKRTCIceConnectionState) { switch state { case .failed, .closed: scheduleTerminal(.peerTerminal); case .new, .checking, .connected, .completed, .count: break; default: scheduleTerminal(.peerUnknown) } }
    func peerConnection(_: LKRTCPeerConnection, didChange state: LKRTCIceGatheringState) { guard state == .complete else { return }; lock.lock(); iceComplete = true; let gate = iceGate; lock.unlock(); gate?.succeed(()) }
    func peerConnection(_: LKRTCPeerConnection, didStartReceivingOn transceiver: LKRTCRtpTransceiver) { guard track == nil, let track = transceiver.receiver.track as? LKRTCAudioTrack, fence.isCurrent(token) else { return }; let renderer = NativeRemoteAudioRenderer(slot: output.slot); self.track = track; self.renderer = renderer; track.add(renderer); output.start(token: token, fence: fence, relay: relay, terminal: terminal) }
    private func scheduleTerminal(_ reason: NativeBridgeReason) { lock.lock(); guard !terminalLatched else { lock.unlock(); return }; terminalLatched = true; lock.unlock(); let token = token; let terminal = terminal; Task { @MainActor in terminal(token, reason) } }
    func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCSignalingState) {}; func peerConnection(_: LKRTCPeerConnection, didAdd _: LKRTCMediaStream) {}; func peerConnection(_: LKRTCPeerConnection, didRemove _: LKRTCMediaStream) {}; func peerConnectionShouldNegotiate(_: LKRTCPeerConnection) {}; func peerConnection(_: LKRTCPeerConnection, didGenerate _: LKRTCIceCandidate) {}; func peerConnection(_: LKRTCPeerConnection, didRemove _: [LKRTCIceCandidate]) {}; func peerConnection(_: LKRTCPeerConnection, didOpen _: LKRTCDataChannel) {}
  }
  private final class NativeChannelProxy: NSObject, LKRTCDataChannelDelegate, @unchecked Sendable {
    let token: NativeBridgeToken; let fence: NativeCallbackFence; let relay: NativeRealtimeWebRTCEventRelay; let terminal: @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void
    init(token: NativeBridgeToken, fence: NativeCallbackFence, relay: NativeRealtimeWebRTCEventRelay, terminal: @escaping @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void) { self.token = token; self.fence = fence; self.relay = relay; self.terminal = terminal }
    func dataChannelDidChangeState(_ channel: LKRTCDataChannel) { switch channel.readyState { case .connecting: enqueue(.dataChannelState(generation: token.generation, state: "connecting")); case .open: enqueue(.dataChannelState(generation: token.generation, state: "open")); case .closing, .closed: scheduleTerminal(.channelTerminal); default: scheduleTerminal(.channelUnknown) } }
    func dataChannel(_: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) { guard !buffer.isBinary, buffer.data.count <= RealtimeProtocolCodec.maximumEventBytes, let json = String(data: buffer.data, encoding: .utf8), fence.isCurrent(token) else { return }; enqueue(.serverEvent(generation: token.generation, json: json)) }
    private func enqueue(_ event: RealtimeWebRTCBridgeEvent) { if relay.enqueue(token, event) { scheduleTerminal(.eventOverflow) } }
    private func scheduleTerminal(_ reason: NativeBridgeReason) { let token = token; let terminal = terminal; Task { @MainActor in terminal(token, reason) } }
  }
  private final class NativeAudioLevelSlot: @unchecked Sendable { private let lock = NSLock(); private var level: Double = 0; func write(_ value: Double) { guard lock.try() else { return }; level = value; lock.unlock() }; func take() -> Double? { guard lock.try() else { return nil }; defer { lock.unlock() }; return level } }
  private final class NativeOutputActivityPublisher: @unchecked Sendable { let slot = NativeAudioLevelSlot(); private var timer: DispatchSourceTimer?; func start(token: NativeBridgeToken, fence: NativeCallbackFence, relay: NativeRealtimeWebRTCEventRelay, terminal: @escaping @MainActor @Sendable (NativeBridgeToken, NativeBridgeReason) -> Void) { guard timer == nil else { return }; let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "dev.rawkode.enchiridion.native-webrtc-meter")); timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50)); timer.setEventHandler { [slot, token, fence, relay] in guard fence.isCurrent(token), let value = slot.take() else { return }; if relay.enqueue(token, .audioActivity(generation: token.generation, inputLevel: 0, outputLevel: value)) { Task { @MainActor in terminal(token, .eventOverflow) } } }; self.timer = timer; timer.resume() }; func stop() { timer?.cancel(); timer = nil } }
  private final class NativeRemoteAudioRenderer: NSObject, LKRTCAudioRenderer { let slot: NativeAudioLevelSlot; init(slot: NativeAudioLevelSlot) { self.slot = slot }; func render(pcmBuffer: AVAudioPCMBuffer) { guard let channels = pcmBuffer.floatChannelData, pcmBuffer.frameLength > 0 else { return }; let values = channels[0]; var sum: Float = 0; for index in 0..<Int(pcmBuffer.frameLength) { sum += values[index] * values[index] }; slot.write(Double((sum / Float(pcmBuffer.frameLength)).squareRoot())) } }
#endif
