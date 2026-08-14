// VaultSyncClient.swift
// EnchiridionSync
//
// WebSocket sync client shell per the plan's §Backend architecture "Sync
// protocol" and §Native apps sections. There is no VaultDO to talk to yet
// (a separate, not-yet-implemented task) — this implements the real client-
// side control flow (connect, catalog-first handshake, reconnect-with-
// backoff, outbox hooks) against `URLSessionWebSocketTask`, so the wire
// protocol has somewhere real to plug in once a server exists.
//
// Auth: per plan Risk #7 ("Access service tokens on URLSession WebSocket
// upgrade — verify week 1; fallback: short-lived JWT minted over
// authenticated fetch") — VERIFIED against developers.cloudflare.com
// (Cloudflare Access service-token docs) before writing this: a Cloudflare
// Access *service token* is NOT a bearer token presented via an
// `Authorization` header. It's a client id/secret PAIR, sent to Access at
// the edge as two headers — `CF-Access-Client-Id` and
// `CF-Access-Client-Secret` — on every request, and Access reads those
// headers off the WebSocket upgrade request the very same way it reads
// them off any other HTTPS request (there is no separate WS credential
// channel, and no documented gotcha specific to the upgrade request beyond
// "the headers have to be there, same as any other request" — which this
// client now does). On success, Access forwards the request to the origin
// worker with a `Cf-Access-Jwt-Assertion` header carrying a JWT Access
// itself signed; the worker verifies that JWT (`workers/vault/src/
// access-auth.ts`) — this client never sees or sends that JWT itself, it
// only supplies the client id/secret pair that gets Access to mint it.
//
// (An earlier revision of this file sent `Authorization: Bearer <token>`
// instead, based on an unverified assumption about how service tokens
// work. That was wrong — fixed here once the mechanism was confirmed
// against Cloudflare's docs; see `workers/vault/ACCESS_SETUP.md` for the
// citations.)

import EnchiridionCore
import Foundation

/// Errors specific to `VaultSyncClient`, distinct from the underlying
/// `URLSessionWebSocketTask` transport errors it wraps.
public enum VaultSyncClientError: Error, Sendable, Equatable {
  case notConnected
  case encodingFailed(String)
  case decodingFailed(String)
}

/// A Cloudflare Access *service token* — a client id/secret pair, not a
/// single bearer token (see this file's header comment on why). Sent as
/// `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers on the
/// WebSocket upgrade request; Keychain-backed per-device storage of one of
/// these is the plan's pinned Auth model ("Cloudflare Access service
/// tokens per device (Keychain)").
public struct AccessServiceTokenCredential: Sendable, Equatable {
  public let clientId: String
  public let clientSecret: String

  public init(clientId: String, clientSecret: String) {
    self.clientId = clientId
    self.clientSecret = clientSecret
  }
}

/// A non-CRDT outbox action's transport — deliberately left as an injected
/// closure rather than a concrete implementation. The plan's outbox is for
/// approvals/gadget calls (plan §Native apps), which are server RPCs, not
/// part of the six-message CRDT sync protocol (`SyncProtocolMessage`) this
/// client speaks over the WebSocket — the real transport (likely an
/// authenticated HTTPS RPC to the vault worker) doesn't exist yet, so
/// `VaultSyncClient` only owns *when* to attempt a drain, not *how* one
/// action gets delivered.
public typealias OutboxActionSender = @Sendable (OutboxAction) async throws -> Void

