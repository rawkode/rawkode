// VaultSyncClientTests.swift
// EnchiridionSyncTests
//
// `VaultSyncClient` itself needs a live VaultDO to test its connect/receive
// flow end-to-end (that server doesn't exist yet — a separate task). What's
// tested here is its pure, server-independent logic: the reconnect backoff
// schedule, and that a fresh client starts disconnected.

import Foundation
import XCTest

@testable import EnchiridionSync

final class VaultSyncClientTests: XCTestCase {
  func testReconnectBackoffDoublesUntilCap() {
    let backoff = ReconnectBackoff(baseInterval: 1, maxInterval: 60)
    XCTAssertEqual(backoff.interval(forAttempt: 1), 1)
    XCTAssertEqual(backoff.interval(forAttempt: 2), 2)
    XCTAssertEqual(backoff.interval(forAttempt: 3), 4)
    XCTAssertEqual(backoff.interval(forAttempt: 4), 8)
    XCTAssertEqual(backoff.interval(forAttempt: 5), 16)
    XCTAssertEqual(backoff.interval(forAttempt: 6), 32)
    // Caps at maxInterval rather than continuing to grow unbounded.
    XCTAssertEqual(backoff.interval(forAttempt: 7), 60)
    XCTAssertEqual(backoff.interval(forAttempt: 20), 60)
  }

  func testReconnectBackoffAttemptZeroReturnsBase() {
    let backoff = ReconnectBackoff(baseInterval: 2, maxInterval: 30)
    XCTAssertEqual(backoff.interval(forAttempt: 0), 2)
  }

  func testFreshClientStartsDisconnected() async {
    let client = VaultSyncClient(
      vaultURL: URL(string: "wss://vault.example.com/sync")!,
      accessCredential: { AccessServiceTokenCredential(clientId: "test-client-id", clientSecret: "test-client-secret") }
    )
    let state = await client.connectionState
    XCTAssertEqual(state, .disconnected)
  }

  func testSendWithoutConnectingThrowsNotConnected() async {
    let client = VaultSyncClient(
      vaultURL: URL(string: "wss://vault.example.com/sync")!,
      accessCredential: { AccessServiceTokenCredential(clientId: "test-client-id", clientSecret: "test-client-secret") }
    )
    do {
      try await client.send(.catalogRequest)
      XCTFail("expected VaultSyncClientError.notConnected")
    } catch VaultSyncClientError.notConnected {
      // expected
    } catch {
      XCTFail("expected .notConnected, got \(error)")
    }
  }

  func testDrainOutboxStopsAtFirstFailureAndRequeues() async {
    let client = VaultSyncClient(
      vaultURL: URL(string: "wss://vault.example.com/sync")!,
      accessCredential: { AccessServiceTokenCredential(clientId: "test-client-id", clientSecret: "test-client-secret") }
    )
    let first = OutboxAction(idempotencyKey: "1", kind: "test.kind", payload: Data())
    let second = OutboxAction(idempotencyKey: "2", kind: "test.kind", payload: Data())
    await client.outbox.enqueue(first)
    await client.outbox.enqueue(second)

    struct SendFailure: Error {}
    await client.drainOutbox { action in
      if action.idempotencyKey == "1" {
        throw SendFailure()
      }
    }

    // "1" failed and was requeued to the back; "2" was never attempted
    // because drain stops at the first failure — so "2" is oldest again
    // and will be retried before "1" on the next drain.
    let pending = await client.outbox.pendingActions()
    XCTAssertEqual(pending.map(\.idempotencyKey), ["2", "1"])
  }

  func testDrainOutboxAcknowledgesSuccessfulSends() async {
    let client = VaultSyncClient(
      vaultURL: URL(string: "wss://vault.example.com/sync")!,
      accessCredential: { AccessServiceTokenCredential(clientId: "test-client-id", clientSecret: "test-client-secret") }
    )
    await client.outbox.enqueue(
      OutboxAction(idempotencyKey: "ok", kind: "test.kind", payload: Data()))

    await client.drainOutbox { _ in }

    let pending = await client.outbox.pendingActions()
    XCTAssertTrue(pending.isEmpty)
  }
}
