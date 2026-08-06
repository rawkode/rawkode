// BlobCacheTests.swift
// EnchiridionBlobsTests
//
// `BlobCache`'s upload/download round-trip has no live vault-worker blob
// route to test against yet (see `BlobCache.swift`'s header comment), so
// what's tested here is everything that doesn't require one: that upload
// and download requests carry the Cloudflare Access service-token headers
// (`CF-Access-Client-Id`/`CF-Access-Client-Secret`) instead of the
// `Authorization: Bearer` header this module used to send — the same bug,
// and the same fix, as `EnchiridionSync/VaultSyncClientTests.swift` covers
// for the WebSocket client — plus the LRU cache bookkeeping and error
// paths, all driven against `MockURLProtocol` rather than a real server.

import Foundation
import XCTest

@testable import EnchiridionBlobs

final class BlobCacheTests: XCTestCase {
  override func tearDown() {
    MockURLProtocol.reset()
    super.tearDown()
  }

  private func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    return URLSession(configuration: configuration)
  }

  private func makeEndpoint(
    credential: AccessServiceTokenCredential = AccessServiceTokenCredential(
      clientId: "test-client-id", clientSecret: "test-client-secret")
  ) -> BlobServiceEndpoint {
    BlobServiceEndpoint(
      baseURL: URL(string: "https://vault.example.com")!,
      accessCredential: { credential }
    )
  }

  // MARK: - Access header contract

  func testUploadBlobSendsAccessHeadersNotAuthorization() async throws {
    MockURLProtocol.stubHandler = { _ in .init(statusCode: 200, body: Data()) }
    let credential = AccessServiceTokenCredential(
      clientId: "upload-client-id", clientSecret: "upload-client-secret")
    let cache = BlobCache(
      endpoint: makeEndpoint(credential: credential), session: makeSession())

    _ = try await cache.uploadBlob(
      data: Data("hello world".utf8),
      metadata: BlobMetadata(mimeType: "text/plain", byteCount: 11))

    let requests = MockURLProtocol.requests
    XCTAssertEqual(requests.count, 1)
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "PUT")
    XCTAssertEqual(request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "upload-client-id")
    XCTAssertEqual(
      request.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "upload-client-secret")
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
  }

  func testDownloadBlobSendsAccessHeadersNotAuthorization() async throws {
    let data = Data("downloaded bytes".utf8)
    let id = BlobID(contentsOf: data)
    MockURLProtocol.stubHandler = { _ in .init(statusCode: 200, body: data) }
    let credential = AccessServiceTokenCredential(
      clientId: "download-client-id", clientSecret: "download-client-secret")
    let cache = BlobCache(
      endpoint: makeEndpoint(credential: credential), session: makeSession())

    _ = try await cache.downloadBlob(id: id)

    let requests = MockURLProtocol.requests
    XCTAssertEqual(requests.count, 1)
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(
      request.value(forHTTPHeaderField: "CF-Access-Client-Id"), "download-client-id")
    XCTAssertEqual(
      request.value(forHTTPHeaderField: "CF-Access-Client-Secret"), "download-client-secret")
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
  }

  func testAccessCredentialIsResolvedFreshOnEachRequest() async throws {
    MockURLProtocol.stubHandler = { _ in .init(statusCode: 200, body: Data()) }
    let counter = CredentialCallCounter()
    let endpoint = BlobServiceEndpoint(
      baseURL: URL(string: "https://vault.example.com")!,
      accessCredential: {
        let call = await counter.next()
        return AccessServiceTokenCredential(clientId: "id-\(call)", clientSecret: "secret")
      }
    )
    let cache = BlobCache(endpoint: endpoint, session: makeSession())

    _ = try await cache.uploadBlob(
      data: Data("a".utf8), metadata: BlobMetadata(mimeType: "text/plain", byteCount: 1))
    _ = try await cache.uploadBlob(
      data: Data("b".utf8), metadata: BlobMetadata(mimeType: "text/plain", byteCount: 1))

    let finalCount = await counter.next()
    XCTAssertEqual(finalCount, 3, "expected exactly two prior resolutions, one per upload")
    XCTAssertEqual(
      MockURLProtocol.requests.map { $0.value(forHTTPHeaderField: "CF-Access-Client-Id") },
      ["id-1", "id-2"])
  }

  // MARK: - Cache behavior

  func testDownloadBlobServesFromCacheWithoutNetworkCall() async throws {
    MockURLProtocol.stubHandler = { _ in .init(statusCode: 200, body: Data()) }
    let cache = BlobCache(endpoint: makeEndpoint(), session: makeSession())
    let data = Data("cached bytes".utf8)
    let reference = try await cache.uploadBlob(
      data: data, metadata: BlobMetadata(mimeType: "text/plain", byteCount: data.count))
    XCTAssertEqual(MockURLProtocol.requests.count, 1)

    // No stub handler configured for a second network call — if
    // `downloadBlob` fell through to the network instead of serving from
    // cache, `startLoading` would still succeed (stubHandler falls back to
    // a 200/empty body), so assert on request *count* rather than relying
    // on a failure to catch this.
    let downloaded = try await cache.downloadBlob(id: reference.id)

    XCTAssertEqual(downloaded, data)
    XCTAssertEqual(MockURLProtocol.requests.count, 1, "expected no additional network request")
  }

  func testUploadBlobTracksCachedByteCount() async throws {
    MockURLProtocol.stubHandler = { _ in .init(statusCode: 200, body: Data()) }
    let cache = BlobCache(endpoint: makeEndpoint(), session: makeSession())
    let data = Data(repeating: 0x41, count: 128)

    _ = try await cache.uploadBlob(
      data: data, metadata: BlobMetadata(mimeType: "application/octet-stream", byteCount: 128))

    let count = await cache.cachedByteCount
    XCTAssertEqual(count, 128)
  }

  func testEvictAllClearsCachedByteCount() async throws {
    MockURLProtocol.stubHandler = { _ in .init(statusCode: 200, body: Data()) }
    let cache = BlobCache(endpoint: makeEndpoint(), session: makeSession())
    _ = try await cache.uploadBlob(
      data: Data(repeating: 0x41, count: 64),
      metadata: BlobMetadata(mimeType: "application/octet-stream", byteCount: 64))

    await cache.evictAll()

    let count = await cache.cachedByteCount
    XCTAssertEqual(count, 0)
  }

  func testLRUEvictsOldestEntryWhenOverCapacity() async throws {
    let firstData = Data(repeating: 0x01, count: 64)
    let secondData = Data(repeating: 0x02, count: 64)
    let firstID = BlobID(contentsOf: firstData)
    // The upload requests' response bodies are irrelevant (only status
    // matters there); the GET re-fetch below needs its body to match
    // `firstID`'s content so the post-eviction re-download's checksum
    // check passes.
    MockURLProtocol.stubHandler = { request in
      if request.httpMethod == "GET", request.url?.lastPathComponent == firstID.rawValue {
        return .init(statusCode: 200, body: firstData)
      }
      return .init(statusCode: 200, body: Data())
    }
    // Small enough that a second 64-byte blob forces eviction of the first.
    let cache = BlobCache(endpoint: makeEndpoint(), session: makeSession(), maxCacheBytes: 100)

    let first = try await cache.uploadBlob(
      data: firstData, metadata: BlobMetadata(mimeType: "application/octet-stream", byteCount: 64))
    _ = try await cache.uploadBlob(
      data: secondData, metadata: BlobMetadata(mimeType: "application/octet-stream", byteCount: 64))

    let countAfterEviction = await cache.cachedByteCount
    XCTAssertEqual(countAfterEviction, 64, "oldest entry should have been evicted")

    // The evicted entry is gone from the cache, so re-fetching it must hit
    // the network again (a third request beyond the two uploads already
    // made).
    let redownloaded = try await cache.downloadBlob(id: first.id)
    XCTAssertEqual(redownloaded, firstData)
    XCTAssertEqual(MockURLProtocol.requests.count, 3)
  }

  // MARK: - Error paths

  func testUploadBlobThrowsUnexpectedStatusOnServerError() async {
    MockURLProtocol.stubHandler = { _ in .init(statusCode: 500, body: Data()) }
    let cache = BlobCache(endpoint: makeEndpoint(), session: makeSession())

    do {
      _ = try await cache.uploadBlob(
        data: Data("x".utf8), metadata: BlobMetadata(mimeType: "text/plain", byteCount: 1))
      XCTFail("expected BlobCacheError.unexpectedStatus")
    } catch BlobCacheError.unexpectedStatus(let status) {
      XCTAssertEqual(status, 500)
    } catch {
      XCTFail("expected .unexpectedStatus, got \(error)")
    }
  }

  func testDownloadBlobThrowsChecksumMismatchOnCorruptedBody() async {
    let requestedID = BlobID(contentsOf: Data("expected".utf8))
    MockURLProtocol.stubHandler = { _ in .init(statusCode: 200, body: Data("different".utf8)) }
    let cache = BlobCache(endpoint: makeEndpoint(), session: makeSession())

    do {
      _ = try await cache.downloadBlob(id: requestedID)
      XCTFail("expected BlobCacheError.checksumMismatch")
    } catch BlobCacheError.checksumMismatch(let expected, _) {
      XCTAssertEqual(expected, requestedID)
    } catch {
      XCTFail("expected .checksumMismatch, got \(error)")
    }
  }
}

