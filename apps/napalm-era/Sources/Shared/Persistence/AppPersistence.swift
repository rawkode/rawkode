import Foundation
import SwiftData

@MainActor
struct AppPersistence {
    let container: ModelContainer

    static let schema = Schema([
        MealEntry.self,
        NutrientValue.self,
        NutritionTarget.self,
        MachineProfile.self,
        GymSession.self,
        CompletedSet.self,
    ])

    static func make(inMemory: Bool = false) -> AppPersistence {
        let configuration = ModelConfiguration(
            "NapalmEra",
            schema: schema,
            isStoredInMemoryOnly: inMemory,
            cloudKitDatabase: .none
        )
        do {
            return AppPersistence(container: try ModelContainer(for: schema, configurations: [configuration]))
        } catch {
            fatalError("Unable to create Napalm Era store: \(error.localizedDescription)")
        }
    }
}

@MainActor
enum SeedData {
    static func installIfNeeded(in context: ModelContext) throws {
        var targetDescriptor = FetchDescriptor<NutritionTarget>()
        targetDescriptor.fetchLimit = 1
        if try context.fetch(targetDescriptor).isEmpty {
            for seed in nutritionTargets {
                context.insert(NutritionTarget(metric: seed.metric, amount: seed.amount, behavior: seed.behavior))
            }
        }

        var machineDescriptor = FetchDescriptor<MachineProfile>()
        machineDescriptor.fetchLimit = 1
        if try context.fetch(machineDescriptor).isEmpty {
            for (index, seed) in machineSeeds.enumerated() {
                context.insert(MachineProfile(name: seed.name, order: index, defaultSets: seed.sets, defaultReps: seed.reps))
            }
        }
        try context.save()
    }

    private static let nutritionTargets: [(metric: NutritionMetric, amount: Double, behavior: TargetBehavior)] = [
        (.energy, 2_000, .reference), (.carbohydrate, 260, .reference), (.protein, 50, .reference),
        (.fat, 70, .maximum), (.saturatedFat, 20, .maximum), (.sugar, 90, .maximum),
        (.sodium, 2_400, .maximum), (.fibre, 30, .minimum),
        (.vitaminA, 800, .reference), (.vitaminD, 10, .reference), (.vitaminE, 12, .reference),
        (.vitaminK, 75, .reference), (.vitaminC, 80, .reference), (.vitaminB1, 1.1, .reference),
        (.vitaminB2, 1.4, .reference), (.vitaminB3, 16, .reference), (.vitaminB5, 6, .reference),
        (.vitaminB6, 1.4, .reference), (.vitaminB7, 50, .reference), (.vitaminB9, 200, .reference),
        (.vitaminB12, 2.5, .reference), (.potassium, 2_000, .reference), (.chloride, 800, .reference),
        (.calcium, 800, .reference), (.phosphorus, 700, .reference), (.magnesium, 375, .reference),
        (.iron, 14, .reference), (.zinc, 10, .reference), (.copper, 1, .reference),
        (.manganese, 2, .reference), (.selenium, 55, .reference), (.chromium, 40, .reference),
        (.molybdenum, 50, .reference), (.iodine, 150, .reference),
    ]

    private static let machineSeeds: [(name: String, sets: Int, reps: Int)] = [
        ("Chest press", 3, 10), ("Shoulder press", 3, 10), ("Lat pulldown", 3, 10),
        ("Seated row", 3, 10), ("Leg press", 3, 10), ("Leg extension", 2, 12),
        ("Leg curl", 2, 12), ("Pec fly", 2, 12), ("Reverse fly", 2, 12),
        ("Biceps curl", 2, 12), ("Triceps extension", 2, 12), ("Hip abductor", 2, 15),
        ("Hip adductor", 2, 15), ("Back extension", 2, 15), ("Calf raise", 3, 15),
        ("Abdominal crunch", 3, 15),
    ]
}
