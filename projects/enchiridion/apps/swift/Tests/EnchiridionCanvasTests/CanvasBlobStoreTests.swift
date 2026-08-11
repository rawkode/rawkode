// CanvasBlobStoreTests.swift
// EnchiridionCanvasTests
//
// Task brief: "Blob storage/retrieval round-trip for canvas content — real
// EnchiridionBlobs integration, not mocked."
//
// "Real ... not mocked" here follows this codebase's own established
// convention for exactly this situation (no live vault-worker server to
// hit in this sandbox — see `EnchiridionBlobs/BlobCache.swift`'s header
// and `Tests/EnchiridionBlobsTests/BlobCacheTests.swift`, which already
// solved this the same way): a `URLProtocol` stub intercepting the real
// `URLSession` call. What's "real" here is the actual `BlobCache` actor
// (LRU cache, checksum verification, Access-header construction), the
// actual `URLRequest`/`URLResponse` wire path, and the actual
// `CanvasDocument`/`CanvasBlobStore` encode-upload/download-decode
// pipeline — nothing about `CanvasBlobStore` or `BlobCache` is mocked or
// stubbed; only the network TRANSPORT (an in-process fake blob server
// keyed by content hash) stands in for a live vault worker, which doesn't
// exist to hit in this sandbox — the identical boundary
// `EnchiridionBlobsTests`/`EnchiridionAPITests` already draw for the same
// reason.

import EnchiridionCore
import Foundation
import XCTest

@testable import EnchiridionBlobs
@testable import EnchiridionCanvas

final class CanvasBlobStoreTests: XCTestCase {
  override func tearDown() {
    CanvasMockURLProtocol.reset()
    super.tearDown()
  }

  private func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CanvasMockURLProtocol.self]
    return URLSession(configuration: configuration)
  }

  private func makeCache(session: URLSession) -> BlobCache {
    let endpoint = BlobServiceEndpoint(
      baseURL: URL(string: "https://vault.example.com")!,
      accessCredential: { AccessServiceTokenCredential(clientId: "test-id", clientSecret: "test-secret") }
    )
    return BlobCache(endpoint: endpoint, session: session)
  }

  func testUploadThenDownloadRoundTripsTheExactCanvasDocument() async throws {
    // An in-process fake blob store keyed by content hash (the URL path,
    // which BlobCache derives from BlobID(contentsOf:)) — a real PUT
    // stores the exact bytes it received; a real GET returns exactly what
    // was stored for that id, or 404 if nothing was ever uploaded there.
    // This proves the round trip through real content-addressing, not a
    // canned response.
    let server = CanvasFakeBlobServer()
    CanvasMockURLProtocol.stubHandler = { request in server.handle(request) }

    let cache = makeCache(session: makeSession())
    let document = CanvasDocument(
      canvasSize: CanvasSize(width: 640, height: 480),
      elements: [
        .stroke(CanvasStroke(points: [CanvasPoint(x: 0, y: 0), CanvasPoint(x: 5, y: 5), CanvasPoint(x: 10, y: 0)])),
        .rectangle(CanvasShape(origin: CanvasPoint(x: 1, y: 1), size: CanvasSize(width: 20, height: 30))),
        .text(CanvasText(position: CanvasPoint(x: 2, y: 2), content: "round trip")),
      ]
    )

    let reference = try await CanvasBlobStore.upload(document, using: cache)
    XCTAssertEqual(reference.metadata.mimeType, CanvasBlobStore.mimeType)
    XCTAssertEqual(reference.metadata.width, 640)
    XCTAssertEqual(reference.metadata.height, 480)

    // A second BlobCache instance (fresh LRU cache, no in-memory carry-over)
    // against the SAME fake server — forces the download to actually hit
    // the network path, not the uploader's own local cache, proving the
    // bytes really made the PUT -> server -> GET round trip.
    let downloadingCache = makeCache(session: makeSession())
    let downloaded = try await CanvasBlobStore.download(id: reference.id, using: downloadingCache)

    XCTAssertEqual(downloaded, document)
  }

  func testDownloadingAnUnknownBlobIDThrows() async {
    let server = CanvasFakeBlobServer()
    CanvasMockURLProtocol.stubHandler = { request in server.handle(request) }
    let cache = makeCache(session: makeSession())

    do {
      _ = try await CanvasBlobStore.download(id: BlobID(rawValue: "blob_doesnotexist"), using: cache)
      XCTFail("expected an error for a blob that was never uploaded")
    } catch {
      // BlobCacheError.unexpectedStatus(404) — asserted loosely (via
      // `is BlobCacheError`) since the exact error type belongs to
      // `EnchiridionBlobs`, not this module; this test only needs to know
      // CanvasBlobStore surfaces the real failure rather than swallowing it.
      XCTAssertTrue(error is BlobCacheError, "expected a BlobCacheError, got \(error)")
    }
  }

  /// Missing-device-credential honesty (task #96, plan §Live Backend
  /// Connectivity (P8) scope item 2, applied to canvas save): a
  /// `BlobServiceEndpoint.accessCredential` closure that throws (exactly
  /// what `EnchiridionCore.DeviceAccessCredentialResolver.resolveCredential()`
  /// does for a never-enrolled device — see `EnchiridionUI/
  /// PageCanvasEmbedding.swift`'s `BlobCache.appDefault()`) must propagate
  /// as a real, catchable error out of `CanvasBlobStore.upload`, never
  /// silently no-op and never crash.
  func testUploadPropagatesADeviceNotEnrolledCredentialErrorWithoutSendingARequest() async {
    let server = CanvasFakeBlobServer()
    CanvasMockURLProtocol.stubHandler = { request in
      XCTFail("no HTTP request should be sent when the credential closure throws")
      return server.handle(request)
    }
    let endpoint = BlobServiceEndpoint(
      baseURL: URL(string: "https://vault.example.com")!,
      accessCredential: { throw DeviceAccessCredentialResolutionError.deviceNotEnrolled }
    )
    let cache = BlobCache(endpoint: endpoint, session: makeSession())
    let document = CanvasDocument(elements: [.text(CanvasText(position: CanvasPoint(x: 0, y: 0), content: "x"))])

    do {
      _ = try await CanvasBlobStore.upload(document, using: cache)
      XCTFail("expected the credential error to propagate")
    } catch DeviceAccessCredentialResolutionError.deviceNotEnrolled {
      // expected — a real, catchable, distinct error, not a crash or silent no-op.
    } catch {
      XCTFail("expected DeviceAccessCredentialResolutionError.deviceNotEnrolled, got \(error)")
    }
  }

  func testUploadedBlobIDIsContentAddressedDeterministically() async throws {
    let server = CanvasFakeBlobServer()
    CanvasMockURLProtocol.stubHandler = { request in server.handle(request) }
    let cache = makeCache(session: makeSession())
    let document = CanvasDocument(elements: [.text(CanvasText(position: CanvasPoint(x: 0, y: 0), content: "same"))])

    let first = try await CanvasBlobStore.upload(document, using: cache)
    let second = try await CanvasBlobStore.upload(document, using: cache)

    XCTAssertEqual(
      first.id, second.id,
      "uploading logically-identical canvas content twice must content-address to the same BlobID"
        + " (CanvasDocumentCoding's deterministic .sortedKeys encoding is what makes this true)")
  }
}

