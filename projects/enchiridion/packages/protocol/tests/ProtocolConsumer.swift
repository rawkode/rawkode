import Foundation
import EnchiridionProtocol

@main
enum ProtocolConsumer {
  static func main() throws {
    let request = DeviceRevokeRequest(
      protocolVersion: try EnchiridionProtocolVersion(),
      idempotencyKey: try EnchiridionIdentifier("request-1")
    )
    let encoded = try JSONEncoder().encode(request)
    let decoded = try JSONDecoder().decode(DeviceRevokeRequest.self, from: encoded)
    guard decoded == request else { throw ConsumerFailure.roundTrip }
    guard EnchiridionErrorCode.replayDetected.rawValue == "replay_detected" else { throw ConsumerFailure.errorCode }
    guard (try? EnchiridionFrameID("frame-1")) == nil else { throw ConsumerFailure.validation }
    _ = try EnchiridionP256Signature("MAYCAQECAQE=")
    _ = try EnchiridionP256SPKI("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==")
    guard (try? EnchiridionP256Signature("MAYCAQECAQEA")) == nil else { throw ConsumerFailure.validation }
    _ = try EnchiridionBase64Payload("AA==")
    guard (try? EnchiridionBase64Payload("AB==")) == nil else { throw ConsumerFailure.validation }
    guard (try? EnchiridionP256Signature("MAYCAQECAQF=")) == nil else { throw ConsumerFailure.validation }
    let spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    guard (try? EnchiridionP256SPKI(String(spki.dropLast(2)) + "B==")) == nil else { throw ConsumerFailure.validation }
    for suffix in ["B", "C", "D"] { guard (try? EnchiridionFrameID(String(repeating: "A", count: 21) + suffix)) == nil else { throw ConsumerFailure.validation } }
    let unknownMember = Data(#"{"protocolVersion":2,"idempotencyKey":"request-1","extra":true}"#.utf8)
    guard (try? JSONDecoder().decode(DeviceRevokeRequest.self, from: unknownMember)) == nil else { throw ConsumerFailure.validation }
    let wrongDiscriminator = Data(#"{"type":"other","supportedProtocolVersions":[2],"deviceID":"device-1","authEpoch":1}"#.utf8)
    guard (try? JSONDecoder().decode(HelloFrame.self, from: wrongDiscriminator)) == nil else { throw ConsumerFailure.validation }
  }
}

private enum ConsumerFailure: Error { case roundTrip, errorCode, validation }
