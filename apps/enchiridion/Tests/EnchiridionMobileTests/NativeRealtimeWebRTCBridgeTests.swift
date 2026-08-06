import XCTest

@testable import Enchiridion

#if os(iOS)
  final class NativeRealtimeWebRTCBridgeTests: XCTestCase {
    func testGateCompletesBeforeWait() async throws {
      let gate = NativeRealtimeWebRTCOperationGate<Int>()
      gate.succeed(42)
      let value = try await gate.wait(timeout: .seconds(1))
      XCTAssertEqual(value, 42)
    }

    func testGateInvalidatesWaiter() async {
      let gate = NativeRealtimeWebRTCOperationGate<Void>()
      gate.invalidate()
      do {
        _ = try await gate.wait(timeout: .seconds(1))
        XCTFail("expected invalidated gate")
      } catch {}
    }

    func testRelayPrioritizesTerminalThenControlsThenActivity() async {
      let relay = NativeRealtimeWebRTCEventRelay()
      let stream = relay.stream()
      relay.push(.audioActivity(generation: 1, inputLevel: 0, outputLevel: 0.2))
      relay.push(.answerApplied(generation: 1))
      var iterator = stream.makeAsyncIterator()
      let control = await iterator.next()
      let activity = await iterator.next()
      XCTAssertEqual(control, .answerApplied(generation: 1))
      XCTAssertEqual(activity, .audioActivity(generation: 1, inputLevel: 0, outputLevel: 0.2))
      relay.terminal(.failure(generation: 1, code: "terminal"))
      let terminal = await iterator.next()
      let end = await iterator.next()
      XCTAssertEqual(terminal, .failure(generation: 1, code: "terminal"))
      XCTAssertNil(end)
    }

    func testRelayOnlyAllowsOneConsumerAndReservesTerminalSlot() async {
      let relay = NativeRealtimeWebRTCEventRelay()
      let first = relay.stream()
      let second = relay.stream()
      var secondIterator = second.makeAsyncIterator()
      let secondEnd = await secondIterator.next()
      XCTAssertNil(secondEnd)
      for index in 0..<257 { relay.push(.serverEvent(generation: 7, json: "\(index)")) }
      var iterator = first.makeAsyncIterator()
      let overflow = await iterator.next()
      let end = await iterator.next()
      XCTAssertEqual(overflow, .failure(generation: 7, code: "event_overflow"))
      XCTAssertNil(end)
    }

    func testStaleReadinessNonceCannotBindOrEmitReady() async {
      let relay = NativeRealtimeWebRTCEventRelay()
      let token = NativeBridgeToken(generation: 2, epoch: 2)
      relay.storeReady(11)
      relay.storeReady(12)
      XCTAssertFalse(relay.bind(token, nonce: 11))
      XCTAssertTrue(relay.bind(token, nonce: 12))
      var iterator = relay.stream().makeAsyncIterator()
      let ready = await iterator.next()
      XCTAssertEqual(ready, .ready)
    }

    func testOverflowForARejectsBAndDeliversFailureOnlyAfterCompletion() async {
      let relay = NativeRealtimeWebRTCEventRelay()
      let a = NativeBridgeToken(generation: 1, epoch: 1)
      let b = NativeBridgeToken(generation: 2, epoch: 2)
      relay.storeReady(1)
      XCTAssertTrue(relay.bind(a, nonce: 1))
      // The bound readiness control occupies one of the 256 FIFO positions.
      for index in 0..<255 { XCTAssertFalse(relay.enqueue(a, .serverEvent(generation: 1, json: "\(index)"))) }
      XCTAssertTrue(relay.enqueue(a, .serverEvent(generation: 1, json: "overflow")))
      XCTAssertFalse(relay.enqueue(b, .serverEvent(generation: 2, json: "stale-b")))
      relay.completeTerminal(a, event: .failure(generation: 1, code: "event_overflow"))
      var iterator = relay.stream().makeAsyncIterator()
      let event = await iterator.next()
      let end = await iterator.next()
      XCTAssertEqual(event, .failure(generation: 1, code: "event_overflow"))
      XCTAssertNil(end)
    }
  }
#endif
