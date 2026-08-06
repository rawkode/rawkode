// GadgetBridgeTests.swift
// EnchiridionGadgetsTests
//
// The three behaviors the task brief asks for directly:
//   1. A request for a capability the gadget wasn't granted is denied
//      BEFORE reaching any network call.
//   2. A granted capability's request/response round-trips correctly
//      through `GadgetBridge`'s handling logic (mocked transport).
//   3. Malformed/unexpected shapes are rejected safely (covered mostly by
//      GadgetBridgeRequestParsingTests.swift — this file adds the
//      "GadgetBridge.handle never crashes on a request whose transport
//      call fails" half of that same guarantee).
//
// `RecordingTransport` below both records every call it receives (so a
// test can assert the "before reaching any network call" property by
// asserting zero calls) and returns a scripted result/error, so both
// success and failure paths through `GadgetBridge.handle` are exercised
// without any real networking.

import Foundation
import XCTest

@testable import EnchiridionGadgets

private actor RecordingTransport: GadgetBridgeTransport {
  private(set) var receivedRequests: [GadgetBridgeRequest] = []
  private let result: Result<GadgetJSONValue, Error>

  init(result: Result<GadgetJSONValue, Error>) {
    self.result = result
  }

  func send(_ request: GadgetBridgeRequest) async throws -> GadgetJSONValue {
    receivedRequests.append(request)
    return try result.get()
  }

  var callCount: Int { receivedRequests.count }
}

private struct TestTransportError: Error, Equatable {
  let message: String
}

/// A `GadgetBridgeTransport` that stays "in flight" for a fixed delay
/// before returning success — used to prove `GadgetBridge`'s concurrent-
/// request cap (see "CONCURRENCY CAP" in GadgetBridge.swift's header):
/// holding every call open for the same window means a burst of
/// concurrently-dispatched `handle(request:)` calls genuinely overlaps
/// inside `transport.send(_:)`, rather than completing so fast the cap
/// never has a chance to matter.
private actor DelayedTransport: GadgetBridgeTransport {
  private let delayNanoseconds: UInt64
  private(set) var callCount = 0

  init(delayNanoseconds: UInt64) {
    self.delayNanoseconds = delayNanoseconds
  }

  func send(_ request: GadgetBridgeRequest) async throws -> GadgetJSONValue {
    callCount += 1
    try await Task.sleep(nanoseconds: delayNanoseconds)
    return .null
  }
}

final class GadgetBridgeTests: XCTestCase {
  // MARK: - Denial before any network call

  func testUngrantedCapabilityIsDeniedWithoutCallingTransport() async {
    let transport = RecordingTransport(result: .success(.null))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [], transport: transport)

    let request = GadgetBridgeRequest(id: "req-1", capabilityType: .graphQuery, view: "nodesByTag")
    let response = await bridge.handle(request: request)

