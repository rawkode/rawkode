import CryptoKit
import Foundation

/// The single, local opt-in for copying calendar occurrences into normal,
/// Cloud-synchronised Event pages. Calendar credentials and raw provider IDs stay
/// exclusively in the local projection.
public enum CalendarEventMaterialization {
  public static let settingKey = "calendar.materialize-events"

  public static func identity(for event: CalendarEventSnapshot) -> CalendarMaterializedIdentity? {
    guard let uid = nonEmpty(event.iCalendarUID?.precomposedStringWithCanonicalMapping)
    else { return nil }

    let occurrence: String
    if event.isAllDay {
      guard let day = event.originalStartCivilDay,
        let zone = nonEmpty(event.timeZoneIdentifier)
      else { return nil }
      occurrence = "all-day\u{0}\(day.rawValue)\u{0}\(zone)"
    } else {
      guard let original = event.originalStartDate else { return nil }
      occurrence = "instant\u{0}\(Int64(original.timeIntervalSince1970.rounded(.towardZero)))"
    }
    let digest = SHA256.hash(data: Data(uid.utf8)).map { String(format: "%02x", $0) }.joined()
    // Do not merge independently refreshed providers until their projection CRDT
    // has a shared schema. Provider scope is itself hashed and keeps raw account
    // identifiers out of the synced kind.
    let provider = event.identity.provider.precomposedStringWithCanonicalMapping
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !provider.isEmpty else { return nil }
    let sourceScope = SHA256.hash(data: Data(provider.utf8))
      .map { String(format: "%02x", $0) }.joined()
    return .init(uidDigest: digest, occurrenceToken: occurrence, sourceScopeDigest: sourceScope)
  }

