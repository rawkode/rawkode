import CryptoKit
import Foundation

/// Foundation-only contract used by the Watch outbox and the iPhone importer.
public enum EnchiridionWorkoutTransport {
  public static let moduleID = "dev.rawkode.enchiridion.workouts"
  public static let version = 1
}

public enum WorkoutActivity: String, Codable, CaseIterable, Sendable {
  case strengthTraining, outdoorRun, indoorRun, outdoorCycle, indoorCycle, outdoorWalk, hiking, other
}

public enum WorkoutCaptureStatus: String, Codable, Sendable { case complete, partial }
public enum WorkoutHealthKitExportState: String, Codable, Sendable { case saved, notAuthorized, revoked, failed, notRequested, unavailable }
public enum WorkoutRouteState: String, Codable, Sendable { case saved, notRequested, unavailable, failed }

public struct WorkoutSetPayload: Codable, Hashable, Sendable {
  public let ordinal: Int
  public let repetitions: Int
  public let loadKilograms: Double
  public let rpe: Double?
  public let completedAt: Date?
  public init(ordinal: Int, repetitions: Int, loadKilograms: Double, rpe: Double? = nil, completedAt: Date? = nil) {
    self.ordinal = ordinal; self.repetitions = repetitions; self.loadKilograms = loadKilograms; self.rpe = rpe; self.completedAt = completedAt
  }
}

public struct WorkoutExercisePayload: Codable, Hashable, Sendable {
  public let ordinal: Int
  public let name: String
  public let sets: [WorkoutSetPayload]
  public init(ordinal: Int, name: String, sets: [WorkoutSetPayload]) { self.ordinal = ordinal; self.name = name; self.sets = sets }
}

public struct WorkoutSplitPayload: Codable, Hashable, Sendable {
  public let ordinal: Int
  public let distanceMeters: Double
  public let durationSeconds: Double
  public let averageHeartRate: Double?
  public let energyKilocalories: Double?
  public init(ordinal: Int, distanceMeters: Double, durationSeconds: Double, averageHeartRate: Double? = nil, energyKilocalories: Double? = nil) {
    self.ordinal = ordinal; self.distanceMeters = distanceMeters; self.durationSeconds = durationSeconds; self.averageHeartRate = averageHeartRate; self.energyKilocalories = energyKilocalories
  }
}

public enum WorkoutPayload: Codable, Hashable, Sendable {
  case strength(exercises: [WorkoutExercisePayload])
  case cardio(splits: [WorkoutSplitPayload], distanceMeters: Double?, elevationMeters: Double?, averageSpeedMetersPerSecond: Double?, averagePaceSecondsPerKilometre: Double?)
  private enum CodingKeys: String, CodingKey { case kind, exercises, splits, distanceMeters, elevationMeters, averageSpeedMetersPerSecond, averagePaceSecondsPerKilometre }
  private enum Kind: String, Codable { case strength, cardio }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    switch try c.decode(Kind.self, forKey: .kind) {
    case .strength: self = .strength(exercises: try c.decode([WorkoutExercisePayload].self, forKey: .exercises))
    case .cardio: self = .cardio(splits: try c.decode([WorkoutSplitPayload].self, forKey: .splits), distanceMeters: try c.decodeIfPresent(Double.self, forKey: .distanceMeters), elevationMeters: try c.decodeIfPresent(Double.self, forKey: .elevationMeters), averageSpeedMetersPerSecond: try c.decodeIfPresent(Double.self, forKey: .averageSpeedMetersPerSecond), averagePaceSecondsPerKilometre: try c.decodeIfPresent(Double.self, forKey: .averagePaceSecondsPerKilometre))
    }
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .strength(exercises): try c.encode(Kind.strength, forKey: .kind); try c.encode(exercises, forKey: .exercises)
    case let .cardio(splits, distance, elevation, speed, pace): try c.encode(Kind.cardio, forKey: .kind); try c.encode(splits, forKey: .splits); try c.encodeIfPresent(distance, forKey: .distanceMeters); try c.encodeIfPresent(elevation, forKey: .elevationMeters); try c.encodeIfPresent(speed, forKey: .averageSpeedMetersPerSecond); try c.encodeIfPresent(pace, forKey: .averagePaceSecondsPerKilometre)
    }
  }
}

