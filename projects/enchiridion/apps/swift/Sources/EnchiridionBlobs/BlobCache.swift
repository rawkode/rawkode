// BlobCache.swift
// EnchiridionBlobs
//
// Skeleton per the plan's "Blobs (R2)" section: local LRU cache + HTTP
// upload/download against the vault worker's (not-yet-implemented) blob
// routes, `/blobs/<id>`, behind Cloudflare Access. The routes don't exist
// yet (VaultDO/vault worker is a separate task), but the client-side HTTP
// contract is implemented for real here: no live server to hit means the
// upload/download round-trip is untestable today (no live-server test is
// included for that reason) — the request/response shape against the
// plan's `/blobs/<id>` route contract is what's being proven, ready for a
// real server to exist on the other end.
//
// Local cache is in-memory only for this skeleton (dictionary + a simple
// LRU eviction list). TODO(EnchiridionStore): once EnchiridionStore's GRDB
// layer exists, back this with an on-disk cache (plan: "Devices keep an LRU
// local cache in EnchiridionBlobs") so blobs survive app relaunch without
// re-downloading.
//
// Auth: fixed to match `EnchiridionSync/VaultSyncClient.swift`'s corrected
// mechanism — a Cloudflare Access *service token* is a client id/secret
// PAIR sent as `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers, not
// a bearer token via `Authorization` (see that file's header comment, and
// `workers/vault/ACCESS_SETUP.md`, for the citations against Cloudflare's
// docs). This module previously sent `Authorization: Bearer <token>` on
// both the upload and download requests, which `ACCESS_SETUP.md` flagged
// explicitly as the same bug, out of scope for that pass — fixed here.
//
// `AccessServiceTokenCredential` is intentionally duplicated from
// `EnchiridionSync` rather than imported from it: the only thing worth
// sharing is a four-line `{clientId, clientSecret}` struct, and
// `EnchiridionSync` also pulls in the Loro CRDT engine (and the
// `loro-swift` binary package dependency) for reasons entirely unrelated
// to blob caching. Adding that dependency edge to `EnchiridionBlobs` just
// to reuse one small value type would be a worse trade than a few
// duplicated lines — this cache has no other reason to know Loro exists.

import EnchiridionCore
import Foundation

/// A Cloudflare Access *service token* — a client id/secret pair, not a
/// single bearer token. Sent as `CF-Access-Client-Id`/`CF-Access-Client-
/// Secret` headers on every request to the vault worker's blob routes.
/// Deliberately duplicated from `EnchiridionSync.AccessServiceTokenCredential`
/// — see this file's header comment for why.
public struct AccessServiceTokenCredential: Sendable, Equatable {
  public let clientId: String
  public let clientSecret: String

  public init(clientId: String, clientSecret: String) {
    self.clientId = clientId
    self.clientSecret = clientSecret
  }
}

/// Where to reach the vault worker's blob routes, and how to authenticate.
///
/// `accessCredential` is a closure, not a stored value, because the plan's
/// auth model is per-device Cloudflare Access service tokens with an
/// explicit expiry/re-enrollment UX ("In-app expiry warning + re-enrollment
/// UX before a token goes dark") — the credential can change out from under
/// a long-lived `BlobCache` instance.
///
/// THROWING (task #96, plan §Live Backend Connectivity (P8) scope item 4):
/// was `@Sendable () async -> AccessServiceTokenCredential` (non-throwing)
/// before this pass, which forced a caller with no enrolled device yet to
/// either fabricate a placeholder credential (what
/// `EnchiridionUI/PageCanvasEmbedding.swift` did — an empty-string client
/// id/secret pair that would only ever fail once it reached the network,
/// indistinguishable from a real server-side rejection) or crash. Now a
/// caller (e.g. `EnchiridionCore.DeviceAccessCredentialResolver.resolveCredential()`)
/// can throw a real, distinct "not enrolled" error BEFORE any request is
/// built — `uploadBlob`/`downloadBlob` below propagate it exactly like any
/// other thrown error, never swallowing it.
public struct BlobServiceEndpoint: Sendable {
  public var baseURL: URL
  public var accessCredential: @Sendable () async throws -> AccessServiceTokenCredential

  public init(
    baseURL: URL,
    accessCredential: @escaping @Sendable () async throws -> AccessServiceTokenCredential
  ) {
    self.baseURL = baseURL
    self.accessCredential = accessCredential
  }

  /// `<baseURL>/blobs/<id>` — plan: "uploaded/downloaded through vault
  /// worker routes behind Access".
  func blobURL(for id: BlobID) -> URL {
    baseURL.appendingPathComponent("blobs").appendingPathComponent(id.rawValue)
  }
}