    guard case .failure(let code, _) = response.outcome else {
      return XCTFail("expected denial, got \(response.outcome)")
    }
    XCTAssertEqual(code, "capability_denied")
    let callCount = await transport.callCount
    XCTAssertEqual(callCount, 0, "transport must not be called for an ungranted capability")
  }

  func testViewOutsideGrantAllowlistIsDeniedWithoutCallingTransport() async {
    let transport = RecordingTransport(result: .success(.null))
    let grant = GadgetCapabilityGrant(id: "grant-1", scope: .graphQuery(views: ["nodesByTag"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    // Granted graph.query, but for a DIFFERENT view than requested.
    let request = GadgetBridgeRequest(id: "req-2", capabilityType: .graphQuery, view: "listPages")
    let response = await bridge.handle(request: request)

    guard case .failure(let code, let message) = response.outcome else {
      return XCTFail("expected denial, got \(response.outcome)")
    }
    XCTAssertEqual(code, "capability_denied")
    XCTAssertTrue(message.contains("listPages"), "denial message should name the rejected view")
    let callCount = await transport.callCount
    XCTAssertEqual(callCount, 0)
  }

  func testGraphQueryRequestMissingViewIsDeniedWithoutCallingTransport() async {
    let transport = RecordingTransport(result: .success(.null))
    let grant = GadgetCapabilityGrant(id: "grant-1", scope: .graphQuery(views: ["nodesByTag"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(id: "req-3", capabilityType: .graphQuery, view: nil)
    let response = await bridge.handle(request: request)

    guard case .failure = response.outcome else {
      return XCTFail("expected denial, got \(response.outcome)")
    }
    let callCount = await transport.callCount
    XCTAssertEqual(callCount, 0)
  }

  func testGraphProposeOutsideScopeIsDeniedWithoutCallingTransport() async {
    let transport = RecordingTransport(result: .success(.null))
    let grant = GadgetCapabilityGrant(
      id: "grant-2",
      scope: .graphPropose(pageIDs: [], pagePrefixes: ["daily:"])
    )
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(
      id: "req-4", capabilityType: .graphPropose, params: .object(["pageID": .string("person_abc123")])
    )
    let response = await bridge.handle(request: request)

    guard case .failure = response.outcome else {
      return XCTFail("expected denial, got \(response.outcome)")
    }
    let callCount = await transport.callCount
    XCTAssertEqual(callCount, 0)
  }

  func testGraphProposeMissingPageIDIsDeniedWithoutCallingTransport() async {
    let transport = RecordingTransport(result: .success(.null))
    let grant = GadgetCapabilityGrant(id: "grant-2", scope: .graphPropose(pageIDs: [], pagePrefixes: ["daily:"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(id: "req-5", capabilityType: .graphPropose, params: nil)
    let response = await bridge.handle(request: request)

    guard case .failure = response.outcome else {
      return XCTFail("expected denial, got \(response.outcome)")
    }
    let callCount = await transport.callCount
    XCTAssertEqual(callCount, 0)
  }

  // MARK: - Granted capability round-trips through the mocked transport

  func testGrantedGraphQueryRoundTripsThroughTransport() async {
    let expectedResult = GadgetJSONValue.object(["nodes": .array([.object(["id": .string("task_1"), "title": .string("Buy milk")])])])
    let transport = RecordingTransport(result: .success(expectedResult))
    let grant = GadgetCapabilityGrant(id: "grant-1", scope: .graphQuery(views: ["nodesByTag"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(
      id: "req-6", capabilityType: .graphQuery, view: "nodesByTag", params: .object(["tagID": .string("task")])
    )
    let response = await bridge.handle(request: request)

    XCTAssertEqual(response.id, "req-6")
    guard case .success(let result) = response.outcome else {
      return XCTFail("expected success, got \(response.outcome)")
    }
    XCTAssertEqual(result, expectedResult)

    let received = await transport.receivedRequests
    XCTAssertEqual(received, [request], "the exact request should be forwarded to the transport unmodified")
  }

  func testGrantedGraphProposeExactPageIDMatchRoundTrips() async {
    let transport = RecordingTransport(result: .success(.object(["proposalID": .string("prop-1")])))
    let grant = GadgetCapabilityGrant(id: "grant-2", scope: .graphPropose(pageIDs: ["daily:2026-08-06"], pagePrefixes: []))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(
      id: "req-7", capabilityType: .graphPropose, params: .object(["pageID": .string("daily:2026-08-06")])
    )
    let response = await bridge.handle(request: request)

    guard case .success = response.outcome else {
      return XCTFail("expected success, got \(response.outcome)")
    }
    let callCount = await transport.callCount
    XCTAssertEqual(callCount, 1)
  }

  func testGrantedGraphProposePagePrefixMatchRoundTrips() async {
    let transport = RecordingTransport(result: .success(.bool(true)))
    let grant = GadgetCapabilityGrant(id: "grant-2", scope: .graphPropose(pageIDs: [], pagePrefixes: ["daily:"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(
      id: "req-8", capabilityType: .graphPropose, params: .object(["pageID": .string("daily:2026-08-07")])
    )
    let response = await bridge.handle(request: request)

    guard case .success = response.outcome else {
      return XCTFail("expected success for a page matching the granted prefix, got \(response.outcome)")
    }
  }

  func testGrantedCalendarReadRoundTrips() async {
    let transport = RecordingTransport(result: .success(.array([.string("event-1")])))
    let grant = GadgetCapabilityGrant(id: "grant-3", scope: .gatekeeperGoogleCalendarRead)
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(id: "req-9", capabilityType: .gatekeeperGoogleCalendarRead)
    let response = await bridge.handle(request: request)

    guard case .success = response.outcome else {
      return XCTFail("expected success, got \(response.outcome)")
    }
  }

  // MARK: - Transport failure surfaces as a denial-shaped response, not a crash

  func testTransportErrorProducesFailureResponseNotACrash() async {
    let transport = RecordingTransport(result: .failure(TestTransportError(message: "network down")))
    let grant = GadgetCapabilityGrant(id: "grant-1", scope: .graphQuery(views: ["nodesByTag"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(id: "req-10", capabilityType: .graphQuery, view: "nodesByTag")
    let response = await bridge.handle(request: request)

    guard case .failure(let code, _) = response.outcome else {
      return XCTFail("expected failure, got \(response.outcome)")
    }
    XCTAssertEqual(code, "transport_error")
    XCTAssertEqual(response.id, "req-10")
  }

  // MARK: - Revocation via updateGrants

  func testRevokedGrantDeniesTheNextRequest() async {
    let transport = RecordingTransport(result: .success(.null))
    let grant = GadgetCapabilityGrant(id: "grant-1", scope: .graphQuery(views: ["nodesByTag"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(id: "req-11", capabilityType: .graphQuery, view: "nodesByTag")
    let firstResponse = await bridge.handle(request: request)
    guard case .success = firstResponse.outcome else {
      return XCTFail("expected the initial grant to authorize the request")
    }

    // Revoke by handing the bridge an empty grant set.
    await bridge.updateGrants([])

    let secondResponse = await bridge.handle(request: request)
    guard case .failure(let code, _) = secondResponse.outcome else {
      return XCTFail("expected denial after revocation, got \(secondResponse.outcome)")
    }
    XCTAssertEqual(code, "capability_denied")

    let callCount = await transport.callCount
    XCTAssertEqual(callCount, 1, "the revoked request must not reach the transport a second time")
  }

  func testUpdateGrantsCanWidenAllowlistForSubsequentRequests() async {
    let transport = RecordingTransport(result: .success(.null))
    let grant = GadgetCapabilityGrant(id: "grant-1", scope: .graphQuery(views: ["nodesByTag"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let request = GadgetBridgeRequest(id: "req-12", capabilityType: .graphQuery, view: "listPages")
    let denied = await bridge.handle(request: request)
    guard case .failure = denied.outcome else { return XCTFail("expected initial denial") }

    await bridge.updateGrants([GadgetCapabilityGrant(id: "grant-1b", scope: .graphQuery(views: ["nodesByTag", "listPages"]))])

    let allowed = await bridge.handle(request: request)
    guard case .success = allowed.outcome else {
      return XCTFail("expected success after widening the grant, got \(allowed.outcome)")
    }
  }

  // MARK: - Concurrent in-flight request cap

  /// Fires `GadgetBridge.maxConcurrentInFlightRequests + 1` authorized
  /// requests essentially simultaneously against a transport that holds
  /// every call open for the same delay. Exactly `maxConcurrentInFlightRequests`
  /// should reach the transport and succeed; the one request that arrives
  /// once the cap is already saturated should be denied with
  /// `too_many_in_flight_requests` WITHOUT ever reaching the transport —
  /// mirrors this file's existing "denied before any network call"
  /// pattern, just for the concurrency cap instead of the authorization
  /// check.
  func testRequestsPastTheConcurrencyCapAreDeniedWithoutCallingTransport() async {
    let cap = GadgetBridge.maxConcurrentInFlightRequests
    let transport = DelayedTransport(delayNanoseconds: 300_000_000)  // 300ms — long enough that none finish before the burst is fully dispatched
    let grant = GadgetCapabilityGrant(id: "grant-1", scope: .graphQuery(views: ["nodesByTag"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    let responses = await withTaskGroup(of: GadgetBridgeResponse.self) { group in
      for index in 0..<(cap + 1) {
        group.addTask {
          let request = GadgetBridgeRequest(id: "req-burst-\(index)", capabilityType: .graphQuery, view: "nodesByTag")
          return await bridge.handle(request: request)
        }
      }
      var collected: [GadgetBridgeResponse] = []
      for await response in group {
        collected.append(response)
      }
      return collected
    }

    XCTAssertEqual(responses.count, cap + 1)

    let succeeded = responses.filter {
      if case .success = $0.outcome { return true }
      return false
    }
    let denied = responses.filter {
      if case .failure(let code, _) = $0.outcome { return code == "too_many_in_flight_requests" }
      return false
    }

    XCTAssertEqual(succeeded.count, cap, "exactly the cap's worth of requests should reach the transport and succeed")
    XCTAssertEqual(denied.count, 1, "exactly one request should be denied for exceeding the concurrency cap")

    let callCount = await transport.callCount
    XCTAssertEqual(callCount, cap, "the denied request must never have reached the transport")
  }

  /// Once every in-flight request from a saturated burst has completed,
  /// `inFlightRequestCount` must have been decremented back down — a new
  /// request afterward should succeed normally, proving the cap doesn't
  /// permanently wedge the bridge.
  func testConcurrencyCapReleasesAfterInFlightRequestsComplete() async {
    let cap = GadgetBridge.maxConcurrentInFlightRequests
    let transport = DelayedTransport(delayNanoseconds: 50_000_000)  // 50ms
    let grant = GadgetCapabilityGrant(id: "grant-1", scope: .graphQuery(views: ["nodesByTag"]))
    let bridge = GadgetBridge(gadgetID: "gadget-1", grants: [grant], transport: transport)

    await withTaskGroup(of: Void.self) { group in
      for index in 0..<cap {
        group.addTask {
          let request = GadgetBridgeRequest(id: "req-first-wave-\(index)", capabilityType: .graphQuery, view: "nodesByTag")
          _ = await bridge.handle(request: request)
        }
      }
      await group.waitForAll()
    }

    let followUpRequest = GadgetBridgeRequest(id: "req-after-release", capabilityType: .graphQuery, view: "nodesByTag")
    let followUpResponse = await bridge.handle(request: followUpRequest)

    guard case .success = followUpResponse.outcome else {
      return XCTFail("expected success once the in-flight slots freed up, got \(followUpResponse.outcome)")
    }
  }
}
