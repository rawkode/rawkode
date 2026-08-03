import EnchiridionWorkoutTransport
import Foundation
import Observation

@MainActor
@Observable
final class WatchWorkoutCaptureStore {
  enum Phase: String, Codable { case idle, recording, interrupted, saving, quarantined }
  struct StrengthSet: Codable, Identifiable {
    var id = UUID()
    var repetitions = 5
    var loadKilograms = 0.0
    var rpe: Double?
    var completedAt: Date?
  }
  struct StrengthExercise: Codable, Identifiable {
    var id = UUID()
    var name = "Exercise"
    var sets: [StrengthSet] = [StrengthSet()]
  }
  struct CardioDraft: Codable {
    var activity: WorkoutActivity = .outdoorRun
    var distanceMeters: Double?
    var elevationMeters: Double?
    var energyKilocalories: Double?
    var averageHeartRate: Double?
    var maximumHeartRate: Double?
    var splits: [WorkoutSplitPayload] = []
  }
  enum Draft: Codable {
    case strength([StrengthExercise])
    case cardio(CardioDraft)
    private enum Keys: String, CodingKey { case kind, exercises, cardio }
    private enum Kind: String, Codable { case strength, cardio }
    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: Keys.self)
      switch try c.decode(Kind.self, forKey: .kind) {
      case .strength: self = .strength(try c.decode([StrengthExercise].self, forKey: .exercises))
      case .cardio: self = .cardio(try c.decode(CardioDraft.self, forKey: .cardio))
      }
    }
    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: Keys.self)
      switch self {
      case .strength(let value):
        try c.encode(Kind.strength, forKey: .kind)
        try c.encode(value, forKey: .exercises)
      case .cardio(let value):
        try c.encode(Kind.cardio, forKey: .kind)
        try c.encode(value, forKey: .cardio)
      }
    }
  }
  struct Checkpoint: Codable {
    var eventID: UUID
    var startedAt: Date
    var phase: Phase
    var draft: Draft
    var completedAt: Date?
    var requestedStatus: WorkoutCaptureStatus?
  }
  struct Quarantine: Codable, Identifiable {
    var id: UUID { UUID(uuidString: envelope.eventID) ?? UUID() }
    var envelope: WorkoutCaptureEnvelope
    var reason: String
  }
  struct Persisted: Codable {
    var checkpoint: Checkpoint?
    var outbox: [WorkoutCaptureEnvelope]
    var quarantined: [Quarantine]
    var acknowledgementObservations: [WorkoutImportAcknowledgement]
  }
  private let persistence: WatchWorkoutPersistence
  private let healthKit: any WatchWorkoutHealthKitExporting
  private let transfer: any WatchWorkoutTransferring
  private var state = Persisted(
    checkpoint: nil, outbox: [], quarantined: [], acknowledgementObservations: [])
  private(set) var phase: Phase = .idle
  private(set) var validationMessage: String?
  private(set) var persistenceBlocked = false
  init(
    persistence: WatchWorkoutPersistence = .applicationSupport(),
    healthKit: any WatchWorkoutHealthKitExporting = WatchHealthKitExportService(),
    transfer: any WatchWorkoutTransferring = WatchConnectivityTransfer()
  ) {
    self.persistence = persistence
    self.healthKit = healthKit
    self.transfer = transfer
    reload()
  }
  var checkpoint: Checkpoint? { state.checkpoint }
  var pendingCount: Int { state.outbox.count }
  var quarantined: [Quarantine] { state.quarantined }
  func beginStrength() {
    begin(draft: .strength([StrengthExercise()]), activity: .strengthTraining)
  }
  func beginCardio(activity: WorkoutActivity = .outdoorRun) {
    begin(draft: .cardio(CardioDraft(activity: activity)), activity: activity)
  }
  func addExercise() {
    guard var checkpoint = state.checkpoint, case .strength(var exercises) = checkpoint.draft else {
      return
    }
    exercises.append(StrengthExercise())
    checkpoint.draft = .strength(exercises)
    state.checkpoint = checkpoint
    persist()
  }
  func removeExercise(_ id: UUID) {
    guard var checkpoint = state.checkpoint, case .strength(var exercises) = checkpoint.draft else {
      return
    }
    exercises.removeAll { $0.id == id }
    checkpoint.draft = .strength(exercises)
    state.checkpoint = checkpoint
    persist()
  }
  func updateExerciseName(_ id: UUID, name: String) {
    guard var checkpoint = state.checkpoint, case .strength(var exercises) = checkpoint.draft,
      let index = exercises.firstIndex(where: { $0.id == id })
    else { return }
    exercises[index].name = name
    checkpoint.draft = .strength(exercises)
    state.checkpoint = checkpoint
    persist()
  }
  func addSet(exerciseID: UUID) {
    guard var checkpoint = state.checkpoint, case .strength(var exercises) = checkpoint.draft,
      let index = exercises.firstIndex(where: { $0.id == exerciseID })
    else { return }
    exercises[index].sets.append(StrengthSet())
    checkpoint.draft = .strength(exercises)
    state.checkpoint = checkpoint
    persist()
  }
  func completeSet(exerciseID: UUID, setID: UUID) {
    guard var checkpoint = state.checkpoint, case .strength(var exercises) = checkpoint.draft,
      let exercise = exercises.firstIndex(where: { $0.id == exerciseID }),
      let set = exercises[exercise].sets.firstIndex(where: { $0.id == setID })
    else { return }
    exercises[exercise].sets[set].completedAt = Date()
    checkpoint.draft = .strength(exercises)
    state.checkpoint = checkpoint
    persist()
  }
  func adjustSet(
    exerciseID: UUID, setID: UUID, repetitions: Int? = nil, loadKilograms: Double? = nil,
    rpe: Double?? = nil
  ) {
    guard var checkpoint = state.checkpoint, case .strength(var exercises) = checkpoint.draft,
      let exercise = exercises.firstIndex(where: { $0.id == exerciseID }),
      let set = exercises[exercise].sets.firstIndex(where: { $0.id == setID })
    else { return }
    if let repetitions { exercises[exercise].sets[set].repetitions = max(0, repetitions) }
    if let loadKilograms { exercises[exercise].sets[set].loadKilograms = max(0, loadKilograms) }
    if let rpe { exercises[exercise].sets[set].rpe = rpe }
    checkpoint.draft = .strength(exercises)
    state.checkpoint = checkpoint
    persist()
  }
  func updateCardio(activity: WorkoutActivity) {
    guard var checkpoint = state.checkpoint, case .cardio(var cardio) = checkpoint.draft else {
      return
    }
    cardio.activity = activity
    checkpoint.draft = .cardio(cardio)
    state.checkpoint = checkpoint
    persist()
  }
  func addKilometreSplit() {
    guard var checkpoint = state.checkpoint, case .cardio(var cardio) = checkpoint.draft else {
      return
    }
    cardio.splits.append(
      .init(ordinal: cardio.splits.count + 1, distanceMeters: 1_000, durationSeconds: 1))
    checkpoint.draft = .cardio(cardio)
    state.checkpoint = checkpoint
    persist()
  }
  func adjustSplit(_ ordinal: Int, durationSeconds: Double) {
    guard var checkpoint = state.checkpoint, case .cardio(var cardio) = checkpoint.draft,
      let index = cardio.splits.firstIndex(where: { $0.ordinal == ordinal })
    else { return }
    let split = cardio.splits[index]
    cardio.splits[index] = .init(
      ordinal: split.ordinal, distanceMeters: split.distanceMeters,
      durationSeconds: max(1, durationSeconds), averageHeartRate: split.averageHeartRate,
      energyKilocalories: split.energyKilocalories)
    checkpoint.draft = .cardio(cardio)
    state.checkpoint = checkpoint
    persist()
  }
  private func begin(draft: Draft, activity: WorkoutActivity) {
    guard !persistenceBlocked, state.checkpoint == nil else { return }
    let checkpoint = Checkpoint(eventID: UUID(), startedAt: Date(), phase: .recording, draft: draft)
    state.checkpoint = checkpoint
    phase = .recording
    guard persist() else { return }
    Task {
      await healthKit.begin(
        eventID: checkpoint.eventID, activity: activity, startedAt: checkpoint.startedAt)
    }
  }
  func markInterrupted() {
    guard var c = state.checkpoint else { return }
    c.phase = .interrupted
    state.checkpoint = c
    phase = .interrupted
    persist()
  }
  func resume() {
    guard var c = state.checkpoint else { return }
    c.phase = .recording
    state.checkpoint = c
    phase = .recording
    guard persist() else { return }
    Task {
      await healthKit.begin(
        eventID: c.eventID, activity: activity(for: c.draft), startedAt: c.startedAt)
    }
  }
  func cancel() {
    guard let checkpoint = state.checkpoint else { return }
    Task { await healthKit.cancel(eventID: checkpoint.eventID) }
    state.checkpoint = nil
    phase = .idle
    persist()
  }
  func discardQuarantine(_ item: Quarantine) {
    state.quarantined.removeAll { $0.envelope.eventID == item.envelope.eventID }
    phase = state.quarantined.isEmpty ? .idle : .quarantined
    persist()
  }
  func supportExport(_ item: Quarantine) -> Data? { try? JSONEncoder().encode(item.envelope) }
  func save(status: WorkoutCaptureStatus) async {
    guard var c = state.checkpoint else { return }
    guard validate(c.draft) else { return }
    let completedAt = Date()
    c.phase = .saving
    c.completedAt = completedAt
    c.requestedStatus = status
    state.checkpoint = c
    phase = .saving
    guard persist() else { return }
    let export = await healthKit.finishOrRecover(
      eventID: c.eventID, activity: activity(for: c.draft), startedAt: c.startedAt,
      completedAt: completedAt)
    let envelope = makeEnvelope(
      checkpoint: c, completedAt: completedAt, status: status, export: export)
    state.outbox.append(envelope)
    guard persist() else { return }
    state.checkpoint = nil
    phase = .idle
    guard persist() else { return }
    transferPending()
  }
  func recoverSavingCheckpoint() async {
    guard let c = state.checkpoint, c.phase == .saving, let completedAt = c.completedAt,
      let status = c.requestedStatus
    else { return }
    let export = await healthKit.recover(eventID: c.eventID)
    let envelope = makeEnvelope(
      checkpoint: c, completedAt: completedAt, status: status, export: export)
    if !state.outbox.contains(where: { $0.eventID == envelope.eventID }) {
      state.outbox.append(envelope)
    }
    state.checkpoint = nil
    phase = .idle
    guard persist() else { return }
    transferPending()
  }
  func receiveAcknowledgement(_ acknowledgement: WorkoutImportAcknowledgement) {
    guard acknowledgement.moduleID == EnchiridionWorkoutTransport.moduleID,
      let item = state.outbox.first(where: {
        $0.eventID == acknowledgement.eventID && $0.payloadHash == acknowledgement.payloadHash
      })
    else { return }
    state.outbox.removeAll { $0.eventID == item.eventID && $0.payloadHash == item.payloadHash }
    state.acknowledgementObservations.append(acknowledgement)
    guard persist() else { return }
    transferPending()
  }
  func receive(_ response: WorkoutDeliveryResponse) {
    switch response.disposition {
    case .imported, .duplicate: receiveAcknowledgement(response.acknowledgement)
    case .conflict:
      receiveConflict(response.acknowledgement, reason: "Phone reported an identity conflict")
    }
  }
  func receiveConflict(_ acknowledgement: WorkoutImportAcknowledgement, reason: String) {
    guard acknowledgement.moduleID == EnchiridionWorkoutTransport.moduleID,
      let item = state.outbox.first(where: {
        $0.eventID == acknowledgement.eventID && $0.payloadHash == acknowledgement.payloadHash
      })
    else { return }
    state.outbox.removeAll { $0.eventID == item.eventID && $0.payloadHash == item.payloadHash }
    state.quarantined.append(Quarantine(envelope: item, reason: reason))
    state.acknowledgementObservations.append(acknowledgement)
    phase = .quarantined
    guard persist() else { return }
    transferPending()
  }
  func transferPending() {
    for item in state.outbox { _ = transfer.enqueueEnvelope(item) }
    let observed = state.acknowledgementObservations.filter {
      transfer.enqueueAcknowledgementObserved($0)
    }
    guard !observed.isEmpty else { return }
    state.acknowledgementObservations.removeAll { observed.contains($0) }
    _ = persist()
  }
  private func reload() {
    do { state = try persistence.load() ?? state } catch {
      persistenceBlocked = true
      validationMessage =
        "Workout recovery data could not be read. Keep this capture for support before recording another workout."
      return
    }
    if var checkpoint = state.checkpoint, checkpoint.phase == .recording {
      checkpoint.phase = .interrupted
      state.checkpoint = checkpoint
      _ = persist()
    }
    phase = state.checkpoint?.phase ?? (state.quarantined.isEmpty ? .idle : .quarantined)
    transferPending()
  }
  @discardableResult private func persist() -> Bool {
    do {
      try persistence.save(state)
      return true
    } catch {
      validationMessage = "Could not save workout capture."
      return false
    }
  }
  private func validate(_ draft: Draft) -> Bool {
    switch draft {
    case .strength(let exercises):
      let valid =
        !exercises.isEmpty
        && exercises.allSatisfy {
          !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !$0.sets.isEmpty
            && $0.sets.allSatisfy {
              $0.repetitions >= 0 && $0.loadKilograms >= 0
                && ($0.rpe == nil || (1...10).contains($0.rpe!))
            }
        }
      validationMessage = valid ? nil : "Add a named exercise and valid sets before saving."
      return valid
    case .cardio(let cardio):
      let valid = cardio.splits.allSatisfy { $0.distanceMeters > 0 && $0.durationSeconds > 0 }
      validationMessage = valid ? nil : "Each split needs distance and duration."
      return valid
    }
  }
  private func activity(for draft: Draft) -> WorkoutActivity {
    if case .cardio(let value) = draft { return value.activity }
    return .strengthTraining
  }
  private func makeEnvelope(
    checkpoint: Checkpoint, completedAt: Date, status: WorkoutCaptureStatus,
    export: WatchWorkoutHealthKitExport
  ) -> WorkoutCaptureEnvelope {
    let duration = max(0, completedAt.timeIntervalSince(checkpoint.startedAt))
    switch checkpoint.draft {
    case .strength(let exercises):
      let payload = exercises.enumerated().map { index, exercise in
        WorkoutExercisePayload(
          ordinal: index + 1, name: exercise.name,
          sets: exercise.sets.enumerated().map { setIndex, set in
            WorkoutSetPayload(
              ordinal: setIndex + 1, repetitions: set.repetitions, loadKilograms: set.loadKilograms,
              rpe: set.rpe, completedAt: set.completedAt)
          })
      }
      return WorkoutCaptureEnvelope(
        eventID: checkpoint.eventID.uuidString, startedAt: checkpoint.startedAt,
        completedAt: completedAt, activity: .strengthTraining, status: status,
        durationSeconds: duration, healthKitExportState: export.state,
        healthKitExportErrorCategory: export.errorCategory,
        healthKitWorkoutUUID: export.workoutUUID, routeState: export.routeState,
        payload: .strength(exercises: payload))
    case .cardio(let cardio):
      return WorkoutCaptureEnvelope(
        eventID: checkpoint.eventID.uuidString, startedAt: checkpoint.startedAt,
        completedAt: completedAt, activity: cardio.activity, status: status,
        durationSeconds: duration, energyKilocalories: cardio.energyKilocalories,
        averageHeartRate: cardio.averageHeartRate, maximumHeartRate: cardio.maximumHeartRate,
        healthKitExportState: export.state, healthKitExportErrorCategory: export.errorCategory,
        healthKitWorkoutUUID: export.workoutUUID, routeState: export.routeState,
        payload: .cardio(
          splits: cardio.splits, distanceMeters: cardio.distanceMeters,
          elevationMeters: cardio.elevationMeters, averageSpeedMetersPerSecond: nil,
          averagePaceSecondsPerKilometre: nil))
    }
  }
}

struct WatchWorkoutPersistence {
  let url: URL
  static func applicationSupport() -> Self {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
      .first!
    return Self(url: base.appendingPathComponent("workout-capture-v1.json"))
  }
  func load() throws -> WatchWorkoutCaptureStore.Persisted? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(
      WatchWorkoutCaptureStore.Persisted.self, from: Data(contentsOf: url))
  }
  func save(_ value: WatchWorkoutCaptureStore.Persisted) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(value)
    try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
  }
}
