import Foundation

// Phase 7 native stage ("HealthKit import as typed graph pages") — the native client for
// `workspace-durable-object.ts`'s five Phase 7 workout Cap'n Web methods (`importWorkout`,
// `listWorkoutImports`, `importWorkouts`, `listWorkouts`, `getWorkout` —
// `packages/domain/src/workout-rpc.ts`). Same `rpc(_:_:)` dispatch / hand-rolled "RPC*"-prefixed
// decode-struct convention as `WorkspaceRPCClient+Meetings.swift`/`WorkspaceRPCClient+Calendar.swift` —
// deliberately its own ad-hoc decode/encode types here (not `AthenaeumDomain`'s Codable mirrors),
// matching every other `WorkspaceRPCClient+*.swift` extension file's existing precedent.
//
// **Deliberately AthenaeumCore/HealthKit-agnostic**: this file (and the whole `AthenaeumRPC`
// target) has zero dependency on `AthenaeumCore` — per `AthenaeumRPC/Package.swift`'s own header
// comment, this package "builds and runs on watchOS too," which cannot link `AthenaeumCore`
// (`AthenaeumCore/Package.swift`: "Platforms: macOS/iOS only, deliberately NOT watchOS"). The
// types below (`RPCWorkoutImportPayload` etc.) are plain, source-agnostic wire shapes — the
// bridge from `AthenaeumCore`'s HealthKit-flavored `ImportedWorkout` to these types lives in
// `AthenaeumCore/Sources/AthenaeumCore/Workouts/WorkoutImportBridge.swift`, the caller-side glue,
// not here.
//
// Role gates, confirmed by reading `workspace-durable-object.ts`'s own Phase 7 section, not assumed:
// `importWorkout`/`importWorkouts` -> `"build"`; `listWorkoutImports`/`listWorkouts`/`getWorkout`
// -> `"use"` — same convention as every other governed-workspace RPC method in this codebase.

/// Mirrors `packages/domain/src/workout.ts`'s `WorkoutImportReceipt`.
public struct RPCWorkoutImportReceipt: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let sourceWorkoutId: String
    public let source: String
    public let payloadHash: String
    public let rootNodeId: String
    public let importedAt: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let sourceWorkoutId = try value.field("sourceWorkoutId").stringValue,
              let source = try value.field("source").stringValue,
              let payloadHash = try value.field("payloadHash").stringValue,
              let rootNodeId = try value.field("rootNodeId").stringValue,
              let importedAt = try value.field("importedAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed WorkoutImportReceipt: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.sourceWorkoutId = sourceWorkoutId
        self.source = source
        self.payloadHash = payloadHash
        self.rootNodeId = rootNodeId
        self.importedAt = importedAt
    }
}

/// Mirrors `packages/domain/src/workout-rpc.ts`'s `StrengthSetImportInput`.
public struct RPCStrengthSetInput: Sendable, Equatable {
    public let ordinal: Int
    public let repetitions: Int
    public let loadKilograms: Double
    public let rpe: Double?
    /// ISO-8601, matching `IsoDateTimeString`'s wire representation.
    public let completedAt: String?

    public init(ordinal: Int, repetitions: Int, loadKilograms: Double, rpe: Double? = nil, completedAt: String? = nil) {
        self.ordinal = ordinal
        self.repetitions = repetitions
        self.loadKilograms = loadKilograms
        self.rpe = rpe
        self.completedAt = completedAt
    }

    var wireValue: CapnWebValue {
        var fields: [String: CapnWebValue] = [
            "ordinal": .int(ordinal),
            "repetitions": .int(repetitions),
            "loadKilograms": .number(loadKilograms)
        ]
        if let rpe { fields["rpe"] = .number(rpe) }
        if let completedAt { fields["completedAt"] = .string(completedAt) }
        return .object(fields)
    }
}

