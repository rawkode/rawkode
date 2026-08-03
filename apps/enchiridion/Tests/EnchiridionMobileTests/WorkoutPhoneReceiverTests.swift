import EnchiridionCore
import EnchiridionWorkoutTransport
import Foundation
import XCTest

@testable import Enchiridion

@available(iOS 26.0, *)
@MainActor
final class WorkoutPhoneReceiverTests: XCTestCase {
  func testQueueFailureLeavesResponseDurableUntilExactObservation() async throws {
    let fixture = try makeFixture()
    let sender = Sender(shouldFail: true)
    let receiver = try WorkoutPhoneReceiver(
      vaultSession: fixture.session, registry: fixture.registry, acknowledgementSender: sender
    )
    let envelope = workout()
    let result = await receiver.receive(try JSONEncoder().encode(envelope))
    XCTAssertEqual(result, .imported)
    XCTAssertEqual(try fixture.registry.pendingWorkoutAcknowledgements().count, 1)
    XCTAssertTrue(sender.values.isEmpty)

    receiver.observeAcknowledgement(.init(envelope))
    XCTAssertTrue(try fixture.registry.pendingWorkoutAcknowledgements().isEmpty)
  }

  func testHashConflictQueuesTerminalConflictResponse() async throws {
    let fixture = try makeFixture()
    let sender = Sender()
    let receiver = try WorkoutPhoneReceiver(
      vaultSession: fixture.session, registry: fixture.registry, acknowledgementSender: sender
    )
    let first = workout()
    let firstResult = await receiver.receive(try JSONEncoder().encode(first))
    XCTAssertEqual(firstResult, .imported)
    let second = workout(eventID: first.eventID, repetitions: 9)
    let secondResult = await receiver.receive(try JSONEncoder().encode(second))
    XCTAssertEqual(secondResult, .conflict)

    let responses = try sender.values.map {
      try JSONDecoder().decode(WorkoutDeliveryResponse.self, from: $0)
    }
    XCTAssertEqual(responses.last?.disposition, .conflict)
    XCTAssertEqual(responses.last?.acknowledgement, .init(second))
  }

  func testUnavailableRoutedVaultDoesNotQueueTerminalResponse() async throws {
    let fixture = try makeFixture()
    let work = try fixture.registry.createVault(name: "Work")
    try fixture.registry.setDefaultCaptureVault(work.id)
    let envelope = workout()
    _ = try fixture.registry.claimWorkoutCaptureRoute(
      moduleID: envelope.moduleID, eventID: envelope.eventID, payloadHash: envelope.payloadHash
    )
    _ = try fixture.registry.deleteVault(work.id)
    let sender = Sender()
    let receiver = try WorkoutPhoneReceiver(
      vaultSession: fixture.session, registry: fixture.registry, acknowledgementSender: sender
    )

    let result = await receiver.receive(try JSONEncoder().encode(envelope))
    XCTAssertEqual(result, .unavailable)
    XCTAssertTrue(sender.values.isEmpty)
    XCTAssertTrue(try fixture.registry.pendingWorkoutAcknowledgements().isEmpty)
  }

  private func workout(eventID: String = UUID().uuidString, repetitions: Int = 5)
    -> WorkoutCaptureEnvelope
  {
    let start = Date(timeIntervalSince1970: 1_700_000_000)
    return .init(
      eventID: eventID, startedAt: start, completedAt: start.addingTimeInterval(60),
      activity: .strengthTraining, status: .complete, durationSeconds: 60,
      payload: .strength(exercises: [
        .init(
          ordinal: 1, name: "Squat",
          sets: [.init(ordinal: 1, repetitions: repetitions, loadKilograms: 50)]
        )
      ])
    )
  }

  private func makeFixture() throws -> (registry: VaultRegistry, session: VaultSession) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let registry = try VaultRegistry(path: directory.appendingPathComponent("catalog.sqlite").path)
    return (registry, try VaultSession(registry: registry, startImmediately: false))
  }
}

@available(iOS 26.0, *)
private final class Sender: WorkoutAcknowledgementSending {
  var values: [Data] = []
  let shouldFail: Bool
  init(shouldFail: Bool = false) { self.shouldFail = shouldFail }
  func enqueueAcknowledgement(_ data: Data) throws {
    if shouldFail { throw SenderError.failed }
    values.append(data)
  }
  private enum SenderError: Error { case failed }
}
