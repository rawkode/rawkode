// WorkoutCaptureTests.swift
// EnchiridionWatchKitTests
//
// P6 "watchOS workout capture" task's required test bar (task brief:
// "test against a real temporary LocalGraphStore, proving a completed
// workout persists as a real CRDT-backed page with the correct supertag
// fields — same fixture convention as every other write-path test in
// this package"). Same pattern `EnchiridionShareKitTests/ShareCaptureTests.swift`
// established: real `LocalGraphStore.openTemporary()`, real
// `saveDocumentSnapshot`/`writeProjection` underneath, nothing mocked.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionStore
@testable import EnchiridionWatchKit

final class WorkoutCaptureTests: XCTestCase {
  private func makeStore() throws -> LocalGraphStore {
    try LocalGraphStore.openTemporary()
  }

  func testCaptureWritesANewFreePageTitledWithActivityAndStartDate() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let startedAt = Date(timeIntervalSince1970: 1_800_000_000)

    let returnedID = try await WorkoutCapture.capture(
      WorkoutRecord(activity: .run, startedAt: startedAt, durationMinutes: 32.5, calories: 410),
      into: store, pageID: pageID, createdAt: startedAt)

    XCTAssertEqual(returnedID, pageID)
    let node = try await store.node(for: pageID)
    XCTAssertEqual(node?.nodeID, pageID)
    XCTAssertEqual(node?.kind, "free")
    XCTAssertNil(node?.deletedAt)
    XCTAssertEqual(node?.title, WorkoutCapture.title(for: WorkoutRecord(activity: .run, startedAt: startedAt, durationMinutes: 32.5)))
  }

  func testCapturedPageCarriesTheWorkoutSupertagWithAllFourFieldsSet() async throws {
    let store = try makeStore()
    let pageID = PageID.free()
    let startedAt = Date(timeIntervalSince1970: 1_800_000_000)

    _ = try await WorkoutCapture.capture(
      WorkoutRecord(activity: .cycle, startedAt: startedAt, durationMinutes: 45, calories: 512.3),
      into: store, pageID: pageID)

    let record = try await store.documentSnapshot(for: pageID)
    let unwrapped = try XCTUnwrap(record, "WorkoutCapture must persist a durable CRDT snapshot")
    let projection = try PageDocument.projection(of: unwrapped.snapshot)

    XCTAssertEqual(projection.objectMetadata.supertagIDs, [WorkoutsWorkoutFieldIDs.supertagID])

    let activityKey = SupertagPropertyKey(
      supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.activity)
    let durationKey = SupertagPropertyKey(
      supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.durationMinutes)
    let startedAtKey = SupertagPropertyKey(
      supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.startedAt)
    let caloriesKey = SupertagPropertyKey(
      supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.calories)

    XCTAssertEqual(projection.objectMetadata.properties[activityKey], [.select("cycle")])
    XCTAssertEqual(projection.objectMetadata.properties[durationKey], [.number(45)])
    XCTAssertEqual(projection.objectMetadata.properties[startedAtKey], [.dateTime(startedAt)])
    XCTAssertEqual(projection.objectMetadata.properties[caloriesKey], [.number(512.3)])
  }

  func testCapturedPageOmitsTheCaloriesFieldEntirelyWhenNoEstimateIsAvailable() async throws {
    let store = try makeStore()
    let pageID = PageID.free()

    _ = try await WorkoutCapture.capture(
      WorkoutRecord(activity: .other, startedAt: Date(), durationMinutes: 10, calories: nil),
      into: store, pageID: pageID)

    let record = try await store.documentSnapshot(for: pageID)
    let projection = try PageDocument.projection(of: try XCTUnwrap(record).snapshot)
    let caloriesKey = SupertagPropertyKey(
      supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.calories)
    XCTAssertNil(
      projection.objectMetadata.properties[caloriesKey],
      "a workout with no calorie estimate must never write a fake zero")
  }

  func testCaptureRejectsAZeroOrNegativeDurationAndWritesNothing() async throws {
    let store = try makeStore()
    let pageID = PageID.free()

    do {
      _ = try await WorkoutCapture.capture(
        WorkoutRecord(activity: .walk, startedAt: Date(), durationMinutes: 0), into: store, pageID: pageID)
      XCTFail("expected WorkoutCaptureError.invalidDuration")
    } catch WorkoutCaptureError.invalidDuration {
      // expected
    }

    let node = try await store.node(for: pageID)
    XCTAssertNil(node, "a rejected zero-duration capture must not write any page")
  }

  func testEachActivityCaseRoundTripsThroughItsSlugifiedSelectOptionID() async throws {
    let store = try makeStore()
    let expected: [(WorkoutsWorkoutActivity, String)] = [
      (.run, "run"), (.walk, "walk"), (.cycle, "cycle"), (.swim, "swim"), (.strength, "strength"),
      (.other, "other"),
    ]

    for (activity, optionID) in expected {
      let pageID = PageID.free()
      _ = try await WorkoutCapture.capture(
        WorkoutRecord(activity: activity, startedAt: Date(), durationMinutes: 5), into: store, pageID: pageID)
      let record = try await store.documentSnapshot(for: pageID)
      let projection = try PageDocument.projection(of: try XCTUnwrap(record).snapshot)
      let key = SupertagPropertyKey(
        supertagID: WorkoutsWorkoutFieldIDs.supertagID, fieldID: WorkoutsWorkoutFieldIDs.activity)
      XCTAssertEqual(projection.objectMetadata.properties[key], [.select(optionID)])
    }
  }

  func testCaptureIsQueryableThroughTheBoundedSQLSurfaceLikeAnyOtherPage() async throws {
    let store = try makeStore()

    let pageID = try await WorkoutCapture.capture(
      WorkoutRecord(activity: .run, startedAt: Date(), durationMinutes: 20), into: store)

    let result = try store.query(
      sql: "SELECT node_id, kind FROM graph_nodes WHERE node_id = :id",
      arguments: [":id": .text(pageID.rawValue)])
    XCTAssertEqual(result.rows.count, 1)
  }

  func testCaptureAssignsADistinctRandomPageIDPerCallWhenNoneIsSupplied() async throws {
    let store = try makeStore()

    let first = try await WorkoutCapture.capture(
      WorkoutRecord(activity: .run, startedAt: Date(), durationMinutes: 5), into: store)
    let second = try await WorkoutCapture.capture(
      WorkoutRecord(activity: .walk, startedAt: Date(), durationMinutes: 5), into: store)

    XCTAssertNotEqual(first, second)
  }
}
