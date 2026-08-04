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

  /// A cloud-safe calendar occurrence identifier. Provider identifiers and iCalendar
  /// UIDs deliberately never appear in the page id or its kind.
  public static func materializedCalendarEvent(_ identity: CalendarMaterializedIdentity) -> Self {
    Self(rawValue: "calendar_event_\(digest(identity.stableKey))")
  }

  public static func calendarSeries(_ identity: CalendarSeriesIdentity) -> Self {
    Self(rawValue: "series_\(digest(identity.canonicalKey))")
  }

  public static func person(email: String) -> Self {
    Self(rawValue: "person_\(digest(email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()))")
  }

  public static func taskOccurrence(
    seriesID: TaskRecurrenceSeriesID,
    sequence: Int
  ) -> Self {
    let canonicalKey = "task-recurrence-occurrence-v1\u{0}\(seriesID.rawValue)\u{0}\(sequence)"
    return Self(rawValue: "task_occurrence_\(digest(canonicalKey))")
  }

  fileprivate static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
      .prefix(20)
      .map { String(format: "%02x", $0) }
      .joined()
  }
}

public struct TaskRecurrenceSeriesID: RawRepresentable, Codable, Hashable, Sendable,
  Identifiable, CustomStringConvertible
{
  public let rawValue: String

  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  /// Gives a legacy recurring task a stable series identity without a database migration.
  /// Every replica that has the same original page derives the same value.
  public static func derived(from rootPageID: PageID) -> Self {
    let canonicalKey = "task-recurrence-series-v1\u{0}\(rootPageID.rawValue)"
    return Self(rawValue: "task_series_\(PageID.digest(canonicalKey))")
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

/// The identity persisted with a synced Event page. `uidDigest` is SHA-256 of the
/// normalised iCalendar UID, so neither an EventKit identifier nor a provider UID
/// leaks into CloudKit.
public struct CalendarMaterializedIdentity: Codable, Hashable, Sendable {
  public static let version = 1
  public var version: Int
  public var uidDigest: String
  public var occurrenceToken: String
  public var sourceScopeDigest: String?

  public init(version: Int = Self.version, uidDigest: String, occurrenceToken: String, sourceScopeDigest: String? = nil) {
    self.version = version
    self.uidDigest = uidDigest
    self.occurrenceToken = occurrenceToken
    self.sourceScopeDigest = sourceScopeDigest
  }

  public var stableKey: String {
    ["calendar-materialized-v\(version)", uidDigest, occurrenceToken, sourceScopeDigest ?? ""].joined(separator: "\u{0}")
  }
}

public enum PageKind: Codable, Hashable, Sendable {
  case daily(DayKey)
  case free
  case calendarEvent(CalendarEventIdentity)
  case calendarSeries(CalendarSeriesIdentity)
  case calendarMaterializedEvent(CalendarMaterializedIdentity)
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

  public var effectivePersonVisibility: PersonVisibility? {
    guard hasSupertag(BuiltInSupertags.person) else { return nil }
    return objectMetadata.personVisibility ?? .promoted
  }

  public var personOrigin: PersonOrigin? { objectMetadata.personOrigin }

  public var isOtherPerson: Bool { effectivePersonVisibility == .other }
}

public enum PageDestinationKind: Hashable, Sendable {
  case unavailable
  case task
  case entity
  case note
}

public enum PageDestinationClassifier {
  public static func classify(_ page: PageSnapshot?) -> PageDestinationKind {
    guard let page, page.deletedAt == nil else { return .unavailable }
    if page.hasSupertag(BuiltInSupertags.task) { return .task }
    if !page.objectMetadata.supertagIDs.isEmpty { return .entity }
    return .note
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
  /// Local-only provider projection data. These values are never copied into a
  /// materialized page kind or CloudKit record.
  public var iCalendarUID: String?
  public var originalStartDate: Date?
  public var timeZoneIdentifier: String?
  public var originalStartCivilDay: DayKey?

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
    organizer: CalendarAttendeeIdentity? = nil,
    iCalendarUID: String? = nil,
    originalStartDate: Date? = nil,
    timeZoneIdentifier: String? = nil,
    originalStartCivilDay: DayKey? = nil
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
    self.iCalendarUID = Self.nonEmpty(iCalendarUID)
    self.originalStartDate = originalStartDate ?? identity.occurrenceStart
    self.timeZoneIdentifier = timeZoneIdentifier
    self.originalStartCivilDay = originalStartCivilDay
  }

  private enum CodingKeys: String, CodingKey {
    case identity, title, startDate, endDate, isAllDay, location, notes, url, calendarTitle, calendarColorHex, isDetached, attendees, organizer, iCalendarUID, originalStartDate, timeZoneIdentifier, originalStartCivilDay
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    identity = try c.decode(CalendarEventIdentity.self, forKey: .identity)
    title = try c.decode(String.self, forKey: .title)
    startDate = try c.decode(Date.self, forKey: .startDate)
    endDate = try c.decode(Date.self, forKey: .endDate)
    isAllDay = try c.decode(Bool.self, forKey: .isAllDay)
    location = try c.decodeIfPresent(String.self, forKey: .location)
    notes = try c.decodeIfPresent(String.self, forKey: .notes)
    url = try c.decodeIfPresent(URL.self, forKey: .url)
    calendarTitle = try c.decode(String.self, forKey: .calendarTitle)
    calendarColorHex = try c.decodeIfPresent(String.self, forKey: .calendarColorHex)
    isDetached = try c.decodeIfPresent(Bool.self, forKey: .isDetached) ?? false
    attendees = try c.decodeIfPresent([CalendarAttendeeIdentity].self, forKey: .attendees)
    organizer = try c.decodeIfPresent(CalendarAttendeeIdentity.self, forKey: .organizer)
    iCalendarUID = Self.nonEmpty(try c.decodeIfPresent(String.self, forKey: .iCalendarUID))
    originalStartDate = try c.decodeIfPresent(Date.self, forKey: .originalStartDate) ?? identity.occurrenceStart
    timeZoneIdentifier = try c.decodeIfPresent(String.self, forKey: .timeZoneIdentifier)
    originalStartCivilDay = try c.decodeIfPresent(DayKey.self, forKey: .originalStartCivilDay)
  }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
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
