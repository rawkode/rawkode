import EnchiridionWorkoutTransport
import SwiftUI

@main
struct WatchWorkoutApp: App {
  static let sharedCaptureStore = WatchWorkoutCaptureStore()
  init() { WatchConnectivityTransfer.responseHandler = { Self.sharedCaptureStore.receive($0) } }
  var body: some Scene {
    WindowGroup {
      WatchWorkoutRootView(store: Self.sharedCaptureStore).task {
        await Self.sharedCaptureStore.recoverSavingCheckpoint()
      }
    }
  }
}

struct WatchWorkoutRootView: View {
  @Bindable var store: WatchWorkoutCaptureStore
  var body: some View {
    NavigationStack {
      Group {
        if let checkpoint = store.checkpoint {
          WatchWorkoutCaptureView(store: store, checkpoint: checkpoint)
        } else if let item = store.quarantined.first {
          WatchWorkoutQuarantineView(store: store, item: item)
        } else {
          List {
            if let message = store.validationMessage { Text(message).foregroundStyle(.secondary) }
            Button("Strength", systemImage: "dumbbell") { store.beginStrength() }.disabled(
              store.persistenceBlocked)
            Button("Cardio", systemImage: "figure.run") { store.beginCardio() }.disabled(
              store.persistenceBlocked)
            if store.pendingCount > 0 {
              Label(
                "\(store.pendingCount) waiting to transfer", systemImage: "iphone.and.arrow.forward"
              )
            }
          }.navigationTitle("Workout")
        }
      }
    }
  }
}
private struct WatchWorkoutCaptureView: View {
  @Bindable var store: WatchWorkoutCaptureStore
  let checkpoint: WatchWorkoutCaptureStore.Checkpoint
  var body: some View {
    List {
      Text(checkpoint.phase == .interrupted ? "Workout interrupted" : "Recording").font(.headline)
      if let message = store.validationMessage { Text(message).foregroundStyle(.secondary) }
      if checkpoint.phase == .saving {
        ProgressView("Saving workout")
      } else {
        switch checkpoint.draft {
        case .strength(let exercises): StrengthCaptureFields(store: store, exercises: exercises)
        case .cardio(let draft): CardioCaptureFields(store: store, draft: draft)
        }
      }
      if checkpoint.phase == .interrupted {
        Button("Resume") { store.resume() }
        Button("Save Partial") { Task { await store.save(status: .partial) } }
        Button("Discard", role: .destructive) { store.cancel() }
      } else if checkpoint.phase != .saving {
        Button("Finish") { Task { await store.save(status: .complete) } }
        Button("Cancel", role: .destructive) { store.cancel() }
      }
    }.navigationTitle("Capture")
  }
}
private struct StrengthCaptureFields: View {
  @Bindable var store: WatchWorkoutCaptureStore
  let exercises: [WatchWorkoutCaptureStore.StrengthExercise]
  var body: some View {
    ForEach(exercises) { exercise in
      Section(exercise.name) {
        TextField(
          "Exercise",
          text: Binding(
            get: { exercise.name }, set: { store.updateExerciseName(exercise.id, name: $0) }))
        ForEach(exercise.sets) { set in
          HStack {
            Text("\(set.repetitions) reps").font(.footnote)
            Text(String(format: "%.1f kg", set.loadKilograms)).font(.footnote)
            Spacer()
            Button(set.completedAt == nil ? "Done" : "✓") {
              store.completeSet(exerciseID: exercise.id, setID: set.id)
            }
          }
          HStack {
            Button("− rep") {
              store.adjustSet(
                exerciseID: exercise.id, setID: set.id, repetitions: set.repetitions - 1)
            }
            Button("+ rep") {
              store.adjustSet(
                exerciseID: exercise.id, setID: set.id, repetitions: set.repetitions + 1)
            }
            Button("+ kg") {
              store.adjustSet(
                exerciseID: exercise.id, setID: set.id, loadKilograms: set.loadKilograms + 2.5)
            }
          }
          Button("Set RPE") {
            store.adjustSet(
              exerciseID: exercise.id, setID: set.id, rpe: .some(min(10, (set.rpe ?? 0) + 1)))
          }
          Button("Add set") { store.addSet(exerciseID: exercise.id) }
          Button("Remove exercise", role: .destructive) { store.removeExercise(exercise.id) }
        }
      }
    }
    Button("Add exercise") { store.addExercise() }
  }
}
private struct CardioCaptureFields: View {
  @Bindable var store: WatchWorkoutCaptureStore
  let draft: WatchWorkoutCaptureStore.CardioDraft
  private let activities: [WorkoutActivity] = [
    .outdoorRun, .indoorRun, .outdoorCycle, .indoorCycle, .outdoorWalk, .hiking, .other,
  ]
  var body: some View {
    Picker(
      "Activity",
      selection: Binding(get: { draft.activity }, set: { store.updateCardio(activity: $0) })
    ) { ForEach(activities, id: \.self) { Text($0.rawValue) } }
    ForEach(draft.splits, id: \.ordinal) { split in
      HStack {
        Text("km \(split.ordinal)")
        Spacer()
        Button("+ 30s") {
          store.adjustSplit(split.ordinal, durationSeconds: split.durationSeconds + 30)
        }
        Text("\(Int(split.durationSeconds))s")
      }
    }
    Button("Add kilometre split") { store.addKilometreSplit() }
  }
}
private struct WatchWorkoutQuarantineView: View {
  @Bindable var store: WatchWorkoutCaptureStore
  let item: WatchWorkoutCaptureStore.Quarantine
  var body: some View {
    List {
      Text("Needs attention")
      Text(item.reason).font(.footnote)
      Button("Keep for Support Export") { _ = store.supportExport(item) }
      Button("Discard Capture", role: .destructive) { store.discardQuarantine(item) }
    }.navigationTitle("Capture")
  }
}
