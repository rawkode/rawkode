import EnchiridionCore
import SwiftUI

/// Registers the first-party workout renderer without giving it repository or SQL access.
///
/// Call this once while the app is being configured. A duplicate registration is reported by
/// `ModuleViewRendererRegistry`, which keeps app wiring deterministic.
@MainActor
public enum WorkoutModuleViews {
  public static let summaryViewType = ViewTypeID(
    rawValue: "dev.rawkode.enchiridion.workouts.summary"
  )

  public static func register(in registry: ModuleViewRendererRegistry = .shared) throws {
    try registry.register(summaryViewType) { context in
      // ModuleViewContext intentionally contains only saved view data and query rows. The
      // host adds a vault-scoped destination when it can prove the active vault identity.
      AnyView(WorkoutSummaryScreen(context: context))
    }
  }
}

/// A module-local presentation over already-materialized live-query rows.
/// It deliberately has no LibraryStore, repository, or database dependency.
@MainActor
private struct WorkoutSummaryScreen: View {
  let context: ModuleViewContext

  private var workouts: [WorkoutRowModel] {
    context.items.compactMap(WorkoutRowModel.init)
  }

  var body: some View {
    Group {
      if workouts.isEmpty {
        ContentUnavailableView(
          "No Workouts",
          systemImage: "figure.run",
          description: Text("Completed strength and cardio workouts will appear here.")
        )
      } else {
        List(workouts) { workout in
          Button {
            context.dispatch(
              .openPage(
                .init(
                  vaultID: context.vaultID,
                  nodeID: .init(rawValue: workout.id.rawValue)
                )))
          } label: {
            WorkoutSummaryRow(workout: workout)
          }
          .buttonStyle(.plain)
          .accessibilityHint("Opens the workout")
        }
        .listStyle(.inset)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Workout summary")
  }
}

private struct WorkoutSummaryRow: View {
  let workout: WorkoutRowModel

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Image(systemName: workout.kind.symbol)
          .foregroundStyle(workout.kind.tint)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(workout.title)
            .font(.headline)
          Text(workout.startedAt.formatted(date: .abbreviated, time: .shortened))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 8)
        WorkoutStatusBadge(status: workout.status)
      }

      HStack(spacing: 12) {
        WorkoutMetric(label: "Duration", value: workout.durationText, systemImage: "timer")
        if let energy = workout.energyText {
          WorkoutMetric(label: "Energy", value: energy, systemImage: "flame")
        }
        if let heartRate = workout.heartRateText {
          WorkoutMetric(label: "Heart rate", value: heartRate, systemImage: "heart")
        }
      }

