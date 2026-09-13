#if os(iOS) || os(macOS)
import ApsidesCore
import AVFoundation
import Combine
import Foundation
#if os(macOS)
import AppKit
#endif
@preconcurrency import WebRTC

enum VoiceSurface: String { case iphone, carplay, mac }

/// Owns one foreground conversation. The server owns identity, model configuration and tools.
@MainActor
final class VoiceConversation: NSObject, ObservableObject {
    enum Phase: Equatable { case idle, connecting, connected, ended, failed }
    @Published private(set) var surface: VoiceSurface?
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var message = "Talk through your day."
    @Published private(set) var isMuted = false
    @Published private(set) var isSendingText = false
    private var textOperation: UUID?
    @Published private(set) var captions = VoiceCaptions()
    #if os(iOS)
    struct AudioOutput: Identifiable {
        let id: String
        let name: String
    }
    @Published private(set) var audioOutputName = "Speaker"
    @Published private(set) var audioOutputs: [AudioOutput] = []
    @Published private(set) var audioOutputError: String?
    private var routeObservation: AnyCancellable?
    #endif
    #if ENCHIRIDION_VOICE_AUDIO_HARNESS
    var harnessAudioDevice: RTCAudioDevice?
    private(set) var harnessEndConfirmed = false
    #endif
    private let session: NativeSession
    private var factory: RTCPeerConnectionFactory?
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var microphone: RTCAudioTrack?
    private var sessionID: String?
    private var operation: UUID?
    private var stopping = false
    private var localTeardownPending = false
    private var serverClosed = false
    private var startTask: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var interruption: AnyCancellable?
    private var authorization: AnyCancellable?
    private var observedAccountID: String?
    private var observedConnected = false
    private var activeAccountID: String?

