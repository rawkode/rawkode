import CryptoKit
import EnchiridionWorkoutTransport
import Foundation
import GRDB

/// The compiled, local-only declaration for Watch workout captures.
public enum WorkoutModule {
  public static let id = EnchiridionModuleID(rawValue: EnchiridionWorkoutTransport.moduleID)
  public static let namespace = ModuleNamespace(moduleID: id)
  public enum Tag {
    public static let workout = SupertagID(rawValue: "dev.rawkode.enchiridion.workouts.workout")
    public static let strength = SupertagID(
      rawValue: "dev.rawkode.enchiridion.workouts.strength-workout")
    public static let cardio = SupertagID(
      rawValue: "dev.rawkode.enchiridion.workouts.cardio-workout")
    public static let exercise = SupertagID(
      rawValue: "dev.rawkode.enchiridion.workouts.strength-exercise")
    public static let set = SupertagID(rawValue: "dev.rawkode.enchiridion.workouts.strength-set")
    public static let split = SupertagID(rawValue: "dev.rawkode.enchiridion.workouts.cardio-split")
  }
  public enum Relation {
    public static let workoutExercises = RelationID(
      rawValue: "dev.rawkode.enchiridion.workouts.workout-exercises")
    public static let exerciseSets = RelationID(
      rawValue: "dev.rawkode.enchiridion.workouts.exercise-sets")
    public static let workoutSplits = RelationID(
      rawValue: "dev.rawkode.enchiridion.workouts.workout-splits")
  }
  private static func field(_ name: String, _ title: String, _ type: SupertagFieldType)
    -> SupertagFieldDefinition
  { .init(id: .init(rawValue: name), name: title, type: type) }
  private static let common = [
    field("started-at", "Started", .dateTime), field("completed-at", "Completed", .dateTime),
    field("duration-seconds", "Duration", .number), field("activity", "Activity", .select),
    field("raw-activity", "Raw activity", .text), field("status", "Status", .select),
    field("source", "Source", .text), field("source-event-id", "Source event ID", .text),
    field("payload-hash", "Payload hash", .text),
    field("healthkit-export-state", "HealthKit export", .select),
    field("healthkit-export-error", "HealthKit error", .text),
    field("healthkit-workout-uuid", "HealthKit workout", .text),
    field("route-state", "Route", .select), field("energy-kilocalories", "Energy", .number),
    field("average-heart-rate", "Average heart rate", .number),
    field("maximum-heart-rate", "Maximum heart rate", .number),
  ]
  public static let manifest = EnchiridionModuleManifest(
    id: id, version: 1,
    supertags: [
      .init(
        id: Tag.workout, name: "Workout", symbol: "figure.run", fields: common, isBuiltIn: true),
      .init(
        id: Tag.strength, name: "Strength Workout", symbol: "dumbbell",
        fields: [
          field("exercise-count", "Exercises", .number), field("set-count", "Sets", .number),
          field("total-volume-kilograms", "Volume", .number),
        ], parentIDs: [Tag.workout], isBuiltIn: true),
      .init(
        id: Tag.cardio, name: "Cardio Workout", symbol: "heart",
        fields: [
          field("distance-meters", "Distance", .number),
          field("elevation-meters", "Elevation", .number),
          field("average-speed-meters-per-second", "Average speed", .number),
          field("average-pace-seconds-per-kilometre", "Average pace", .number),
          field("split-count", "Splits", .number),
        ], parentIDs: [Tag.workout], isBuiltIn: true),
      .init(
        id: Tag.exercise, name: "Strength Exercise", symbol: "figure.strengthtraining.traditional",
        fields: [
          field("ordinal", "Order", .number), field("set-count", "Sets", .number),
          field("volume-kilograms", "Volume", .number),
        ], isBuiltIn: true),
      .init(
        id: Tag.set, name: "Strength Set", symbol: "number",
        fields: [
          field("ordinal", "Order", .number), field("repetitions", "Repetitions", .number),
          field("load-kilograms", "Load", .number), field("volume-kilograms", "Volume", .number),
          field("rpe", "RPE", .number), field("completed-at", "Completed", .dateTime),
        ], isBuiltIn: true),
      .init(
        id: Tag.split, name: "Cardio Split", symbol: "timer",
        fields: [
          field("ordinal", "Order", .number), field("distance-meters", "Distance", .number),
          field("duration-seconds", "Duration", .number),
          field("pace-seconds-per-kilometre", "Pace", .number),
          field("average-heart-rate", "Average heart rate", .number),
          field("energy-kilocalories", "Energy", .number),
        ], isBuiltIn: true),
    ],
    relations: [
      .init(
        id: Relation.workoutExercises, sourceTagIDs: [Tag.strength], targetTagIDs: [Tag.exercise],
        forwardName: "exercises", inverseName: "workout", cardinality: .oneToMany, isSystem: true),
      .init(
        id: Relation.exerciseSets, sourceTagIDs: [Tag.exercise], targetTagIDs: [Tag.set],
        forwardName: "sets", inverseName: "exercise", cardinality: .oneToMany, isSystem: true),
      .init(
        id: Relation.workoutSplits, sourceTagIDs: [Tag.cardio], targetTagIDs: [Tag.split],
        forwardName: "splits", inverseName: "workout", cardinality: .oneToMany, isSystem: true),
    ],
    projections: [
      .init(
        id: "dev.rawkode.enchiridion.workouts.projection.workouts.v1",
        viewName: "graph_workouts_v1", version: 1, statement: "SELECT * FROM graph_workouts_v1"),
      .init(
        id: "dev.rawkode.enchiridion.workouts.projection.exercises.v1",
        viewName: "graph_workout_exercises_v1", version: 1,
        statement: "SELECT * FROM graph_workout_exercises_v1"),
      .init(
        id: "dev.rawkode.enchiridion.workouts.projection.sets.v1",
        viewName: "graph_workout_sets_v1", version: 1,
        statement: "SELECT * FROM graph_workout_sets_v1"),
      .init(
        id: "dev.rawkode.enchiridion.workouts.projection.splits.v1",
        viewName: "graph_workout_splits_v1", version: 1,
        statement: "SELECT * FROM graph_workout_splits_v1"),
    ],
    viewTypes: [.init(id: .init(rawValue: "dev.rawkode.enchiridion.workouts.summary"))]
  )
}