/// Mirrors `packages/domain/src/workout-rpc.ts`'s `StrengthExerciseImportInput`.
public struct RPCStrengthExerciseInput: Sendable, Equatable {
    public let ordinal: Int
    public let name: String
    public let sets: [RPCStrengthSetInput]

    public init(ordinal: Int, name: String, sets: [RPCStrengthSetInput]) {
        self.ordinal = ordinal
        self.name = name
        self.sets = sets
    }

    var wireValue: CapnWebValue {
        .object(["ordinal": .int(ordinal), "name": .string(name), "sets": .array(sets.map(\.wireValue))])
    }
}

/// Mirrors `packages/domain/src/workout-rpc.ts`'s `CardioSplitImportInput`.
public struct RPCCardioSplitInput: Sendable, Equatable {
    public let ordinal: Int
    public let distanceMeters: Double
    public let durationSeconds: Double
    public let averageHeartRate: Double?
    public let energyKilocalories: Double?

    public init(
        ordinal: Int,
        distanceMeters: Double,
        durationSeconds: Double,
        averageHeartRate: Double? = nil,
        energyKilocalories: Double? = nil
    ) {
        self.ordinal = ordinal
        self.distanceMeters = distanceMeters
        self.durationSeconds = durationSeconds
        self.averageHeartRate = averageHeartRate
        self.energyKilocalories = energyKilocalories
    }

    var wireValue: CapnWebValue {
        var fields: [String: CapnWebValue] = [
            "ordinal": .int(ordinal),
            "distanceMeters": .number(distanceMeters),
            "durationSeconds": .number(durationSeconds)
        ]
        if let averageHeartRate { fields["averageHeartRate"] = .number(averageHeartRate) }
        if let energyKilocalories { fields["energyKilocalories"] = .number(energyKilocalories) }
        return .object(fields)
    }
}

/// Mirrors `packages/domain/src/workout-rpc.ts`'s discriminated `WorkoutImportPayload` union.
public enum RPCWorkoutImportPayload: Sendable, Equatable {
    case strength(exercises: [RPCStrengthExerciseInput])
    case cardio(
        splits: [RPCCardioSplitInput],
        distanceMeters: Double? = nil,
        elevationMeters: Double? = nil,
        averageSpeedMetersPerSecond: Double? = nil,
        averagePaceSecondsPerKilometre: Double? = nil
    )

    var wireValue: CapnWebValue {
        switch self {
        case .strength(let exercises):
            return .object(["kind": .string("strength"), "exercises": .array(exercises.map(\.wireValue))])
        case .cardio(let splits, let distanceMeters, let elevationMeters, let averageSpeedMetersPerSecond, let averagePaceSecondsPerKilometre):
            var fields: [String: CapnWebValue] = [
                "kind": .string("cardio"),
                "splits": .array(splits.map(\.wireValue))
            ]
            if let distanceMeters { fields["distanceMeters"] = .number(distanceMeters) }
            if let elevationMeters { fields["elevationMeters"] = .number(elevationMeters) }
            if let averageSpeedMetersPerSecond { fields["averageSpeedMetersPerSecond"] = .number(averageSpeedMetersPerSecond) }
            if let averagePaceSecondsPerKilometre { fields["averagePaceSecondsPerKilometre"] = .number(averagePaceSecondsPerKilometre) }
            return .object(fields)
        }
    }
}

extension WorkspaceRPCClient {
    // MARK: - Workouts

