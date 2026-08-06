#if os(iOS)
  import Foundation
  @preconcurrency import LiveKitWebRTC

  enum NativeWebRTCOfferPreflightError: Error, Equatable {
    case peerCreationFailed
    case offerCreationFailed
    case invalidOffer
  }

  struct NativeWebRTCOfferPreflightResult: Equatable, Sendable {
    let sdp: String
    let dataChannelLabel: String
    let isDataChannelOrdered: Bool
    let hasLocalAudioSource: Bool
  }

  /// A no-network proof that the pinned LiveKitWebRTC build can make the exact
  /// offer shape required by the future native transport. It has no bootstrap,
  /// credentials, capture, or playback dependencies.
  @MainActor
  enum NativeWebRTCOfferPreflight {
    static func create() async throws -> NativeWebRTCOfferPreflightResult {
      let audio = SystemLiveKitRTCAudioSessionBacking()
      audio.configureManualAudioDisabled()

      let factory = LKRTCPeerConnectionFactory()
      let configuration = LKRTCConfiguration()
      configuration.sdpSemantics = .unifiedPlan
      let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
      let delegate = Delegate()
      guard let peer = factory.peerConnection(
        with: configuration, constraints: constraints, delegate: delegate
      ) else { throw NativeWebRTCOfferPreflightError.peerCreationFailed }
      defer { peer.close() }

      let transceiverInit = LKRTCRtpTransceiverInit()
      transceiverInit.direction = .sendRecv
      guard let transceiver = peer.addTransceiver(of: .audio, init: transceiverInit) else {
        throw NativeWebRTCOfferPreflightError.peerCreationFailed
      }
      let hasLocalAudioSource = transceiver.sender.track != nil
      guard !hasLocalAudioSource else { throw NativeWebRTCOfferPreflightError.invalidOffer }

      let channelConfiguration = LKRTCDataChannelConfiguration()
      channelConfiguration.isOrdered = true
      guard let channel = peer.dataChannel(
        forLabel: "oai-events", configuration: channelConfiguration
      ) else { throw NativeWebRTCOfferPreflightError.peerCreationFailed }
      defer { channel.close() }

      let offer = try await peer.offer(constraints: constraints)
      try await peer.setLocal(description: offer)
      // Candidate gathering may update localDescription.  The preflight proves
      // the exact final SDP handed to the transport, never the provisional offer.
      guard let finalSDP = peer.localDescription?.sdp, validates(finalSDP) else {
        throw NativeWebRTCOfferPreflightError.invalidOffer
      }
      return .init(
        sdp: finalSDP,
        dataChannelLabel: channel.label,
        isDataChannelOrdered: channel.isOrdered,
        hasLocalAudioSource: hasLocalAudioSource
      )
    }

    static func validates(_ sdp: String) -> Bool {
      guard !sdp.isEmpty, sdp.utf8.count <= 128 * 1024 else { return false }
      let lines = sdp.split(whereSeparator: \.isNewline).map(String.init)
      let audioSections = lines.filter { $0.hasPrefix("m=audio ") }
      guard audioSections.count == 1,
        !lines.contains(where: { $0.hasPrefix("m=video ") }),
        lines.contains(where: { $0.hasPrefix("m=application ") })
      else { return false }

      guard let audioStart = lines.firstIndex(where: { $0.hasPrefix("m=audio ") }) else { return false }
      let audioEnd = lines[audioStart...].dropFirst().firstIndex(where: { $0.hasPrefix("m=") })
        ?? lines.endIndex
      return lines[audioStart..<audioEnd].contains("a=sendrecv")
    }

    private final class Delegate: NSObject, LKRTCPeerConnectionDelegate {
      func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCSignalingState) {}
      func peerConnection(_: LKRTCPeerConnection, didAdd _: LKRTCMediaStream) {}
      func peerConnection(_: LKRTCPeerConnection, didRemove _: LKRTCMediaStream) {}
      func peerConnectionShouldNegotiate(_: LKRTCPeerConnection) {}
      func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCIceConnectionState) {}
      func peerConnection(_: LKRTCPeerConnection, didChange _: LKRTCIceGatheringState) {}
      func peerConnection(_: LKRTCPeerConnection, didGenerate _: LKRTCIceCandidate) {}
      func peerConnection(_: LKRTCPeerConnection, didRemove _: [LKRTCIceCandidate]) {}
      func peerConnection(_: LKRTCPeerConnection, didOpen _: LKRTCDataChannel) {}
    }
  }

  private extension LKRTCPeerConnection {
    func offer(constraints: LKRTCMediaConstraints) async throws -> LKRTCSessionDescription {
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<LKRTCSessionDescription, Error>) in
        offer(for: constraints) { description, error in
          if let description { continuation.resume(returning: description) }
          else { continuation.resume(throwing: error ?? NativeWebRTCOfferPreflightError.offerCreationFailed) }
        }
      }
    }

    func setLocal(description: LKRTCSessionDescription) async throws {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        setLocalDescription(description) { error in
          if let error { continuation.resume(throwing: error) }
          else { continuation.resume() }
        }
      }
    }
  }
#endif