public struct WorkoutCaptureEnvelope: Codable, Hashable, Sendable {
  public let moduleID: String
  public let version: Int
  public let eventID: String
  public let payloadHash: String
  public let startedAt: Date
  public let completedAt: Date
  public let activity: WorkoutActivity
  public let rawActivity: String?
  public let status: WorkoutCaptureStatus
  public let durationSeconds: Double
  public let energyKilocalories: Double?
  public let averageHeartRate: Double?
  public let maximumHeartRate: Double?
  public let source: String
  public let healthKitExportState: WorkoutHealthKitExportState
  /// Stable sanitized category only; never an OS error string containing diagnostics.
  public let healthKitExportErrorCategory: String?
  public let healthKitWorkoutUUID: String?
  public let routeState: WorkoutRouteState
  public let payload: WorkoutPayload
  public init(eventID: String, startedAt: Date, completedAt: Date, activity: WorkoutActivity, rawActivity: String? = nil, status: WorkoutCaptureStatus, durationSeconds: Double, energyKilocalories: Double? = nil, averageHeartRate: Double? = nil, maximumHeartRate: Double? = nil, source: String = "watch", healthKitExportState: WorkoutHealthKitExportState = .notRequested, healthKitExportErrorCategory: String? = nil, healthKitWorkoutUUID: String? = nil, routeState: WorkoutRouteState = .notRequested, payload: WorkoutPayload, moduleID: String = EnchiridionWorkoutTransport.moduleID, version: Int = EnchiridionWorkoutTransport.version) {
    self.moduleID = moduleID; self.version = version; self.eventID = eventID; self.startedAt = startedAt; self.completedAt = completedAt; self.activity = activity; self.rawActivity = rawActivity; self.status = status; self.durationSeconds = durationSeconds; self.energyKilocalories = energyKilocalories; self.averageHeartRate = averageHeartRate; self.maximumHeartRate = maximumHeartRate; self.source = source; self.healthKitExportState = healthKitExportState; self.healthKitExportErrorCategory = healthKitExportErrorCategory; self.healthKitWorkoutUUID = healthKitWorkoutUUID; self.routeState = routeState; self.payload = payload
    self.payloadHash = Self.hash(eventID: eventID, startedAt: startedAt, completedAt: completedAt, activity: activity, rawActivity: rawActivity, status: status, durationSeconds: durationSeconds, energyKilocalories: energyKilocalories, averageHeartRate: averageHeartRate, maximumHeartRate: maximumHeartRate, source: source, healthKitExportState: healthKitExportState, healthKitExportErrorCategory: healthKitExportErrorCategory, healthKitWorkoutUUID: healthKitWorkoutUUID, routeState: routeState, payload: payload, moduleID: moduleID, version: version)
  }
  public func isAuthentic() -> Bool { payloadHash == Self.hash(eventID: eventID, startedAt: startedAt, completedAt: completedAt, activity: activity, rawActivity: rawActivity, status: status, durationSeconds: durationSeconds, energyKilocalories: energyKilocalories, averageHeartRate: averageHeartRate, maximumHeartRate: maximumHeartRate, source: source, healthKitExportState: healthKitExportState, healthKitExportErrorCategory: healthKitExportErrorCategory, healthKitWorkoutUUID: healthKitWorkoutUUID, routeState: routeState, payload: payload, moduleID: moduleID, version: version) }
  private static func hash(eventID: String, startedAt: Date, completedAt: Date, activity: WorkoutActivity, rawActivity: String?, status: WorkoutCaptureStatus, durationSeconds: Double, energyKilocalories: Double?, averageHeartRate: Double?, maximumHeartRate: Double?, source: String, healthKitExportState: WorkoutHealthKitExportState, healthKitExportErrorCategory: String?, healthKitWorkoutUUID: String?, routeState: WorkoutRouteState, payload: WorkoutPayload, moduleID: String, version: Int) -> String {
    struct Semantic: Codable { let moduleID: String; let version: Int; let eventID: String; let startedAt: Date; let completedAt: Date; let activity: WorkoutActivity; let rawActivity: String?; let status: WorkoutCaptureStatus; let durationSeconds: Double; let energyKilocalories: Double?; let averageHeartRate: Double?; let maximumHeartRate: Double?; let source: String; let healthKitExportState: WorkoutHealthKitExportState; let healthKitExportErrorCategory: String?; let healthKitWorkoutUUID: String?; let routeState: WorkoutRouteState; let payload: WorkoutPayload }
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]; encoder.dateEncodingStrategy = .millisecondsSince1970
    let data = (try? encoder.encode(Semantic(moduleID: moduleID, version: version, eventID: eventID, startedAt: startedAt, completedAt: completedAt, activity: activity, rawActivity: rawActivity, status: status, durationSeconds: durationSeconds, energyKilocalories: energyKilocalories, averageHeartRate: averageHeartRate, maximumHeartRate: maximumHeartRate, source: source, healthKitExportState: healthKitExportState, healthKitExportErrorCategory: healthKitExportErrorCategory, healthKitWorkoutUUID: healthKitWorkoutUUID, routeState: routeState, payload: payload))) ?? Data()
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

public struct WorkoutImportAcknowledgement: Codable, Hashable, Sendable {
  public let moduleID: String
  public let eventID: String
  public let payloadHash: String
  public init(moduleID: String, eventID: String, payloadHash: String) { self.moduleID = moduleID; self.eventID = eventID; self.payloadHash = payloadHash }
  public init(_ envelope: WorkoutCaptureEnvelope) { self.init(moduleID: envelope.moduleID, eventID: envelope.eventID, payloadHash: envelope.payloadHash) }
}
