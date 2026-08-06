import Foundation
import EnchiridionProtocol

@main
enum ProtocolConsumer {
  static func main() async throws {
    let envelope = SignedDeviceRequestEnvelope(
      protocolVersion: try EnchiridionProtocolVersion(), method: .post,
      canonicalPath: try EnchiridionCanonicalPath("/v2/devices/device-1/revoke"),
      canonicalQuery: try EnchiridionCanonicalQuery(""), bodySHA256: try EnchiridionSHA256Digest(String(repeating: "0", count: 64)),
      requestID: try EnchiridionIdentifier("request-1"), idempotencyKey: try EnchiridionIdentifier("idem-1"), ownerID: try EnchiridionOwnerID("owner-1"), vaultID: try EnchiridionVaultID("vault-1"), generationEpoch: try EnchiridionGenerationEpoch(5), actorDeviceID: try EnchiridionDeviceID("device-1"), targetDeviceID: try EnchiridionDeviceID("device-2"), authEpoch: try EnchiridionAuthEpoch(3), credentialEpoch: try EnchiridionCredentialEpoch(4), issuedAt: try EnchiridionSignedTimestamp(1760000000000), expiresAt: try EnchiridionSignedTimestamp(1760000120000), nonce: try EnchiridionFrameID("AAAAAAAAAAAAAAAAAAAAAA"), deviceSignature: try EnchiridionP256Signature("MAYCAQECAQE=")
    )
    let request = DeviceRevokeRequest(envelope: envelope, command: DeviceRevokeCommand(type: "deviceRevoke", actorDeviceID: try EnchiridionDeviceID("device-1"), targetDeviceID: try EnchiridionDeviceID("device-2")))
    let encoded = try JSONEncoder().encode(request)
    let decoded = try JSONDecoder().decode(DeviceRevokeRequest.self, from: encoded)
    guard decoded == request else { throw ConsumerFailure.roundTrip }
    guard EnchiridionErrorCode.replayDetected.rawValue == "replay_detected" else { throw ConsumerFailure.errorCode }
    guard (try? EnchiridionFrameID("frame-1")) == nil else { throw ConsumerFailure.validation }
    _ = try EnchiridionP256Signature("MAYCAQECAQE=")
    _ = try EnchiridionP256Signature("MEQCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiAdJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew==")
    guard (try? EnchiridionP256Signature("MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY=")) == nil else { throw ConsumerFailure.validation }
    _ = try EnchiridionP256SPKI("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==")
    guard (try? EnchiridionP256Signature("MAYCAQECAQEA")) == nil else { throw ConsumerFailure.validation }
    _ = try EnchiridionBase64Payload("AA==")
    guard (try? EnchiridionBase64Payload("AB==")) == nil else { throw ConsumerFailure.validation }
    guard (try? EnchiridionP256Signature("MAYCAQECAQF=")) == nil else { throw ConsumerFailure.validation }
    let spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    guard (try? EnchiridionP256SPKI(String(spki.dropLast(2)) + "B==")) == nil else { throw ConsumerFailure.validation }
    for suffix in ["B", "C", "D"] { guard (try? EnchiridionFrameID(String(repeating: "A", count: 21) + suffix)) == nil else { throw ConsumerFailure.validation } }
    let unknownMember = Data(#"{"envelope":{},"command":{},"extra":true}"#.utf8)
    guard (try? JSONDecoder().decode(DeviceRevokeRequest.self, from: unknownMember)) == nil else { throw ConsumerFailure.validation }
    let wrongDiscriminator = Data(#"{"type":"other","supportedProtocolVersions":[2],"ownerID":"owner-1","vaultID":"vault-1","deviceID":"device-1","authEpoch":1,"credentialEpoch":1,"generationEpoch":1,"sessionNonce":"AAAAAAAAAAAAAAAAAAAAAA","assertionExpiresAt":1760000120000}"#.utf8)
    guard (try? JSONDecoder().decode(HelloFrame.self, from: wrongDiscriminator)) == nil else { throw ConsumerFailure.validation }
    let digest = try EnchiridionSHA256Digest(String(repeating: "a", count: 64))
    let deleteCommand = BlobDeleteCommand(type: "blobDelete", blobSHA256: digest)
    let deleteHash = try EnchiridionCanonicalJSON.sha256Hex(deleteCommand)
    let deleteEnvelope = SignedDeviceRequestEnvelope(protocolVersion: try EnchiridionProtocolVersion(), method: .delete, canonicalPath: try EnchiridionCanonicalPath("/v2/blobs/\(digest.value)"), canonicalQuery: try EnchiridionCanonicalQuery(""), bodySHA256: try EnchiridionSHA256Digest(deleteHash), requestID: try EnchiridionIdentifier("delete-1"), idempotencyKey: try EnchiridionIdentifier("delete-idem"), ownerID: try EnchiridionOwnerID("owner-1"), vaultID: try EnchiridionVaultID("vault-1"), generationEpoch: try EnchiridionGenerationEpoch(5), actorDeviceID: try EnchiridionDeviceID("device-1"), targetDeviceID: nil, authEpoch: try EnchiridionAuthEpoch(3), credentialEpoch: try EnchiridionCredentialEpoch(4), issuedAt: try EnchiridionSignedTimestamp(1760000000000), expiresAt: try EnchiridionSignedTimestamp(1760000120000), nonce: try EnchiridionFrameID("AAAAAAAAAAAAAAAAAAAAAA"), deviceSignature: try EnchiridionP256Signature("MAYCAQECAQE="))
    let capture = CaptureTransport()
    let client = try EnchiridionHTTPClient(baseURL: URL(string: "https://api.example.test")!, transport: capture)
    _ = try await client.deleteBlob(BlobDeleteRequest(envelope: deleteEnvelope, command: deleteCommand), accessToken: "token")
    let expectedDeleteHeader = EnchiridionSignedRequestHeader.value(deleteEnvelope)
    guard !expectedDeleteHeader.isEmpty,
      capture.request?.httpMethod == "DELETE",
      capture.request?.httpBody == nil,
      capture.request?.url?.path == "/v2/blobs/\(digest.value)",
      capture.request?.value(forHTTPHeaderField: EnchiridionSignedRequestHeader.name) == expectedDeleteHeader
    else { throw ConsumerFailure.validation }
  }
}

private enum ConsumerFailure: Error { case roundTrip, errorCode, validation }

private final class CaptureTransport: @unchecked Sendable, EnchiridionHTTPTransport {
  var request: URLRequest?
  func execute(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    self.request = request
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
    return (Data(#"{"protocolVersion":2,"mutationID":"delete-1","acceptedAt":1760000000000}"#.utf8), response)
  }
}
