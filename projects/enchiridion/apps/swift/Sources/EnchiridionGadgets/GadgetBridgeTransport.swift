// GadgetBridgeTransport.swift
// EnchiridionGadgets
//
// The ONE way an authorized capability request leaves this module — see
// GadgetBridge.swift for the authorization step that must pass before this
// protocol is ever called. Deliberately just a protocol: this target
// depends only on `EnchiridionCore` (Package.swift), not `EnchiridionSync`
// or `EnchiridionAPI` (both README-only/still-forming as of this task —
// EnchiridionAPI has no client to reuse yet, and EnchiridionSync's real
// `AccessServiceTokenCredential`/`CF-Access-Client-Id`/`CF-Access-Client-
// Secret` header pair, VaultSyncClient.swift, is exactly the "existing
// authenticated app connection" the task brief describes gadget requests
// proxying through — but wiring THAT concrete credential source in is an
// app-layer job for whichever future task assembles `EnchiridionUI`'s real
// `GadgetWebViewHost` call sites, not this module's). Keeping this a
// protocol (not a concrete client baked in) means:
//   1. This module never needs a second dependency edge onto
//      EnchiridionSync/EnchiridionAPI just to know a credential shape that
//      belongs to those modules.
//   2. `GadgetBridge`'s tests (GadgetBridgeTests.swift) can substitute a
//      trivial recording mock instead of a real network stack — the task
//      brief's explicit ask ("mock the authenticated network layer").
//   3. Server-side, gadget-host's actual production HTTP surface for
//      reaching a gadget's capabilities doesn't exist yet (as of this
//      task: `workers/gadget-host/src/index.ts`'s own header says its
//      `fetch()` handler has no production route — every real capability
//      call there is DO-RPC-only, reached from another Worker, not a
//      device). `HTTPGadgetBridgeTransport` below is a ready, correctly-
//      shaped client for whatever that route ends up being, wired with
//      `authHeaders` exactly the way VaultSyncClient.swift already proves
//      out for the sync WebSocket — but the concrete base URL/route is a
//      server-side task (`workers/`) this task does not touch.
//
// Every call here is exactly what "authorized" from `GadgetBridge` means
// (GadgetBridge.swift's `authorize`): a `GadgetBridgeRequest` already
// confirmed against a local grant, sent as-is. This protocol does not — and
// must not — re-decide authorization; that decision is made once, in
// `GadgetBridge`, before `send(_:)` is ever reached.

import Foundation

public protocol GadgetBridgeTransport: Sendable {
  /// Sends an already-authorized capability request over the app's
  /// existing authenticated connection and returns the raw JSON result.
  /// Throws on any transport-level failure (network error, non-2xx
  /// response, malformed response body) — `GadgetBridge.handle(request:)`
  /// turns a thrown error into a `.failure` `GadgetBridgeResponse`, never
  /// lets it propagate into `WKScriptMessageHandler`.
  func send(_ request: GadgetBridgeRequest) async throws -> GadgetJSONValue
}

public enum GadgetBridgeTransportError: Error, Sendable, Equatable {
  case httpError(statusCode: Int)
  case malformedResponseBody
}

/// A ready `GadgetBridgeTransport` over a plain authenticated HTTPS POST —
/// see this file's header for why the exact route/base URL is left to the
/// caller rather than hardcoded. `authHeaders` is a closure (not a stored
/// credential) for the same reason `VaultSyncClient`'s `accessCredential`
/// is (VaultSyncClient.swift): the app's Access service-token headers can
/// rotate/refresh independently of this transport's lifetime, so this
/// transport re-reads them on every call instead of caching a snapshot
/// that could go stale mid-session.
public struct HTTPGadgetBridgeTransport: GadgetBridgeTransport {
  private let endpoint: URL
  private let session: URLSession
  private let authHeaders: @Sendable () async -> [String: String]

  /// - Parameters:
  ///   - endpoint: the full URL this gadget's capability requests POST to
  ///     (e.g. `https://gadgets.example.workers.dev/gadgets/<gadgetID>/capability`
  ///     once that route exists server-side — see this file's header).
  ///   - session: defaults to `.shared`; overridable for tests
  ///     (`URLSession(configuration:)` with a stub `URLProtocol`) without
  ///     this type needing its own test-only initializer.
  ///   - authHeaders: returns the headers that authenticate this device's
  ///     existing connection (e.g. `CF-Access-Client-Id`/
  ///     `CF-Access-Client-Secret`, matching VaultSyncClient.swift's
  ///     `AccessServiceTokenCredential` — that concrete type lives in
  ///     EnchiridionSync, so the caller (an app-layer type outside this
  ///     module) is what actually bridges the two) — re-read on every
  ///     call, not cached.
  public init(
    endpoint: URL,
    session: URLSession = .shared,
    authHeaders: @escaping @Sendable () async -> [String: String]
  ) {
    self.endpoint = endpoint
    self.session = session
    self.authHeaders = authHeaders
  }

  public func send(_ request: GadgetBridgeRequest) async throws -> GadgetJSONValue {
    var urlRequest = URLRequest(url: endpoint)
    urlRequest.httpMethod = "POST"
    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    for (field, value) in await authHeaders() {
      urlRequest.setValue(value, forHTTPHeaderField: field)
    }

    let payload = GadgetJSONValue.object([
      "type": .string(request.capabilityType.rawValue),
      "view": request.view.map(GadgetJSONValue.string) ?? .null,
      "params": request.params ?? .null,
    ])
    urlRequest.httpBody = Data(try payload.jsonString().utf8)

    let (data, response) = try await session.data(for: urlRequest)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
      throw GadgetBridgeTransportError.httpError(statusCode: statusCode)
    }

    let decoded: Any
    do {
      decoded = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    } catch {
      throw GadgetBridgeTransportError.malformedResponseBody
    }
    guard let value = GadgetJSONValue(any: decoded) else {
      throw GadgetBridgeTransportError.malformedResponseBody
    }
    return value
  }
}
