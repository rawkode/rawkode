import EnchiridionWorkoutTransport
import Foundation
import GRDB
import XCTest
@testable import EnchiridionCore

final class WorkoutImportTests: XCTestCase {
  func testStrengthImportCreatesDeterministicGraphAndReplayPreservesEdits() async throws {
    let repository = try makeRepository()
    let registry = try ModuleRegistry(manifests: [WorkoutModule.manifest])
    let envelope = strengthEnvelope()
    let imported = try await repository.importWorkout(envelope, registry: registry)
    guard case let .imported(rootID, _) = imported else { return XCTFail("Expected import") }
    let rootEdges = try await repository.outgoingEdges(from: rootID)
    XCTAssertEqual(rootEdges.map(\.relationID), [WorkoutModule.Relation.workoutExercises])
    let exercise = try XCTUnwrap(rootEdges.first?.targetNodeID)
    let setEdges = try await repository.outgoingEdges(from: exercise)
    XCTAssertEqual(setEdges.count, 2)
    _ = try await repository.renamePage(pageID: rootID, title: "Edited locally")
    let replay = try await repository.importWorkout(envelope, registry: registry)
    guard case let .duplicate(replayedID, _) = replay else { return XCTFail("Expected duplicate") }
    XCTAssertEqual(replayedID, rootID)
    let renamed = try await repository.page(id: rootID)
    XCTAssertEqual(renamed?.title, "Edited locally")
    let summaries = try await repository.workoutSummaries()
    XCTAssertEqual(summaries.first?.id, rootID)
  }

  func testCardioCapturesAggregatesAndRejectsMalformedPayload() async throws {
    let repository = try makeRepository()
    let registry = try ModuleRegistry(manifests: [WorkoutModule.manifest])
    let start = Date(timeIntervalSince1970: 1_000)
    let cardio = WorkoutCaptureEnvelope(eventID: "10000000-0000-0000-0000-000000000001", startedAt: start, completedAt: start.addingTimeInterval(600), activity: .outdoorRun, status: .complete, durationSeconds: 600, payload: .cardio(splits: [.init(ordinal: 1, distanceMeters: 1_000, durationSeconds: 300), .init(ordinal: 2, distanceMeters: 1_000, durationSeconds: 300)], distanceMeters: 2_000, elevationMeters: 32, averageSpeedMetersPerSecond: 3.33, averagePaceSecondsPerKilometre: 300))
    guard case let .imported(rootID, _) = try await repository.importWorkout(cardio, registry: registry) else { return XCTFail("Expected cardio import") }
    let splitEdges = try await repository.outgoingEdges(from: rootID)
    XCTAssertEqual(splitEdges.count, 2)
    let invalid = WorkoutCaptureEnvelope(eventID: "10000000-0000-0000-0000-000000000002", startedAt: start, completedAt: start.addingTimeInterval(10), activity: .outdoorRun, status: .complete, durationSeconds: 10, payload: .cardio(splits: [.init(ordinal: 1, distanceMeters: 0, durationSeconds: 1)], distanceMeters: .nan, elevationMeters: nil, averageSpeedMetersPerSecond: nil, averagePaceSecondsPerKilometre: nil))
    await XCTAssertThrowsErrorAsync(try await repository.importWorkout(invalid, registry: registry)) { error in
      XCTAssertEqual(error as? LibraryRepositoryError, .invalidRecord)
    }
  }

  func testSameEventDifferentPayloadIsDurablyQuarantined() async throws {
    let repository = try makeRepository()
    let registry = try ModuleRegistry(manifests: [WorkoutModule.manifest])
    let first = strengthEnvelope()
    _ = try await repository.importWorkout(first, registry: registry)
    let changed = WorkoutCaptureEnvelope(eventID: first.eventID, startedAt: first.startedAt, completedAt: first.completedAt, activity: first.activity, status: .complete, durationSeconds: first.durationSeconds, payload: .strength(exercises: [.init(ordinal: 1, name: "Squat", sets: [.init(ordinal: 1, repetitions: 9, loadKilograms: 100)])]))
    let conflict = try await repository.importWorkout(changed, registry: registry)
    XCTAssertEqual(conflict, .conflict)
  }