/// A minimal in-process fake blob server: `PUT` stores the request body
/// keyed by the trailing path component (the `BlobID`), `GET` returns it
/// (404 if absent). Lock-guarded (not an actor) — `URLProtocol`'s loading
/// callbacks run synchronously on whatever thread the URL loading system
/// chooses, so this matches `EnchiridionBlobsTests.MockURLProtocol`'s own
/// synchronous, lock-guarded convention rather than introducing `Task`/
/// `await` into the interception path.
final class CanvasFakeBlobServer: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [String: Data] = [:]

  func handle(_ request: URLRequest) -> CanvasMockURLProtocol.Stub {
    let id = request.url?.lastPathComponent ?? ""
    lock.lock()
    defer { lock.unlock() }
    switch request.httpMethod {
    case "PUT":
      storage[id] = request.bodyDataForTesting ?? Data()
      return .init(statusCode: 200, body: Data())
    case "GET":
      guard let data = storage[id] else {
        return .init(statusCode: 404, body: Data())
      }
      return .init(statusCode: 200, body: data)
    default:
      return .init(statusCode: 400, body: Data())
    }
  }
}

extension URLRequest {
  /// `URLProtocol` sees the outgoing request's body via `httpBodyStream`
  /// once `URLSession` has taken ownership of it, not always via
  /// `httpBody` directly — this reads whichever is present, draining the
  /// stream if that's what's there, so the fake server actually captures
  /// the uploaded bytes.
  fileprivate var bodyDataForTesting: Data? {
    if let httpBody { return httpBody }
    guard let stream = httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let bufferSize = 4096
    var buffer = [UInt8](repeating: 0, count: bufferSize)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: bufferSize)
      if read <= 0 { break }
      data.append(buffer, count: read)
    }
    return data
  }
}

/// Same shape as `EnchiridionBlobsTests.MockURLProtocol` — duplicated
/// rather than shared because SPM test targets can't import another
/// target's test-only sources.
final class CanvasMockURLProtocol: URLProtocol {
  struct Stub {
    var statusCode: Int
    var body: Data
  }

  nonisolated(unsafe) static var stubHandler: (@Sendable (URLRequest) -> Stub)?

  static func reset() {
    stubHandler = nil
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let stub = CanvasMockURLProtocol.stubHandler?(request) ?? Stub(statusCode: 200, body: Data())
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
