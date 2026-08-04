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

  public init(changedPageIDs: [PageID] = [], skippedCount: Int = 0) {
    self.changedPageIDs = changedPageIDs
    self.skippedCount = skippedCount
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
