import Foundation
import EnchiridionProtocol

@main
enum ProtocolGolden {
  static func main() throws {
    let version = try EnchiridionProtocolVersion()
    let deviceID = try EnchiridionDeviceID("device-1")
    let signature = try EnchiridionP256Signature("MAYCAQECAQE=")
    _ = try EnchiridionP256Signature("MEQCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiAdJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew==")
    guard (try? EnchiridionP256Signature("MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY=")) == nil else { throw GoldenFailure.mismatch("high-S signature accepted") }
    let challengeProof = DeviceChallengeProof(protocolVersion: version, challengeID: try EnchiridionIdentifier("challenge-1"), challengeAudience: try EnchiridionText256("enchiridion"), challengeBase64: try EnchiridionBase64Payload("AQI="), expiresAt: try EnchiridionSignedTimestamp(1760000120000), nonce: try EnchiridionFrameID("AAAAAAAAAAAAAAAAAAAAAA"), devicePublicKey: try EnchiridionP256SPKI("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="), signature: signature)
    guard !EnchiridionDeviceChallengeProofSigningPayload.canonicalBytes(challengeProof).isEmpty else { throw GoldenFailure.mismatch("challenge proof bytes") }
    guard EnchiridionDeviceChallengeProofSigningPayload.canonicalBytes(challengeProof).base64EncodedString() == "RU5DSENIQUwBAAAAATIAAAALY2hhbGxlbmdlLTEAAAALZW5jaGlyaWRpb24AAAAEQVFJPQAAAA0xNzYwMDAwMTIwMDAwAAAAFkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEAAAB8TUZrd0V3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FFQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE9PQ==" else { throw GoldenFailure.mismatch("challenge proof vector") }
    let headerEnvelope = SignedDeviceRequestEnvelope(protocolVersion: version, method: .post, canonicalPath: try EnchiridionCanonicalPath("/v2/mutations"), canonicalQuery: try EnchiridionCanonicalQuery(""), bodySHA256: try EnchiridionSHA256Digest(String(repeating: "0", count: 64)), requestID: try EnchiridionIdentifier("request-1"), idempotencyKey: try EnchiridionIdentifier("idem-1"), ownerID: try EnchiridionOwnerID("owner-1"), vaultID: try EnchiridionVaultID("vault-1"), generationEpoch: try EnchiridionGenerationEpoch(5), actorDeviceID: deviceID, targetDeviceID: nil, authEpoch: try EnchiridionAuthEpoch(3), credentialEpoch: try EnchiridionCredentialEpoch(4), issuedAt: try EnchiridionSignedTimestamp(1760000000000), expiresAt: try EnchiridionSignedTimestamp(1760000120000), nonce: try EnchiridionFrameID("AAAAAAAAAAAAAAAAAAAAAA"), deviceSignature: signature)
    guard EnchiridionSignedRequestHeader.value(headerEnvelope) == "eyJhY3RvckRldmljZUlEIjoiZGV2aWNlLTEiLCJhdXRoRXBvY2giOjMsImJvZHlTSEEyNTYiOiIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwiY2Fub25pY2FsUGF0aCI6Ii92Mi9tdXRhdGlvbnMiLCJjYW5vbmljYWxRdWVyeSI6IiIsImNyZWRlbnRpYWxFcG9jaCI6NCwiZGV2aWNlU2lnbmF0dXJlIjoiTUFZQ0FRRUNBUUU9IiwiZXhwaXJlc0F0IjoxNzYwMDAwMTIwMDAwLCJnZW5lcmF0aW9uRXBvY2giOjUsImlkZW1wb3RlbmN5S2V5IjoiaWRlbS0xIiwiaXNzdWVkQXQiOjE3NjAwMDAwMDAwMDAsIm1ldGhvZCI6IlBPU1QiLCJub25jZSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUEiLCJvd25lcklEIjoib3duZXItMSIsInByb3RvY29sVmVyc2lvbiI6MiwicmVxdWVzdElEIjoicmVxdWVzdC0xIiwidGFyZ2V0RGV2aWNlSUQiOm51bGwsInZhdWx0SUQiOiJ2YXVsdC0xIn0" else { throw GoldenFailure.mismatch("signed header vector") }
    let frame = SyncChangeFrame(
      type: "syncChange",
      protocolVersion: version,
      vaultID: try EnchiridionVaultID("vault-1"),
      deviceID: deviceID,
      authEpoch: try EnchiridionAuthEpoch(3),
      credentialEpoch: try EnchiridionCredentialEpoch(4),
      generationEpoch: try EnchiridionGenerationEpoch(5),
      sessionNonce: try EnchiridionFrameID("AAAAAAAAAAAAAAAAAAAAAA"),
      assertionExpiresAt: try EnchiridionSignedTimestamp(1760000120000),
      changeID: try EnchiridionIdentifier("change-1"),
      causalVersion: try EnchiridionNonNegativeInt(9),
      frameID: try EnchiridionFrameID("AAAAAAAAAAAAAAAAAAAAAA"),
      signingPayloadVersion: try EnchiridionSigningPayloadVersion(),
      payloadBase64: try EnchiridionBase64Payload("AQI="),
      deviceSignature: signature
    )
    let wire = EnchiridionClientWebSocketFrame.syncChange(frame)
    let decoded = try JSONDecoder().decode(EnchiridionClientWebSocketFrame.self, from: JSONEncoder().encode(wire))
    guard decoded == wire else { throw GoldenFailure.mismatch("WebSocket Codable round trip") }
    let originalSigningBytes = EnchiridionSyncChangeSigningPayload.canonicalBytes(frame)
    let changedEpoch = SyncChangeFrame(type: "syncChange", protocolVersion: version, vaultID: try EnchiridionVaultID("vault-1"), deviceID: deviceID, authEpoch: try EnchiridionAuthEpoch(3), credentialEpoch: try EnchiridionCredentialEpoch(6), generationEpoch: try EnchiridionGenerationEpoch(5), sessionNonce: try EnchiridionFrameID("AAAAAAAAAAAAAAAAAAAAAA"), assertionExpiresAt: try EnchiridionSignedTimestamp(1760000120000), changeID: try EnchiridionIdentifier("change-1"), causalVersion: try EnchiridionNonNegativeInt(9), frameID: try EnchiridionFrameID("AAAAAAAAAAAAAAAAAAAAAA"), signingPayloadVersion: try EnchiridionSigningPayloadVersion(), payloadBase64: try EnchiridionBase64Payload("AQI="), deviceSignature: signature)
    guard originalSigningBytes != EnchiridionSyncChangeSigningPayload.canonicalBytes(changedEpoch) else { throw GoldenFailure.mismatch("session epoch signing payload") }
    guard EnchiridionHTTPClient.percentEncodedPathSegment("device/one ?#%") == "device%2Fone%20%3F%23%25" else { throw GoldenFailure.mismatch("RFC 3986 path segment encoding") }
    _ = try EnchiridionHTTPClient(baseURL: URL(string: "https://api.example.test")!)
    do { _ = try EnchiridionHTTPClient(baseURL: URL(string: "http://api.example.test")!); throw GoldenFailure.mismatch("HTTP base URL accepted") } catch EnchiridionAPIError.invalidBaseURL {}
  }
}

private enum GoldenFailure: Error { case mismatch(String) }
