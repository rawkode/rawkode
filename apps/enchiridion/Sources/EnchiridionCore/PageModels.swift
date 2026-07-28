import CryptoKit
import Foundation

public struct PageID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String

  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static func free(_ id: UUID = UUID()) -> Self {
    Self(rawValue: "page_\(id.uuidString.lowercased())")
  }

  public static func daily(_ day: DayKey) -> Self {
    Self(rawValue: "daily_\(day.rawValue)")
  }

  public static func calendarEvent(_ identity: CalendarEventIdentity) -> Self {
    Self(rawValue: "event_\(digest(identity.stableKey))")
  }

  public static func calendarOccurrence(_ identity: CalendarEventIdentity) -> Self {
    Self(rawValue: "event_\(digest(identity.canonicalOccurrenceKey))")
  }

  public static func calendarSeries(_ identity: CalendarSeriesIdentity) -> Self {
    Self(rawValue: "series_\(digest(identity.canonicalKey))")
  }

  public static func person(email: String) -> Self {
    Self(rawValue: "person_\(digest(email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()))")
  }

  private static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
      .prefix(20)
      .map { String(format: "%02x", $0) }
      .joined()
  }
}

public struct CalendarSeriesIdentity: Codable, Hashable, Sendable {
  public var provider: String
  public var externalIdentifier: String
  public var disambiguator: String?
  public var crossProviderIdentifier: String?
  public var canonicalIdentifier: String?

  public init(
    provider: String,
    externalIdentifier: String,
    disambiguator: String? = nil,
    crossProviderIdentifier: String? = nil,
    canonicalIdentifier: String? = nil
  ) {
    self.provider = provider
    self.externalIdentifier = externalIdentifier
    self.disambiguator = disambiguator
    self.crossProviderIdentifier = crossProviderIdentifier
    self.canonicalIdentifier = canonicalIdentifier
  }

  public var sourceKey: String {
    [provider, externalIdentifier, disambiguator ?? ""].joined(separator: "\u{0}")
  }

  public var preferredCanonicalKey: String {
    if let value = crossProviderIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
      !value.isEmpty
    {
      return "ical\u{0}\(value.lowercased())"
    }
    return sourceKey
  }

  public var canonicalKey: String {
    canonicalIdentifier ?? preferredCanonicalKey
  }

  public func resolved(to canonicalKey: String) -> Self {
    var copy = self
    copy.canonicalIdentifier = canonicalKey
    return copy
  }
}

public struct DayKey: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public init(date: Date, calendar: Calendar = .current) {
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    self.init(
      rawValue: String(
        format: "%04d-%02d-%02d",
        components.year ?? 0,
        components.month ?? 0,
        components.day ?? 0
      )
    )
  }
}

public struct CalendarEventIdentity: Codable, Hashable, Sendable {
  public var provider: String
  public var externalIdentifier: String
  public var occurrenceStart: Date
  public var disambiguator: String?
  public var localIdentifierHint: String?
  public var series: CalendarSeriesIdentity?

  public init(
    provider: String = "eventkit",
    externalIdentifier: String,
    occurrenceStart: Date,
    disambiguator: String? = nil,
    localIdentifierHint: String? = nil,
    series: CalendarSeriesIdentity? = nil
  ) {
    self.provider = provider
    self.externalIdentifier = externalIdentifier
    self.occurrenceStart = occurrenceStart
    self.disambiguator = disambiguator
    self.localIdentifierHint = localIdentifierHint
    self.series = series
  }

  public var stableKey: String {
    let instant = occurrenceStart.enchiridionISO8601
    return [provider, externalIdentifier, instant, disambiguator ?? ""]
      .joined(separator: "\u{0}")
  }

  public var canonicalOccurrenceKey: String {
    guard let series else { return stableKey }
    return [series.canonicalKey, occurrenceStart.enchiridionISO8601]
      .joined(separator: "\u{0}")
  }
}

public enum PageKind: Codable, Hashable, Sendable {
  case daily(DayKey)
  case free
  case calendarEvent(CalendarEventIdentity)
  case calendarSeries(CalendarSeriesIdentity)
}

public struct AutomergeHeads: Codable, Hashable, Sendable {
  public var values: [String]