    init(session: NativeSession) {
        self.session = session
        super.init()
        observedAccountID = session.accountID
        observedConnected = session.isConnected
        authorization = session.$accountID.combineLatest(session.$isConnected).sink { [weak self] accountID, connected in
            guard let self else { return }
            // @Published sends before assignment. Use the emitted identity and connection values.
            let revoked = accountID != observedAccountID || (observedConnected && !connected)
            observedAccountID = accountID
            observedConnected = connected
            if revoked && (surface != nil || !captions.rows.isEmpty) { stopForAccountChange() }
        }
        #if os(iOS)
        #if !ENCHIRIDION_VOICE_AUDIO_HARNESS
        routeObservation = NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)
            .receive(on: RunLoop.main).sink { [weak self] _ in
                self?.refreshAudioOutputs()
            }
        interruption = NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)
            .receive(on: RunLoop.main).sink { [weak self] _ in
                Task { @MainActor in await self?.stop(message: "Audio was interrupted. Start again when you’re ready.") }
            }
        #endif
        #else
        interruption = NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)
            .receive(on: RunLoop.main).sink { [weak self] _ in
                Task { @MainActor in await self?.stop(message: "The Mac went to sleep. Start again when you’re ready.") }
            }
        #endif
    }

    func start(surface requestedSurface: VoiceSurface, preservingHistory: Bool = false) {
        guard surface == nil, operation == nil, !stopping, !localTeardownPending, !isSendingText else { return }
        surface = requestedSurface
        activeAccountID = session.accountID
        serverClosed = false
        let history = preservingHistory ? conversationHistory : []
        if preservingHistory { captions.beginSegment() } else { captions = VoiceCaptions() }
        let token = UUID()
        operation = token
        phase = .connecting
        message = "Connecting…"
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                guard session.isConnected, session.accountID != nil else { throw NativeSession.SessionError.signInRequired }
                #if ENCHIRIDION_VOICE_AUDIO_HARNESS
                let permitted = harnessAudioDevice != nil
                #elseif os(iOS)
                let permitted = await AVAudioApplication.requestRecordPermission()
                #else
                let permitted = await AVCaptureDevice.requestAccess(for: .audio)
                #endif
                guard permitted else {
                    throw VoiceError.microphoneDenied
                }
                try check(token)
                #if os(iOS) && !ENCHIRIDION_VOICE_AUDIO_HARNESS
                // WebRTC reapplies this configuration when its audio device starts.
                // Setting AVAudioSession alone loses defaultToSpeaker at that point.
                try configureAudioOutput(defaultToSpeaker: requestedSurface == .iphone)
                try AVAudioSession.sharedInstance().setActive(true)
                audioOutputError = nil
                refreshAudioOutputs()
                #endif
                RTCInitializeSSL()
                #if ENCHIRIDION_VOICE_AUDIO_HARNESS
                let factory = RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: nil, audioDevice: harnessAudioDevice!)
                #else
                let factory = RTCPeerConnectionFactory()
                #endif
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
                let answer = try await session.createVoiceSession(sdp: sdp, requestID: token.uuidString, device: requestedSurface.rawValue, history: history)
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

    #if os(iOS)
    private func configureAudioOutput(defaultToSpeaker: Bool) throws {
        let configuration = RTCAudioSessionConfiguration.webRTC()
        configuration.category = AVAudioSession.Category.playAndRecord.rawValue
        configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
        configuration.categoryOptions = defaultToSpeaker ? [.allowBluetoothHFP, .defaultToSpeaker] : [.allowBluetoothHFP]
        RTCAudioSessionConfiguration.setWebRTC(configuration)
        let audio = RTCAudioSession.sharedInstance()
        audio.lockForConfiguration()
        defer { audio.unlockForConfiguration() }
        try audio.setConfiguration(configuration)
    }

    private func refreshAudioOutputs() {
        let audio = AVAudioSession.sharedInstance()
        audioOutputs = (audio.availableInputs ?? []).filter { $0.portType != .builtInMic }
            .map { AudioOutput(id: $0.uid, name: $0.portName) }
        guard surface == .iphone else { return }
        audioOutputName = audio.currentRoute.outputs.map {
            switch $0.portType {
            case .builtInSpeaker: "Speaker"
            case .builtInReceiver: "iPhone"
            default: $0.portName
            }
        }.joined(separator: ", ")
        if audioOutputName.isEmpty { audioOutputName = "Audio" }
    }

    /// Route selection is explicit; automatic route changes continue to respect accessories.
    func selectAudioOutput(_ id: String) {
        guard surface == .iphone, phase == .connected || phase == .connecting, !stopping else { return }
        let session = AVAudioSession.sharedInstance()
        let input = id == "speaker" || id == "receiver"
            ? session.availableInputs?.first { $0.portType == .builtInMic }
            : session.availableInputs?.first { $0.uid == id }
        guard let input else { audioOutputError = "That audio device is no longer available."; return }
        do {
            try configureAudioOutput(defaultToSpeaker: id == "speaker")
            let audio = RTCAudioSession.sharedInstance()
            audio.lockForConfiguration()
            defer { audio.unlockForConfiguration() }
            try audio.overrideOutputAudioPort(.none)
            try audio.setPreferredInput(input)
            if id == "speaker" { try audio.overrideOutputAudioPort(.speaker) }
            audioOutputError = nil
            refreshAudioOutputs()
        } catch {
            audioOutputError = "Couldn’t switch audio. Try choosing the output again."
            refreshAudioOutputs()
        }
    }
    #endif

    private var conversationHistory: [[String: String]] {
        var remaining = 12_000
        return captions.rows.suffix(20).reversed().compactMap { row in
            guard remaining > 0, !row.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            var text = String(row.text.prefix(min(remaining, 4_000)))
            while text.utf16.count > min(remaining, 4_000) { text.removeLast() }
            remaining -= text.utf16.count
            return ["role": row.speaker.rawValue, "content": text]
        }.reversed()
    }

    func sendText(_ text: String) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 4_000, !isSendingText, surface == nil, !stopping, session.isConnected else { return false }
        let token = UUID()
        textOperation = token
        let account = session.accountID
        let history = conversationHistory
        isSendingText = true
        message = "Working…"
        captions.appendMessage(text, speaker: .user)
        defer { if textOperation == token { isSendingText = false; textOperation = nil } }
        do {
            let reply = try await session.sendAgentMessage(text, history: history)
            guard textOperation == token, session.accountID == account, session.isConnected else { return true }
            captions.appendMessage(reply, speaker: .assistant)
            message = ""
        } catch {
            guard textOperation == token, session.accountID == account else { return true }
            message = "Couldn’t confirm the reply. A requested change may have completed. Check before trying again."
        }
        return true
    }

    func toggleMute(surface requestedSurface: VoiceSurface) {
        guard surface == requestedSurface, phase == .connected, !stopping else { return }
        isMuted.toggle(); microphone?.isEnabled = !isMuted
    }

    func stop(surface requestedSurface: VoiceSurface) async {
        guard surface == requestedSurface else { return }
        await stop()
    }

    /// Identity changes cannot leave a prior account's captions or media alive during remote cleanup.
    func stopForAccountChange() {
        textOperation = nil
        isSendingText = false
        disconnectLocalTransport()
        captions = VoiceCaptions()
        Task { await stop(message: "Your account changed. Start a new conversation.") }
    }

    #if os(macOS)
    /// Called synchronously by the owning NSWindow before it closes, even during connection setup.
    func stopForWindowClose() {
        guard surface == .mac else { return }
        disconnectLocalTransport()
        Task { await stop() }
    }
    #endif

    private func disconnectLocalTransport() {
        localTeardownPending = true
        operation = nil
        microphone?.isEnabled = false
        channel?.delegate = nil; channel?.close(); channel = nil
        peer?.delegate = nil; peer?.close(); peer = nil
        microphone = nil; factory = nil
    }

    private func stop(message: String = "Conversation ended.", failed: Bool = false) async {
        guard !stopping else { return }
        stopping = true
        defer { stopping = false; localTeardownPending = false; surface = nil; activeAccountID = nil }
        operation = nil
        startTask = nil
        deadline?.cancel(); deadline = nil
        microphone?.isEnabled = false
        if !serverClosed, let channel, channel.readyState == .open {
            let command = Data("{\"type\":\"session.close\"}".utf8)
            _ = channel.sendData(RTCDataBuffer(data: command, isBinary: false))
            let end = Date().addingTimeInterval(3)
            while !serverClosed, channel.readyState == .open, Date() < end, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
        channel?.delegate = nil; channel?.close(); channel = nil
        peer?.delegate = nil; peer?.close(); peer = nil
        microphone = nil; factory = nil
        isMuted = false
        phase = failed ? .failed : .ended
        self.message = message
        #if os(iOS) && !ENCHIRIDION_VOICE_AUDIO_HARNESS
        let audio = RTCAudioSession.sharedInstance()
        audio.lockForConfiguration()
        try? audio.overrideOutputAudioPort(.none)
        // The SDK wrapper marks this argument nonnull; AVAudioSession accepts nil to reset it.
        try? AVAudioSession.sharedInstance().setPreferredInput(nil)
        audio.unlockForConfiguration()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        audioOutputError = nil
        #endif
        let id = sessionID; sessionID = nil
        if let id {
            do {
                try await session.endVoiceSession(id: id)
                #if ENCHIRIDION_VOICE_AUDIO_HARNESS
                harnessEndConfirmed = true
                #endif
            }
            catch { self.message = "Audio stopped. The server could not confirm the session ended." }
        }
    }

    private func check(_ token: UUID) throws {
        try Task.checkCancellation()
        guard operation == token, session.isConnected, session.accountID == activeAccountID else { throw CancellationError() }
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
