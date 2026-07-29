import Foundation
import SwiftData

@Model
final class MealEntry {
    var id: UUID = UUID()
    var name: String = "Meal"
    var portionSummary: String = ""
    var eatenAt: Date = Date.now
    var createdAt: Date = Date.now
    var updatedAt: Date = Date.now
    var healthKitCorrelationUUID: UUID?
    var modelRoute: String = ""
    var promptVersion: String = ""
    var assumptions: [String] = []
    @Relationship(deleteRule: .cascade, inverse: \NutrientValue.meal)
    var nutrients: [NutrientValue] = []

    init(
        id: UUID = UUID(),
        name: String,
        portionSummary: String,
        eatenAt: Date,
        modelRoute: String,
        promptVersion: String,
        assumptions: [String],
        nutrients: [NutrientValue]
    ) {
        self.id = id
        self.name = name
        self.portionSummary = portionSummary
        self.eatenAt = eatenAt
        self.modelRoute = modelRoute
        self.promptVersion = promptVersion
        self.assumptions = assumptions
        self.nutrients = nutrients
    }

    var nutritionAmounts: [NutritionAmount] {
        nutrients.compactMap(\.nutritionAmount)
    }
}

@Model
final class NutrientValue {
    var id: UUID = UUID()
    var metricRaw: String = NutritionMetric.energy.rawValue
    var amount: Double = 0
    var provenanceRaw: String = NutrientProvenance.estimated.rawValue
    var confidenceRaw: String = NutrientConfidence.low.rawValue
    var meal: MealEntry?

    init(
        id: UUID = UUID(),
        metric: NutritionMetric,
        amount: Double,
        provenance: NutrientProvenance,
        confidence: NutrientConfidence
    ) {
        self.id = id
        metricRaw = metric.rawValue
        self.amount = amount
        provenanceRaw = provenance.rawValue
        confidenceRaw = confidence.rawValue
    }

    var nutritionAmount: NutritionAmount? {
        guard let metric = NutritionMetric(rawValue: metricRaw),
              let provenance = NutrientProvenance(rawValue: provenanceRaw),
              let confidence = NutrientConfidence(rawValue: confidenceRaw) else { return nil }
        return NutritionAmount(metric: metric, amount: amount, provenance: provenance, confidence: confidence)
    }
}

@Model
final class NutritionTarget {
    var id: UUID = UUID()
    var metricRaw: String = NutritionMetric.energy.rawValue
    var amount: Double = 0
    var behaviorRaw: String = TargetBehavior.reference.rawValue

    init(metric: NutritionMetric, amount: Double, behavior: TargetBehavior) {
        metricRaw = metric.rawValue
        self.amount = amount
        behaviorRaw = behavior.rawValue
    }

    var metric: NutritionMetric? { NutritionMetric(rawValue: metricRaw) }
    var behavior: TargetBehavior { TargetBehavior(rawValue: behaviorRaw) ?? .reference }
}

@Model
final class MachineProfile {
    var id: UUID = UUID()
    var name: String = ""
    var symbol: String = "figure.strengthtraining.traditional"
    var order: Int = 0
    var isVisible: Bool = true
    var defaultLoadKilograms: Double = 0
    var defaultSets: Int = 3
    var defaultReps: Int = 10

    init(
        id: UUID = UUID(),
        name: String,
        symbol: String = "figure.strengthtraining.traditional",
        order: Int,
        defaultLoadKilograms: Double = 0,
        defaultSets: Int,
        defaultReps: Int
    ) {
        self.id = id
        self.name = name
        self.symbol = symbol
        self.order = order
        self.defaultLoadKilograms = defaultLoadKilograms
        self.defaultSets = defaultSets
        self.defaultReps = defaultReps
    }

    var snapshot: GymMachineSnapshot {
        GymMachineSnapshot(
            id: id,
            name: name,
            symbol: symbol,
            order: order,
            defaultLoadKilograms: defaultLoadKilograms,
            defaultSets: defaultSets,
            defaultReps: defaultReps,
            isVisible: isVisible
        )
    }
}

@Model
final class GymSession {
    var id: UUID = UUID()
    var startedAt: Date = Date.now
    var endedAt: Date = Date.now
    var healthKitWorkoutUUID: UUID?
    @Relationship(deleteRule: .cascade, inverse: \CompletedSet.session)
    var sets: [CompletedSet] = []

    init(payload: GymSessionPayload) {
        id = payload.id
        startedAt = payload.startedAt
        endedAt = payload.endedAt
        healthKitWorkoutUUID = payload.healthKitWorkoutUUID
        sets = payload.sets.map(CompletedSet.init)
    }
}

@Model
final class CompletedSet {
    var id: UUID = UUID()
    var machineID: UUID = UUID()
    var machineName: String = ""
    var order: Int = 0
    var loadKilograms: Double = 0
    var repetitions: Int = 0
    var completedAt: Date = Date.now
    var session: GymSession?

    init(payload: CompletedSetPayload) {
        id = payload.id
        machineID = payload.machineID
        machineName = payload.machineName
        order = payload.order
        loadKilograms = payload.loadKilograms
        repetitions = payload.repetitions
        completedAt = payload.completedAt
    }
}

