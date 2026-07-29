import SwiftData
import SwiftUI

struct TodayView: View {
    @Environment(\.healthKitClient) private var healthKit
    @Query(sort: \MealEntry.eatenAt, order: .reverse) private var meals: [MealEntry]
    @Query private var targets: [NutritionTarget]
    @State private var workouts: [WorkoutSummary] = []
    @State private var showsCapture = false

    private var todayMeals: [MealEntry] {
        meals.filter { Calendar.autoupdatingCurrent.isDateInToday($0.eatenAt) }
    }

    private var summary: DailyNutritionSummary {
        DailyNutritionSummary(amounts: todayMeals.flatMap(\.nutritionAmounts))
    }

    private var targetsByMetric: [NutritionMetric: NutritionTarget] {
        Dictionary(uniqueKeysWithValues: targets.compactMap { target in
            target.metric.map { ($0, target) }
        })
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                dayHeader
                macroGrid
                metricSection("Nutrients", metrics: [.fibre, .saturatedFat, .sugar, .sodium, .potassium, .calcium, .iron, .magnesium, .zinc, .cholesterol])
                metricSection("Vitamins", metrics: [.vitaminA, .vitaminB1, .vitaminB2, .vitaminB3, .vitaminB5, .vitaminB6, .vitaminB7, .vitaminB9, .vitaminB12, .vitaminC, .vitaminD, .vitaminE, .vitaminK])
                mealsSection
                workoutsSection
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Today")
        .toolbarTitleDisplayMode(.large)
        .safeAreaInset(edge: .bottom) {
            Button {
                showsCapture = true
            } label: {
                Label("Log Nutrition", systemImage: "sparkles")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding()
            .background(.bar)
        }
        .sheet(isPresented: $showsCapture) {
            NavigationStack { NutritionCaptureView() }
        }
        .task { workouts = (try? await healthKit.fetchTodayWorkouts()) ?? [] }
    }

    private var dayHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Date.now, format: .dateTime.weekday(.wide).day().month(.wide))
                .font(.title2.weight(.semibold))
            Text("Nutrition from confirmed meals. Workouts from Apple Health.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var macroGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
            ForEach([NutritionMetric.energy, .protein, .carbohydrate, .fat]) { metric in
                NutritionProgressCard(
                    metric: metric,
                    amount: summary.amount(for: metric),
                    target: targetsByMetric[metric]?.amount
                )
            }
        }
    }

    private func metricSection(_ title: String, metrics: [NutritionMetric]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            VStack(spacing: 0) {
                ForEach(metrics) { metric in
                    NutritionMetricRow(
                        metric: metric,
                        amount: summary.amount(for: metric),
                        target: targetsByMetric[metric]?.amount
                    )
                    if metric != metrics.last { Divider() }
                }
            }
            .padding(.horizontal)
            .background(.background, in: .rect(cornerRadius: 16))
        }
    }

    private var mealsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Meals").font(.headline)
            if todayMeals.isEmpty {
                ContentUnavailableView("No confirmed meals", systemImage: "fork.knife", description: Text("Use Log Nutrition to describe or photograph a meal."))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(.background, in: .rect(cornerRadius: 16))
            } else {
                VStack(spacing: 0) {
                    ForEach(todayMeals) { meal in
                        NavigationLink(value: meal) {
                            MealRow(meal: meal)
                        }
                        .buttonStyle(.plain)
                        if meal.id != todayMeals.last?.id { Divider() }
                    }
                }
                .padding(.horizontal)
                .background(.background, in: .rect(cornerRadius: 16))
            }
        }
        .navigationDestination(for: MealEntry.self) { MealDetailView(meal: $0) }
    }

    private var workoutsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Workouts").font(.headline)
            if workouts.isEmpty {
                Text("No HealthKit workouts today")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(.background, in: .rect(cornerRadius: 16))
            } else {
                ForEach(Array(workouts.enumerated()), id: \.element.id) { _, workout in
                    HStack {
                        Image(systemName: "figure.strengthtraining.traditional")
                            .foregroundStyle(.tint)
                        VStack(alignment: .leading) {
                            Text(workout.activityName).font(.body.weight(.medium))
                            Text(workout.startedAt, format: .dateTime.hour().minute())
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(Int(workout.duration / 60)) min")
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                    .background(.background, in: .rect(cornerRadius: 16))
                }
            }
        }
    }
}

private struct NutritionProgressCard: View {
    let metric: NutritionMetric
    let amount: Double
    let target: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(metric.title).font(.subheadline).foregroundStyle(.secondary)
            Text(amount.formatted(.number.precision(.fractionLength(amount < 10 ? 1 : 0))))
                .font(.title2.monospacedDigit().weight(.semibold))
            if let target {
                ProgressView(value: min(amount / max(target, 0.001), 1))
                Text("of \(target.formatted(.number.precision(.fractionLength(target < 10 ? 1 : 0)))) \(metric.unitSymbol)")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text(metric.unitSymbol).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.background, in: .rect(cornerRadius: 16))
    }
}

private struct NutritionMetricRow: View {
    let metric: NutritionMetric
    let amount: Double
    let target: Double?

    var body: some View {
        HStack {
            Text(metric.title)
            Spacer()
            VStack(alignment: .trailing) {
                Text("\(amount.formatted(.number.precision(.fractionLength(amount < 10 ? 1 : 0)))) \(metric.unitSymbol)")
                    .monospacedDigit()
                if let target {
                    Text("target \(target.formatted(.number.precision(.fractionLength(target < 10 ? 1 : 0))))")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 11)
    }
}

private struct MealRow: View {
    let meal: MealEntry

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(meal.name).font(.body.weight(.medium))
                Text(meal.portionSummary).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let energy = meal.nutritionAmounts.first(where: { $0.metric == .energy }) {
                Text("\(energy.amount.formatted(.number.precision(.fractionLength(0)))) kcal")
                    .foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 12)
    }
}
