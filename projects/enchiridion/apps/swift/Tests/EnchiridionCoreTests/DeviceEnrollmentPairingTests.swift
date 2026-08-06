// DeviceEnrollmentPairingTests.swift
// EnchiridionCoreTests
//
// Covers DeviceEnrollmentPairing.swift's four independent pieces:
// pairing-code generation/validation (mirrors workers/vault/src/
// enroll-routes.ts's format), the QR/manual-code payload codec, the
// `/enroll/provision` HTTP client's real request shape (via a `URLProtocol`
// stub, the same pattern `EnchiridionAPITests/VaultEmailSearchClientTests.swift`
// established), and the expiry-warning decision logic.

import Foundation
import XCTest

@testable import EnchiridionCore

// MARK: - Pairing code

final class PairingCodeTests: XCTestCase {
  func testGeneratedCodeMatchesTheValidatedFormat() {
    for _ in 0..<50 {
      let code = PairingCode.generate()
      XCTAssertTrue(PairingCode.isValidFormat(code), "\(code) failed its own format check")
    }
  }

  func testGeneratedCodeExcludesVisuallyAmbiguousCharacters() {
    for _ in 0..<200 {
      let code = PairingCode.generate()
      for forbidden in "0O1IL" {
        XCTAssertFalse(code.contains(forbidden), "\(code) contains ambiguous character \(forbidden)")
      }
    }
  }

  func testIsValidFormatRejectsMalformedCodes() {
    XCTAssertFalse(PairingCode.isValidFormat("abcd-efgh")) // lowercase
    XCTAssertFalse(PairingCode.isValidFormat("ABCDEFGH")) // missing hyphen
    XCTAssertFalse(PairingCode.isValidFormat("ABC-DEFGH")) // wrong grouping
    XCTAssertFalse(PairingCode.isValidFormat("AB0D-EFGH")) // ambiguous char "0"
    XCTAssertFalse(PairingCode.isValidFormat("")) // empty
  }

  func testIsValidFormatAcceptsAWellFormedCode() {
    XCTAssertTrue(PairingCode.isValidFormat("ABCD-2345"))
  }

  func testGenerateIsDeterministicUnderASeededGenerator() {
    struct FixedGenerator: RandomNumberGenerator {
      func next() -> UInt64 { 42 }
    }
    var first = FixedGenerator()
    var second = FixedGenerator()
    XCTAssertEqual(PairingCode.generate(using: &first), PairingCode.generate(using: &second))
  }
}

// MARK: - Payload codec

final class DeviceEnrollmentPairingCodecTests: XCTestCase {
  private func samplePayload() -> DeviceEnrollmentPairingPayload {
    DeviceEnrollmentPairingPayload(
      pairingCode: "ABCD-2345",
      deviceName: "David's iPad",
      clientId: "minted-client-id.access",
      clientSecret: "minted-client-secret",
      mintedAt: Date(timeIntervalSince1970: 1_700_000_000),
      expiresAt: Date(timeIntervalSince1970: 1_700_000_000 + 8760 * 60 * 60)
    )
  }

  func testEncodeThenDecodeRoundTrips() throws {
    let payload = samplePayload()
    let encoded = try DeviceEnrollmentPairingCodec.encode(payload)
    let decoded = try DeviceEnrollmentPairingCodec.decode(encoded)
    XCTAssertEqual(decoded, payload)
  }

  func testDecodeTrimsSurroundingWhitespaceFromAPastedCode() throws {
    let payload = samplePayload()
    let encoded = try DeviceEnrollmentPairingCodec.encode(payload)
    let decoded = try DeviceEnrollmentPairingCodec.decode("  \n\(encoded)\n  ")
    XCTAssertEqual(decoded, payload)
  }

  func testDecodeThrowsMalformedForGarbageInput() {
    XCTAssertThrowsError(try DeviceEnrollmentPairingCodec.decode("not json at all")) { error in
      XCTAssertEqual(error as? DeviceEnrollmentPairingCodecError, .malformed)
    }
  }

