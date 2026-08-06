import XCTest

@testable import Enchiridion

#if os(iOS)
  private extension NativeBridgeLifecycleCoordinator {
    func installTerminal(_ token: NativeBridgeToken, failure: String?) -> TerminalClaim { reserveAndClaimTerminal(token, failure: failure) }
    func complete(_ token: NativeBridgeToken, completion: TerminalTicket) { complete(completion) }
  }
  private extension NativeBridgeLifecycleCoordinator.TerminalTicket {
    func wait() async { await completion.wait() }
  }
  private final class HeldTerminalDriverScheduler: @unchecked Sendable {
    private let release = NativeRelayCompletion()
    let submitted = NativeRelayCompletion()
    private let lock = NSLock(); private var submissionCount = 0
    func makeScheduler() -> NativeTerminalDriverScheduler {
      NativeTerminalDriverScheduler { [release, submitted, lock] action in
        lock.withLock { self.submissionCount += 1 }
        submitted.finish()
        return Task { @MainActor in
          await release.wait()
          await action()
        }
      }
    }
    func run() { release.finish() }
    var count: Int { lock.withLock { submissionCount } }
  }
  private final class HeldTerminalCleanup: @unchecked Sendable {
    private let release = NativeRelayCompletion()
    let entered = NativeRelayCompletion()
    private let lock = NSLock(); private var executions = 0
    func makeOperation() -> NativeTerminalCleanupOperation {
      NativeTerminalCleanupOperation { [release, entered, lock] in
        lock.withLock { self.executions += 1 }
        entered.finish()
        await release.wait()
      }
    }
    func run() { release.finish() }
    var count: Int { lock.withLock { executions } }
  }
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
      let token = NativeBridgeToken(generation: 1, epoch: 1)
      relay.storeReady(1); XCTAssertTrue(relay.bind(token, nonce: 1))
      var iterator = stream.makeAsyncIterator()
      let ready = await iterator.next()
      XCTAssertEqual(ready, .ready)
      XCTAssertFalse(relay.enqueue(token, .audioActivity(generation: 1, inputLevel: 0, outputLevel: 0.2)))
      XCTAssertFalse(relay.enqueue(token, .answerApplied(generation: 1)))
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
      let token = NativeBridgeToken(generation: 7, epoch: 7)
      relay.storeReady(1); XCTAssertTrue(relay.bind(token, nonce: 1))
      for index in 0..<255 { XCTAssertFalse(relay.enqueue(token, .serverEvent(generation: 7, json: "\(index)"))) }
      XCTAssertTrue(relay.enqueue(token, .serverEvent(generation: 7, json: "overflow")))
      relay.terminal(.failure(generation: 7, code: "event_overflow"))
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

    func testOverflowFirstThenStopJoinsAndDeliversFailureBeforeEOF() async {
      let relay = NativeRealtimeWebRTCEventRelay()
      let a = NativeBridgeToken(generation: 1, epoch: 1)
      let b = NativeBridgeToken(generation: 2, epoch: 2)
      relay.storeReady(1)
      XCTAssertTrue(relay.bind(a, nonce: 1))
      // The bound readiness control occupies one of the 256 FIFO positions.
      for index in 0..<255 { XCTAssertFalse(relay.enqueue(a, .serverEvent(generation: 1, json: "\(index)"))) }
      XCTAssertTrue(relay.enqueue(a, .serverEvent(generation: 1, json: "overflow")))
      XCTAssertFalse(relay.enqueue(b, .serverEvent(generation: 2, json: "stale-b")))
      let coordinator = NativeBridgeLifecycleCoordinator(); XCTAssertTrue(coordinator.beginPreinstall(a))
      guard case let .driver(completion) = coordinator.installTerminal(a, failure: "event_overflow") else { return XCTFail("overflow must have one driver") }
      guard case let .join(joinCompletion) = coordinator.installTerminal(a, failure: nil) else { return XCTFail("stop must join pending failure") }
      XCTAssertTrue(completion === joinCompletion)
      relay.terminal(.failure(generation: 1, code: "event_overflow")); coordinator.complete(a, completion: completion)
      await joinCompletion.wait()
      var iterator = relay.stream().makeAsyncIterator()
      let event = await iterator.next()
      let end = await iterator.next()
      XCTAssertEqual(event, .failure(generation: 1, code: "event_overflow"))
      XCTAssertNil(end)
    }

    func testStopFirstMakesDelayedTerminalCallbackHarmlessEOF() async {
      let relay = NativeRealtimeWebRTCEventRelay()
      let token = NativeBridgeToken(generation: 3, epoch: 3)
      relay.storeReady(1)
      XCTAssertTrue(relay.bind(token, nonce: 1))
      let coordinator = NativeBridgeLifecycleCoordinator(); XCTAssertTrue(coordinator.beginPreinstall(token))
      guard case let .driver(completion) = coordinator.installTerminal(token, failure: nil) else { return XCTFail("stop should drive EOF") }
      guard case let .join(joinCompletion) = coordinator.installTerminal(token, failure: "peer_terminal") else { return XCTFail("late callback must join") }
      XCTAssertTrue(completion === joinCompletion)
      relay.finish(); coordinator.complete(token, completion: completion)
      var iterator = relay.stream().makeAsyncIterator()
      let first = await iterator.next()
      let end = await iterator.next()
      XCTAssertNil(first)
      XCTAssertNil(end)
    }

    func testDriverCancellationStillLeavesTicketCompletable() async {
      let relay = NativeRealtimeWebRTCEventRelay()
      let token = NativeBridgeToken(generation: 4, epoch: 4)
      relay.storeReady(1)
      XCTAssertTrue(relay.bind(token, nonce: 1))
      let coordinator = NativeBridgeLifecycleCoordinator(); XCTAssertTrue(coordinator.beginPreinstall(token))
      guard case let .driver(completion) = coordinator.installTerminal(token, failure: "channel_terminal") else { return XCTFail("terminal should claim") }
      // The completion is deliberately independent of the task that drove
      // cleanup; a cancelled driver can still commit its original outcome.
      relay.terminal(.failure(generation: 4, code: "channel_terminal")); coordinator.complete(token, completion: completion)
      await completion.wait()
      var iterator = relay.stream().makeAsyncIterator()
      let event = await iterator.next()
      let end = await iterator.next()
      XCTAssertEqual(event, .failure(generation: 4, code: "channel_terminal"))
      XCTAssertNil(end)
    }

    func testTerminalLatchedBeforeOfferCannotBeReactivatedByFenceInstall() async {
      let coordinator = NativeBridgeLifecycleCoordinator()
      let token = NativeBridgeToken(generation: 5, epoch: 5)
      // This is the post-arm/pre-offer race: a delegate can synchronously
      // cancel its generation before the MainActor terminal task runs.
      XCTAssertTrue(coordinator.beginPreinstall(token))
      guard case .driver = coordinator.installTerminal(token, failure: "peer_terminal") else { return XCTFail("terminal") }
      coordinator.activateCallbacks(token)
      XCTAssertFalse(coordinator.callbacksCurrent(token))
      let offer = NativeRealtimeWebRTCOperationGate<Void>()
      coordinator.register(offer, token: token)
      do {
        _ = try await offer.wait(timeout: .seconds(1))
        XCTFail("a cancelled generation must not start an offer")
      } catch {}
    }

    func testCoordinatorBroadcastsToThreeJoiners() async {
      let coordinator = NativeBridgeLifecycleCoordinator()
      let token = NativeBridgeToken(generation: 8, epoch: 8)
      XCTAssertTrue(coordinator.beginPreinstall(token))
      guard case let .driver(completion) = coordinator.installTerminal(token, failure: "peer_terminal") else { return XCTFail("first terminal drives") }
      guard case let .join(a) = coordinator.installTerminal(token, failure: nil),
            case let .join(b) = coordinator.installTerminal(token, failure: nil),
            case let .join(c) = coordinator.installTerminal(token, failure: nil) else { return XCTFail("all join") }
      async let one: Void = a.wait(); async let two: Void = b.wait(); async let three: Void = c.wait()
      coordinator.complete(token, completion: completion)
      _ = await (one, two, three)
      XCTAssertEqual(coordinator.testTerminalFailure, "peer_terminal")
    }

    func testCoordinatorTerminalInvalidatesGatesBeforeDriverRuns() async {
      let coordinator = NativeBridgeLifecycleCoordinator(); let token = NativeBridgeToken(generation: 9, epoch: 9)
      final class Snapshot {}
      let snapshot = Snapshot(); XCTAssertTrue(coordinator.beginPreinstall(token)); XCTAssertTrue(coordinator.install(token, snapshot: snapshot))
      let gate = NativeRealtimeWebRTCOperationGate<Void>(); coordinator.register(gate, token: token, snapshot: snapshot)
      guard case .driver = coordinator.installTerminal(token, failure: "terminal") else { return XCTFail("terminal") }
      XCTAssertFalse(coordinator.admit(token, snapshot: snapshot))
      do { _ = try await gate.wait(timeout: .seconds(1)); XCTFail("gate must be invalidated synchronously") } catch {}
    }

    func testCoordinatorAdmissionDrainsBeforeTeardown() async {
      let coordinator = NativeBridgeLifecycleCoordinator(); let token = NativeBridgeToken(generation: 10, epoch: 10)
      final class Snapshot {}
      let snapshot = Snapshot(); XCTAssertTrue(coordinator.beginPreinstall(token)); XCTAssertTrue(coordinator.install(token, snapshot: snapshot))
      XCTAssertTrue(coordinator.admit(token, snapshot: snapshot))
      guard case let .driver(completion) = coordinator.installTerminal(token, failure: "failure") else { return XCTFail("terminal") }
      XCTAssertFalse(coordinator.admit(token, snapshot: snapshot))
      let released = expectation(description: "drained")
      Task { await coordinator.waitForAdmissionsToDrain(); released.fulfill() }
      coordinator.release()
      await fulfillment(of: [released], timeout: 1)
      coordinator.complete(token, completion: completion)
    }

    func testCoordinatorFirstTerminalWinsOverflowAndStop() {
      let coordinator = NativeBridgeLifecycleCoordinator(); let token = NativeBridgeToken(generation: 11, epoch: 11)
      XCTAssertTrue(coordinator.beginPreinstall(token))
      guard case let .driver(completion) = coordinator.installTerminal(token, failure: "event_overflow") else { return XCTFail("overflow") }
      guard case .join = coordinator.installTerminal(token, failure: nil) else { return XCTFail("stop joins") }
      XCTAssertEqual(coordinator.testTerminalFailure, "event_overflow")
      coordinator.complete(token, completion: completion)
    }

    func testProductionCoordinatorIngressReservesOverflowBeforeStop() {
      final class Snapshot {}
      let relay = NativeRealtimeWebRTCEventRelay(); let coordinator = NativeBridgeLifecycleCoordinator()
      let token = NativeBridgeToken(generation: 12, epoch: 12); let snapshot = Snapshot()
      relay.storeReady(1); XCTAssertTrue(relay.bind(token, nonce: 1))
      XCTAssertTrue(coordinator.beginPreinstall(token)); XCTAssertTrue(coordinator.install(token, snapshot: snapshot)); coordinator.activateCallbacks(token)
      // ready is the first FIFO control, so this next ingress is the 257th.
      for index in 0..<255 { guard case .accepted = coordinator.ingestControl(token, .serverEvent(generation: 12, json: "\(index)"), relay: relay) else { return XCTFail("unexpected terminal") } }
      guard case let .driver(ticket) = coordinator.ingestControl(token, .serverEvent(generation: 12, json: "overflow"), relay: relay) else { return XCTFail("overflow must reserve and claim") }
      guard case let .join(stop) = coordinator.installTerminal(token, failure: nil) else { return XCTFail("stop must join reserved overflow") }
      XCTAssertTrue(ticket === stop)
      relay.terminal(.failure(generation: 12, code: "event_overflow")); coordinator.complete(token, completion: ticket)
    }

    @MainActor func testActualProxyAttachmentOperationsDetachBeforeClose() async {
      final class Recorder: @unchecked Sendable { private let lock = NSLock(); private var values: [String] = []; func add(_ value: String) { lock.withLock { values.append(value) } }; var steps: [String] { lock.withLock { values } } }
      let heldDriver = HeldTerminalDriverScheduler()
      let bridge = NativeRealtimeWebRTCBridge(terminalDriverScheduler: heldDriver.makeScheduler())
      let token = NativeBridgeToken(generation: 13, epoch: 13)
      XCTAssertTrue(bridge.testPrepareTerminalIngress(token))
      let proxy = bridge.testMakePeerProxy(token, armed: false)
      let recorder = Recorder(); let attached = expectation(description: "actual proxy output lane attached")
      let operations = NativeOutputAttachmentOperations(add: { recorder.add("add"); attached.fulfill() }, start: { recorder.add("start") }, stop: { recorder.add("stop") }, remove: { recorder.add("remove") })
      proxy.testStageOutputAttachment(operations) // installed-before-activation callback window
      proxy.testArmAndRoute()
      proxy.testReplayStagedOutput()
      await fulfillment(of: [attached], timeout: 1)
      proxy.testTerminalIngress(.peerTerminal)
      await heldDriver.submitted.wait()
      XCTAssertTrue(bridge.testBeginTeardown(token))
      await proxy.detachOutput()
      recorder.add("channel-close"); recorder.add("peer-close")
      XCTAssertEqual(recorder.steps, ["add", "start", "stop", "remove", "channel-close", "peer-close"])
      heldDriver.run()
    }

    func testPeerTerminalTicketWinsWhileDriverSchedulingIsHeld() async {
      let coordinator = NativeBridgeLifecycleCoordinator(); let relay = NativeRealtimeWebRTCEventRelay(); let token = NativeBridgeToken(generation: 21, epoch: 21)
      XCTAssertTrue(coordinator.beginPreinstall(token))
      guard case let .driver(ticket) = coordinator.reserveAndClaimTerminal(token, failure: "peer_terminal") else { return XCTFail("peer claims synchronously") }
      guard case let .join(stop) = coordinator.reserveAndClaimTerminal(token, failure: nil) else { return XCTFail("stop joins held driver") }
      XCTAssertTrue(ticket === stop)
      async let a: Void = ticket.wait(); async let b: Void = stop.wait()
      relay.terminal(.failure(generation: 21, code: ticket.failure!)); coordinator.complete(ticket)
      _ = await (a, b)
      var iterator = relay.stream().makeAsyncIterator()
      let event = await iterator.next(); let end = await iterator.next()
      XCTAssertEqual(event, .failure(generation: 21, code: "peer_terminal")); XCTAssertNil(end)
    }

    func testChannelTerminalAndStopFirstLateSourcesHaveOneOutcome() async {
      let coordinator = NativeBridgeLifecycleCoordinator(); let relay = NativeRealtimeWebRTCEventRelay(); let token = NativeBridgeToken(generation: 22, epoch: 22)
      XCTAssertTrue(coordinator.beginPreinstall(token))
      guard case let .driver(eof) = coordinator.reserveAndClaimTerminal(token, failure: nil) else { return XCTFail("stop") }
      guard case let .join(channel) = coordinator.reserveAndClaimTerminal(token, failure: "channel_terminal") else { return XCTFail("late channel joins") }
      guard case let .join(peer) = coordinator.reserveAndClaimTerminal(token, failure: "peer_terminal") else { return XCTFail("late peer joins") }
      XCTAssertTrue(eof === channel && channel === peer)
      relay.finish(); coordinator.complete(eof)
      await channel.wait(); await peer.wait()
      var iterator = relay.stream().makeAsyncIterator()
      let end = await iterator.next(); XCTAssertNil(end)
    }

    func testHeldDriverCancellationStillBroadcastsOriginalTicket() async {
      let coordinator = NativeBridgeLifecycleCoordinator(); let relay = NativeRealtimeWebRTCEventRelay(); let token = NativeBridgeToken(generation: 23, epoch: 23)
      XCTAssertTrue(coordinator.beginPreinstall(token))
      guard case let .driver(ticket) = coordinator.reserveAndClaimTerminal(token, failure: "event_overflow") else { return XCTFail("driver") }
      guard case let .join(one) = coordinator.reserveAndClaimTerminal(token, failure: nil), case let .join(two) = coordinator.reserveAndClaimTerminal(token, failure: "peer_terminal") else { return XCTFail("joiners") }
      let heldDriver = Task { await ticket.wait() }
      heldDriver.cancel() // cancelling a waiter cannot cancel the retained ticket.
      relay.terminal(.failure(generation: 23, code: ticket.failure!)); coordinator.complete(ticket)
      await one.wait(); await two.wait()
      var iterator = relay.stream().makeAsyncIterator()
      let event = await iterator.next(); let end = await iterator.next()
      XCTAssertEqual(event, .failure(generation: 23, code: "event_overflow")); XCTAssertNil(end)
    }

    @MainActor func testActualPeerIngressHoldsRetainedDriverAndCompletesAfterCancellation() async {
      let heldDriver = HeldTerminalDriverScheduler()
      let heldCleanup = HeldTerminalCleanup()
      let bridge = NativeRealtimeWebRTCBridge(terminalDriverScheduler: heldDriver.makeScheduler(), terminalCleanupOperation: heldCleanup.makeOperation())
      let token = NativeBridgeToken(generation: 24, epoch: 24)
      XCTAssertTrue(bridge.testPrepareTerminalIngress(token))
      let peer = bridge.testMakePeerProxy(token)
      let channel = bridge.testMakeChannelProxy(token)

      peer.testTerminalIngress(.peerTerminal)
      await heldDriver.submitted.wait()
      XCTAssertEqual(heldDriver.count, 1)
      XCTAssertEqual(bridge.testTerminalFailure, "peer_terminal")
      let firstStopped = NativeRelayCompletion()
      let secondStopped = NativeRelayCompletion()
      let stopClaimed = NativeRelayCompletion()
      Task { @MainActor in await bridge.testStopTerminalIngress(token, didClaim: { stopClaimed.finish() }); firstStopped.finish() }
      await stopClaimed.wait()
      Task { @MainActor in await bridge.testStopTerminalIngress(token); secondStopped.finish() }
      channel.testTerminalIngress(.channelTerminal)
      XCTAssertEqual(bridge.testTerminalFailure, "peer_terminal")
      XCTAssertEqual(heldDriver.count, 1)

      bridge.testTerminalDriverTask?.cancel()
      heldDriver.run()
      await heldCleanup.entered.wait()
      XCTAssertEqual(heldCleanup.count, 1)
      heldCleanup.run()
      await firstStopped.wait()
      await secondStopped.wait()

      var iterator = bridge.events().makeAsyncIterator()
      let failure = await iterator.next()
      let eof = await iterator.next()
      XCTAssertEqual(failure, .failure(generation: 24, code: "peer_terminal"))
      XCTAssertNil(eof)
      XCTAssertEqual(heldCleanup.count, 1)
    }

    @MainActor func testActualStopIngressWinsOverLatePeerAndChannelClosures() async {
      let heldDriver = HeldTerminalDriverScheduler()
      let bridge = NativeRealtimeWebRTCBridge(terminalDriverScheduler: heldDriver.makeScheduler())
      let token = NativeBridgeToken(generation: 25, epoch: 25)
      XCTAssertTrue(bridge.testPrepareTerminalIngress(token))
      let stopped = NativeRelayCompletion()
      let stopClaimed = NativeRelayCompletion()
      Task { @MainActor in await bridge.testStopTerminalIngress(token, didClaim: { stopClaimed.finish() }); stopped.finish() }
      await stopClaimed.wait()
      let peer = bridge.testMakePeerProxy(token)
      let channel = bridge.testMakeChannelProxy(token)
      peer.testTerminalIngress(.peerTerminal)
      channel.testTerminalIngress(.channelTerminal)
      channel.testControlIngress(.serverEvent(generation: 25, json: "late"))
      peer.testMeterActivity(0.2)
      await heldDriver.submitted.wait()
      XCTAssertNil(bridge.testTerminalFailure)
      XCTAssertEqual(heldDriver.count, 1)
      heldDriver.run()
      await stopped.wait()

      var iterator = bridge.events().makeAsyncIterator()
      let eof = await iterator.next()
      XCTAssertNil(eof)
    }

    @MainActor func test257thActualChannelIngressReservesOverflowBeforeStop() async {
      let heldDriver = HeldTerminalDriverScheduler()
      let bridge = NativeRealtimeWebRTCBridge(terminalDriverScheduler: heldDriver.makeScheduler())
      let token = NativeBridgeToken(generation: 26, epoch: 26)
      XCTAssertTrue(bridge.testPrepareTerminalIngress(token))
      let channel = bridge.testMakeChannelProxy(token)
      for index in 0..<255 { channel.testControlIngress(.serverEvent(generation: 26, json: "\(index)")) }
      channel.testControlIngress(.serverEvent(generation: 26, json: "overflow"))
      await heldDriver.submitted.wait()
      XCTAssertEqual(bridge.testTerminalFailure, "event_overflow")
      XCTAssertEqual(heldDriver.count, 1)
      let stopped = NativeRelayCompletion()
      let stopClaimed = NativeRelayCompletion()
      Task { @MainActor in await bridge.testStopTerminalIngress(token, didClaim: { stopClaimed.finish() }); stopped.finish() }
      await stopClaimed.wait()
      XCTAssertEqual(bridge.testTerminalFailure, "event_overflow")
      heldDriver.run()
      await stopped.wait()

      var iterator = bridge.events().makeAsyncIterator()
      let failure = await iterator.next()
      let eof = await iterator.next()
      XCTAssertEqual(failure, .failure(generation: 26, code: "event_overflow"))
      XCTAssertNil(eof)
    }

    @MainActor func testActualChannelTerminalIngressHoldsDriverUntilStopJoins() async {
      let heldDriver = HeldTerminalDriverScheduler()
      let bridge = NativeRealtimeWebRTCBridge(terminalDriverScheduler: heldDriver.makeScheduler())
      let token = NativeBridgeToken(generation: 27, epoch: 27)
      XCTAssertTrue(bridge.testPrepareTerminalIngress(token))
      let channel = bridge.testMakeChannelProxy(token)
      channel.testTerminalIngress(.channelTerminal)
      await heldDriver.submitted.wait()
      XCTAssertEqual(bridge.testTerminalFailure, "channel_terminal")
      XCTAssertEqual(heldDriver.count, 1)
      let stopped = NativeRelayCompletion()
      let stopClaimed = NativeRelayCompletion()
      Task { @MainActor in await bridge.testStopTerminalIngress(token, didClaim: { stopClaimed.finish() }); stopped.finish() }
      await stopClaimed.wait()
      XCTAssertEqual(bridge.testTerminalFailure, "channel_terminal")
      heldDriver.run()
      await stopped.wait()

      var iterator = bridge.events().makeAsyncIterator()
      let failure = await iterator.next()
      let eof = await iterator.next()
      XCTAssertEqual(failure, .failure(generation: 27, code: "channel_terminal"))
      XCTAssertNil(eof)
    }
  }
#endif
