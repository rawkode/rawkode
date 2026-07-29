import SwiftData
import SwiftUI

struct MealDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(\.healthKitClient) private var healthKit
    let meal: MealEntry
    @State private var showsCorrection = false
    @State private var showsDeleteConfirmation = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                LabeledContent("Portion", value: meal.portionSummary)
                LabeledContent("Time") {
                    Text(meal.eatenAt, format: .dateTime.day().month().hour().minute())
                }
            }

            Section("Nutrition") {
                ForEach(meal.nutritionAmounts.sorted(by: nutritionSort)) { value in
                    NutritionValueRow(value: value)
                }
            }

            if !meal.assumptions.isEmpty {
                Section("Assumptions") {
                    ForEach(meal.assumptions, id: \.self) { Text($0) }
                }
            }

            Section {
                Button("Correct with AI", systemImage: "sparkles") { showsCorrection = true }
                Button("Delete Meal", systemImage: "trash", role: .destructive) { showsDeleteConfirmation = true }
            }
        }
        .navigationTitle(meal.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showsCorrection) {
            NavigationStack { NutritionCaptureView(existingMeal: meal) }
        }
        .confirmationDialog("Delete this meal?", isPresented: $showsDeleteConfirmation, titleVisibility: .visible) {
            Button("Delete Meal", role: .destructive) { Task { await deleteMeal() } }
        } message: {
            Text("This removes the journal entry and its Apple Health food correlation.")
        }
        .alert("Couldn’t Delete Meal", isPresented: .init(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: { Text(errorMessage ?? "Unknown error") }
    }

    private func deleteMeal() async {
        do {
            try await healthKit.deleteMeal(id: meal.id)
            modelContext.delete(meal)
            try modelContext.save()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func nutritionSort(_ lhs: NutritionAmount, _ rhs: NutritionAmount) -> Bool {
        let all = NutritionMetric.allCases
        return (all.firstIndex(of: lhs.metric) ?? 0) < (all.firstIndex(of: rhs.metric) ?? 0)
    }
}

struct NutritionValueRow: View {
    let value: NutritionAmount

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(value.metric.title)
                HStack(spacing: 6) {
                    Text(value.provenance.title)
                    Text("•")
                    Text("\(value.confidence.title) confidence")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Text("\(value.amount.formatted(.number.precision(.fractionLength(value.amount < 10 ? 1 : 0)))) \(value.metric.unitSymbol)")
                .monospacedDigit()
        }
    }
}