      switch workout.kind {
      case .strength:
        if let detail = workout.strengthDetail {
          Label(detail, systemImage: "dumbbell")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      case .cardio:
        if let detail = workout.cardioDetail {
          Label(detail, systemImage: "figure.run")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }

      HStack(spacing: 8) {
        WorkoutStateLabel(
          label: "HealthKit", value: workout.healthKitState, systemImage: "heart.text.square")
        WorkoutStateLabel(label: "Route", value: workout.routeState, systemImage: "map")
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(workout.accessibilitySummary)
  }
}

private struct WorkoutMetric: View {
  let label: String
  let value: String
  let systemImage: String

  var body: some View {
    Label(value, systemImage: systemImage)
      .font(.caption)
      .foregroundStyle(.secondary)
      .accessibilityLabel("\(label): \(value)")
  }
}

private struct WorkoutStateLabel: View {
  let label: String
  let value: String
  let systemImage: String

  var body: some View {
    Label("\(label): \(value)", systemImage: systemImage)
      .font(.caption2)
      .foregroundStyle(.secondary)
      .accessibilityLabel("\(label): \(value)")
  }
}

private struct WorkoutStatusBadge: View {
  let status: String

  var body: some View {
    Text(status.capitalized)
      .font(.caption.weight(.medium))
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(.quaternary, in: Capsule())
      .accessibilityLabel("Capture status: \(status)")
  }
}

private struct WorkoutRowModel: Identifiable {
  enum Kind: Equatable {
    case strength
    case cardio

    var symbol: String {
      switch self {
      case .strength: "dumbbell"
      case .cardio: "figure.run"
      }
    }

    var tint: Color {
      switch self {
      case .strength: .indigo
      case .cardio: .orange
      }
    }
  }

  let page: PageSnapshot
  let kind: Kind
  let title: String
  let startedAt: Date
  let durationSeconds: Double?
  let status: String
  let energyKilocalories: Double?
  let averageHeartRate: Double?
  let exerciseCount: Double?
  let setCount: Double?
  let totalVolumeKilograms: Double?
  let distanceMeters: Double?
  let averagePaceSecondsPerKilometre: Double?
  let healthKitState: String
  let routeState: String

  init?(_ item: LiveQueryItem) {
    guard case .page(let page) = item else { return nil }
    let tags = page.objectMetadata.supertagIDs
    let kind: Kind
    if tags.contains(WorkoutModule.Tag.strength) {
      kind = .strength
    } else if tags.contains(WorkoutModule.Tag.cardio) {
      kind = .cardio
    } else {
      return nil
    }

    self.page = page
    self.kind = kind
    title = page.displayTitle
    startedAt =
      page.dateValue(named: "started-at", preferredOwners: [WorkoutModule.Tag.workout])
      ?? page.createdAt
    durationSeconds = page.numberValue(
      named: "duration-seconds", preferredOwners: [WorkoutModule.Tag.workout])
    status =
      page.stringValue(named: "status", preferredOwners: [WorkoutModule.Tag.workout]) ?? "unknown"
    energyKilocalories = page.numberValue(
      named: "energy-kilocalories", preferredOwners: [WorkoutModule.Tag.workout])
    averageHeartRate = page.numberValue(
      named: "average-heart-rate", preferredOwners: [WorkoutModule.Tag.workout])
    healthKitState =
      page.stringValue(
        named: "healthkit-export-state", preferredOwners: [WorkoutModule.Tag.workout])
      ?? "unavailable"
    routeState =
      page.stringValue(named: "route-state", preferredOwners: [WorkoutModule.Tag.workout])
      ?? "unavailable"
    exerciseCount = page.numberValue(
      named: "exercise-count", preferredOwners: [WorkoutModule.Tag.strength])
    setCount = page.numberValue(named: "set-count", preferredOwners: [WorkoutModule.Tag.strength])
    totalVolumeKilograms = page.numberValue(
      named: "total-volume-kilograms", preferredOwners: [WorkoutModule.Tag.strength])
    distanceMeters = page.numberValue(
      named: "distance-meters", preferredOwners: [WorkoutModule.Tag.cardio])
    averagePaceSecondsPerKilometre = page.numberValue(
      named: "average-pace-seconds-per-kilometre", preferredOwners: [WorkoutModule.Tag.cardio])
  }

  var id: PageID { page.id }

  var durationText: String {
    guard let durationSeconds else { return "—" }
    return Duration.seconds(durationSeconds).formatted(.time(pattern: .hourMinuteSecond))
  }

  var energyText: String? {
    energyKilocalories.map { "\($0.formatted(.number.precision(.fractionLength(0)))) kcal" }
  }

  var heartRateText: String? {
    averageHeartRate.map { "\($0.formatted(.number.precision(.fractionLength(0)))) bpm" }
  }

  var strengthDetail: String? {
    guard kind == .strength else { return nil }
    var values: [String] = []
    if let exerciseCount {
      values.append("\(exerciseCount.formatted(.number.precision(.fractionLength(0)))) exercises")
    }
    if let setCount {
      values.append("\(setCount.formatted(.number.precision(.fractionLength(0)))) sets")
    }
    if let totalVolumeKilograms {
      values.append(
        "\(totalVolumeKilograms.formatted(.number.precision(.fractionLength(0)))) kg volume")
    }
    return values.isEmpty ? nil : values.joined(separator: " · ")
  }

  var cardioDetail: String? {
    guard kind == .cardio else { return nil }
    var values: [String] = []
    if let distanceMeters {
      values.append(
        "\((distanceMeters / 1_000).formatted(.number.precision(.fractionLength(2)))) km")
    }
    if let pace = averagePaceSecondsPerKilometre, pace > 0 {
      values.append("\(Duration.seconds(pace).formatted(.time(pattern: .minuteSecond))) / km")
    }
    return values.isEmpty ? nil : values.joined(separator: " · ")
  }

  var accessibilitySummary: String {
    let details = [durationText, strengthDetail ?? cardioDetail, energyText, heartRateText]
      .compactMap { $0 }
      .joined(separator: ", ")
    return
      "\(title), \(kind == .strength ? "strength" : "cardio") workout, \(details), status \(status)"
  }
}

extension PageSnapshot {
  fileprivate func numberValue(named name: String, preferredOwners: [SupertagID]) -> Double? {
    value(named: name, preferredOwners: preferredOwners).flatMap {
      if case .number(let number) = $0 { return number }
      return nil
    }
  }

  fileprivate func dateValue(named name: String, preferredOwners: [SupertagID]) -> Date? {
    value(named: name, preferredOwners: preferredOwners).flatMap {
      switch $0 {
      case .date(let value), .dateTime(let value): value
      default: nil
      }
    }
  }

  fileprivate func stringValue(named name: String, preferredOwners: [SupertagID]) -> String? {
    value(named: name, preferredOwners: preferredOwners).flatMap {
      switch $0 {
      case .text(let value), .select(let value): value
      default: nil
      }
    }
  }

  private func value(named name: String, preferredOwners: [SupertagID]) -> SupertagValue? {
    let fieldID = SupertagFieldID(rawValue: name)
    for owner in preferredOwners {
      if let value = objectMetadata.properties[.init(supertagID: owner, fieldID: fieldID)]?.first {
        return value
      }
    }
    return objectMetadata.properties.first(where: { $0.key.fieldID == fieldID })?.value.first
  }
}
