import XCTest
@testable import AthenaeumCore

/// Proves `SyntheticWorkoutDataSource` produces the two realistic fixtures the hard constraint
/// asks for ("a strength session with multiple exercises/sets, a cardio session with distance/
/// pace") through the real `WorkoutDataSource` protocol surface, and that its date-window
/// filtering behaves like a real HealthKit query's date predicate would.
final class SyntheticWorkoutDataSourceTests: XCTestCase {
    func testRequestAuthorizationAlwaysSucceeds() async throws {
        let source = SyntheticWorkoutDataSource()
        let granted = try await source.requestAuthorizationIfNeeded()
        XCTAssertTrue(granted)
    }

    func testDefaultFixturesIncludeAMultiExerciseStrengthSessionAndACardioSessionWithSplits() async throws {
        let source = SyntheticWorkoutDataSource()
        let workouts = try await source.fetchRecentWorkouts(since: .distantPast, limit: 10)
        XCTAssertEqual(workouts.count, 2)

        let strength = try XCTUnwrap(workouts.first { $0.activity == .strengthTraining })
        let exercises = try XCTUnwrap(strength.strengthExercises)
        XCTAssertEqual(exercises.count, 2)
        XCTAssertTrue(exercises.allSatisfy { !$0.sets.isEmpty })
        XCTAssertEqual(exercises.flatMap(\.sets).count, 5)
        XCTAssertEqual(strength.source, .synthetic)

        let cardio = try XCTUnwrap(workouts.first { $0.activity == .running })
        XCTAssertNil(cardio.strengthExercises)
        XCTAssertEqual(cardio.cardioSplits.count, 3)
        XCTAssertEqual(cardio.cardioTotals.distanceMeters, 3000)
        XCTAssertNotNil(cardio.cardioTotals.averagePaceSecondsPerKilometre)
    }

    func testFetchRecentWorkoutsRespectsTheSinceDateLikeARealHealthKitPredicateWould() async throws {
        let source = SyntheticWorkoutDataSource()
        // Both fixtures complete before this date — a "since tomorrow" query should return none.
        let none = try await source.fetchRecentWorkouts(since: Date(timeIntervalSinceNow: 86_400), limit: 10)
        XCTAssertTrue(none.isEmpty)

        let all = try await source.fetchRecentWorkouts(since: .distantPast, limit: 10)
        XCTAssertEqual(all.count, 2)
    }

    func testFetchRecentWorkoutsRespectsLimitAndOrdersMostRecentFirst() async throws {
        let source = SyntheticWorkoutDataSource()
        let limited = try await source.fetchRecentWorkouts(since: .distantPast, limit: 1)
        XCTAssertEqual(limited.count, 1)
        // The cardio fixture starts a day after the strength fixture — most-recent-first.
        XCTAssertEqual(limited.first?.activity, .running)
    }

    func testACallerSuppliedFixtureSetIsUsedInsteadOfTheDefault() async throws {
        let custom = ImportedWorkout(
            sourceWorkoutId: "custom-1",
            source: .synthetic,
            activity: .cycling,
            startedAt: Date(timeIntervalSince1970: 0),
            completedAt: Date(timeIntervalSince1970: 3_600),
            durationSeconds: 3_600
        )
        let source = SyntheticWorkoutDataSource(workouts: [custom])
        let workouts = try await source.fetchRecentWorkouts(since: .distantPast, limit: 10)
        XCTAssertEqual(workouts, [custom])
    }
}
