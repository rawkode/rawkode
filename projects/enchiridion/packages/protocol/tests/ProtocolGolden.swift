import Foundation

@main
enum ProtocolGolden {
  static func main() throws {
    let version = try EnchiridionProtocolVersion()
    let deviceID = try EnchiridionDeviceID("device-1")
    let signature = try EnchiridionP256Signature("MAYCAQECAQE=")
    let frame = SyncChangeFrame(
      type: "syncChange",
      protocolVersion: version,
      vaultID: try EnchiridionVaultID("vault-1"),
      deviceID: deviceID,
      authEpoch: try EnchiridionNonNegativeInt(3),
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
    guard EnchiridionSyncChangeSigningPayload.canonicalBytes(frame).base64EncodedString() == "RU5DSFNZTkMBAAAAATIAAAAHdmF1bHQtMQAAAAhkZXZpY2UtMQAAAAEzAAAACGNoYW5nZS0xAAAAATkAAAAWQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQAAAARBUUk9" else { throw GoldenFailure.mismatch("canonical signing payload") }
    guard EnchiridionHTTPClient.percentEncodedPathSegment("device/one ?#%") == "device%2Fone%20%3F%23%25" else { throw GoldenFailure.mismatch("RFC 3986 path segment encoding") }
    _ = try EnchiridionHTTPClient(baseURL: URL(string: "https://api.example.test")!)
    do { _ = try EnchiridionHTTPClient(baseURL: URL(string: "http://api.example.test")!); throw GoldenFailure.mismatch("HTTP base URL accepted") } catch EnchiridionAPIError.invalidBaseURL {}
  }
}

private enum GoldenFailure: Error { case mismatch(String) }