    /// `role` gate: `"build"`. Atomically imports one workout as a `Workout`-tagged node subgraph
    /// — see `workout-rpc.ts`'s `ImportWorkoutInput` doc comment for why this is one RPC call, not
    /// N generic graph calls. Idempotent by `sourceWorkoutId`: `duplicate == true` means an
    /// identical import already existed and nothing new was written.
    public func importWorkout(
        sourceWorkoutId: String,
        source: String,
        activity: String,
        rawActivity: String? = nil,
        startedAt: String,
        completedAt: String,
        durationSeconds: Double,
        energyKilocalories: Double? = nil,
        averageHeartRate: Double? = nil,
        maximumHeartRate: Double? = nil,
        payload: RPCWorkoutImportPayload
    ) async throws -> (receipt: RPCWorkoutImportReceipt, duplicate: Bool) {
        var args: [String: CapnWebValue] = [
            "sourceWorkoutId": .string(sourceWorkoutId),
            "source": .string(source),
            "activity": .string(activity),
            "startedAt": .string(startedAt),
            "completedAt": .string(completedAt),
            "durationSeconds": .number(durationSeconds),
            "payload": payload.wireValue
        ]
        if let rawActivity { args["rawActivity"] = .string(rawActivity) }
        if let energyKilocalories { args["energyKilocalories"] = .number(energyKilocalories) }
        if let averageHeartRate { args["averageHeartRate"] = .number(averageHeartRate) }
        if let maximumHeartRate { args["maximumHeartRate"] = .number(maximumHeartRate) }

        let result = try await rpc("importWorkout", args)
        return (
            receipt: try RPCWorkoutImportReceipt(result.field("receipt")),
            duplicate: try result.field("duplicate").boolValue ?? false
        )
    }

    /// `role` gate: `"use"`. Lists this workspace's workout-import receipts, most-recently-imported
    /// first.
    public func listWorkoutImports() async throws -> [RPCWorkoutImportReceipt] {
        let result = try await rpc("listWorkoutImports", [:])
        return try (result.field("receipts").arrayValue ?? []).map(RPCWorkoutImportReceipt.init)
    }
}

// MARK: - Batch import (`importWorkouts`)

/// One item within a batch `importWorkouts` call — mirrors `workout-rpc.ts`'s `WorkoutImportItem`
/// (identical fields to the single-import `importWorkout` call minus `workspaceId`, which the batch
/// input carries once — `rpc(_:_:)` injects it the same way it does for every other method here).
public struct RPCWorkoutImportItem: Sendable, Equatable {
    public let sourceWorkoutId: String
    public let source: String
    public let activity: String
    public let rawActivity: String?
    public let startedAt: String
    public let completedAt: String
    public let durationSeconds: Double
    public let energyKilocalories: Double?
    public let averageHeartRate: Double?
    public let maximumHeartRate: Double?
    public let payload: RPCWorkoutImportPayload

    public init(
        sourceWorkoutId: String,
        source: String,
        activity: String,
        rawActivity: String? = nil,
        startedAt: String,
        completedAt: String,
        durationSeconds: Double,
        energyKilocalories: Double? = nil,
        averageHeartRate: Double? = nil,
        maximumHeartRate: Double? = nil,
        payload: RPCWorkoutImportPayload
    ) {
        self.sourceWorkoutId = sourceWorkoutId
        self.source = source
        self.activity = activity
        self.rawActivity = rawActivity
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.durationSeconds = durationSeconds
        self.energyKilocalories = energyKilocalories
        self.averageHeartRate = averageHeartRate
        self.maximumHeartRate = maximumHeartRate
        self.payload = payload
    }

    var wireValue: CapnWebValue {
        var fields: [String: CapnWebValue] = [
            "sourceWorkoutId": .string(sourceWorkoutId),
            "source": .string(source),
            "activity": .string(activity),
            "startedAt": .string(startedAt),
            "completedAt": .string(completedAt),
            "durationSeconds": .number(durationSeconds),
            "payload": payload.wireValue
        ]
        if let rawActivity { fields["rawActivity"] = .string(rawActivity) }
        if let energyKilocalories { fields["energyKilocalories"] = .number(energyKilocalories) }
        if let averageHeartRate { fields["averageHeartRate"] = .number(averageHeartRate) }
        if let maximumHeartRate { fields["maximumHeartRate"] = .number(maximumHeartRate) }
        return .object(fields)
    }
}

