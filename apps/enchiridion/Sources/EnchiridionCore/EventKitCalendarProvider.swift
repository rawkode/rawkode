import EventKit
import Foundation

public enum CalendarProviderError: Error, LocalizedError, Equatable {
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

@MainActor
public final class EventKitCalendarProvider {
  private let eventStore: EKEventStore
  private var observation: NSObjectProtocol?
  private var onChanged: (@MainActor () -> Void)?

  public init(eventStore: EKEventStore = EKEventStore()) {
    self.eventStore = eventStore
  }

  isolated deinit {
    if let observation {
      NotificationCenter.default.removeObserver(observation)
    }
  }

  public var authorizationStatus: EKAuthorizationStatus {
    EKEventStore.authorizationStatus(for: .event)
  }

  public func requestAccess() async throws {
    switch authorizationStatus {
    case .fullAccess, .authorized:
      return
    case .restricted:
      throw CalendarProviderError.accessRestricted
    case .denied, .writeOnly:
      throw CalendarProviderError.accessDenied
    case .notDetermined:
      do {
        guard try await eventStore.requestFullAccessToEvents() else {
          throw CalendarProviderError.accessDenied
        }
      } catch let error as CalendarProviderError {
        throw error
      } catch {
        throw CalendarProviderError.unavailable(error.localizedDescription)
      }
    @unknown default:
      throw CalendarProviderError.accessDenied
    }
  }

  public func events(from start: Date, through end: Date) throws -> [CalendarEventSnapshot] {
    guard authorizationStatus == .fullAccess else {
      throw CalendarProviderError.accessDenied
    }
    eventStore.refreshSourcesIfNecessary()
    let calendars = eventStore.calendars(for: .event)
    let predicate = eventStore.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let sourceEvents = eventStore.events(matching: predicate)

    let duplicateKeys = Dictionary(grouping: sourceEvents) { event in
      let external = event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier
      return "\(external)\u{0}\(event.startDate.timeIntervalSince1970)"
    }.filter { $0.value.count > 1 }.keys

    return sourceEvents.map { event in
      let startDate = event.startDate ?? .distantPast
      let endDate = event.endDate ?? startDate
      let external = event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier
      let duplicateKey = "\(external)\u{0}\(startDate.timeIntervalSince1970)"
      let disambiguator: String? = duplicateKeys.contains(duplicateKey)
        ? Self.calendarFingerprint(event.calendar)
        : nil
      let occurrenceStart = event.occurrenceDate ?? startDate
      let series = (event.hasRecurrenceRules || event.occurrenceDate != nil)
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
        calendarColorHex: Self.hexColor(event.calendar.cgColor),
        isDetached: event.isDetached,
        attendees: event.attendees?.map(Self.attendee),
        organizer: event.organizer.map(Self.attendee)
      )
    }.sorted {
      if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
      return $0.title.localizedStandardCompare($1.title) == .orderedAscending
    }
  }

  public func startObserving(onChanged: @escaping @MainActor () -> Void) {
    self.onChanged = onChanged
    if let observation { NotificationCenter.default.removeObserver(observation) }
    observation = NotificationCenter.default.addObserver(
      forName: .EKEventStoreChanged,
      object: eventStore,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in self?.onChanged?() }
    }
  }

  private static func calendarFingerprint(_ calendar: EKCalendar) -> String {
    [calendar.source.sourceType.rawValue.description, calendar.source.title, calendar.title, calendar.type.rawValue.description]
      .joined(separator: "\u{0}")
      .lowercased()
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
