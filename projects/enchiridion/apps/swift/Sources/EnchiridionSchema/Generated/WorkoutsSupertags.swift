// GENERATED — DO NOT EDIT BY HAND.
//
// Produced by `packages/codegen`'s `generateSwiftSchema()` (packages/codegen/src/index.ts)
// from the `dev.rawkode.enchiridion.workouts` supertag module (see `supertags/*`). Regenerate with:
//
//   bun run --cwd packages/codegen generate
//
// which writes every registered module's output into
// apps/swift/Sources/EnchiridionSchema/Generated/ (packages/codegen/scripts/generate.ts).
// See apps/swift/Sources/EnchiridionSchema/README.md and the plan's §Supertag module
// contract ("Swift learns the schema at runtime first ... The generated
// EnchiridionSchema ... is a compile-time convenience layered on top, not a
// prerequisite.").

import EnchiridionCore
import Foundation

/// Field ID constants `dev.rawkode.enchiridion.workouts.workout` (`Workout`) declares itself — does NOT include
/// inherited fields (see `WorkoutsWorkoutFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum WorkoutsWorkoutFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.workouts.workout")

  public static let activity = SupertagFieldID(rawValue: "activity")
  public static let durationMinutes = SupertagFieldID(rawValue: "duration-minutes")
  public static let startedAt = SupertagFieldID(rawValue: "started-at")
  public static let calories = SupertagFieldID(rawValue: "calories")
}

/// Select options for `dev.rawkode.enchiridion.workouts.workout`'s `activity` field (`Activity`). Case raw values are the field's stored
/// option ids exactly (slugified: lowercase, spaces -> hyphens — see
/// packages/schema/src/index.ts's `f.select()`), so this round-trips real stored data
/// unchanged.
public enum WorkoutsWorkoutActivity: String, Codable, Hashable, Sendable, CaseIterable {
  case run = "run"
  case walk = "walk"
  case cycle = "cycle"
  case swim = "swim"
  case strength = "strength"
  case other = "other"
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.workouts.workout`
/// (`Workout`) — includes Workout's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct WorkoutsWorkoutFields: Hashable, Sendable {
  public static let supertagID = WorkoutsWorkoutFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var activity: WorkoutsWorkoutActivity? {
    get { SupertagFieldStorage.readSelect(metadata, WorkoutsWorkoutFieldIDs.supertagID, WorkoutsWorkoutFieldIDs.activity) }
    set { SupertagFieldStorage.writeSelect(&metadata, WorkoutsWorkoutFieldIDs.supertagID, WorkoutsWorkoutFieldIDs.activity, newValue) }
  }

  public var durationMinutes: Double? {
    get { SupertagFieldStorage.readNumber(metadata, WorkoutsWorkoutFieldIDs.supertagID, WorkoutsWorkoutFieldIDs.durationMinutes) }
    set { SupertagFieldStorage.writeNumber(&metadata, WorkoutsWorkoutFieldIDs.supertagID, WorkoutsWorkoutFieldIDs.durationMinutes, newValue) }
  }

  public var startedAt: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, WorkoutsWorkoutFieldIDs.supertagID, WorkoutsWorkoutFieldIDs.startedAt) }
    set { SupertagFieldStorage.writeDateTime(&metadata, WorkoutsWorkoutFieldIDs.supertagID, WorkoutsWorkoutFieldIDs.startedAt, newValue) }
  }

  public var calories: Double? {
    get { SupertagFieldStorage.readNumber(metadata, WorkoutsWorkoutFieldIDs.supertagID, WorkoutsWorkoutFieldIDs.calories) }
    set { SupertagFieldStorage.writeNumber(&metadata, WorkoutsWorkoutFieldIDs.supertagID, WorkoutsWorkoutFieldIDs.calories, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.workouts.workout` (`Workout`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct WorkoutsWorkout: Codable, Hashable, Sendable {
  public var id: PageID
  public var activity: WorkoutsWorkoutActivity?
  public var durationMinutes: Double?
  public var startedAt: Date?
  public var calories: Double?

  public init(
    id: PageID,
    activity: WorkoutsWorkoutActivity? = nil,
    durationMinutes: Double? = nil,
    startedAt: Date? = nil,
    calories: Double? = nil
  ) {
    self.id = id
    self.activity = activity
    self.durationMinutes = durationMinutes
    self.startedAt = startedAt
    self.calories = calories
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case activity = "activity"
    case durationMinutes = "durationMinutes"
    case startedAt = "startedAt"
    case calories = "calories"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.activity = (try container.decodeIfPresent(String.self, forKey: .activity)).flatMap { WorkoutsWorkoutActivity(rawValue: $0) }
    self.durationMinutes = try container.decodeIfPresent(Double.self, forKey: .durationMinutes)
    self.startedAt = (try container.decodeIfPresent(Double.self, forKey: .startedAt)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.calories = try container.decodeIfPresent(Double.self, forKey: .calories)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(activity?.rawValue, forKey: .activity)
    try container.encodeIfPresent(durationMinutes, forKey: .durationMinutes)
    try container.encodeIfPresent(startedAt.map { $0.timeIntervalSince1970 * 1000 }, forKey: .startedAt)
    try container.encodeIfPresent(calories, forKey: .calories)
  }
}
