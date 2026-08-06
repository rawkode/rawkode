#if DEBUG && os(iOS)
  import EnchiridionCore
  import Foundation
  @preconcurrency import LiveKitWebRTC

  /// Debug-only, credential-blind implementation of the existing narrow
  /// bridge seam. The transport remains responsible for the bootstrap HTTP
  /// exchange and for every credential-bearing decision.
  @MainActor
  final class NativeRealtimeWebRTCBridge: NSObject, RealtimeWebRTCBridging {
    private static let maximumControlEvents = 256
    private static let maximumSDPBytes = 128 * 1024
    private static let offerDeadline: Duration = .seconds(6)

    private let factory = LKRTCPeerConnectionFactory()
    private let ingress = NativeRealtimeWebRTCIngress()
    private var lifecycle = RealtimeWebRTCBridgeLifecycleState()
    private var authorization = RealtimeWebRTCBridgeAuthorizationState()
    private var continuations: [UUID: AsyncStream<RealtimeWebRTCBridgeEvent>.Continuation] = [:]
    private var peer: LKRTCPeerConnection?
    private var audioTransceiver: LKRTCRtpTransceiver?
    private var channel: LKRTCDataChannel?
    private var peerProxy: PeerProxy?
    private var channelProxy: ChannelProxy?
    private var inputSource: LKRTCAudioSource?
    private var inputTrack: LKRTCAudioTrack?
    private var newestLease: RealtimeVoiceInputLease?
    private var emittedReady = false

    override init() {
      super.init()
      ingress.installDrain { [weak self] in self?.drainIngress() }
    }

    func load() throws {
      guard lifecycle.currentEpoch != nil else { throw RealtimeVoiceTransportError.bridgeClosed }
      if !emittedReady { emittedReady = true; emit(.ready) }
    }

    func authorize(_ capability: RealtimeWebRTCBridgeAuthorization, generation: UInt64) async throws {
      guard let epoch = lifecycle.beginAuthorization(), capability.authorizes(generation: generation) else {
        throw RealtimeVoiceTransportError.bridgeClosed
      }
      invalidateMedia()
      authorization.revoke()
      guard lifecycle.isCurrent(epoch) else { throw RealtimeVoiceTransportError.bridgeClosed }
      do { try authorization.activate(capability, generation: generation) }
      catch { throw RealtimeVoiceTransportError.bridgeClosed }
    }

    func start(generation: UInt64) async throws {
      guard authorization.authorizes(generation: generation), let epoch = lifecycle.currentEpoch else {
        throw RealtimeVoiceTransportError.bridgeClosed
      }
      invalidateMedia()
      let configuration = LKRTCConfiguration()
      configuration.sdpSemantics = .unifiedPlan
      let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
      let proxy = PeerProxy(generation: generation, epoch: epoch, ingress: ingress)
      guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: proxy) else {
        throw RealtimeVoiceTransportError.bridgeClosed
      }
      let transceiverInit = LKRTCRtpTransceiverInit()
      transceiverInit.direction = .sendRecv
      guard let transceiver = peer.addTransceiver(of: .audio, init: transceiverInit), transceiver.sender.track == nil else {
        peer.close(); throw RealtimeVoiceTransportError.bridgeClosed
      }
      let channelConfig = LKRTCDataChannelConfiguration()
      channelConfig.isOrdered = true
      guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfig) else {
        peer.close(); throw RealtimeVoiceTransportError.bridgeClosed
      }
      let dataProxy = ChannelProxy(generation: generation, epoch: epoch, ingress: ingress)
      channel.delegate = dataProxy
      self.peer = peer; audioTransceiver = transceiver; self.channel = channel
      peerProxy = proxy; channelProxy = dataProxy
      do {
        let offer = try await peer.makeOffer(constraints: constraints)
        guard isCurrent(epoch, generation), self.peer === peer else { throw CancellationError() }
        try await peer.setLocal(offer)
        guard isCurrent(epoch, generation), self.peer === peer else { throw CancellationError() }
        if peer.iceGatheringState != .complete {
          try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await proxy.waitForICEComplete() }
            group.addTask { try await Task.sleep(for: Self.offerDeadline) }
            defer { group.cancelAll() }
            _ = try await group.next()
            if peer.iceGatheringState != .complete { throw RealtimeVoiceTransportError.bridgeClosed }
          }
        }
        guard let finalSDP = peer.localDescription?.sdp,
              NativeWebRTCOfferPreflight.validates(finalSDP), isCurrent(epoch, generation) else {
          throw RealtimeVoiceTransportError.bridgeClosed
        }
        emit(.offer(generation: generation, sdp: finalSDP))
      } catch {
        fail(generation: generation, epoch: epoch, code: "bridge_failed")
        throw RealtimeVoiceTransportError.bridgeClosed
      }
    }

    func applyAnswer(_ sdp: String, generation: UInt64) async throws {
      guard let epoch = lifecycle.currentEpoch, isCurrent(epoch, generation), sdp.utf8.count <= Self.maximumSDPBytes, let peer else {
        throw RealtimeVoiceTransportError.bridgeClosed
      }
      do {
        try await peer.setRemote(LKRTCSessionDescription(type: .answer, sdp: sdp))
        guard isCurrent(epoch, generation), self.peer === peer else { throw CancellationError() }
        emit(.answerApplied(generation: generation))
      } catch { throw RealtimeVoiceTransportError.bridgeClosed }
    }

    func sendEvent(_ json: String, generation: UInt64) async throws {
      guard let epoch = lifecycle.currentEpoch, isCurrent(epoch, generation), json.utf8.count <= RealtimeProtocolCodec.maximumEventBytes,
            let channel, channel.readyState == .open,
            channel.sendData(LKRTCDataBuffer(data: Data(json.utf8), isBinary: false)) else {
        throw RealtimeVoiceTransportError.bridgeClosed
      }
    }

    func setInputEnabled(_ enabled: Bool, lease: RealtimeVoiceInputLease) async throws {
      guard let epoch = lifecycle.currentEpoch, isCurrent(epoch, lease.transportGeneration),
              newestLease.map({ lease.inputEpoch > $0.inputEpoch }) ?? true,
              let sender = audioTransceiver?.sender else { throw RealtimeVoiceTransportError.bridgeClosed }
      newestLease = lease
      // Detach synchronously before releasing retained capture objects. This
      // deliberately leaves LiveKit's global output gate untouched.
      if !enabled {
        sender.track = nil
        guard sender.track == nil, isCurrent(epoch, lease.transportGeneration), newestLease == lease else {
          throw RealtimeVoiceTransportError.bridgeClosed
        }
        inputTrack = nil; inputSource = nil
        return
      }
      let source = factory.audioSource(with: nil)
      let track = factory.audioTrack(with: source, trackId: "enchiridion-input")
      guard isCurrent(epoch, lease.transportGeneration), newestLease == lease else { throw RealtimeVoiceTransportError.bridgeClosed }
      sender.track = track
      guard sender.track != nil, isCurrent(epoch, lease.transportGeneration), newestLease == lease else {
        sender.track = nil; throw RealtimeVoiceTransportError.bridgeClosed
      }
      inputSource = source; inputTrack = track
    }

    func stop() async {
      guard lifecycle.stop() != nil else { return }
      authorization.revoke(); invalidateMedia(); ingress.finish()
      let values = continuations.values; continuations.removeAll()
      for continuation in values { continuation.finish() }
    }

    func events() -> AsyncStream<RealtimeWebRTCBridgeEvent> {
      let id = UUID()
      return AsyncStream { continuation in
        continuations[id] = continuation
        continuation.onTermination = { [weak self] _ in
          Task { @MainActor in self?.continuations.removeValue(forKey: id) }
        }
      }
    }

    private func isCurrent(_ epoch: UInt64, _ generation: UInt64) -> Bool {
      lifecycle.isCurrent(epoch) && authorization.authorizes(generation: generation)
    }
    private func emit(_ event: RealtimeWebRTCBridgeEvent) { for c in continuations.values { c.yield(event) } }
    private func invalidateMedia() {
      // Fence proxy callbacks before the peer/channel are allowed to close.
      inputTrack = nil; inputSource = nil; audioTransceiver?.sender.track = nil
      channel?.delegate = nil; channel?.close(); channel = nil; channelProxy = nil
      peer?.close(); peer = nil; peerProxy = nil; audioTransceiver = nil; newestLease = nil
    }
    private func fail(generation: UInt64, epoch: UInt64, code: String) {
      guard isCurrent(epoch, generation) else { return }
      _ = lifecycle.beginAuthorization(); authorization.revoke(); invalidateMedia()
      emit(.failure(generation: generation, code: code))
    }
    private func drainIngress() {
      for item in ingress.drain() {
        guard isCurrent(item.epoch, item.generation) else { continue }
        emit(item.event)
      }
    }
  }

  private extension LKRTCPeerConnection {
    func makeOffer(constraints: LKRTCMediaConstraints) async throws -> LKRTCSessionDescription {
      try await withCheckedThrowingContinuation { continuation in
        offer(for: constraints) { description, error in
          if let description { continuation.resume(returning: description) }
          else { continuation.resume(throwing: error ?? RealtimeVoiceTransportError.bridgeClosed) }
        }
      }
    }
    func setLocal(_ description: LKRTCSessionDescription) async throws {
      try await withCheckedThrowingContinuation { continuation in
        setLocalDescription(description) { error in error.map { continuation.resume(throwing: $0) } ?? continuation.resume() }
      }
    }
    func setRemote(_ description: LKRTCSessionDescription) async throws {
      try await withCheckedThrowingContinuation { continuation in
        setRemoteDescription(description) { error in error.map { continuation.resume(throwing: $0) } ?? continuation.resume() }
      }
    }
  }

  private final class NativeRealtimeWebRTCIngress: @unchecked Sendable {
    struct Item { let generation: UInt64; let epoch: UInt64; let event: RealtimeWebRTCBridgeEvent }
    private let lock = NSLock(); private var items: [Item] = []; private var scheduled = false; private var finished = false
    private var drainHandler: (() -> Void)?
    func installDrain(_ handler: @escaping () -> Void) { lock.lock(); drainHandler = handler; lock.unlock() }
    func push(_ item: Item) {
      lock.lock(); defer { lock.unlock() }
      guard !finished else { return }
      if items.count == 256 {
        finished = true; items = [Item(generation: item.generation, epoch: item.epoch, event: .failure(generation: item.generation, code: "event_overflow"))]
      } else { items.append(item) }
      guard !scheduled else { return }; scheduled = true
      DispatchQueue.main.async { [weak self] in self?.drainHandler?() }
    }
    func drain() -> [Item] { lock.lock(); defer { lock.unlock() }; scheduled = false; let value = items; items.removeAll(keepingCapacity: true); return value }
    func finish() { lock.lock(); finished = true; items.removeAll(); lock.unlock() }
  }

  private final class PeerProxy: NSObject, @unchecked Sendable, LKRTCPeerConnectionDelegate {
    let generation: UInt64; let epoch: UInt64; let ingress: NativeRealtimeWebRTCIngress
    private var iceContinuation: CheckedContinuation<Void, Error>?
    init(generation: UInt64, epoch: UInt64, ingress: NativeRealtimeWebRTCIngress) { self.generation = generation; self.epoch = epoch; self.ingress = ingress }
    func waitForICEComplete() async throws { try await withCheckedThrowingContinuation { iceContinuation = $0 } }
    func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCSignalingState) {}
    func peerConnection(_: LKRTCPeerConnection, didAdd _: LKRTCMediaStream) {}
    func peerConnection(_: LKRTCPeerConnection, didRemove _: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_: LKRTCPeerConnection) {}
    func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCIceConnectionState) {}
    func peerConnection(_: LKRTCPeerConnection, didChange state: LKRTCIceGatheringState) { if state == .complete { iceContinuation?.resume(); iceContinuation = nil } }
    func peerConnection(_: LKRTCPeerConnection, didGenerate _: LKRTCIceCandidate) {}
    func peerConnection(_: LKRTCPeerConnection, didRemove _: [LKRTCIceCandidate]) {}
    func peerConnection(_: LKRTCPeerConnection, didOpen _: LKRTCDataChannel) {}
  }
  private final class ChannelProxy: NSObject, LKRTCDataChannelDelegate {
    let generation: UInt64; let epoch: UInt64; let ingress: NativeRealtimeWebRTCIngress
    init(generation: UInt64, epoch: UInt64, ingress: NativeRealtimeWebRTCIngress) { self.generation = generation; self.epoch = epoch; self.ingress = ingress }
    func dataChannelDidChangeState(_ channel: LKRTCDataChannel) { let state = ["connecting", "open", "closing", "closed"][Int(channel.readyState.rawValue)]; ingress.push(.init(generation: generation, epoch: epoch, event: .dataChannelState(generation: generation, state: state))) }
    func dataChannel(_: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
      guard !buffer.isBinary, buffer.data.count <= RealtimeProtocolCodec.maximumEventBytes, let text = String(data: buffer.data, encoding: .utf8) else { return }
      ingress.push(.init(generation: generation, epoch: epoch, event: .serverEvent(generation: generation, json: text)))
    }
  }
#endif