/// WebSocket client for the vault sync protocol: catalog-first handshake,
/// per-doc version-vector exchange, and reconnect-with-backoff. Also owns
/// (but does not itself transport) the offline outbox for non-CRDT actions.
///
/// An `actor` (Swift 6 strict concurrency, matching the old app's
/// `Package.swift` tools version 6.2) so connection-state transitions,
/// in-flight sends, and outbox draining all serialize safely.
public actor VaultSyncClient {
  /// The explicitly opt-in development credential understood only by a
  /// loopback `wrangler dev` Vault (see `workers/vault/src/access-auth.ts`).
  /// It is deliberately distinct from Cloudflare Access's service-token
  /// headers, so a production client cannot accidentally send one in place
  /// of a real Access credential.
  public static let localDevelopmentTokenHeader = "X-Enchiridion-Local-Token"

  public enum ConnectionState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int, nextAttemptAt: Date)
  }

  /// Vault-scoped outbox for non-CRDT actions (plan §Native apps). Exposed
  /// directly so callers can `enqueue` from anywhere in the app without
  /// routing every action through this actor first.
  public let outbox: OfflineOutbox

  /// Stream of protocol messages received from the server. A caller (e.g.
  /// a sync coordinator that owns `CRDTEngine`) consumes this to drive
  /// catalog diffing and doc import — `VaultSyncClient` itself does not
  /// interpret message contents, keeping CRDT-engine concerns out of the
  /// transport layer.
  public let incomingMessages: AsyncStream<SyncProtocolMessage>

  private let incomingContinuation: AsyncStream<SyncProtocolMessage>.Continuation
  private let vaultURL: URL
  private let requestHeaders: @Sendable () async -> [String: String]
  private let session: URLSession
  private let backoff: ReconnectBackoff

  private var task: URLSessionWebSocketTask?
  private var state: ConnectionState = .disconnected
  private var receiveLoopTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var shouldStayConnected = false
  private var reconnectAttempt = 0

  public init(
    vaultURL: URL,
    accessCredential: @escaping @Sendable () async -> AccessServiceTokenCredential,
    session: URLSession = .shared,
    outbox: OfflineOutbox = OfflineOutbox(),
    backoff: ReconnectBackoff = ReconnectBackoff()
  ) {
    self.vaultURL = vaultURL
    self.requestHeaders = {
      let credential = await accessCredential()
      return [
        "CF-Access-Client-Id": credential.clientId,
        "CF-Access-Client-Secret": credential.clientSecret,
      ]
    }
    self.session = session
    self.outbox = outbox
    self.backoff = backoff
    var continuation: AsyncStream<SyncProtocolMessage>.Continuation!
    self.incomingMessages = AsyncStream { continuation = $0 }
    self.incomingContinuation = continuation
  }

  /// Builds a client for an explicitly configured loopback local Vault.
  /// Production callers must keep using `init(vaultURL:accessCredential:)`;
  /// this initializer does not know or emulate Cloudflare Access.
  public init(
    vaultURL: URL,
    localDevelopmentToken: String,
    session: URLSession = .shared,
    outbox: OfflineOutbox = OfflineOutbox(),
    backoff: ReconnectBackoff = ReconnectBackoff()
  ) {
    self.vaultURL = vaultURL
    self.requestHeaders = {
      [Self.localDevelopmentTokenHeader: localDevelopmentToken]
    }
    self.session = session
    self.outbox = outbox
    self.backoff = backoff
    var continuation: AsyncStream<SyncProtocolMessage>.Continuation!
    self.incomingMessages = AsyncStream { continuation = $0 }
    self.incomingContinuation = continuation
  }

  public var connectionState: ConnectionState {
    state
  }

  /// Opens the connection and sends the catalog-first handshake
  /// (`.catalogRequest`, per the plan's "Catalog first ... syncs first on
  /// every connect"). On failure, or on any later disconnect, schedules a
  /// reconnect per `backoff` until `disconnect()` is called.
  public func connect() async {
    shouldStayConnected = true
    reconnectAttempt = 0
    await openConnection()
  }

  /// Closes the connection and stops reconnect attempts.
  public func disconnect() async {
    shouldStayConnected = false
    reconnectTask?.cancel()
    reconnectTask = nil
    receiveLoopTask?.cancel()
    receiveLoopTask = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    state = .disconnected
  }

  /// Sends a protocol message. Throws `.notConnected` rather than queuing —
  /// callers that need offline durability for non-CRDT actions should use
  /// `outbox`, not rely on this method buffering.
  public func send(_ message: SyncProtocolMessage) async throws {
    guard let task else {
      throw VaultSyncClientError.notConnected
    }
    let data: Data
    do {
      data = try JSONEncoder.vaultSyncProtocol.encode(message)
    } catch {
      throw VaultSyncClientError.encodingFailed(String(describing: error))
    }
    try await task.send(.data(data))
  }

  /// Attempts to drain the offline outbox using `sender`. Stops at the
  /// first failure (re-enqueuing the action that failed) rather than
  /// reordering around it — non-CRDT actions like approvals are expected to
  /// be applied in submission order.
  public func drainOutbox(using sender: OutboxActionSender) async {
    while let action = await outbox.dequeueOldest() {
      do {
        try await sender(action)
      } catch {
        await outbox.requeue(action)
        break
      }
    }
  }

  // MARK: - Connection lifecycle

  private func openConnection() async {
    state = .connecting
    var request = URLRequest(url: vaultURL)
    for (name, value) in await requestHeaders() {
      request.setValue(value, forHTTPHeaderField: name)
    }

    let newTask = session.webSocketTask(with: request)
    task = newTask
    newTask.resume()
    state = .connected
    reconnectAttempt = 0

    do {
      try await send(.catalogRequest)
    } catch {
      await handleDisconnect()
      return
    }

    receiveLoopTask = Task { [weak self] in
      await self?.receiveLoop()
    }
  }

  private func receiveLoop() async {
    while !Task.isCancelled {
      guard let task else { return }
      do {
        let message = try await task.receive()
        switch message {
        case .data(let data):
          handleIncomingData(data)
        case .string(let string):
          if let data = string.data(using: .utf8) {
            handleIncomingData(data)
          }
        @unknown default:
          break
        }
      } catch {
        await handleDisconnect()
        return
      }
    }
  }

  private func handleIncomingData(_ data: Data) {
    guard let message = try? JSONDecoder.vaultSyncProtocol.decode(SyncProtocolMessage.self, from: data) else {
      // Malformed frame from the server: drop it rather than tearing down
      // the connection — a single bad frame shouldn't cost a resync.
      return
    }
    incomingContinuation.yield(message)
  }

  private func handleDisconnect() async {
    task = nil
    receiveLoopTask?.cancel()
    receiveLoopTask = nil

    guard shouldStayConnected else {
      state = .disconnected
      return
    }

    reconnectAttempt += 1
    let interval = backoff.interval(forAttempt: reconnectAttempt)
    let nextAttemptAt = Date().addingTimeInterval(interval)
    state = .reconnecting(attempt: reconnectAttempt, nextAttemptAt: nextAttemptAt)

    reconnectTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
      guard !Task.isCancelled else { return }
      await self?.retryConnect()
    }
  }

  private func retryConnect() async {
    guard shouldStayConnected else { return }
    await openConnection()
  }
}

/// Exponential backoff with a cap, for `VaultSyncClient`'s reconnect loop.
/// A separate `Sendable` value type (not inline math in the client) so
/// tests can verify the schedule without opening a real socket.
public struct ReconnectBackoff: Sendable {
  public var baseInterval: TimeInterval
  public var maxInterval: TimeInterval

  public init(baseInterval: TimeInterval = 1, maxInterval: TimeInterval = 60) {
    self.baseInterval = baseInterval
    self.maxInterval = maxInterval
  }

  /// `attempt` is 1-based (the first reconnect attempt after a drop).
  public func interval(forAttempt attempt: Int) -> TimeInterval {
    guard attempt > 0 else { return baseInterval }
    let scaled = baseInterval * pow(2, Double(attempt - 1))
    return min(maxInterval, scaled)
  }
}
