#if os(iOS)
import ApsidesCore
import AVFoundation
import Combine
import Foundation
@preconcurrency import WebRTC

/// Owns one foreground conversation. The server owns identity, model configuration and tools.
@MainActor
final class VoiceConversation: NSObject, ObservableObject {
    enum Phase: Equatable { case idle, connecting, connected, ended, failed }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var message = "Talk through your day."
    @Published private(set) var isMuted = false
    @Published private(set) var captions = VoiceCaptions()
    private let session: NativeSession
    private var factory: RTCPeerConnectionFactory?
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var microphone: RTCAudioTrack?
    private var sessionID: String?
    private var operation: UUID?
    private var stopping = false
    private var serverClosed = false
    private var startTask: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var interruption: AnyCancellable?

    init(session: NativeSession) {
        self.session = session
        super.init()
        interruption = NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)
            .receive(on: RunLoop.main).sink { [weak self] _ in
                Task { @MainActor in await self?.stop(message: "Audio was interrupted. Start again when you’re ready.") }
            }
    }

    func start() {
        guard operation == nil, !stopping else { return }
        serverClosed = false
        captions = VoiceCaptions()
        let token = UUID()
        operation = token
        phase = .connecting
        message = "Connecting…"
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                guard session.isConnected, session.accountID != nil else { throw NativeSession.SessionError.signInRequired }
                guard await AVAudioApplication.requestRecordPermission() else {
                    throw VoiceError.microphoneDenied
                }
                try check(token)
                try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
                try AVAudioSession.sharedInstance().setActive(true)
                RTCInitializeSSL()
                let factory = RTCPeerConnectionFactory()
                self.factory = factory
                let configuration = RTCConfiguration()
                configuration.sdpSemantics = .unifiedPlan
                let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
                guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else { throw VoiceError.connection }
                self.peer = peer
                let track = factory.audioTrack(with: factory.audioSource(with: constraints), trackId: "microphone")
                microphone = track
                peer.add(track, streamIds: ["voice"])
                let channel = peer.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
                self.channel = channel
                channel?.delegate = self
                guard channel != nil else { throw VoiceError.connection }
                let offer = try await peer.offer(for: RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil))
                try await peer.setLocalDescription(offer)
                let gatheringDeadline = Date().addingTimeInterval(10)
                while peer.iceGatheringState != .complete {
                    try check(token)
                    guard Date() < gatheringDeadline else { throw VoiceError.connection }
                    try await Task.sleep(for: .milliseconds(50))
                }
                try check(token)
                guard let sdp = peer.localDescription?.sdp else { throw VoiceError.connection }
                let answer = try await session.createVoiceSession(sdp: sdp, requestID: token.uuidString)
                // Stop during the HTTP request must still close a successfully created remote session.
                guard operation == token else { try? await session.endVoiceSession(id: answer.id); return }
                sessionID = answer.id
                try await peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer.sdp))
                try check(token)
                deadline = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled, let self, operation == token, phase == .connecting else { return }
                    deadline = nil
                    await stop(message: "The voice connection didn’t become ready. Please try again.", failed: true)
                }
            } catch {
                guard operation == token else { return }
                await stop(message: error.localizedDescription, failed: true)
            }
        }
    }

    func toggleMute() {
        guard phase == .connected, !stopping else { return }
        isMuted.toggle(); microphone?.isEnabled = !isMuted
    }

    func stop(message: String = "Conversation ended.", failed: Bool = false) async {
        guard !stopping else { return }
        stopping = true
        defer { stopping = false }
        operation = nil
        startTask = nil
        deadline?.cancel(); deadline = nil
        microphone?.isEnabled = false
        if !serverClosed, let channel, channel.readyState == .open {
            let command = Data("{\"type\":\"session.close\"}".utf8)
            _ = channel.sendData(RTCDataBuffer(data: command, isBinary: false))
            let end = Date().addingTimeInterval(3)
            while !serverClosed, Date() < end, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
        channel?.delegate = nil; channel?.close(); channel = nil
        peer?.delegate = nil; peer?.close(); peer = nil
        microphone = nil; factory = nil
        isMuted = false
        phase = failed ? .failed : .ended
        self.message = message
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        let id = sessionID; sessionID = nil
        if let id {
            do { try await session.endVoiceSession(id: id) }
            catch { self.message = "Audio stopped. The server could not confirm the session ended." }
        }
    }

    private func check(_ token: UUID) throws {
        try Task.checkCancellation()
        guard operation == token else { throw CancellationError() }
    }
    private enum VoiceError: LocalizedError {
        case microphoneDenied, connection
        var errorDescription: String? {
            switch self {
            case .microphoneDenied: "Allow microphone access in Settings to start a voice conversation."
            case .connection: "Couldn’t establish the audio connection. Please try again."
            }
        }
    }
}

extension VoiceConversation: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        Task { @MainActor [weak self] in
            guard let self, channel === dataChannel else { return }
            if dataChannel.readyState == .closed { await stop(message: "The audio connection ended.") }
        }
    }
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary, buffer.data.count <= 262_144,
              let event = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any],
              let type = event["type"] as? String else { return }
        let eventData = buffer.data
        Task { @MainActor [weak self] in
            guard let self, channel === dataChannel else { return }
            captions.receive(eventData)
            switch type {
            case "session.started":
                guard !stopping, operation != nil else { return }
                deadline?.cancel(); phase = .connected; message = "Listening. You can speak naturally."
            case "session.closed": serverClosed = true; if !stopping { await stop() }
            case "error": await stop(message: "The voice service reported a problem. Audio has stopped.", failed: true)
            default: break
            }
        }
    }
}
extension VoiceConversation: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        guard newState == .failed || newState == .disconnected else { return }
        Task { @MainActor [weak self] in
            guard let self, peer === peerConnection else { return }
            await stop(message: "The connection was interrupted. Start again when you’re ready.", failed: true)
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
#endif