public enum WorkoutImportResult: Hashable, Sendable {
  case imported(rootID: PageID, acknowledgement: WorkoutImportAcknowledgement)
  case duplicate(rootID: PageID, acknowledgement: WorkoutImportAcknowledgement)
  case conflict
}

/// The only graph fact probe used by catalog-route recovery. It never exposes
/// general page reads to background Watch delivery.
public enum WorkoutCaptureProvenance: Hashable, Sendable {
  case absent
  case matching
  case conflicting
}

public struct WorkoutSummaryRow: Hashable, Sendable, Identifiable {
  public let id: PageID
  public let title: String
  public let activity: String
  public let startedAt: Date
  public let durationSeconds: Double
  public let status: String
}

extension LibraryRepository {
  /// Installs the compiled declaration and imports one Watch outbox envelope atomically.
  @discardableResult public func importWorkout(
    _ envelope: WorkoutCaptureEnvelope, registry: ModuleRegistry, now: Date = Date()
  ) throws -> WorkoutImportResult {
    guard envelope.moduleID == WorkoutModule.id.rawValue,
      envelope.version == EnchiridionWorkoutTransport.version, envelope.isAuthentic(),
      let capability = registry.writeCapability(for: WorkoutModule.id)
    else { throw LibraryRepositoryError.invalidRecord }
    try reconcileModule(WorkoutModule.manifest, using: capability)
    try Self.validate(envelope)
    return try database.write { db in
      if let row = try Row.fetchOne(
        db,
        sql:
          "SELECT payload_hash, root_page_id FROM workout_import_receipts WHERE module_id = ? AND event_id = ?",
        arguments: [envelope.moduleID, envelope.eventID])
      {
        let hash: String = row["payload_hash"] ?? ""
        if hash == envelope.payloadHash {
          return .duplicate(
            rootID: .init(
              rawValue: row["root_page_id"] ?? Self.workoutID(envelope, "workout", 0).rawValue),
            acknowledgement: .init(envelope))
        }
        try db.execute(
          sql:
            "INSERT OR IGNORE INTO workout_import_quarantine (module_id,event_id,payload_hash,reason,received_at) VALUES (?,?,?,?,?)",
          arguments: [
            envelope.moduleID, envelope.eventID, envelope.payloadHash, "event-id hash conflict",
            now.timeIntervalSince1970,
          ])
        return .conflict
      }
      let rootID = Self.workoutID(envelope, "workout", 0)
      // Receipts are an optimisation, not the identity authority. A durable page lets a
      // restarted importer recover safely after a receipt is lost without overwriting edits.
      if let existingHash: String = try Row.fetchOne(
        db,
        sql:
          "SELECT text_value FROM _graph_facts WHERE node_id = ? AND field_id = 'payload-hash' LIMIT 1",
        arguments: [rootID.rawValue])?["text_value"]
      {
        if existingHash == envelope.payloadHash {
          try db.execute(
            sql:
              "INSERT INTO workout_import_receipts (module_id,event_id,payload_hash,root_page_id,imported_at) VALUES (?,?,?,?,?)",
            arguments: [
              envelope.moduleID, envelope.eventID, envelope.payloadHash, rootID.rawValue,
              now.timeIntervalSince1970,
            ])
          return .duplicate(rootID: rootID, acknowledgement: .init(envelope))
        }
        try db.execute(
          sql:
            "INSERT OR IGNORE INTO workout_import_quarantine (module_id,event_id,payload_hash,reason,received_at) VALUES (?,?,?,?,?)",
          arguments: [
            envelope.moduleID, envelope.eventID, envelope.payloadHash, "event-id hash conflict",
            now.timeIntervalSince1970,
          ])
        return .conflict
      }
      let rootTag: SupertagID = {
        if case .strength = envelope.payload { return WorkoutModule.Tag.strength }
        return WorkoutModule.Tag.cardio
      }()
      let rootProperties = Self.rootProperties(envelope, tag: rootTag)
      _ = try Self.createWorkoutPage(
        db, id: rootID, title: Self.title(envelope), tag: rootTag, properties: rootProperties,
        now: now)
      switch envelope.payload {
      case .strength(let exercises):
        for exercise in exercises {
          let exerciseID = Self.workoutID(envelope, "exercise", exercise.ordinal)
          let volume = exercise.sets.reduce(0) { $0 + Double($1.repetitions) * $1.loadKilograms }
          _ = try Self.createWorkoutPage(
            db, id: exerciseID, title: exercise.name, tag: WorkoutModule.Tag.exercise,
            properties: Self.props(
              WorkoutModule.Tag.exercise,
              [
                "ordinal": .number(Double(exercise.ordinal)),
                "set-count": .number(Double(exercise.sets.count)),
                "volume-kilograms": .number(volume),
              ]), now: now)
          _ = try Self.createEdge(
            in: db, relationID: WorkoutModule.Relation.workoutExercises, from: rootID,
            to: exerciseID, origin: .provider, now: now)
          for set in exercise.sets {
            let setID = Self.workoutID(envelope, "set:\(exercise.ordinal)", set.ordinal)
            var values: [String: SupertagValue] = [
              "ordinal": .number(Double(set.ordinal)),
              "repetitions": .number(Double(set.repetitions)),
              "load-kilograms": .number(set.loadKilograms),
              "volume-kilograms": .number(Double(set.repetitions) * set.loadKilograms),
            ]
            if let rpe = set.rpe { values["rpe"] = .number(rpe) }
            if let completed = set.completedAt { values["completed-at"] = .dateTime(completed) }
            _ = try Self.createWorkoutPage(
              db, id: setID, title: "Set \(set.ordinal)", tag: WorkoutModule.Tag.set,
              properties: Self.props(WorkoutModule.Tag.set, values), now: now)
            _ = try Self.createEdge(
              in: db, relationID: WorkoutModule.Relation.exerciseSets, from: exerciseID, to: setID,
              origin: .provider, now: now)
          }
        }
      case .cardio(let splits, _, _, _, _):
        for split in splits {
          let splitID = Self.workoutID(envelope, "split", split.ordinal)
          var values: [String: SupertagValue] = [
            "ordinal": .number(Double(split.ordinal)),
            "distance-meters": .number(split.distanceMeters),
            "duration-seconds": .number(split.durationSeconds),
          ]
          if split.distanceMeters > 0 {
            values["pace-seconds-per-kilometre"] = .number(
              split.durationSeconds / split.distanceMeters * 1000)
          }
          if let rate = split.averageHeartRate { values["average-heart-rate"] = .number(rate) }
          if let energy = split.energyKilocalories {
            values["energy-kilocalories"] = .number(energy)
          }
          _ = try Self.createWorkoutPage(
            db, id: splitID, title: "Split \(split.ordinal)", tag: WorkoutModule.Tag.split,
            properties: Self.props(WorkoutModule.Tag.split, values), now: now)
          _ = try Self.createEdge(
            in: db, relationID: WorkoutModule.Relation.workoutSplits, from: rootID, to: splitID,
            origin: .provider, now: now)
        }
      }
      // Graph projection refreshes occur while edges are installed. Reassert the ordinary
      // per-vault CloudKit intent after the complete module graph is materialized.
      try db.execute(
        sql:
          "UPDATE pages SET person_cloud_eligible = 1, cloud_dirty = 1 WHERE id IN (SELECT node_id FROM graph_node_tags WHERE tag_id LIKE ?)",
        arguments: ["\(WorkoutModule.id.rawValue).%"])
      try db.execute(
        sql:
          "INSERT INTO workout_import_receipts (module_id,event_id,payload_hash,root_page_id,imported_at) VALUES (?,?,?,?,?)",
        arguments: [
          envelope.moduleID, envelope.eventID, envelope.payloadHash, rootID.rawValue,
          now.timeIntervalSince1970,
        ])
      return .imported(rootID: rootID, acknowledgement: .init(envelope))
    }
  }