/// One batch item's outcome — mirrors `workout-rpc.ts`'s discriminated `WorkoutImportBatchItemResult`
/// union (`WorkoutImportSucceeded` / `WorkoutImportFailed`), decoded on `outcome`.
public enum RPCWorkoutImportBatchItemResult: Sendable, Equatable {
    case succeeded(sourceWorkoutId: String, receipt: RPCWorkoutImportReceipt, duplicate: Bool)
    case failed(sourceWorkoutId: String, message: String)

    init(_ value: CapnWebValue) throws {
        guard let outcome = try value.field("outcome").stringValue,
              let sourceWorkoutId = try value.field("sourceWorkoutId").stringValue
        else { throw CapnWebError.malformedMessage("malformed WorkoutImportBatchItemResult: \(value)") }
        switch outcome {
        case "imported":
            self = .succeeded(
                sourceWorkoutId: sourceWorkoutId,
                receipt: try RPCWorkoutImportReceipt(value.field("receipt")),
                duplicate: try value.field("duplicate").boolValue ?? false
            )
        case "failed":
            guard let message = try value.field("message").stringValue else {
                throw CapnWebError.malformedMessage("malformed WorkoutImportFailed: \(value)")
            }
            self = .failed(sourceWorkoutId: sourceWorkoutId, message: message)
        default:
            throw CapnWebError.malformedMessage("unknown WorkoutImportBatchItemResult outcome: \(outcome)")
        }
    }

    public var sourceWorkoutId: String {
        switch self {
        case .succeeded(let sourceWorkoutId, _, _): return sourceWorkoutId
        case .failed(let sourceWorkoutId, _): return sourceWorkoutId
        }
    }
}

// MARK: - Read models (`listWorkouts` / `getWorkout`)

/// Mirrors `workout.ts`'s `WorkoutSummary` — `listWorkouts`' lightweight per-row read shape.
public struct RPCWorkoutSummary: Sendable, Equatable {
    public let nodeId: String
    public let workspaceId: String
    public let sourceWorkoutId: String
    public let source: String
    public let kind: String
    public let activity: String
    public let rawActivity: String?
    public let startedAt: String
    public let completedAt: String
    public let durationSeconds: Double
    public let energyKilocalories: Double?
    public let averageHeartRate: Double?
    public let maximumHeartRate: Double?

    init(_ value: CapnWebValue) throws {
        guard let nodeId = try value.field("nodeId").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let sourceWorkoutId = try value.field("sourceWorkoutId").stringValue,
              let source = try value.field("source").stringValue,
              let kind = try value.field("kind").stringValue,
              let activity = try value.field("activity").stringValue,
              let startedAt = try value.field("startedAt").stringValue,
              let completedAt = try value.field("completedAt").stringValue,
              let durationSeconds = try value.field("durationSeconds").doubleValue
        else { throw CapnWebError.malformedMessage("malformed WorkoutSummary: \(value)") }
        self.nodeId = nodeId
        self.workspaceId = workspaceId
        self.sourceWorkoutId = sourceWorkoutId
        self.source = source
        self.kind = kind
        self.activity = activity
        self.rawActivity = try value.field("rawActivity").stringValue
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.durationSeconds = durationSeconds
        self.energyKilocalories = try value.field("energyKilocalories").doubleValue
        self.averageHeartRate = try value.field("averageHeartRate").doubleValue
        self.maximumHeartRate = try value.field("maximumHeartRate").doubleValue
    }
}

/// Mirrors `workout.ts`'s `WorkoutStrengthSet`.
public struct RPCWorkoutStrengthSet: Sendable, Equatable {
    public let nodeId: String
    public let ordinal: Int
    public let repetitions: Int
    public let loadKilograms: Double
    public let volumeKilograms: Double
    public let rpe: Double?
    public let completedAt: String?

