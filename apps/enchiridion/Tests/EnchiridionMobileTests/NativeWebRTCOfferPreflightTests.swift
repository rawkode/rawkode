import XCTest

@testable import Enchiridion

#if os(iOS)
  @MainActor
  final class NativeWebRTCOfferPreflightTests: XCTestCase {
    func testValidationRejectsInvalidAndUnexpectedOfferShapes() {
      XCTAssertFalse(NativeWebRTCOfferPreflight.validates(""))
      XCTAssertFalse(NativeWebRTCOfferPreflight.validates("m=audio 9 UDP/TLS/RTP/SAVPF 111\na=sendrecv"))
      XCTAssertFalse(
        NativeWebRTCOfferPreflight.validates(
          "m=audio 9 UDP/TLS/RTP/SAVPF 111\na=sendrecv\nm=video 9 UDP/TLS/RTP/SAVPF 96\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel"
        )
      )
    }

    func testRealSDKCreatesAudioAndOrderedDataChannelOfferWithoutLocalSource() async throws {
      let offer = try await NativeWebRTCOfferPreflight.create()

      XCTAssertTrue(NativeWebRTCOfferPreflight.validates(offer.sdp))
      XCTAssertEqual(offer.dataChannelLabel, "oai-events")
      XCTAssertTrue(offer.isDataChannelOrdered)
      XCTAssertFalse(offer.hasLocalAudioSource)
    }
  }
#endif