/// Errors specific to the blob client, distinct from `URLError` /
/// transport-level failures so callers can distinguish "the network is
/// down" from "the server said something unexpected".
public enum BlobCacheError: Error, Sendable, Equatable {
  case unexpectedStatus(Int)
  case missingResponseBody
  case checksumMismatch(expected: BlobID, actual: BlobID)
}

/// Local content-addressed blob cache with LRU eviction, plus the HTTP
/// client for the vault worker's blob routes.
///
/// An `actor` so concurrent upload/download calls (e.g. an editor
/// prefetching a page's attachments while another view uploads a new one)
/// serialize safely around the shared cache dictionary.
public actor BlobCache {
  private let endpoint: BlobServiceEndpoint
  private let session: URLSession
  private let maxCacheBytes: Int

  /// Cached bytes, keyed by blob id.
  private var storage: [BlobID: Data] = [:]
  /// Most-recently-used order, back (last element) = most recent.
  private var lruOrder: [BlobID] = []
  private var currentBytes: Int = 0

  public init(
    endpoint: BlobServiceEndpoint,
    session: URLSession = .shared,
    maxCacheBytes: Int = 256 * 1024 * 1024
  ) {
    self.endpoint = endpoint
    self.session = session
    self.maxCacheBytes = maxCacheBytes
  }

  /// Uploads `data` to the vault worker's blob route and returns a
  /// reference to store in the graph (never the bytes themselves).
  ///
  /// Content-addressing happens client-side (`BlobID(contentsOf:)`) before
  /// the request is sent, matching the plan's "content-addressed
  /// (`blob_<sha256>`)" model — the server is expected to validate the
  /// digest, not assign identity.
  ///
  /// Plan's "register the hash in a pending-references table before
  /// upload" requirement is satisfied server-side, not here: the vault
  /// worker's `handleBlobUpload` (`workers/vault/src/blob-routes.ts`)
  /// calls `registerPendingBlobReference` before any R2 write, as part of
  /// handling this same `PUT /blobs/:id` request — no separate RPC call is
  /// needed from this client.
  public func uploadBlob(
    data: Data,
    metadata: BlobMetadata
  ) async throws -> BlobReference {
    let id = BlobID(contentsOf: data)
    var request = URLRequest(url: endpoint.blobURL(for: id))
    request.httpMethod = "PUT"
    request.httpBody = data
    request.setValue(metadata.mimeType, forHTTPHeaderField: "Content-Type")
    request.setValue("\(data.count)", forHTTPHeaderField: "Content-Length")
    let credential = try await endpoint.accessCredential()
    request.setValue(credential.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
    request.setValue(credential.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")

    let (_, response) = try await session.data(for: request)
    try Self.validate(response)

    store(id: id, data: data)
    return BlobReference(id: id, metadata: metadata)
  }

  /// Downloads a blob, serving from the local LRU cache when present.
  public func downloadBlob(id: BlobID) async throws -> Data {
    if let cached = storage[id] {
      touch(id: id)
      return cached
    }

    var request = URLRequest(url: endpoint.blobURL(for: id))
    request.httpMethod = "GET"
    let credential = try await endpoint.accessCredential()
    request.setValue(credential.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
    request.setValue(credential.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")

    let (data, response) = try await session.data(for: request)
    try Self.validate(response)

    let actualID = BlobID(contentsOf: data)
    guard actualID == id else {
      throw BlobCacheError.checksumMismatch(expected: id, actual: actualID)
    }

    store(id: id, data: data)
    return data
  }

  /// Removes everything from the in-memory cache. Exposed for tests and
  /// for a future low-memory notification handler.
  public func evictAll() {
    storage.removeAll()
    lruOrder.removeAll()
    currentBytes = 0
  }

  public var cachedByteCount: Int {
    currentBytes
  }

  // MARK: - LRU bookkeeping

  private func store(id: BlobID, data: Data) {
    if storage[id] != nil {
      currentBytes -= (storage[id]?.count ?? 0)
      lruOrder.removeAll { $0 == id }
    }
    storage[id] = data
    lruOrder.append(id)
    currentBytes += data.count
    evictIfNeeded()
  }

  private func touch(id: BlobID) {
    lruOrder.removeAll { $0 == id }
    lruOrder.append(id)
  }

  private func evictIfNeeded() {
    while currentBytes > maxCacheBytes, !lruOrder.isEmpty {
      let oldest = lruOrder.removeFirst()
      if let removed = storage.removeValue(forKey: oldest) {
        currentBytes -= removed.count
      }
    }
  }

  private static func validate(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse else {
      throw BlobCacheError.missingResponseBody
    }
    guard (200..<300).contains(http.statusCode) else {
      throw BlobCacheError.unexpectedStatus(http.statusCode)
    }
  }
}