  func testSameEnvelopeIsIsolatedToEachVaultDatabase() async throws {
    let first = try makeRepository()
    let second = try makeRepository()
    let registry = try ModuleRegistry(manifests: [WorkoutModule.manifest])
    let envelope = strengthEnvelope()
    guard case let .imported(firstID, _) = try await first.importWorkout(envelope, registry: registry),
      case let .imported(secondID, _) = try await second.importWorkout(envelope, registry: registry)
    else { return XCTFail("Each vault should accept its own first import") }
    // The identity is stable for a source event, but each vault owns an independent copy.
    XCTAssertEqual(firstID, secondID)
    let firstPage = try await first.page(id: firstID)
    let secondPage = try await second.page(id: secondID)
    XCTAssertNotNil(firstPage)
    XCTAssertNotNil(secondPage)
  }

  func testCompiledDeclarationsStayOutOfCloudSchemaWhileImportedPagesAreDirty() async throws {
    let repository = try makeRepository()
    let registry = try ModuleRegistry(manifests: [WorkoutModule.manifest])
    guard case let .imported(rootID, _) = try await repository.importWorkout(strengthEnvelope(), registry: registry) else { return XCTFail("Expected import") }
    let dirtyTags = try await repository.dirtySupertags()
    let dirtyRelations = try await repository.dirtyRelationDefinitions()
    XCTAssertFalse(dirtyTags.contains { $0.id.rawValue.hasPrefix(WorkoutModule.id.rawValue) })
    XCTAssertFalse(dirtyRelations.contains { $0.definition.id.rawValue.hasPrefix(WorkoutModule.id.rawValue) })
    let cloudDirty: Int = try await repository.database.read { db in
      try Int.fetchOne(db, sql: "SELECT cloud_dirty FROM pages WHERE id = ?", arguments: [rootID.rawValue]) ?? 0
    }
    XCTAssertEqual(cloudDirty, 1)
  }

  func testDeterministicRootRecoversWhenReceiptWasLost() async throws {
    let repository = try makeRepository()
    let registry = try ModuleRegistry(manifests: [WorkoutModule.manifest])
    let envelope = strengthEnvelope()
    guard case let .imported(rootID, _) = try await repository.importWorkout(envelope, registry: registry) else { return XCTFail("Expected import") }
    try await repository.database.write { db in
      try db.execute(sql: "DELETE FROM workout_import_receipts WHERE module_id = ? AND event_id = ?", arguments: [envelope.moduleID, envelope.eventID])
    }
    guard case let .duplicate(recoveredID, _) = try await repository.importWorkout(envelope, registry: registry) else { return XCTFail("Expected root-provenance recovery") }
    XCTAssertEqual(recoveredID, rootID)
  }

  private func strengthEnvelope() -> WorkoutCaptureEnvelope {
    let start = Date(timeIntervalSince1970: 1_000)
    return .init(eventID: "00000000-0000-0000-0000-000000000001", startedAt: start, completedAt: start.addingTimeInterval(120), activity: .strengthTraining, status: .complete, durationSeconds: 120, payload: .strength(exercises: [.init(ordinal: 1, name: "Squat", sets: [.init(ordinal: 1, repetitions: 5, loadKilograms: 100, completedAt: start.addingTimeInterval(20)), .init(ordinal: 2, repetitions: 5, loadKilograms: 100, completedAt: start.addingTimeInterval(40))])]))
  }

  private func makeRepository() throws -> LibraryRepository {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("WorkoutImportTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return try LibraryRepository(path: directory.appendingPathComponent("library.sqlite").path)
  }
}

private func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, _ handler: (Error) -> Void = { _ in }) async {
  do { _ = try await expression(); XCTFail("Expected error") } catch { handler(error) }
}