/// A trivially `Sendable` counter for `testAccessCredentialIsResolvedFreshOnEachRequest` —
/// an `actor` rather than a captured `var`, since `accessCredential` closures
/// are `@Sendable` and a plain mutable capture isn't concurrency-safe.
private actor CredentialCallCounter {
  private var count = 0

  func next() -> Int {
    count += 1
    return count
  }
}

/// Intercepts requests made through any `URLSession` configured with this
/// protocol registered (`configuration.protocolClasses = [MockURLProtocol.self]`),
/// so tests can assert on outgoing headers — the Access service-token pair
/// this suite exists to verify — and script canned responses without a
/// live server.
///
/// `URLProtocol`'s loading callbacks can run on a background queue owned by
/// the URL loading system rather than the calling test's thread, so the
/// captured-request log is guarded by a lock rather than assumed
/// single-threaded.
final class MockURLProtocol: URLProtocol {
  struct Stub {
    var statusCode: Int
    var body: Data
  }

  private static let lock = NSLock()
  /// Guarded by `lock`, not by the compiler — `URLProtocol`'s loading
  /// callbacks aren't isolated to any actor the compiler can statically
  /// verify, so this needs the same escape hatch as `stubHandler` below.
  nonisolated(unsafe) private static var capturedRequests: [URLRequest] = []

  /// Set per-test before making calls through a `BlobCache`; reset in
  /// `tearDown()` via `reset()` so one test's stub can never leak into the
  /// next.
  nonisolated(unsafe) static var stubHandler: (@Sendable (URLRequest) -> Stub)?

  static var requests: [URLRequest] {
    lock.lock()
    defer { lock.unlock() }
    return capturedRequests
  }

  static func reset() {
    lock.lock()
    capturedRequests = []
    lock.unlock()
    stubHandler = nil
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    MockURLProtocol.lock.lock()
    MockURLProtocol.capturedRequests.append(request)
    MockURLProtocol.lock.unlock()

    let stub = MockURLProtocol.stubHandler?(request) ?? Stub(statusCode: 200, body: Data())
    let response = HTTPURLResponse(
      url: request.url ?? URL(string: "https://vault.example.com")!,
      statusCode: stub.statusCode,
      httpVersion: nil,
      headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: stub.body)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
