import Foundation
import HealthKit

enum NutritionCategory: String, Codable, CaseIterable, Sendable {
    case macro
    case nutrient
    case vitamin
    case mineral
    case other

    var title: String {
        switch self {
        case .macro: "Macros"
        case .nutrient: "Nutrients"
        case .vitamin: "Vitamins"
        case .mineral: "Minerals"
        case .other: "Other"
        }
    }
}

enum TargetBehavior: String, Codable, Sendable {
    case reference
    case minimum
    case maximum
}

enum NutrientProvenance: String, Codable, CaseIterable, Sendable {
    case label
    case stated
    case estimated

    var title: String { rawValue.capitalized }
}

enum NutrientConfidence: String, Codable, CaseIterable, Sendable {
    case high
    case medium
    case low

    var title: String { rawValue.capitalized }
}

enum NutritionMetric: String, Codable, CaseIterable, Identifiable, Sendable {
    case energy
    case protein
    case carbohydrate
    case fat
    case saturatedFat
    case monounsaturatedFat
    case polyunsaturatedFat
    case fibre
    case sugar
    case cholesterol
    case sodium
    case potassium
    case calcium
    case iron
    case magnesium
    case zinc
    case chloride
    case phosphorus
    case copper
    case manganese
    case selenium
    case chromium
    case molybdenum
    case iodine
    case vitaminA
    case vitaminB1
    case vitaminB2
    case vitaminB3
    case vitaminB5
    case vitaminB6
    case vitaminB7
    case vitaminB9
    case vitaminB12
    case vitaminC
    case vitaminD
    case vitaminE
    case vitaminK
    case water
    case caffeine

    var id: String { rawValue }

    var title: String {
        switch self {
        case .energy: "Energy"
        case .protein: "Protein"
        case .carbohydrate: "Carbohydrate"
        case .fat: "Fat"
        case .saturatedFat: "Saturated fat"
        case .monounsaturatedFat: "Monounsaturated fat"
        case .polyunsaturatedFat: "Polyunsaturated fat"
        case .fibre: "Fibre"
        case .sugar: "Sugar"
        case .cholesterol: "Cholesterol"
        case .sodium: "Sodium"
        case .potassium: "Potassium"
        case .calcium: "Calcium"
        case .iron: "Iron"
        case .magnesium: "Magnesium"
        case .zinc: "Zinc"
        case .chloride: "Chloride"
        case .phosphorus: "Phosphorus"
        case .copper: "Copper"
        case .manganese: "Manganese"
        case .selenium: "Selenium"
        case .chromium: "Chromium"
        case .molybdenum: "Molybdenum"
        case .iodine: "Iodine"
        case .vitaminA: "Vitamin A"
        case .vitaminB1: "Vitamin B1"
        case .vitaminB2: "Vitamin B2"
        case .vitaminB3: "Vitamin B3"
        case .vitaminB5: "Vitamin B5"
        case .vitaminB6: "Vitamin B6"
        case .vitaminB7: "Vitamin B7"
        case .vitaminB9: "Vitamin B9"
        case .vitaminB12: "Vitamin B12"
        case .vitaminC: "Vitamin C"
        case .vitaminD: "Vitamin D"
        case .vitaminE: "Vitamin E"
        case .vitaminK: "Vitamin K"
        case .water: "Water"
        case .caffeine: "Caffeine"
        }
    }

    var category: NutritionCategory {
        switch self {
        case .energy, .protein, .carbohydrate, .fat: .macro
        case .saturatedFat, .monounsaturatedFat, .polyunsaturatedFat, .fibre, .sugar, .cholesterol, .sodium: .nutrient
        case .vitaminA, .vitaminB1, .vitaminB2, .vitaminB3, .vitaminB5, .vitaminB6, .vitaminB7, .vitaminB9, .vitaminB12, .vitaminC, .vitaminD, .vitaminE, .vitaminK: .vitamin
        case .potassium, .calcium, .iron, .magnesium, .zinc, .chloride, .phosphorus, .copper, .manganese, .selenium, .chromium, .molybdenum, .iodine: .mineral
        case .water, .caffeine: .other
        }
    }

