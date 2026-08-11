// GadgetBridge.swift
// EnchiridionGadgets
//
// The capability-request dispatcher between a WKWebView-hosted gadget's JS
// and its actual capability surface (`GadgetBridgeTransport`) — the "clean
// Swift interface" the task brief asks for. `GadgetBridgeMessageHandler`
// (GadgetBridgeMessageHandler.swift) is the only caller in production: it
// parses a raw `WKScriptMessage.body` into a `GadgetBridgeRequest`
// (GadgetBridgeMessage.swift) and hands it to `handle(request:)` here.
//
// SECURITY POSTURE — mirrors the server's, doesn't replace it: this is a
// DEVICE-SIDE, DEFENSE-IN-DEPTH check, not the authority. `workers/gadget-
// host/src/capability-enforcement.ts`'s `requireCapability` (and the two-
// layer view-allowlist check in `graph-query-capability.ts`) remain the
// real enforcement — a device is untrusted the same way any client is, and
// a compromised/patched app binary could in principle skip this check
// entirely. What this check actually buys, given that: it means a gadget's
// own JS never even gets to attempt an unauthorized call over the network
// — no request for a capability this gadget instance doesn't currently
// hold ever reaches `GadgetBridgeTransport.send(_:)`, so a malicious or
// buggy gadget can't use network timing, retry counts, or error-shape
// differences to probe what it might be able to get away with server-side.
// This is exactly the plan's "default-deny, explicit capability grants, no
// raw access" posture applied client-side, not a substitute for it.
//
// CONCURRENCY CAP: `GadgetBridgeMessageHandler.userContentController(_:
// didReceive:)` spawns one unstructured `Task` per inbound `postMessage`
// with no cap of its own — a misbehaving or malicious gadget flooding
// `postMessage` would otherwise create unbounded concurrent `Task`s, and
// for authorized requests, unbounded concurrent real network calls via
// `transport.send(_:)`. Since this actor is the one place every request
// for one gadget instance funnels through regardless of how many `Task`s
// spawned it, `handle(request:)` tracks `inFlightRequestCount` and denies
// (not queues) any request past `maxConcurrentInFlightRequests` — a clear,
// immediate denial is preferable to silently queuing: queuing would still
// let the caller pile up unbounded pending work, just moved from
// "concurrent network calls" to "concurrent suspended Tasks waiting for a
// turn", which doesn't actually bound resource use, only reshapes it.
//
// REVOCATION: `updateGrants(_:)` lets the host update this bridge's
// snapshot of active grants (e.g. after the in-app approval UI revokes
// one) without tearing down and recreating the whole bridge/WebView. A
// grant removed via `updateGrants(_:)` denies the NEXT request that needs
// it — there is no in-flight-request cancellation here (a request already
// past the `authorize` check and inside `transport.send(_:)` runs to
// completion), matching the plan's `schedule.cron` note that revocation
// must be "re-checked at fan-out time, not just at registration": this
// bridge re-checks at every `handle(request:)` call, not once at gadget
// load.

import Foundation

