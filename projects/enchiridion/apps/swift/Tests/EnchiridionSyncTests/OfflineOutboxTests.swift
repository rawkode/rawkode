// OfflineOutboxTests.swift
// EnchiridionSyncTests

import Foundation
import XCTest

@testable import EnchiridionSync

final class OfflineOutboxTests: XCTestCase {
  func testEnqueueDequeueIsFIFO() async {
    let outbox = OfflineOutbox()
    let first = OutboxAction(idempotencyKey: "a", kind: "test.kind", payload: Data())
    let second = OutboxAction(idempotencyKey: "b", kind: "test.kind", payload: Data())

    let enqueuedFirst = await outbox.enqueue(first)
    let enqueuedSecond = await outbox.enqueue(second)
    XCTAssertTrue(enqueuedFirst)
    XCTAssertTrue(enqueuedSecond)

    let pending = await outbox.pendingActions()
    XCTAssertEqual(pending.map(\.idempotencyKey), ["a", "b"])

    let dequeued = await outbox.dequeueOldest()
    XCTAssertEqual(dequeued?.idempotencyKey, "a")
    let remaining = await outbox.pendingActions()
    XCTAssertEqual(remaining.map(\.idempotencyKey), ["b"])
  }

  func testEnqueueWithDuplicateIdempotencyKeyIsANoOp() async {
    let outbox = OfflineOutbox()
    let original = OutboxAction(
      idempotencyKey: "dup", kind: "test.kind", payload: Data([0x01]))
    let duplicate = OutboxAction(
      idempotencyKey: "dup", kind: "test.kind", payload: Data([0x02]))

    let enqueuedOriginal = await outbox.enqueue(original)
    let enqueuedDuplicate = await outbox.enqueue(duplicate)
    XCTAssertTrue(enqueuedOriginal)
    XCTAssertFalse(enqueuedDuplicate)

    let pending = await outbox.pendingActions()
    XCTAssertEqual(pending.count, 1)
    // The original payload wins — a duplicate enqueue must not clobber it.
    XCTAssertEqual(pending.first?.payload, Data([0x01]))
  }

  func testAcknowledgeRemovesAction() async {
    let outbox = OfflineOutbox()
    let action = OutboxAction(idempotencyKey: "ack-me", kind: "test.kind", payload: Data())
    await outbox.enqueue(action)

    let acknowledged = await outbox.acknowledge(idempotencyKey: "ack-me")
    XCTAssertTrue(acknowledged)
    let pending = await outbox.pendingActions()
    XCTAssertTrue(pending.isEmpty)

    // Acknowledging again is a no-op, not an error.
    let secondAcknowledge = await outbox.acknowledge(idempotencyKey: "ack-me")
    XCTAssertFalse(secondAcknowledge)
  }

  func testRequeueAfterFailedSendPreservesOrder() async {
    let outbox = OfflineOutbox()
    let first = OutboxAction(idempotencyKey: "1", kind: "test.kind", payload: Data())
    let second = OutboxAction(idempotencyKey: "2", kind: "test.kind", payload: Data())
    await outbox.enqueue(first)
    await outbox.enqueue(second)

    // Simulate a send loop: pop the oldest, "fail" to send it, requeue.
    guard let popped = await outbox.dequeueOldest() else {
      return XCTFail("expected a pending action")
    }
    XCTAssertEqual(popped.idempotencyKey, "1")
    let requeued = await outbox.requeue(popped)
    XCTAssertTrue(requeued)

    // Requeued action goes to the back, so "2" is now oldest.
    let pending = await outbox.pendingActions()
    XCTAssertEqual(pending.map(\.idempotencyKey), ["2", "1"])
  }

  func testPendingCountAndRemoveAll() async {
    let outbox = OfflineOutbox()
    await outbox.enqueue(OutboxAction(idempotencyKey: "1", kind: "k", payload: Data()))
    await outbox.enqueue(OutboxAction(idempotencyKey: "2", kind: "k", payload: Data()))
    let count = await outbox.pendingCount
    XCTAssertEqual(count, 2)

    await outbox.removeAll()
    let afterClear = await outbox.pendingCount
    XCTAssertEqual(afterClear, 0)
  }
}