    var unitSymbol: String {
        switch self {
        case .energy: "kcal"
        case .protein, .carbohydrate, .fat, .saturatedFat, .monounsaturatedFat, .polyunsaturatedFat, .fibre, .sugar: "g"
        case .vitaminA, .vitaminB7, .vitaminB9, .vitaminB12, .vitaminD, .vitaminK, .selenium, .chromium, .molybdenum, .iodine: "µg"
        case .water: "ml"
        default: "mg"
        }
    }

    var healthKitIdentifier: HKQuantityTypeIdentifier {
        switch self {
        case .energy: .dietaryEnergyConsumed
        case .protein: .dietaryProtein
        case .carbohydrate: .dietaryCarbohydrates
        case .fat: .dietaryFatTotal
        case .saturatedFat: .dietaryFatSaturated
        case .monounsaturatedFat: .dietaryFatMonounsaturated
        case .polyunsaturatedFat: .dietaryFatPolyunsaturated
        case .fibre: .dietaryFiber
        case .sugar: .dietarySugar
        case .cholesterol: .dietaryCholesterol
        case .sodium: .dietarySodium
        case .potassium: .dietaryPotassium
        case .calcium: .dietaryCalcium
        case .iron: .dietaryIron
        case .magnesium: .dietaryMagnesium
        case .zinc: .dietaryZinc
        case .chloride: .dietaryChloride
        case .phosphorus: .dietaryPhosphorus
        case .copper: .dietaryCopper
        case .manganese: .dietaryManganese
        case .selenium: .dietarySelenium
        case .chromium: .dietaryChromium
        case .molybdenum: .dietaryMolybdenum
        case .iodine: .dietaryIodine
        case .vitaminA: .dietaryVitaminA
        case .vitaminB1: .dietaryThiamin
        case .vitaminB2: .dietaryRiboflavin
        case .vitaminB3: .dietaryNiacin
        case .vitaminB5: .dietaryPantothenicAcid
        case .vitaminB6: .dietaryVitaminB6
        case .vitaminB7: .dietaryBiotin
        case .vitaminB9: .dietaryFolate
        case .vitaminB12: .dietaryVitaminB12
        case .vitaminC: .dietaryVitaminC
        case .vitaminD: .dietaryVitaminD
        case .vitaminE: .dietaryVitaminE
        case .vitaminK: .dietaryVitaminK
        case .water: .dietaryWater
        case .caffeine: .dietaryCaffeine
        }
    }

    var healthKitUnit: HKUnit {
        switch unitSymbol {
        case "kcal": .kilocalorie()
        case "g": .gram()
        case "µg": .gramUnit(with: .micro)
        case "ml": .literUnit(with: .milli)
        default: .gramUnit(with: .milli)
        }
    }

    var plausibleMaximum: Double {
        switch self {
        case .energy: 25_000
        case .protein, .carbohydrate, .fat, .saturatedFat, .monounsaturatedFat, .polyunsaturatedFat, .fibre, .sugar: 2_000
        case .water: 20_000
        default: 100_000
        }
    }
}

struct NutritionAmount: Identifiable, Hashable, Codable, Sendable {
    var metric: NutritionMetric
    var amount: Double
    var provenance: NutrientProvenance
    var confidence: NutrientConfidence

    var id: NutritionMetric { metric }
}

struct DailyNutritionSummary: Sendable {
    let totals: [NutritionMetric: Double]

    init(amounts: some Sequence<NutritionAmount>) {
        totals = amounts.reduce(into: [:]) { result, item in
            result[item.metric, default: 0] += item.amount
        }
    }

    func amount(for metric: NutritionMetric) -> Double {
        totals[metric, default: 0]
    }
}