    init(_ value: CapnWebValue) throws {
        guard let nodeId = try value.field("nodeId").stringValue,
              let ordinal = try value.field("ordinal").intValue,
              let repetitions = try value.field("repetitions").intValue,
              let loadKilograms = try value.field("loadKilograms").doubleValue,
              let volumeKilograms = try value.field("volumeKilograms").doubleValue
        else { throw CapnWebError.malformedMessage("malformed WorkoutStrengthSet: \(value)") }
        self.nodeId = nodeId
        self.ordinal = ordinal
        self.repetitions = repetitions
        self.loadKilograms = loadKilograms
        self.volumeKilograms = volumeKilograms
        self.rpe = try value.field("rpe").doubleValue
        self.completedAt = try value.field("completedAt").stringValue
    }
}

/// Mirrors `workout.ts`'s `WorkoutStrengthExercise`.
public struct RPCWorkoutStrengthExercise: Sendable, Equatable {
    public let nodeId: String
    public let ordinal: Int
    public let name: String
    public let volumeKilograms: Double
    public let sets: [RPCWorkoutStrengthSet]

    init(_ value: CapnWebValue) throws {
        guard let nodeId = try value.field("nodeId").stringValue,
              let ordinal = try value.field("ordinal").intValue,
              let name = try value.field("name").stringValue,
              let volumeKilograms = try value.field("volumeKilograms").doubleValue
        else { throw CapnWebError.malformedMessage("malformed WorkoutStrengthExercise: \(value)") }
        self.nodeId = nodeId
        self.ordinal = ordinal
        self.name = name
        self.volumeKilograms = volumeKilograms
        self.sets = try (value.field("sets").arrayValue ?? []).map(RPCWorkoutStrengthSet.init)
    }
}

/// Mirrors `workout.ts`'s `WorkoutCardioSplit`.
public struct RPCWorkoutCardioSplit: Sendable, Equatable {
    public let nodeId: String
    public let ordinal: Int
    public let distanceMeters: Double
    public let durationSeconds: Double
    public let paceSecondsPerKilometre: Double?
    public let averageHeartRate: Double?
    public let energyKilocalories: Double?

    init(_ value: CapnWebValue) throws {
        guard let nodeId = try value.field("nodeId").stringValue,
              let ordinal = try value.field("ordinal").intValue,
              let distanceMeters = try value.field("distanceMeters").doubleValue,
              let durationSeconds = try value.field("durationSeconds").doubleValue
        else { throw CapnWebError.malformedMessage("malformed WorkoutCardioSplit: \(value)") }
        self.nodeId = nodeId
        self.ordinal = ordinal
        self.distanceMeters = distanceMeters
        self.durationSeconds = durationSeconds
        self.paceSecondsPerKilometre = try value.field("paceSecondsPerKilometre").doubleValue
        self.averageHeartRate = try value.field("averageHeartRate").doubleValue
        self.energyKilocalories = try value.field("energyKilocalories").doubleValue
    }
}

/// Mirrors `workout.ts`'s discriminated `WorkoutDetailPayload`, decoded on `kind`.
public enum RPCWorkoutDetailPayload: Sendable, Equatable {
    case strength(exercises: [RPCWorkoutStrengthExercise])
    case cardio(
        splits: [RPCWorkoutCardioSplit],
        distanceMeters: Double?,
        elevationMeters: Double?,
        averageSpeedMetersPerSecond: Double?,
        averagePaceSecondsPerKilometre: Double?
    )

    init(_ value: CapnWebValue) throws {
        guard let kind = try value.field("kind").stringValue else {
            throw CapnWebError.malformedMessage("malformed WorkoutDetailPayload: \(value)")
        }
        switch kind {
        case "strength":
            self = .strength(exercises: try (value.field("exercises").arrayValue ?? []).map(RPCWorkoutStrengthExercise.init))
        case "cardio":
            self = .cardio(
                splits: try (value.field("splits").arrayValue ?? []).map(RPCWorkoutCardioSplit.init),
                distanceMeters: try value.field("distanceMeters").doubleValue,
                elevationMeters: try value.field("elevationMeters").doubleValue,
                averageSpeedMetersPerSecond: try value.field("averageSpeedMetersPerSecond").doubleValue,
                averagePaceSecondsPerKilometre: try value.field("averagePaceSecondsPerKilometre").doubleValue
            )
        default:
            throw CapnWebError.malformedMessage("unknown WorkoutDetailPayload kind: \(kind)")
        }
    }
}