  public func workoutSummaries(limit: Int = 100) throws -> [WorkoutSummaryRow] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql:
          "SELECT workout_id,title,activity,started_at,duration_seconds,status FROM graph_workouts_v1 ORDER BY started_at DESC LIMIT ?",
        arguments: [max(1, min(limit, 500))]
      ).compactMap { row in
        guard let id: String = row["workout_id"], let title: String = row["title"],
          let activity: String = row["activity"], let started: Double = row["started_at"],
          let duration: Double = row["duration_seconds"], let status: String = row["status"]
        else { return nil }
        return .init(
          id: .init(rawValue: id), title: title, activity: activity,
          startedAt: Date(timeIntervalSince1970: started), durationSeconds: duration, status: status
        )
      }
    }
  }

  public func workoutCaptureProvenance(
    moduleID: String,
    eventID: String,
    payloadHash: String
  ) throws -> WorkoutCaptureProvenance {
    guard moduleID == WorkoutModule.id.rawValue, UUID(uuidString: eventID) != nil else {
      throw LibraryRepositoryError.invalidRecord
    }
    let rootID = Self.workoutID(moduleID: moduleID, eventID: eventID, kind: "workout", ordinal: 0)
    return try database.read { db in
      guard try Self.fetchPage(db, id: rootID) != nil else { return .absent }
      let rows = try Row.fetchAll(
        db,
        sql:
          "SELECT field_id, text_value FROM _graph_facts WHERE node_id = ? AND field_id IN ('source-event-id', 'payload-hash')",
        arguments: [rootID.rawValue]
      )
      let factPairs = rows.compactMap { row -> (String, String)? in
        guard let field: String = row["field_id"], let value: String = row["text_value"] else {
          return nil
        }
        return (field, value)
      }
      let facts = factPairs.reduce(into: [String: String]()) { result, pair in
        if let existing = result[pair.0], existing != pair.1 {
          result[pair.0] = ""
        } else {
          result[pair.0] = pair.1
        }
      }
      guard facts["source-event-id"] == eventID else { return .conflicting }
      return facts["payload-hash"] == payloadHash ? .matching : .conflicting
    }
  }

  private static func createWorkoutPage(
    _ db: Database, id: PageID, title: String, tag: SupertagID,
    properties: [SupertagPropertyKey: [SupertagValue]], now: Date
  ) throws -> PageSnapshot {
    if let page = try fetchPage(db, id: id) { return page }
    let created = try PageDocument.create(id: id, kind: .free, title: title, createdAt: now)
    var mutation = try PageDocument.addSupertag(tag, in: created.document)
    // Parent facts are not an implicit tag assignment in the document format. Tag every
    // property owner so inherited Workout queries and public projections remain correct.
    for owner in Set(properties.keys.map(\.supertagID)) where owner != tag {
      mutation = try PageDocument.addSupertag(owner, in: mutation.document)
    }
    mutation = try PageDocument.setProperties(
      properties, ensuring: tag, message: "Import workout", in: mutation.document)
    let page = PageSnapshot(
      id: id, kind: .free, title: mutation.projection.title,
      plainText: mutation.projection.plainText, document: mutation.document, heads: mutation.heads,
      createdAt: now, modifiedAt: now, dirtyGeneration: 1,
      objectMetadata: mutation.projection.objectMetadata)
    try writePage(db, page: page, cloudDirty: true)
    // Workout records are module-owned operational data, never a private Person projection.
    // Mark their ordinary page records eligible for the existing per-vault CloudKit outbox.
    try db.execute(
      sql: "UPDATE pages SET person_cloud_eligible = 1, cloud_dirty = 1 WHERE id = ?",
      arguments: [id.rawValue])
    return page
  }
  private static func props(_ tag: SupertagID, _ values: [String: SupertagValue])
    -> [SupertagPropertyKey: [SupertagValue]]
  {
    Dictionary(
      uniqueKeysWithValues: values.map {
        (.init(supertagID: tag, fieldID: .init(rawValue: $0.key)), [$0.value])
      })
  }
  private static func rootProperties(_ e: WorkoutCaptureEnvelope, tag: SupertagID)
    -> [SupertagPropertyKey: [SupertagValue]]
  {
    var values: [String: SupertagValue] = [
      "started-at": .dateTime(e.startedAt), "completed-at": .dateTime(e.completedAt),
      "duration-seconds": .number(e.durationSeconds), "activity": .select(e.activity.rawValue),
      "status": .select(e.status.rawValue), "source-event-id": .text(e.eventID),
      "payload-hash": .text(e.payloadHash),
    ]
    values["source"] = .text(e.source)
    values["healthkit-export-state"] = .select(e.healthKitExportState.rawValue)
    values["route-state"] = .select(e.routeState.rawValue)
    if let raw = e.rawActivity { values["raw-activity"] = .text(raw) }
    if let error = e.healthKitExportErrorCategory {
      values["healthkit-export-error"] = .text(error)
    }
    if let uuid = e.healthKitWorkoutUUID { values["healthkit-workout-uuid"] = .text(uuid) }
    if let energy = e.energyKilocalories { values["energy-kilocalories"] = .number(energy) }
    if let rate = e.averageHeartRate { values["average-heart-rate"] = .number(rate) }
    if let rate = e.maximumHeartRate { values["maximum-heart-rate"] = .number(rate) }
    var result = props(WorkoutModule.Tag.workout, values)
    switch e.payload {
    case .strength(let exercises):
      result.merge(
        props(
          tag,
          [
            "exercise-count": .number(Double(exercises.count)),
            "set-count": .number(Double(exercises.reduce(0) { $0 + $1.sets.count })),
            "total-volume-kilograms": .number(
              exercises.flatMap(\.sets).reduce(0) { $0 + Double($1.repetitions) * $1.loadKilograms }
            ),
          ])
      ) { _, new in new }
    case .cardio(let splits, let distance, let elevation, let speed, let pace):
      var cardio: [String: SupertagValue] = ["split-count": .number(Double(splits.count))]
      if let distance { cardio["distance-meters"] = .number(distance) }
      if let elevation { cardio["elevation-meters"] = .number(elevation) }
      if let speed { cardio["average-speed-meters-per-second"] = .number(speed) }
      if let pace { cardio["average-pace-seconds-per-kilometre"] = .number(pace) }
      result.merge(props(tag, cardio)) { _, new in new }
    }
    return result
  }
  private static func title(_ e: WorkoutCaptureEnvelope) -> String {
    "\(e.activity.rawValue.capitalized) workout"
  }
  private static func workoutID(_ e: WorkoutCaptureEnvelope, _ kind: String, _ ordinal: Int)
    -> PageID
  { workoutID(moduleID: e.moduleID, eventID: e.eventID, kind: kind, ordinal: ordinal) }
  private static func workoutID(moduleID: String, eventID: String, kind: String, ordinal: Int)
    -> PageID
  {
    let value = "workout-v1\u{0}\(moduleID)\u{0}\(eventID)\u{0}\(kind)\u{0}\(ordinal)"
    let digest = SHA256.hash(data: Data(value.utf8)).prefix(20).map { String(format: "%02x", $0) }
      .joined()
    return .init(rawValue: "workout_\(digest)")
  }
  private static func validate(_ e: WorkoutCaptureEnvelope) throws {
    let finite: (Double?) -> Bool = { $0.map { $0.isFinite && $0 >= 0 } ?? true }
    let elapsed = e.completedAt.timeIntervalSince(e.startedAt)
    guard UUID(uuidString: e.eventID) != nil, e.source == "watch",
      e.durationSeconds.isFinite && e.durationSeconds >= 0 && e.durationSeconds <= elapsed,
      e.completedAt >= e.startedAt, finite(e.energyKilocalories), finite(e.averageHeartRate),
      finite(e.maximumHeartRate),
      e.rawActivity == nil || e.activity == .other,
      e.healthKitWorkoutUUID == nil || UUID(uuidString: e.healthKitWorkoutUUID!) != nil,
      e.healthKitExportErrorCategory == nil
        || e.healthKitExportErrorCategory!.range(
          of: "^[a-z0-9-]{1,80}$", options: .regularExpression) != nil,
      e.routeState != .saved || (e.healthKitExportState == .saved && e.healthKitWorkoutUUID != nil)
    else { throw LibraryRepositoryError.invalidRecord }
    switch e.payload {
    case .strength(let exercises):
      guard e.activity == .strengthTraining, contiguous(exercises.map(\.ordinal)),
        exercises.allSatisfy({ exercise in
          !exercise.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && contiguous(exercise.sets.map(\.ordinal))
            && exercise.sets.allSatisfy { set in
              set.repetitions >= 0 && set.loadKilograms.isFinite && set.loadKilograms >= 0
                && finite(set.rpe)
                && (set.completedAt == nil
                  || (set.completedAt! >= e.startedAt && set.completedAt! <= e.completedAt))
            }
        })
      else { throw LibraryRepositoryError.invalidRecord }
      let completionTimes = exercises.flatMap(\.sets).compactMap(\.completedAt)
      guard zip(completionTimes, completionTimes.dropFirst()).allSatisfy(<=) else {
        throw LibraryRepositoryError.invalidRecord
      }
    case .cardio(let splits, let distance, let elevation, let speed, let pace):
      guard e.activity != .strengthTraining, contiguous(splits.map(\.ordinal)),
        splits.allSatisfy({
          $0.distanceMeters.isFinite && $0.distanceMeters > 0 && $0.durationSeconds.isFinite
            && $0.durationSeconds > 0 && finite($0.averageHeartRate)
            && finite($0.energyKilocalories)
        }), finite(distance), finite(elevation), finite(speed), finite(pace)
      else { throw LibraryRepositoryError.invalidRecord }
    }
  }
  private static func contiguous(_ ordinals: [Int]) -> Bool {
    ordinals.enumerated().allSatisfy { index, ordinal in ordinal == index + 1 }
  }
}
