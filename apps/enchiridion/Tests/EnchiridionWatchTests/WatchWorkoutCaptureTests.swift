import EnchiridionWorkoutTransport
import XCTest

@MainActor
final class WatchWorkoutCaptureTests: XCTestCase {
  private final class HealthKit: WatchWorkoutHealthKitExporting {
    var cancelled = 0
    var finishes = 0
    var recoveries = 0
    func begin(eventID: UUID, activity: WorkoutActivity, startedAt: Date) async {}
    func cancel(eventID: UUID) async { cancelled += 1 }
    func finishOrRecover(
      eventID: UUID, activity: WorkoutActivity, startedAt: Date, completedAt: Date
    ) async -> WatchWorkoutHealthKitExport {
      finishes += 1
      return .init(state: .notAuthorized, routeState: .unavailable)
    }
    func recover(eventID: UUID) async -> WatchWorkoutHealthKitExport {
      recoveries += 1
      return .init(state: .failed, errorCategory: "metadata-not-indexed")
    }
  }
  private final class Transfer: WatchWorkoutTransferring {
    var envelopes: [WorkoutCaptureEnvelope] = []
    var observations: [WorkoutImportAcknowledgement] = []
    var acceptObservations = true
    func enqueueEnvelope(_ envelope: WorkoutCaptureEnvelope) -> Bool {
      envelopes.append(envelope)
      return true
    }
    func enqueueAcknowledgementObserved(_ acknowledgement: WorkoutImportAcknowledgement) -> Bool {
      guard acceptObservations else { return false }
      observations.append(acknowledgement)
      return true
    }
  }
  private func persistence() -> WatchWorkoutPersistence {
    .init(url: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
  }

  func testCancelEmitsNoEnvelopeAndCancelsHealthKit() async {
    let health = HealthKit()
    let transfer = Transfer()
    let store = WatchWorkoutCaptureStore(
      persistence: persistence(), healthKit: health, transfer: transfer)
    store.beginStrength()
    store.cancel()
    try? await Task.sleep(for: .milliseconds(10))
    XCTAssertEqual(health.cancelled, 1)
    XCTAssertEqual(transfer.envelopes.count, 0)
  }

  func testPartialCaptureIsExactlyAcknowledged() async throws {
    let transfer = Transfer()
    let store = WatchWorkoutCaptureStore(
      persistence: persistence(), healthKit: HealthKit(), transfer: transfer)
    store.beginStrength()
    await store.save(status: .partial)
    let envelope = try XCTUnwrap(transfer.envelopes.first)
    store.receiveAcknowledgement(.init(envelope))
    XCTAssertEqual(store.pendingCount, 0)
    XCTAssertEqual(transfer.observations.first, .init(envelope))
  }

  func testMismatchedResponseDoesNotDeleteOutbox() async throws {
    let transfer = Transfer()
    let store = WatchWorkoutCaptureStore(
      persistence: persistence(), healthKit: HealthKit(), transfer: transfer)
    store.beginStrength()
    await store.save(status: .complete)
    let envelope = try XCTUnwrap(transfer.envelopes.first)
    store.receiveAcknowledgement(
      .init(moduleID: envelope.moduleID, eventID: envelope.eventID, payloadHash: "different"))
    XCTAssertEqual(store.pendingCount, 1)
  }

  func testRestartReplaysPersistedOutbox() async {
    let path = persistence()
    let first = Transfer()
    let store = WatchWorkoutCaptureStore(persistence: path, healthKit: HealthKit(), transfer: first)
    store.beginStrength()
    await store.save(status: .complete)
    let replay = Transfer()
    let restored = WatchWorkoutCaptureStore(
      persistence: path, healthKit: HealthKit(), transfer: replay)
    XCTAssertEqual(restored.pendingCount, 1)
    XCTAssertEqual(replay.envelopes.count, 1)
  }

  func testConflictMovesExactCaptureToQuarantine() async throws {
    let transfer = Transfer()
    let store = WatchWorkoutCaptureStore(
      persistence: persistence(), healthKit: HealthKit(), transfer: transfer)
    store.beginStrength()
    await store.save(status: .complete)
    let envelope = try XCTUnwrap(transfer.envelopes.first)
    store.receive(.init(envelope, disposition: .conflict))
    XCTAssertEqual(store.pendingCount, 0)
    XCTAssertEqual(store.quarantined.count, 1)
  }

  func testDeniedHealthKitStillCreatesEnvelope() async throws {
    let transfer = Transfer()
    let store = WatchWorkoutCaptureStore(
      persistence: persistence(), healthKit: HealthKit(), transfer: transfer)
    store.beginStrength()
    await store.save(status: .complete)
    XCTAssertEqual(try XCTUnwrap(transfer.envelopes.first).healthKitExportState, .notAuthorized)
  }

  func testFailedObservedTransferPersistsForRestartRetry() async throws {
    let path = persistence()
    let failing = Transfer()
    failing.acceptObservations = false
    let store = WatchWorkoutCaptureStore(
      persistence: path, healthKit: HealthKit(), transfer: failing)
    store.beginStrength()
    await store.save(status: .complete)
    let envelope = try XCTUnwrap(failing.envelopes.first)
    store.receiveAcknowledgement(.init(envelope))
    let retry = Transfer()
    _ = WatchWorkoutCaptureStore(persistence: path, healthKit: HealthKit(), transfer: retry)
    XCTAssertEqual(retry.observations, [.init(envelope)])
  }

  func testSavingRecoveryUsesExactIntentWithoutSecondFinish() async throws {
    let path = persistence()
    let eventID = UUID()
    let started = Date(timeIntervalSince1970: 10)
    let completed = Date(timeIntervalSince1970: 20)
    let checkpoint = WatchWorkoutCaptureStore.Checkpoint(
      eventID: eventID, startedAt: started, phase: .saving, draft: .strength([.init()]),
      completedAt: completed, requestedStatus: .partial)
    try path.save(
      .init(checkpoint: checkpoint, outbox: [], quarantined: [], acknowledgementObservations: []))
    let health = HealthKit()
    let transfer = Transfer()
    let store = WatchWorkoutCaptureStore(persistence: path, healthKit: health, transfer: transfer)
    await store.recoverSavingCheckpoint()
    await store.recoverSavingCheckpoint()
    let envelope = try XCTUnwrap(transfer.envelopes.first)
    XCTAssertEqual(envelope.completedAt, completed)
    XCTAssertEqual(envelope.status, .partial)
    XCTAssertEqual(health.recoveries, 1)
    XCTAssertEqual(health.finishes, 0)
    XCTAssertEqual(store.pendingCount, 1)
  }
}