  func testDecodeThrowsMalformedForValidJSONMissingRequiredFields() {
    XCTAssertThrowsError(try DeviceEnrollmentPairingCodec.decode(#"{"pairingCode":"ABCD-2345"}"#)) { error in
      XCTAssertEqual(error as? DeviceEnrollmentPairingCodecError, .malformed)
    }
  }

  func testDecodeThrowsMalformedForEmptyString() {
    XCTAssertThrowsError(try DeviceEnrollmentPairingCodec.decode(""))
  }

  func testAsDeviceAccessCredentialCarriesTheCorrectFields() {
    let payload = samplePayload()
    let credential = payload.asDeviceAccessCredential
    XCTAssertEqual(credential.clientId, payload.clientId)
    XCTAssertEqual(credential.clientSecret, payload.clientSecret)
    XCTAssertEqual(credential.deviceName, payload.deviceName)
    XCTAssertEqual(credential.mintedAt, payload.mintedAt)
    XCTAssertEqual(credential.expiresAt, payload.expiresAt)
  }
}

// MARK: - Provisioning client (real request shape, stubbed transport)

private final class RequestRecorder: @unchecked Sendable {
  var request: URLRequest?
  var body: Data?
}

private final class StubURLProtocol: URLProtocol {
  nonisolated(unsafe) static var handler: ((URLRequest) -> (Data, HTTPURLResponse))?
  nonisolated(unsafe) static var recorder: RequestRecorder?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.recorder?.request = request
    Self.recorder?.body = Self.extractBody(from: request)
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    let (data, response) = handler(request)
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  private static func extractBody(from request: URLRequest) -> Data? {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let bufferSize = 4_096
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: bufferSize)
      guard read > 0 else { break }
      data.append(buffer, count: read)
    }
    return data
  }
}

final class VaultDeviceEnrollmentClientTests: XCTestCase {
  private func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: configuration)
  }

  override func tearDown() {
    StubURLProtocol.handler = nil
    StubURLProtocol.recorder = nil
    super.tearDown()
  }

  func testProvisionDeviceSendsTheAccessHeaderPairAndJSONBody() async throws {
    let endpoint = URL(string: "https://vault.example.com/enroll/provision")!
    let recorder = RequestRecorder()
    StubURLProtocol.recorder = recorder
    StubURLProtocol.handler = { request in
      let json = """
        {"pairingCode":"ABCD-2345","deviceName":"New iPhone","clientId":"minted.access","clientSecret":"minted-secret","mintedAt":"2026-08-06T00:00:00Z","expiresAt":"2027-08-06T00:00:00Z"}
        """
      let response = HTTPURLResponse(url: endpoint, statusCode: 201, httpVersion: nil, headerFields: nil)!
      return (Data(json.utf8), response)
    }
    let client = VaultDeviceEnrollmentClient(endpoint: endpoint, urlSession: makeSession())

    let payload = try await client.provisionDevice(
      deviceName: "New iPhone",
      pairingCode: "ABCD-2345",
      existingCredential: ExistingDeviceAccessCredential(clientId: "existing-id", clientSecret: "existing-secret")
    )

    XCTAssertEqual(payload.clientId, "minted.access")
    XCTAssertEqual(payload.clientSecret, "minted-secret")
    XCTAssertEqual(payload.deviceName, "New iPhone")
    XCTAssertEqual(payload.pairingCode, "ABCD-2345")

    let request = try XCTUnwrap(recorder.request)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.url, endpoint)
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "existing-id")
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "existing-secret")
    let body = try XCTUnwrap(recorder.body)
    let decodedBody = try JSONSerialization.jsonObject(with: body) as? [String: String]
    XCTAssertEqual(decodedBody?["pairingCode"], "ABCD-2345")
    XCTAssertEqual(decodedBody?["deviceName"], "New iPhone")
  }

  func testProvisionDeviceThrowsHTTPErrorWithServerMessageOnFailure() async throws {
    let endpoint = URL(string: "https://vault.example.com/enroll/provision")!
    StubURLProtocol.handler = { _ in
      let json = #"{"error":"pairing code already used or expired — generate a new one on the already-enrolled device"}"#
      let response = HTTPURLResponse(url: endpoint, statusCode: 409, httpVersion: nil, headerFields: nil)!
      return (Data(json.utf8), response)
    }
    let client = VaultDeviceEnrollmentClient(endpoint: endpoint, urlSession: makeSession())

    do {
      _ = try await client.provisionDevice(
        deviceName: "New iPhone", pairingCode: "ABCD-2345",
        existingCredential: ExistingDeviceAccessCredential(clientId: "id", clientSecret: "secret"))
      XCTFail("expected an httpError")
    } catch let error as DeviceEnrollmentProvisioningError {
      guard case .httpError(let status, let message) = error else {
        XCTFail("expected .httpError, got \(error)")
        return
      }
      XCTAssertEqual(status, 409)
      XCTAssertEqual(message, "pairing code already used or expired — generate a new one on the already-enrolled device")
    }
  }

  func testProvisionDeviceThrowsDecodingFailedOnUndecodableSuccessBody() async throws {
    let endpoint = URL(string: "https://vault.example.com/enroll/provision")!
    StubURLProtocol.handler = { _ in
      let response = HTTPURLResponse(url: endpoint, statusCode: 201, httpVersion: nil, headerFields: nil)!
      return (Data("not json".utf8), response)
    }
    let client = VaultDeviceEnrollmentClient(endpoint: endpoint, urlSession: makeSession())

    do {
      _ = try await client.provisionDevice(
        deviceName: "New iPhone", pairingCode: "ABCD-2345",
        existingCredential: ExistingDeviceAccessCredential(clientId: "id", clientSecret: "secret"))
      XCTFail("expected decodingFailed")
    } catch let error as DeviceEnrollmentProvisioningError {
      XCTAssertEqual(error, .decodingFailed)
    }
  }
}

