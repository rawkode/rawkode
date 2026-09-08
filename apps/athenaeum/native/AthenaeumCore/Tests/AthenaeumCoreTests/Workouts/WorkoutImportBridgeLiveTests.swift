import XCTest
@testable import AthenaeumCore
import AthenaeumRPC

/// **Live integration test** — the actual end-to-end proof the hard constraint asks for:
/// "genuinely test the import/transformation pipeline (HKWorkout-shaped data -> Workout/Exercise/
/// Set graph nodes+facts) end to end, even though the live HealthKit store itself can't be queried
/// here." Drives `SyntheticWorkoutDataSource` → `WorkoutImportBridge` → a REAL `WorkspaceRPCClient` →
/// the real backend `WorkoutsService` → real `NodesRepository`/`GraphService` writes, then reads
/// the resulting graph back over `runView`-equivalent RPCs to confirm the transformation produced
/// the correct node/tag/fact/edge shape. Same `ATHENAEUM_TEST_BACKEND_URL`-gated pattern as
/// `AthenaeumRPCTests/WorkspaceRPCClientLiveTests.swift` — skipped (not failed) when no backend is
/// running:
///
/// ```
/// ATHENAEUM_TEST_BACKEND_URL=http://127.0.0.1:8799 swift test --filter WorkoutImportBridgeLiveTests
/// ```
///
/// See `docs/workouts-decisions.md` for the actual transcript from running this against a real
/// local `wrangler dev` backend.
final class WorkoutImportBridgeLiveTests: XCTestCase {
    private func makeClient(workspaceId: String) throws -> WorkspaceRPCClient {
        guard let urlString = ProcessInfo.processInfo.environment["ATHENAEUM_TEST_BACKEND_URL"] else {
            throw XCTSkip("ATHENAEUM_TEST_BACKEND_URL not set — skipping live backend integration test")
        }
        guard let baseURL = URL(string: "\(urlString)/api/workspace/\(workspaceId)") else {
            XCTFail("invalid ATHENAEUM_TEST_BACKEND_URL: \(urlString)")
            throw CapnWebError.malformedMessage("invalid base URL")
        }
        return WorkspaceRPCClient(baseURL: baseURL, workspaceId: workspaceId)
    }

    private func freshWorkspaceId() -> String { UUID().uuidString.lowercased() }

    func testImportsBothSyntheticFixturesAndListsThemBack() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let source = SyntheticWorkoutDataSource()

        let workouts = try await source.fetchRecentWorkouts(since: .distantPast, limit: 10)
        XCTAssertEqual(workouts.count, 2)

        var importedRootNodeIds: Set<String> = []
        for workout in workouts {
            let result = try await WorkoutImportBridge.importWorkout(workout, using: client)
            XCTAssertFalse(result.duplicate, "first import of a fresh sourceWorkoutId must not be a duplicate")
            XCTAssertEqual(result.receipt.sourceWorkoutId, workout.sourceWorkoutId)
            importedRootNodeIds.insert(result.receipt.rootNodeId)
        }
        XCTAssertEqual(importedRootNodeIds.count, 2, "each workout should produce its own root node")

        let receipts = try await client.listWorkoutImports()
        XCTAssertEqual(Set(receipts.map(\.sourceWorkoutId)), Set(workouts.map(\.sourceWorkoutId)))
    }

    func testReimportingTheSameWorkoutIsIdempotent() async throws {
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let workout = SyntheticWorkoutDataSource.strengthFixture

        let first = try await WorkoutImportBridge.importWorkout(workout, using: client)
        XCTAssertFalse(first.duplicate)

        let second = try await WorkoutImportBridge.importWorkout(workout, using: client)
        XCTAssertTrue(second.duplicate)
        XCTAssertEqual(second.receipt.id, first.receipt.id)
        XCTAssertEqual(second.receipt.rootNodeId, first.receipt.rootNodeId)
    }

    func testImportingOnAnUngovernedWorkspaceNeedsNoCredential() async throws {
        // Every workspace this test suite creates via `freshWorkspaceId()` is ungoverned (never went
        // through `UserDurableObject#createWorkspace`), so an anonymous `WorkspaceRPCClient` (no
        // `bearerCredential`) must work unchanged — mirrors every other RPC surface's identical
        // Phase 4 behavior (`requireRoleForGovernedWorkspace`'s own doc comment, backend).
        let workspaceId = freshWorkspaceId()
        let client = try makeClient(workspaceId: workspaceId)
        let result = try await WorkoutImportBridge.importWorkout(SyntheticWorkoutDataSource.cardioFixture, using: client)
        XCTAssertFalse(result.duplicate)
    }
}