  public init(_ values: [String]) {
    self.values = Array(Set(values.map { $0.lowercased() })).sorted()
  }

  public static let empty = Self([])
}

public struct PageSnapshot: Identifiable, Codable, Hashable, Sendable {
  public var id: PageID
  public var kind: PageKind
  public var title: String
  public var plainText: String
  public var document: Data
  public var heads: AutomergeHeads
  public var createdAt: Date
  public var modifiedAt: Date
  public var deletedAt: Date?
  public var isPinned: Bool
  public var dirtyGeneration: Int64
  public var objectMetadata: PageObjectMetadata

  public init(
    id: PageID,
    kind: PageKind,
    title: String,
    plainText: String,
    document: Data,
    heads: AutomergeHeads,
    createdAt: Date,
    modifiedAt: Date,
    deletedAt: Date? = nil,
    isPinned: Bool = false,
    dirtyGeneration: Int64 = 0,
    objectMetadata: PageObjectMetadata = .init()
  ) {
    self.id = id
    self.kind = kind
    self.title = title
    self.plainText = plainText
    self.document = document
    self.heads = heads
    self.createdAt = createdAt
    self.modifiedAt = modifiedAt
    self.deletedAt = deletedAt
    self.isPinned = isPinned
    self.dirtyGeneration = dirtyGeneration
    self.objectMetadata = objectMetadata
  }

  public var displayTitle: String {
    let value = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? "Untitled" : value
  }

  public var preview: String {
    plainText
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\n", with: " ")
  }

  public func hasSupertag(_ id: SupertagID) -> Bool {
    objectMetadata.supertagIDs.contains(id)
  }
}

public struct PageReference: Codable, Hashable, Sendable {
  public var sourcePageID: PageID
  public var targetPageID: PageID
  public var fallbackLabel: String

  public init(sourcePageID: PageID, targetPageID: PageID, fallbackLabel: String) {
    self.sourcePageID = sourcePageID
    self.targetPageID = targetPageID
    self.fallbackLabel = fallbackLabel
  }
}

public struct CalendarEventSnapshot: Identifiable, Codable, Hashable, Sendable {
  public var identity: CalendarEventIdentity
  public var title: String
  public var startDate: Date
  public var endDate: Date
  public var isAllDay: Bool
  public var location: String?
  public var notes: String?
  public var url: URL?
  public var calendarTitle: String
  public var calendarColorHex: String?
  public var isDetached: Bool
  public var attendees: [CalendarAttendeeIdentity]?
  public var organizer: CalendarAttendeeIdentity?

  public var id: String { identity.stableKey }

  public init(
    identity: CalendarEventIdentity,
    title: String,
    startDate: Date,
    endDate: Date,
    isAllDay: Bool,
    location: String?,
    notes: String?,
    url: URL?,
    calendarTitle: String,
    calendarColorHex: String? = nil,
    isDetached: Bool = false,
    attendees: [CalendarAttendeeIdentity]? = nil,
    organizer: CalendarAttendeeIdentity? = nil
  ) {
    self.identity = identity
    self.title = title
    self.startDate = startDate
    self.endDate = endDate
    self.isAllDay = isAllDay
    self.location = location
    self.notes = notes
    self.url = url
    self.calendarTitle = calendarTitle
    self.calendarColorHex = calendarColorHex
    self.isDetached = isDetached
    self.attendees = attendees
    self.organizer = organizer
  }
}

public struct CalendarAttendeeIdentity: Codable, Hashable, Sendable, Identifiable {
  public var email: String?
  public var displayName: String?
  public var role: String
  public var responseStatus: String
  public var isCurrentUser: Bool
  public var sourceIdentifier: String?

  public var id: String {
    email?.lowercased() ?? sourceIdentifier ?? "\(displayName ?? "Unknown"):\(role)"
  }

  public init(
    email: String?,
    displayName: String?,
    role: String,
    responseStatus: String,
    isCurrentUser: Bool,
    sourceIdentifier: String? = nil
  ) {
    self.email = email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    self.displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.role = role
    self.responseStatus = responseStatus
    self.isCurrentUser = isCurrentUser
    self.sourceIdentifier = sourceIdentifier
  }
}

