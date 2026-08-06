import XCTest
import EnchiridionCore
import Foundation

@testable import Enchiridion

@MainActor
final class NativeRealtimeInputLeaseGateTests: XCTestCase {
  func testNewerDisableMakesOldEnableCompletionIneligibleForCaptureAppendAndSend() {
    var gate = NativeRealtimeInputLeaseGate()
    gate.begin(transportGeneration: 41)
    let oldEnable = RealtimeVoiceInputLease(transportGeneration: 41, inputEpoch: 1)
    let newerDisable = RealtimeVoiceInputLease(transportGeneration: 41, inputEpoch: 2)

    XCTAssertTrue(gate.accept(true, lease: oldEnable))
    XCTAssertTrue(gate.inputDesired)
    XCTAssertTrue(gate.allowsCapture(for: oldEnable))

    XCTAssertTrue(gate.accept(false, lease: newerDisable))
    XCTAssertFalse(gate.inputDesired)
    XCTAssertFalse(gate.allowsCapture(for: oldEnable))
    XCTAssertFalse(gate.allowsCapture(for: newerDisable))

    // Model an old `true` capture setup completing after Core has already
    // issued the newer false transition. It cannot turn effective input back
    // on or re-authorise a captured frame for append/send.
    XCTAssertFalse(gate.accept(true, lease: oldEnable))
    XCTAssertFalse(gate.inputDesired)
    XCTAssertFalse(gate.allowsCapture(for: oldEnable))
  }

  func testTerminalCloseMakesOldAndNewCaptureCallbacksIneligible() {
    var gate = NativeRealtimeInputLeaseGate()
    gate.begin(transportGeneration: 9)
    let oldEnable = RealtimeVoiceInputLease(transportGeneration: 9, inputEpoch: 1)
    let futureEnable = RealtimeVoiceInputLease(transportGeneration: 9, inputEpoch: 2)

    XCTAssertTrue(gate.accept(true, lease: oldEnable))
    XCTAssertTrue(gate.allowsCapture(for: oldEnable))

    gate.close()

    XCTAssertTrue(gate.isTerminal)
    XCTAssertFalse(gate.inputDesired)
    XCTAssertFalse(gate.allowsCapture(for: oldEnable))
    XCTAssertFalse(gate.accept(true, lease: futureEnable))
    XCTAssertFalse(gate.allowsCapture(for: futureEnable))
  }

  func testWriterFenceDropsQueuedOldLeaseAndRejectsLateCallback() async {
    let writer = NativeRealtimeWriter()
    let sends = GatedWriterSend()
    let firstLease = RealtimeVoiceInputLease(transportGeneration: 3, inputEpoch: 1)
    let disableLease = RealtimeVoiceInputLease(transportGeneration: 3, inputEpoch: 2)
    let firstFrame = Data([1])
    let queuedFrame = Data([2])

    let first = Task {
      await writer.enqueue(firstFrame, lease: firstLease) { frame, lease in
        await sends.send(frame: frame, lease: lease)
      }
    }
    await sends.waitUntilFirstSendIsBlocked()

    // This returns after queueing because the first send remains suspended.
    await writer.enqueue(queuedFrame, lease: firstLease) { frame, lease in
      await sends.send(frame: frame, lease: lease)
    }

    let disable = Task { await writer.fenceCapture(through: disableLease) }
    var fenceInstalled = false
    for _ in 0..<100 {
      if await writer.captureFenceForTesting() == disableLease {
        fenceInstalled = true
        break
      }
      await Task.yield()
    }
    XCTAssertTrue(fenceInstalled)
    let installedFence = await writer.captureFenceForTesting()
    XCTAssertEqual(installedFence, disableLease)

    await sends.releaseFirstSend()
    await first.value
    await disable.value

    let framesAfterFence = await sends.frames()
    XCTAssertEqual(framesAfterFence, [firstFrame])

    // A callback retained by the old ingress cannot requeue the captured PCM.
    await writer.enqueue(Data([3]), lease: firstLease) { frame, lease in
      await sends.send(frame: frame, lease: lease)
    }
    let framesAfterLateCallback = await sends.frames()
    XCTAssertEqual(framesAfterLateCallback, [firstFrame])
  }

  func testWriterCloseReturnsWhileSendIsBlockedAndRejectsFutureLease() async {
    let writer = NativeRealtimeWriter()
    let sends = GatedWriterSend()
    let closeCompletion = AsyncCompletion()
    let firstLease = RealtimeVoiceInputLease(transportGeneration: 12, inputEpoch: 1)
    let futureLease = RealtimeVoiceInputLease(transportGeneration: 12, inputEpoch: 2)
    let firstFrame = Data([10])

    let first = Task {
      await writer.enqueue(firstFrame, lease: firstLease) { frame, lease in
        await sends.send(frame: frame, lease: lease)
      }
    }
    await sends.waitUntilFirstSendIsBlocked()

    // This is intentionally nonblocking despite the gated in-flight send.
    let close = Task {
      await writer.closeCapture()
      await closeCompletion.finish()
    }
    var closeReturned = false
    for _ in 0..<100 {
      if await closeCompletion.isFinished() {
        closeReturned = true
        break
      }
      await Task.yield()
    }
    XCTAssertTrue(closeReturned)

    await writer.enqueue(Data([11]), lease: futureLease) { frame, lease in
      await sends.send(frame: frame, lease: lease)
    }
    let framesBeforeRelease = await sends.frames()
    XCTAssertEqual(framesBeforeRelease, [firstFrame])

    await sends.releaseFirstSend()
    await first.value
    await close.value
    let framesAfterRelease = await sends.frames()
    XCTAssertEqual(framesAfterRelease, [firstFrame])
  }
}

private actor GatedWriterSend {
  private var sentFrames: [Data] = []
  private var firstSendRelease: CheckedContinuation<Void, Never>?
  private var firstSendWaiter: CheckedContinuation<Void, Never>?

  func send(frame: Data, lease _: RealtimeVoiceInputLease) async {
    sentFrames.append(frame)
    guard sentFrames.count == 1 else { return }
    await withCheckedContinuation { continuation in
      firstSendRelease = continuation
      let waiter = firstSendWaiter
      firstSendWaiter = nil
      waiter?.resume()
    }
  }

  func waitUntilFirstSendIsBlocked() async {
    guard firstSendRelease == nil else { return }
    await withCheckedContinuation { firstSendWaiter = $0 }
  }

  func releaseFirstSend() {
    let release = firstSendRelease
    firstSendRelease = nil
    release?.resume()
  }

  func frames() -> [Data] { sentFrames }
}

private actor AsyncCompletion {
  private var finished = false

  func finish() { finished = true }
  func isFinished() -> Bool { finished }
}