  /// A provider scope is intentionally derived without retaining the raw
  /// account/provider identifier in a cloud-synchronised page or state record.
  /// Retention is only authoritative within this exact scope.
  public static func sourceScopeDigest(for provider: String) -> String? {
    let normalized = provider.precomposedStringWithCanonicalMapping
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    return SHA256.hash(data: Data(normalized.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }

  public static func providerProperties(for event: CalendarEventSnapshot) -> [SupertagPropertyKey: [SupertagValue]] {
    let tag = BuiltInSupertags.event
    var result: [SupertagPropertyKey: [SupertagValue]] = [
      .init(supertagID: tag, fieldID: .init(rawValue: "start")): [.dateTime(event.startDate)],
      .init(supertagID: tag, fieldID: .init(rawValue: "end")): [.dateTime(event.endDate)],
      .init(supertagID: tag, fieldID: .init(rawValue: "all-day")): [.boolean(event.isAllDay)],
      .init(supertagID: tag, fieldID: .init(rawValue: "calendar")): [.text(event.calendarTitle)],
      .init(supertagID: tag, fieldID: .init(rawValue: "source")): [.text("Calendar")],
    ]
    if let location = nonEmpty(event.location) {
      result[.init(supertagID: tag, fieldID: .init(rawValue: "location"))] = [.text(location)]
    }
    return result
  }

  public static func baselineHash(for event: CalendarEventSnapshot) -> String {
    let values = providerProperties(for: event)
      .sorted { $0.key.storageKey < $1.key.storageKey }
      .map { "\($0.key.storageKey)=\($0.value.map(\.id).sorted().joined(separator: ","))" }
      .joined(separator: "\n")
    return SHA256.hash(data: Data((event.title + "\n" + values).utf8)).map { String(format: "%02x", $0) }.joined()
  }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

public struct CalendarEventMaterializationReceipt: Sendable {
  public var changedPageIDs: [PageID]
  public var skippedCount: Int
  /// `false` means the local calendar projection is already available, but its
  /// Event pages are still being materialized in bounded follow-up batches.
  public var isTerminal: Bool

  public init(changedPageIDs: [PageID] = [], skippedCount: Int = 0, isTerminal: Bool = true) {
    self.changedPageIDs = changedPageIDs
    self.skippedCount = skippedCount
    self.isTerminal = isTerminal
  }
}

/// Local-only durable state for one exact provider response. Neither this
/// header nor its immutable item rows are part of the page/CloudKit model.
public enum CalendarProjectionGenerationStatus: String, Codable, Sendable {
  case staged, materializing, completed, superseded, invalidated
}

public struct CalendarProjectionGeneration: Codable, Sendable, Equatable {
  public var provider: String
  public var id: UUID
  public var eligibilityEpoch: Int64
  public var snapshotVersion: Int
  public var snapshotDigest: String
  public var omissionPrefixDigest: String
  public var status: CalendarProjectionGenerationStatus
  public var acceptedCount: Int
  public var rejectedCount: Int
  public var retentionEligible: Bool
  public var refreshAt: Date
  public var nextOrdinal: Int
  public var updatedAt: Date

  public init(provider: String, id: UUID, eligibilityEpoch: Int64, snapshotVersion: Int,
              snapshotDigest: String, omissionPrefixDigest: String,
              status: CalendarProjectionGenerationStatus, acceptedCount: Int,
              rejectedCount: Int, retentionEligible: Bool, refreshAt: Date,
              nextOrdinal: Int, updatedAt: Date) {
    self.provider = provider
    self.id = id
    self.eligibilityEpoch = eligibilityEpoch
    self.snapshotVersion = snapshotVersion
    self.snapshotDigest = snapshotDigest
    self.omissionPrefixDigest = omissionPrefixDigest
    self.status = status
    self.acceptedCount = acceptedCount
    self.rejectedCount = rejectedCount
    self.retentionEligible = retentionEligible
    self.refreshAt = refreshAt
    self.nextOrdinal = nextOrdinal
    self.updatedAt = updatedAt
  }
}

/// A refresh result is authoritative only when it covers this entire interval.
/// Providers must not manufacture this value from a partial response.
public struct AuthoritativeCalendarProjection: Sendable {
  public let provider: String
  public let interval: DateInterval
  public let events: [CalendarEventSnapshot]

  init(provider: String, interval: DateInterval, events: [CalendarEventSnapshot]) {
    let normalized = provider.trimmingCharacters(in: .whitespacesAndNewlines)
    precondition(!normalized.isEmpty, "Calendar provider is required")
    self.provider = normalized
    self.interval = interval
    self.events = events
  }
}

public struct AuthoritativeCalendarRefreshToken: Sendable, Hashable {
  let provider: String
  let id: UUID
  let eligibilityEpoch: Int64
  /// Repositories created before the local opt-in setting existed used the
  /// strict all-valid authoritative API. Keep that direct-call contract while
  /// explicit settings use the v31 partitioning semantics.
  let legacyCompatibility: Bool
}

public enum CalendarEventMaterializationBackfillStatus: String, Codable, Sendable {
  case needed, running, completed
}

public struct CalendarEventMaterializationBackfillState: Codable, Sendable, Equatable {
  public static let schemaVersion = 1
  public var provider: String
  public var schemaVersion: Int
  public var status: CalendarEventMaterializationBackfillStatus
  public var outcome: String?
  public var updatedAt: Date

  public init(provider: String, schemaVersion: Int = Self.schemaVersion, status: CalendarEventMaterializationBackfillStatus, outcome: String? = nil, updatedAt: Date = Date()) {
    self.provider = provider
    self.schemaVersion = schemaVersion
    self.status = status
    self.outcome = outcome
    self.updatedAt = updatedAt
  }
}

/// Local materialization state used solely to distinguish a provider refresh
/// from a user override. Raw calendar identities never enter this value.
struct CalendarEventMaterializationBaseline: Codable, Equatable, Sendable {
  var title: String
  var properties: [String: [SupertagValue]]

  init(title: String, properties: [SupertagPropertyKey: [SupertagValue]]) {
    self.title = title
    self.properties = Dictionary(uniqueKeysWithValues: properties.map { ($0.key.storageKey, $0.value) })
  }

  func matches(_ page: PageSnapshot) -> Bool {
    page.title == title
      && Dictionary(uniqueKeysWithValues: page.objectMetadata.properties.map { ($0.key.storageKey, $0.value) })
        == properties
  }
}