/// Mirrors `workout.ts`'s `WorkoutDetail` — `getWorkout`'s full aggregate read.
public struct RPCWorkoutDetail: Sendable, Equatable {
    public let nodeId: String
    public let workspaceId: String
    public let sourceWorkoutId: String
    public let source: String
    public let activity: String
    public let rawActivity: String?
    public let startedAt: String
    public let completedAt: String
    public let durationSeconds: Double
    public let energyKilocalories: Double?
    public let averageHeartRate: Double?
    public let maximumHeartRate: Double?
    public let payload: RPCWorkoutDetailPayload

    init(_ value: CapnWebValue) throws {
        guard let nodeId = try value.field("nodeId").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let sourceWorkoutId = try value.field("sourceWorkoutId").stringValue,
              let source = try value.field("source").stringValue,
              let activity = try value.field("activity").stringValue,
              let startedAt = try value.field("startedAt").stringValue,
              let completedAt = try value.field("completedAt").stringValue,
              let durationSeconds = try value.field("durationSeconds").doubleValue
        else { throw CapnWebError.malformedMessage("malformed WorkoutDetail: \(value)") }
        self.nodeId = nodeId
        self.workspaceId = workspaceId
        self.sourceWorkoutId = sourceWorkoutId
        self.source = source
        self.activity = activity
        self.rawActivity = try value.field("rawActivity").stringValue
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.durationSeconds = durationSeconds
        self.energyKilocalories = try value.field("energyKilocalories").doubleValue
        self.averageHeartRate = try value.field("averageHeartRate").doubleValue
        self.maximumHeartRate = try value.field("maximumHeartRate").doubleValue
        self.payload = try RPCWorkoutDetailPayload(value.field("payload"))
    }
}

extension WorkspaceRPCClient {
    // MARK: - Workouts: batch import + read models

    /// `role` gate: `"build"`. Batched sibling of `importWorkout` — one RPC call, N items,
    /// per-item independent outcomes (never all-or-nothing; see `workout-rpc.ts`'s
    /// `ImportWorkoutsInput`/`ImportWorkoutsOutput` doc comments). Results are returned in the
    /// same order as `workouts`.
    public func importWorkouts(_ workouts: [RPCWorkoutImportItem]) async throws -> [RPCWorkoutImportBatchItemResult] {
        let result = try await rpc("importWorkouts", ["workouts": .array(workouts.map(\.wireValue))])
        return try (result.field("results").arrayValue ?? []).map(RPCWorkoutImportBatchItemResult.init)
    }

    /// `role` gate: `"use"`. Lightweight per-workout read model, most-recently-started first.
    public func listWorkouts() async throws -> [RPCWorkoutSummary] {
        let result = try await rpc("listWorkouts", [:])
        return try (result.field("workouts").arrayValue ?? []).map(RPCWorkoutSummary.init)
    }

    /// `role` gate: `"use"`. Full aggregate read for one workout root node (`nodeId` — the graph
    /// node id, e.g. `RPCWorkoutImportReceipt.rootNodeId` or `RPCWorkoutSummary.nodeId`, NOT a
    /// `sourceWorkoutId`). Fails with `WorkoutNotFound` if `nodeId` isn't a `Workout`-tagged node
    /// in this workspace.
    public func getWorkout(nodeId: String) async throws -> RPCWorkoutDetail {
        let result = try await rpc("getWorkout", ["nodeId": .string(nodeId)])
        return try RPCWorkoutDetail(result.field("workout"))
    }
}
