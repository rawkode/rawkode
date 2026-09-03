import XCTest
@testable import AthenaeumAppUI

@MainActor
final class WorkoutsViewTests: XCTestCase {
    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    func testFormatDurationUsesReadableBuckets() {
        XCTAssertEqual(WorkoutsViewModel.formatDuration(0), "0s")
        XCTAssertEqual(WorkoutsViewModel.formatDuration(65), "1m 5s")
        XCTAssertEqual(WorkoutsViewModel.formatDuration(3661), "1h 1m")
        XCTAssertEqual(WorkoutsViewModel.formatDuration(-1), "0s")
    }

    func testFormatPaceRejectsInvalidValuesAndPadsSeconds() {
        XCTAssertEqual(WorkoutsViewModel.formatPace(305), "5:05/km")
        XCTAssertNil(WorkoutsViewModel.formatPace(nil))
        XCTAssertNil(WorkoutsViewModel.formatPace(.infinity))
    }

    func testFormatDateKeepsMalformedWireValuesVisible() {
        XCTAssertEqual(WorkoutsViewModel.formatDate("not-a-date"), "not-a-date")
    }

    func testLoadFailureMessagesSuppressUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let workouts = WorkoutsViewModel.workoutsLoadFailureMessage(for: error)
        let detail = WorkoutsViewModel.workoutDetailLoadFailureMessage(for: error)

        XCTAssertEqual(
            workouts,
            "Workouts couldn’t be loaded. Nothing has been changed. Refresh to check your workouts again."
        )
        XCTAssertEqual(
            detail,
            "This workout couldn’t be loaded. Nothing has been changed. Select it again or refresh your workouts."
        )
        XCTAssertFalse(workouts.contains(error.description))
        XCTAssertFalse(detail.contains(error.description))
    }

    func testEmptyWorkoutsPresentationRequiresAConfirmedIdleSuccessfulLoad() {
        XCTAssertFalse(
            WorkoutsViewModel.shouldShowEmptyWorkouts(
                isEmpty: true,
                hasLoadedWorkouts: false,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            WorkoutsViewModel.shouldShowEmptyWorkouts(
                isEmpty: true,
                hasLoadedWorkouts: false,
                isLoading: true,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            WorkoutsViewModel.shouldShowEmptyWorkouts(
                isEmpty: true,
                hasLoadedWorkouts: true,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            WorkoutsViewModel.shouldShowEmptyWorkouts(
                isEmpty: true,
                hasLoadedWorkouts: true,
                isLoading: false,
                errorMessage: "Workouts couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            WorkoutsViewModel.shouldShowEmptyWorkouts(
                isEmpty: false,
                hasLoadedWorkouts: true,
                isLoading: false,
                errorMessage: nil
            )
        )
    }

    func testWorkoutsLoadingPresentationWaitsForFirstResolutionWithoutHidingCachedRows() {
        XCTAssertTrue(
            WorkoutsViewModel.shouldShowWorkoutsLoading(
                hasLoadedWorkouts: false,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            WorkoutsViewModel.shouldShowWorkoutsLoading(
                hasLoadedWorkouts: false,
                isLoading: true,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            WorkoutsViewModel.shouldShowWorkoutsLoading(
                hasLoadedWorkouts: false,
                isLoading: true,
                errorMessage: "Workouts couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            WorkoutsViewModel.shouldShowWorkoutsLoading(
                hasLoadedWorkouts: false,
                isLoading: false,
                errorMessage: "Workouts couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            WorkoutsViewModel.shouldShowWorkoutsLoading(
                hasLoadedWorkouts: true,
                isLoading: true,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            WorkoutsViewModel.shouldShowWorkoutsLoading(
                hasLoadedWorkouts: true,
                isLoading: false,
                errorMessage: "Workouts couldn’t be loaded."
            )
        )
    }

    func testListRefreshPresentationRejectsRapidDuplicateActionsAndRestoresLoadingState() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            WorkoutsListRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            WorkoutsListRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            WorkoutsListRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            WorkoutsListRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = false
        XCTAssertTrue(
            WorkoutsListRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            WorkoutsListRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            WorkoutsListRefreshPresentation.isLoading(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )
    }

    func testWorkoutDetailRetryRequiresSelectedWorkoutAndNoActiveDetailRead() {
        XCTAssertTrue(
            WorkoutDetailSelectionPresentation.canRetryDetail(workoutId: "workout-1", isLoadingDetail: false)
        )
        XCTAssertFalse(
            WorkoutDetailSelectionPresentation.canRetryDetail(workoutId: nil, isLoadingDetail: false)
        )
        XCTAssertFalse(
            WorkoutDetailSelectionPresentation.canRetryDetail(workoutId: "workout-1", isLoadingDetail: true)
        )
    }

    func testRapidWorkoutDetailActivationKeepsTheFirstPendingWorkoutUntilItCompletes() {
        let firstWorkoutId = "workout-first"
        let secondWorkoutId = "workout-second"
        var pendingWorkoutId: String? = firstWorkoutId

        XCTAssertFalse(WorkoutDetailSelectionPresentation.canStartSelection(pendingWorkoutId: pendingWorkoutId))

        pendingWorkoutId = WorkoutDetailSelectionPresentation.pendingWorkoutId(
            afterCompleting: secondWorkoutId,
            pendingWorkoutId: pendingWorkoutId
        )
        XCTAssertEqual(pendingWorkoutId, firstWorkoutId)

        pendingWorkoutId = WorkoutDetailSelectionPresentation.pendingWorkoutId(
            afterCompleting: firstWorkoutId,
            pendingWorkoutId: pendingWorkoutId
        )
        XCTAssertNil(pendingWorkoutId)
        XCTAssertTrue(WorkoutDetailSelectionPresentation.canStartSelection(pendingWorkoutId: pendingWorkoutId))
    }
}
