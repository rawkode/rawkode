// This file intentionally exercises no network, credential, microphone, or playback path.
// It is a compile-only API boundary for a later native WebRTC transport package.
@preconcurrency import LiveKitWebRTC

enum NativeWebRTCCompatibilityProbe {
  /// Proves the exact low-level API surface needed by a future transport. The
  /// application never invokes this compile-only probe; there is no video API.
  static func compileOnlyPeerSetup(
    factory: LKRTCPeerConnectionFactory,
    delegate: any LKRTCPeerConnectionDelegate
  ) {
    let configuration = LKRTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan

    let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let peerConnection = factory.peerConnection(
      with: configuration, constraints: constraints, delegate: delegate
    ) else { return }

    let dataChannelConfiguration = LKRTCDataChannelConfiguration()
    dataChannelConfiguration.isOrdered = true
    let dataChannel = peerConnection.dataChannel(
      forLabel: "oai-events", configuration: dataChannelConfiguration
    )

    let transceiverConfiguration = LKRTCRtpTransceiverInit()
    transceiverConfiguration.direction = .sendRecv
    let audioTransceiver = peerConnection.addTransceiver(of: .audio, init: transceiverConfiguration)

    // The kind-based initializer has no local sender track. A future runtime
    // must retain this invariant until explicit input enablement.
    let localSenderTrack: LKRTCMediaStreamTrack? = audioTransceiver?.sender.track
    _ = localSenderTrack

    peerConnection.offer(for: constraints) { localDescription, _ in
      guard let localDescription else { return }
      peerConnection.setLocalDescription(localDescription) { _ in }
    }
    dataChannel?.close()
    peerConnection.close()
  }

  #if os(iOS)
    static func compileOnlyIOSManualAudioControl() {
      let audioSession = LKRTCAudioSession.sharedInstance()
      audioSession.lockForConfiguration()
      defer { audioSession.unlockForConfiguration() }
      audioSession.useManualAudio = true
      audioSession.isAudioEnabled = false
    }
  #elseif os(macOS)
    static func compileOnlyMacAudioDeviceModule(factory: LKRTCPeerConnectionFactory) {
      let audioDeviceModule: LKRTCAudioDeviceModule = factory.audioDeviceModule
      _ = audioDeviceModule
    }
  #endif
}