public struct CalendarOccurrenceNote: Identifiable, Hashable, Sendable {
  public var pageID: PageID
  public var title: String
  public var preview: String
  public var startDate: Date
  public var endDate: Date?
  public var isAllDay: Bool

  public var id: PageID { pageID }
}

public struct CalendarPageContext: Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    case occurrence
    case series
  }

  public var kind: Kind
  public var event: CalendarEventSnapshot?
  public var series: CalendarSeriesIdentity?
  public var seriesPageID: PageID?
  public var calendarTitle: String?
  public var occurrences: [CalendarOccurrenceNote]
  public var sourceUnavailable: Bool

  public init(
    kind: Kind,
    event: CalendarEventSnapshot? = nil,
    series: CalendarSeriesIdentity? = nil,
    seriesPageID: PageID? = nil,
    calendarTitle: String? = nil,
    occurrences: [CalendarOccurrenceNote] = [],
    sourceUnavailable: Bool = false
  ) {
    self.kind = kind
    self.event = event
    self.series = series
    self.seriesPageID = seriesPageID
    self.calendarTitle = calendarTitle
    self.occurrences = occurrences
    self.sourceUnavailable = sourceUnavailable
  }
}

public struct CalendarEventGroup: Identifiable, Hashable, Sendable {
  public var id: String
  public var title: String
  public var series: CalendarSeriesIdentity?
  public var events: [CalendarEventSnapshot]

  public init(
    id: String,
    title: String,
    series: CalendarSeriesIdentity?,
    events: [CalendarEventSnapshot]
  ) {
    self.id = id
    self.title = title
    self.series = series
    self.events = events
  }
}

public struct CalendarEventPages: Sendable {
  public var occurrence: PageSnapshot
  public var series: PageSnapshot?
  public var createdPageIDs: [PageID]
}

public enum CalendarSeriesMatcher {
  public static func likelyMatch(_ lhs: CalendarEventSnapshot, _ rhs: CalendarEventSnapshot) -> Bool {
    guard lhs.identity.provider != rhs.identity.provider,
      lhs.identity.series != nil,
      rhs.identity.series != nil,
      normalize(lhs.title) == normalize(rhs.title),
      lhs.isAllDay == rhs.isAllDay,
      abs(lhs.identity.occurrenceStart.timeIntervalSince(rhs.identity.occurrenceStart)) <= 60,
      abs(lhs.endDate.timeIntervalSince(lhs.startDate) - rhs.endDate.timeIntervalSince(rhs.startDate)) <= 60
    else { return false }

    let lhsLocation = lhs.location.map(normalize)
    let rhsLocation = rhs.location.map(normalize)
    return lhsLocation == nil || rhsLocation == nil || lhsLocation == rhsLocation
  }

  private static func normalize(_ value: String) -> String {
    value
      .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
      .split(whereSeparator: { $0.isWhitespace })
      .joined(separator: " ")
  }
}

public enum SyncStatus: Codable, Equatable, Sendable {
  case localOnly
  case syncing
  case synced(Date)
  case offline
  case iCloudUnavailable(String)
  case attentionRequired(String)

  public var title: String {
    switch self {
    case .localOnly: "Saved locally"
    case .syncing: "Syncing"
    case .synced: "Synced"
    case .offline: "Offline — saved locally"
    case .iCloudUnavailable: "iCloud unavailable"
    case .attentionRequired: "Sync needs attention"
    }
  }

  public var detail: String {
    switch self {
    case .localOnly:
      "Changes are safe on this device. Sign in to iCloud to keep them in sync."
    case .syncing:
      "Sending local changes and checking iCloud for updates."
    case .synced(let date):
      "All known changes were synced \(date.formatted(date: .abbreviated, time: .shortened))."
    case .offline:
      "Changes are safe on this device and will sync automatically when iCloud is reachable."
    case .iCloudUnavailable(let message), .attentionRequired(let message):
      message
    }
  }
}

extension Date {
  static let enchiridionISO8601Style = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

  var enchiridionISO8601: String {
    formatted(Self.enchiridionISO8601Style)
  }

  static func fromEnchiridionISO8601(_ value: String) -> Date? {
    try? Date(value, strategy: enchiridionISO8601Style)
  }
}
