@preconcurrency import EventKit
import Foundation

public enum CalendarProviderError: Error, LocalizedError, Equatable, Sendable {
  case accessDenied
  case accessRestricted
  case unavailable(String)

  public var errorDescription: String? {
    switch self {
    case .accessDenied:
      "Calendar access is off. Enable Full Access for Enchiridion in System Settings."
    case .accessRestricted:
      "Calendar access is restricted on this device."
    case .unavailable(let message):
      "Calendar data is unavailable: \(message)"
    }
  }
}

/// The subset of EventKit authorization that Enchiridion needs. Keeping this
/// Sendable prevents EventKit framework values from leaking out of the owner.
public enum EventKitCalendarAuthorization: Sendable, Equatable {
  case notDetermined
  case restricted
  case denied
  case writeOnly
  case fullAccess
}

/// The only boundary between the application and EventKit. Implementations own
/// their EventKit objects and return value snapshots exclusively, so callers
/// never hold an `EKEvent`, `EKCalendar`, or `EKEventStore` across an await.
public protocol EventKitCalendarSnapshotSource: Sendable {
  func authorizationStatus() async -> EventKitCalendarAuthorization
  func requestFullAccess() async throws -> Bool
  func authoritativeProjection(from start: Date, through end: Date) async throws
    -> AuthoritativeCalendarProjection
  func startObserving(onChanged: @escaping @Sendable () -> Void) async
  func stopObserving() async
}

/// Main-actor facade for a serial EventKit owner. UI state can safely hold this
/// object, while all synchronous EventKit enumeration and mapping stays on the
/// private owner actor rather than blocking the main actor.
@MainActor
public final class EventKitCalendarProvider {
  private let source: any EventKitCalendarSnapshotSource
  private var onChanged: (@MainActor @Sendable () -> Void)?
  private var observationGeneration: UInt64 = 0

  public init() {
    source = EventKitCalendarSource()
  }

  public init(source: any EventKitCalendarSnapshotSource) {
    self.source = source
  }

  isolated deinit {
    let source = source
    Task { await source.stopObserving() }
  }

  public func authorizationStatus() async -> EventKitCalendarAuthorization {
    await source.authorizationStatus()
  }

  public func requestAccess() async throws {
    switch await source.authorizationStatus() {
    case .fullAccess:
      return
    case .restricted:
      throw CalendarProviderError.accessRestricted
    case .denied, .writeOnly:
      throw CalendarProviderError.accessDenied
    case .notDetermined:
      do {
        guard try await source.requestFullAccess() else {
          throw CalendarProviderError.accessDenied
        }
      } catch let error as CalendarProviderError {
        throw error
      } catch {
        throw CalendarProviderError.unavailable(error.localizedDescription)
      }
    }
  }

  public func events(from start: Date, through end: Date) async throws -> [CalendarEventSnapshot] {
    try await authoritativeProjection(from: start, through: end).events
  }

  public func authoritativeProjection(
    from start: Date,
    through end: Date
  ) async throws -> AuthoritativeCalendarProjection {
    guard await source.authorizationStatus() == .fullAccess else {
      throw CalendarProviderError.accessDenied
    }
    try Task.checkCancellation()
    let projection = try await source.authoritativeProjection(from: start, through: end)
    try Task.checkCancellation()
    return projection
  }

  public func startObserving(onChanged: @escaping @MainActor @Sendable () -> Void) async {
    observationGeneration &+= 1
    let generation = observationGeneration
    self.onChanged = onChanged
    await source.startObserving { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.observationGeneration == generation else { return }
        self.onChanged?()
      }
    }
  }

  public func stopObserving() async {
    observationGeneration &+= 1
    onChanged = nil
    await source.stopObserving()
  }
}