/// One capability request per gadget instance, dispatched serially per
/// gadget (an `actor`, matching `VaultSyncClient`'s convention in
/// EnchiridionSync — see that file) — the grants dictionary is mutable
/// state (`updateGrants(_:)`) that must never be read mid-mutation by a
/// concurrent `handle(request:)` call.
public actor GadgetBridge {
  /// Machine-checkable failure codes surfaced in a `.failure`
  /// `GadgetBridgeResponse` — a gadget's own error-handling JS can branch
  /// on these without string-matching a human-readable message.
  public enum DenialCode: String, Sendable {
    case capabilityDenied = "capability_denied"
    case transportError = "transport_error"
    /// Returned by `handle(request:)` when this gadget instance already
    /// has `maxConcurrentInFlightRequests` requests in progress — see this
    /// file's header ("CONCURRENCY CAP") for why this exists.
    case tooManyInFlightRequests = "too_many_in_flight_requests"
  }

  /// Hard cap on how many `handle(request:)` calls may be simultaneously
  /// past authorization and inside `transport.send(_:)` for one gadget
  /// instance at a time — see this file's header ("CONCURRENCY CAP").
  /// Chosen as 10: generous enough that no legitimate gadget UI (which
  /// fires a handful of `graphQuery`/`graphPropose` calls per user
  /// interaction, not dozens) should ever bump into it, while still being
  /// a small, fixed multiple of realistic concurrent use — bounding both
  /// the unstructured `Task` fan-out in `GadgetBridgeMessageHandler`
  /// (one per inbound `postMessage`) and, for authorized requests, the
  /// real concurrent network calls `HTTPGadgetBridgeTransport` would
  /// otherwise place with no ceiling at all.
  public static let maxConcurrentInFlightRequests = 10

  public let gadgetID: String
  private var grantsByType: [GadgetCapabilityType: GadgetCapabilityScope]
  private let transport: GadgetBridgeTransport
  /// Count of requests currently past authorization and awaiting
  /// `transport.send(_:)` — see "CONCURRENCY CAP" in this file's header.
  /// Actor-isolated like every other mutable field here, so increment/
  /// check/decrement can never race across concurrently-dispatched
  /// `handle(request:)` calls.
  private var inFlightRequestCount = 0

  public init(gadgetID: String, grants: [GadgetCapabilityGrant], transport: GadgetBridgeTransport) {
    self.gadgetID = gadgetID
    self.transport = transport
    self.grantsByType = Dictionary(grants.map { ($0.capabilityType, $0.scope) }, uniquingKeysWith: { _, latest in latest })
  }

  /// Replaces this bridge's grant snapshot wholesale — see this file's
  /// header ("REVOCATION"). A capability type absent from `grants` is
  /// treated as not granted at all, matching the server's "default
  /// nothing" posture; there's no way to update one grant in place while
  /// leaving stale ones behind.
  public func updateGrants(_ grants: [GadgetCapabilityGrant]) {
    grantsByType = Dictionary(grants.map { ($0.capabilityType, $0.scope) }, uniquingKeysWith: { _, latest in latest })
  }

  /// The single entry point `GadgetBridgeMessageHandler` calls for every
  /// parsed `postMessage`. Always returns a response keyed to
  /// `request.id` — never throws, never leaves a JS-side `Promise`
  /// hanging on an unhandled Swift error.
  public func handle(request: GadgetBridgeRequest) async -> GadgetBridgeResponse {
    if case .failure(let denial) = authorize(request) {
      return GadgetBridgeResponse(
        id: request.id, outcome: .failure(code: DenialCode.capabilityDenied.rawValue, message: denial.reason))
    }

    // See "CONCURRENCY CAP" in this file's header. Checked (and, on
    // success, incremented) synchronously — no `await` between the check
    // and the increment — so concurrently-dispatched calls into this
    // actor can't both observe room under the cap and both proceed;
    // actor isolation serializes this whole synchronous section.
    guard inFlightRequestCount < Self.maxConcurrentInFlightRequests else {
      return GadgetBridgeResponse(
        id: request.id,
        outcome: .failure(
          code: DenialCode.tooManyInFlightRequests.rawValue,
          message:
            "gadget \"\(gadgetID)\" already has \(inFlightRequestCount) request(s) in flight (max \(Self.maxConcurrentInFlightRequests))"
        )
      )
    }
    inFlightRequestCount += 1
    defer { inFlightRequestCount -= 1 }

    do {
      let result = try await transport.send(request)
      return GadgetBridgeResponse(id: request.id, outcome: .success(result))
    } catch {
      return GadgetBridgeResponse(
        id: request.id,
        outcome: .failure(code: DenialCode.transportError.rawValue, message: "\(error)")
      )
    }
  }

  /// A plain, `Error`-conforming wrapper around the denial reason string —
  /// `Result`'s failure type must conform to `Error`, and a bare `String`
  /// doesn't.
  private struct AuthorizationDenial: Error, Sendable {
    let reason: String
  }

  /// The local allowlist check — see this file's header for what this
  /// does and does not guarantee. Denies BEFORE `transport.send(_:)` is
  /// ever called, which is the property under test in
  /// `GadgetBridgeTests.swift` ("a request for a capability the gadget
  /// wasn't granted is denied before reaching any network call").
  private func authorize(_ request: GadgetBridgeRequest) -> Result<Void, AuthorizationDenial> {
    guard let scope = grantsByType[request.capabilityType] else {
      return .failure(
        AuthorizationDenial(reason: "gadget \"\(gadgetID)\" has no active \(request.capabilityType.rawValue) grant")
      )
    }

    switch (request.capabilityType, scope) {
    case (.graphQuery, .graphQuery(let views)):
      guard let view = request.view, !view.isEmpty else {
        return .failure(AuthorizationDenial(reason: "graph.query request is missing \"view\""))
      }
      guard views.contains(view) else {
        return .failure(
          AuthorizationDenial(
            reason: "view \"\(view)\" is not in this grant's allowlist (\(views.isEmpty ? "<empty>" : views.joined(separator: ", ")))"
          )
        )
      }
      return .success(())

    case (.graphPropose, .graphPropose(let pageIDs, let pagePrefixes)):
      guard let pageID = request.params?.stringValue(forKey: "pageID"), !pageID.isEmpty else {
        return .failure(AuthorizationDenial(reason: "graph.propose request is missing params.pageID"))
      }
      let inScope = pageIDs.contains(pageID) || pagePrefixes.contains { pageID.hasPrefix($0) }
      guard inScope else {
        return .failure(AuthorizationDenial(reason: "pageID \"\(pageID)\" is not in this grant's scope"))
      }
      return .success(())

    case (.gatekeeperGoogleCalendarRead, .gatekeeperGoogleCalendarRead):
      return .success(())

    case (.scheduleCron, .scheduleCron):
      // A UI gadget's postMessage bridge is not the path
      // `schedule-fanout.ts` uses to invoke a headless gadget on a timer
      // (that's a server-side supervisor tick, not a WebView call) — this
      // case exists only so the capability-type switch stays exhaustive
      // and every `GadgetCapabilityType` has a defined authorization rule,
      // matching "default nothing" even for a case this bridge doesn't
      // expect to see in practice. Grant presence alone is sufficient
      // here; there is no request-shape to validate beyond that.
      return .success(())

    default:
      // Defensive — cannot happen if `grantsByType`'s construction
      // invariant holds (keyed by `scope.capabilityType`), but fail closed
      // rather than assume, mirroring `graph-query-capability.ts`'s
      // identical defensive branch for the same reason.
      return .failure(
        AuthorizationDenial(reason: "grant scope is malformed for \(request.capabilityType.rawValue) (type mismatch)")
      )
    }
  }
}
