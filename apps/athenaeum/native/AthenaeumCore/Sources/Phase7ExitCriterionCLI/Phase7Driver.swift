import Foundation
import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

// Phase 7 native-stage exit-criterion driver ("HealthKit import as typed graph pages" — plan
// §"Phased delivery"; hard constraint: "get a genuine end-to-end test using
// SyntheticWorkoutDataSource against a real local backend (a CLI-driver-style test, matching
// prior phases' pattern) — confirm workout nodes/facts land correctly and a second import of the
// same synthetic data doesn't duplicate").
//
// Same "small subcommand CLI an external orchestrator drives" shape as
// `phase2-driver`/.../`phase6-driver` (see `Phase6Driver.swift`'s own header comment for the
// pattern this follows). Every subcommand talks to the real backend (`wrangler dev`,
// `packages/backend`) over the real `AthenaeumRPC` HTTP-batch transport — nothing here is stubbed
// or mocked at the RPC layer. `--workspace` is any fresh UUID (an ungoverned workspace —
// `requireRoleForGovernedWorkspace` is a no-op for one with no owner, matching every other
// phaseN-driver's identical anonymous-workspace convention).
//
// This driver's one real data source is `SyntheticWorkoutDataSource` (`AthenaeumCore`) — the real
// `WorkoutDataSource` protocol's test double, not `HealthKitWorkoutDataSource` (that class cannot
// run here at all: no TCC dialog can be answered in this automated environment, no real Watch
// data exists on this machine — hard constraint). `import-synthetic`/`import-synthetic-batch`
// drive `SyntheticWorkoutDataSource.fetchRecentWorkouts` -> `WorkoutImportBridge` -> a real
// `WorkspaceRPCClient` -> the real backend `WorkoutsService`, proving the transformation/import
// pipeline end to end for exactly the two fixtures the hard constraint names ("a strength session
// with multiple exercises/sets, a cardio session with distance/pace").

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("ERROR: \(message)\n".utf8))
    exit(1)
}

func requireArg(_ args: [String], _ index: Int, _ name: String) -> String {
    guard args.count > index else { fail("missing required argument: \(name)") }
    return args[index]
}