/// A serial owner for one and only one `EKEventStore`. EventKit's synchronous
/// fetch APIs are intentionally invoked here, never from `MainActor`.
private actor EventKitCalendarSource: EventKitCalendarSnapshotSource {
  private var eventStore: EKEventStore?
  private let notificationCenter: NotificationCenter
  private var observation: NSObjectProtocol?

  init(notificationCenter: NotificationCenter = .default) {
    self.notificationCenter = notificationCenter
  }

  isolated deinit {
    if let observation {
      notificationCenter.removeObserver(observation)
    }
  }

  func authorizationStatus() -> EventKitCalendarAuthorization {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .fullAccess, .authorized:
      .fullAccess
    case .restricted:
      .restricted
    case .denied:
      .denied
    case .writeOnly:
      .writeOnly
    case .notDetermined:
      .notDetermined
    @unknown default:
      .denied
    }
  }

  func requestFullAccess() async throws -> Bool {
    do {
      return try await ownedEventStore().requestFullAccessToEvents()
    } catch {
      throw CalendarProviderError.unavailable(error.localizedDescription)
    }
  }

  func authoritativeProjection(from start: Date, through end: Date) throws
    -> AuthoritativeCalendarProjection
  {
    let eventStore = ownedEventStore()
    eventStore.refreshSourcesIfNecessary()
    let calendars = eventStore.calendars(for: .event)
    let predicate = eventStore.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let sourceEvents = eventStore.events(matching: predicate)
    let snapshots = Self.snapshots(from: sourceEvents)
    return .init(provider: "eventkit", interval: .init(start: start, end: end), events: snapshots)
  }

  func startObserving(onChanged: @escaping @Sendable () -> Void) {
    if let observation { notificationCenter.removeObserver(observation) }
    let eventStore = ownedEventStore()
    observation = notificationCenter.addObserver(
      forName: .EKEventStoreChanged,
      object: eventStore,
      queue: nil
    ) { _ in
      onChanged()
    }
  }

  func stopObserving() {
    if let observation { notificationCenter.removeObserver(observation) }
    observation = nil
  }

  /// This is actor-isolated deliberately: constructing `EKEventStore` can do
  /// synchronous provider work, so a façade created on `MainActor` must not
  /// allocate it until an EventKit operation actually reaches this owner.
  private func ownedEventStore() -> EKEventStore {
    if let eventStore { return eventStore }
    let eventStore = EKEventStore()
    self.eventStore = eventStore
    return eventStore
  }

  private static func snapshots(from sourceEvents: [EKEvent]) -> [CalendarEventSnapshot] {
    let duplicateKeys = Dictionary(grouping: sourceEvents) { event in
      let external = event.calendarItemExternalIdentifier ?? ""
      return "\(external)\u{0}\(event.startDate.timeIntervalSince1970)"
    }.filter { $0.value.count > 1 }.keys

    return sourceEvents.map { event in
      let startDate = event.startDate ?? .distantPast
      let endDate = event.endDate ?? startDate
      // A local EventKit identifier is useful for diagnostics only. It must
      // never stand in for the provider's external UID: events without one
      // remain visible locally but are rejected by materialization later.
      let external = event.calendarItemExternalIdentifier ?? ""
      let duplicateKey = "\(external)\u{0}\(startDate.timeIntervalSince1970)"
      let disambiguator: String?
      if external.isEmpty {
        // Keep local-only snapshots independently addressable without turning
        // the local identifier into a provider or CloudKit identity.
        disambiguator = "local:\(event.calendarItemIdentifier)"
      } else {
        disambiguator = duplicateKeys.contains(duplicateKey)
          ? calendarFingerprint(event.calendar)
          : nil
      }
      let occurrenceStart = event.occurrenceDate ?? startDate
      let series = (!external.isEmpty && (event.hasRecurrenceRules || event.occurrenceDate != nil))
        ? CalendarSeriesIdentity(
          provider: "eventkit",
          externalIdentifier: external,
          disambiguator: disambiguator,
          crossProviderIdentifier: external
        )
        : nil
      return CalendarEventSnapshot(
        identity: CalendarEventIdentity(
          externalIdentifier: external,
          occurrenceStart: occurrenceStart,
          disambiguator: disambiguator,
          localIdentifierHint: event.calendarItemIdentifier,
          series: series
        ),
        title: event.title?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "Untitled event",
        startDate: startDate,
        endDate: endDate,
        isAllDay: event.isAllDay,
        location: event.location?.nonEmpty,
        notes: event.notes?.nonEmpty,
        url: event.url,
        calendarTitle: event.calendar.title,
        calendarColorHex: hexColor(event.calendar.cgColor),
        isDetached: event.isDetached,
        attendees: event.attendees?.map(attendee),
        organizer: event.organizer.map(attendee),
        iCalendarUID: event.calendarItemExternalIdentifier,
        originalStartDate: occurrenceStart,
        timeZoneIdentifier: event.timeZone?.identifier ?? TimeZone.current.identifier,
        originalStartCivilDay: event.isAllDay
          ? DayKey(date: occurrenceStart, calendar: civilCalendar(timeZone: event.timeZone))
          : nil
      )
    }.sorted {
      if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
      if $0.title != $1.title {
        return $0.title.localizedStandardCompare($1.title) == .orderedAscending
      }
      return $0.id < $1.id
    }
  }

  private static func calendarFingerprint(_ calendar: EKCalendar) -> String {
    [calendar.source.sourceType.rawValue.description, calendar.source.title, calendar.title, calendar.type.rawValue.description]
      .joined(separator: "\u{0}")
      .lowercased()
  }

  private static func civilCalendar(timeZone: TimeZone?) -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone ?? .current
    return calendar
  }

  private static func hexColor(_ color: CGColor?) -> String? {
    guard let components = color?.components, components.count >= 3 else { return nil }
    let red = Int((components[0] * 255).rounded())
    let green = Int((components[1] * 255).rounded())
    let blue = Int((components[2] * 255).rounded())
    return String(format: "#%02X%02X%02X", red, green, blue)
  }

  private static func attendee(_ participant: EKParticipant) -> CalendarAttendeeIdentity {
    let email: String?
    if participant.url.scheme?.lowercased() == "mailto" {
      email = String(participant.url.absoluteString.dropFirst("mailto:".count)).removingPercentEncoding
    } else {
      email = nil
    }
    return CalendarAttendeeIdentity(
      email: email,
      displayName: participant.name,
      role: String(describing: participant.participantRole),
      responseStatus: String(describing: participant.participantStatus),
      isCurrentUser: participant.isCurrentUser,
      sourceIdentifier: participant.url.absoluteString
    )
  }
}

private extension String {
  var nonEmpty: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