// MARK: - Expiry warning

final class DeviceCredentialExpiryTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_700_000_000)

  func testHealthyWhenFarFromExpiry() {
    let expiresAt = now.addingTimeInterval(200 * 24 * 60 * 60) // 200 days out
    XCTAssertEqual(evaluateDeviceCredentialExpiry(now: now, expiresAt: expiresAt), .healthy)
  }

  func testExpiringSoonWithinTheWarningWindow() {
    let expiresAt = now.addingTimeInterval(10 * 24 * 60 * 60) // 10 days out
    XCTAssertEqual(
      evaluateDeviceCredentialExpiry(now: now, expiresAt: expiresAt), .expiringSoon(daysRemaining: 10))
  }

  func testExpiredWhenExpiresAtIsInThePast() {
    let expiresAt = now.addingTimeInterval(-60)
    XCTAssertEqual(evaluateDeviceCredentialExpiry(now: now, expiresAt: expiresAt), .expired)
  }

  func testExpiredWhenExpiresAtIsExactlyNow() {
    XCTAssertEqual(evaluateDeviceCredentialExpiry(now: now, expiresAt: now), .expired)
  }

  func testRespectsACustomWarningWindow() {
    let expiresAt = now.addingTimeInterval(5 * 24 * 60 * 60) // 5 days out
    XCTAssertEqual(
      evaluateDeviceCredentialExpiry(now: now, expiresAt: expiresAt, warningWindow: 3 * 24 * 60 * 60), .healthy)
    XCTAssertEqual(
      evaluateDeviceCredentialExpiry(now: now, expiresAt: expiresAt, warningWindow: 7 * 24 * 60 * 60),
      .expiringSoon(daysRemaining: 5))
  }

  func testBoundaryAtExactlyTheWarningWindow() {
    let expiresAt = now.addingTimeInterval(30 * 24 * 60 * 60)
    XCTAssertEqual(
      evaluateDeviceCredentialExpiry(now: now, expiresAt: expiresAt), .expiringSoon(daysRemaining: 30))
  }
}