func optionValue(_ args: [String], _ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

@main
struct Phase7Driver {
    static func main() async {
        do {
            try await run()
        } catch {
            fail("\(error)")
        }
    }

    static func run() async throws {
        var args = Array(CommandLine.arguments.dropFirst())
        guard !args.isEmpty else {
            fail("usage: phase7-driver <subcommand> [args] --backend <url> --workspace <id>")
        }
        let subcommand = args.removeFirst()
        let allArgs = CommandLine.arguments.map { $0 }

        let backendURLString = optionValue(allArgs, "--backend") ?? ProcessInfo.processInfo.environment["ATHENAEUM_BACKEND_URL"]
        guard let backendURLString else { fail("--backend <url> (or ATHENAEUM_BACKEND_URL) is required") }

        let workspaceIdString = optionValue(allArgs, "--workspace") ?? ProcessInfo.processInfo.environment["ATHENAEUM_WORKSPACE_ID"]
        guard let workspaceIdString else { fail("--workspace <id> (or ATHENAEUM_WORKSPACE_ID) is required") }
        let workspaceId = try EntityId(validating: workspaceIdString)
        guard let apiURL = URL(string: "\(backendURLString)/api/workspace/\(workspaceId.rawValue)") else {
            fail("invalid backend URL: \(backendURLString)")
        }
        let client = WorkspaceRPCClient(baseURL: apiURL, workspaceId: workspaceId.rawValue)

        let flagsWithValues: Set<String> = ["--backend", "--workspace", "--node"]
        var positional: [String] = []
        var i = 0
        while i < args.count {
            if flagsWithValues.contains(args[i]) {
                i += 2
            } else {
                positional.append(args[i])
                i += 1
            }
        }

        switch subcommand {
        case "import-synthetic":
            // One workout at a time via the single `importWorkout` RPC — imports BOTH default
            // fixtures (strength then cardio), same as `WorkoutImportBridgeLiveTests
            // .testImportsBothSyntheticFixturesAndListsThemBack`, so this driver and the XCTest
            // suite exercise the identical fixture set.
            let source = SyntheticWorkoutDataSource()
            let workouts = try await source.fetchRecentWorkouts(since: .distantPast, limit: 10)
            print("FETCHED_COUNT: \(workouts.count)")
            for workout in workouts {
                let result = try await WorkoutImportBridge.importWorkout(workout, using: client)
                print("IMPORTED: sourceWorkoutId=\(workout.sourceWorkoutId) rootNodeId=\(result.receipt.rootNodeId) duplicate=\(result.duplicate)")
            }

        case "import-synthetic-batch":
            // The same two fixtures, but through the batched `importWorkouts` RPC in one call —
            // proves the batch path independently of the single-item path above.
            let source = SyntheticWorkoutDataSource()
            let workouts = try await source.fetchRecentWorkouts(since: .distantPast, limit: 10)
            print("FETCHED_COUNT: \(workouts.count)")
            let results = try await WorkoutImportBridge.importWorkouts(workouts, using: client)
            print("RESULT_COUNT: \(results.count)")
            for result in results {
                switch result {
                case .succeeded(let sourceWorkoutId, let receipt, let duplicate):
                    print("SUCCEEDED: sourceWorkoutId=\(sourceWorkoutId) rootNodeId=\(receipt.rootNodeId) duplicate=\(duplicate)")
                case .failed(let sourceWorkoutId, let message):
                    print("FAILED: sourceWorkoutId=\(sourceWorkoutId) message=\"\(message)\"")
                }
            }

        case "list-workout-imports":
            let receipts = try await client.listWorkoutImports()
            print("RECEIPT_COUNT: \(receipts.count)")
            for receipt in receipts {
                print("RECEIPT: \(receipt.id) sourceWorkoutId=\(receipt.sourceWorkoutId) source=\(receipt.source) rootNodeId=\(receipt.rootNodeId) importedAt=\(receipt.importedAt)")
            }

        case "list-workouts":
            let summaries = try await client.listWorkouts()
            print("WORKOUT_COUNT: \(summaries.count)")
            for summary in summaries {
                print("WORKOUT: \(summary.nodeId) kind=\(summary.kind) activity=\(summary.activity) sourceWorkoutId=\(summary.sourceWorkoutId) startedAt=\(summary.startedAt) durationSeconds=\(summary.durationSeconds)")
            }

        case "get-workout":
            let nodeId = optionValue(allArgs, "--node") ?? requireArg(positional, 0, "nodeId")
            let detail = try await client.getWorkout(nodeId: nodeId)
            print("WORKOUT: \(detail.nodeId) activity=\(detail.activity) sourceWorkoutId=\(detail.sourceWorkoutId) durationSeconds=\(detail.durationSeconds)")
            switch detail.payload {
            case .strength(let exercises):
                print("KIND: strength")
                print("EXERCISE_COUNT: \(exercises.count)")
                for exercise in exercises.sorted(by: { $0.ordinal < $1.ordinal }) {
                    print("EXERCISE: ordinal=\(exercise.ordinal) name=\"\(exercise.name)\" volumeKilograms=\(exercise.volumeKilograms) setCount=\(exercise.sets.count)")
                    for set in exercise.sets.sorted(by: { $0.ordinal < $1.ordinal }) {
                        let rpeDescription: String = set.rpe != nil ? "\(set.rpe!)" : "<none>"
                        print("  SET: ordinal=\(set.ordinal) repetitions=\(set.repetitions) loadKilograms=\(set.loadKilograms) rpe=\(rpeDescription)")
                    }
                }
            case .cardio(let splits, let distanceMeters, _, _, let averagePace):
                let distanceDescription: String = distanceMeters != nil ? "\(distanceMeters!)" : "<none>"
                let paceDescription: String = averagePace != nil ? "\(averagePace!)" : "<none>"
                print("KIND: cardio")
                print("SPLIT_COUNT: \(splits.count)")
                print("DISTANCE_METERS: \(distanceDescription)")
                print("AVERAGE_PACE_SECONDS_PER_KM: \(paceDescription)")
                for split in splits.sorted(by: { $0.ordinal < $1.ordinal }) {
                    print("  SPLIT: ordinal=\(split.ordinal) distanceMeters=\(split.distanceMeters) durationSeconds=\(split.durationSeconds)")
                }
            }

        default:
            fail("unknown subcommand: \(subcommand)")
        }
    }
}
