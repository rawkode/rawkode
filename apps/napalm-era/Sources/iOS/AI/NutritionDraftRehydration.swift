import Foundation

extension NutritionDraft {
    init(rehydrating meal: MealEntry) {
        name = meal.name
        portionSummary = meal.portionSummary
        timestampISO8601 = ISO8601DateFormatter().string(from: meal.eatenAt)
        nutrients = meal.nutritionAmounts.compactMap { value in
            guard let metric = GeneratedNutritionMetric.allCases.first(where: { $0.metric == value.metric }),
                  let provenance = GeneratedProvenance.allCases.first(where: { $0.value == value.provenance }),
                  let confidence = GeneratedConfidence.allCases.first(where: { $0.value == value.confidence }) else { return nil }
            return GeneratedNutrient(metric: metric, amount: value.amount, provenance: provenance, confidence: confidence)
        }
        assumptions = meal.assumptions
    }
}

