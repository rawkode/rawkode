import Foundation
import UserNotifications

public struct MeetingPromptOccurrence: Equatable, Sendable {
  public let vaultID: VaultID
  public let eventPageID: PageID
  /// Opaque, provider-safe identity supplied by the calendar materialization layer.
  public let occurrenceKey: String
  public let revision: Int
  public let startsAt: Date
  public let title: String

  public init(vaultID: VaultID, eventPageID: PageID, occurrenceKey: String, revision: Int, startsAt: Date, title: String) {
    self.vaultID = vaultID
    self.eventPageID = eventPageID
    self.occurrenceKey = occurrenceKey
    self.revision = revision
    self.startsAt = startsAt
    self.title = title
  }
}

public enum MeetingPromptAction: String, CaseIterable, Equatable, Sendable {
  case start
  case skip
  public var notificationActionIdentifier: String { "ENCHIRIDION_MEETING_" + rawValue.uppercased() }
}

public struct MeetingPromptNotificationRoute: Equatable, Sendable {
  public let notificationID: String
  public let action: MeetingPromptAction
}

public protocol MeetingPromptOccurrenceResolving: Sendable {
  /// Re-fetches a current occurrence for a notification identifier. It must not
  /// trust notification payloads: changed/deleted events return nil.
  func occurrence(forNotificationID identifier: String) async -> MeetingPromptOccurrence?
}

public protocol MeetingPromptNotificationCenter: Sendable {
  func pendingIdentifiers() async -> [String]
  func schedule(identifier: String, occurrence: MeetingPromptOccurrence) async throws
  func cancel(identifiers: [String]) async
}

public actor MeetingTranscriptionPromptScheduler {
  public static let shared = MeetingTranscriptionPromptScheduler()
  public nonisolated static let notificationCategoryIdentifier = "ENCHIRIDION_MEETING_TRANSCRIPTION"
  public nonisolated static let notificationIDUserInfoKey = "meetingPromptNotificationID"
  private let prefix = "dev.rawkode.enchiridion.meeting."
  private let center: any MeetingPromptNotificationCenter

  public init(center: (any MeetingPromptNotificationCenter)? = nil) {
    self.center = center ?? UserNotificationMeetingPromptCenter()
  }

  /// Register foreground-only actions. Neither action is permitted to begin
  /// microphone or system-audio capture while the app is backgrounded.
  public nonisolated static func registerNotificationCategory() {
    guard Bundle.main.bundleURL.pathExtension == "app" else { return }
    let actions = MeetingPromptAction.allCases.map {
      UNNotificationAction(identifier: $0.notificationActionIdentifier, title: $0 == .start ? "Start" : "Skip", options: [.foreground])
    }
    UNUserNotificationCenter.current().setNotificationCategories([
      .init(identifier: notificationCategoryIdentifier, actions: actions, intentIdentifiers: [], options: [])
    ])
  }

  public func reconcile(_ occurrences: [MeetingPromptOccurrence], promptsEnabled: Bool, now: Date = Date()) async {
    var desired: [String: MeetingPromptOccurrence] = [:]
    if promptsEnabled {
      for occurrence in occurrences where occurrence.startsAt > now {
        desired[identifier(for: occurrence)] = occurrence
      }
    }
    let pending = await center.pendingIdentifiers()
    let stale = pending.filter { $0.hasPrefix(prefix) && desired[$0] == nil }
    if !stale.isEmpty { await center.cancel(identifiers: stale) }
    for (identifier, occurrence) in desired {
      do { try await center.schedule(identifier: identifier, occurrence: occurrence) } catch { }
    }
  }

  public func cancel(_ occurrence: MeetingPromptOccurrence) async {
    await center.cancel(identifiers: [identifier(for: occurrence)])
  }

  public nonisolated func identifier(for occurrence: MeetingPromptOccurrence) -> String {
    prefix + stableDigest("\(occurrence.vaultID.rawValue)|\(occurrence.eventPageID.rawValue)|\(occurrence.occurrenceKey)|\(occurrence.revision)")
  }

  public nonisolated static func route(actionIdentifier: String, userInfo: [AnyHashable: Any], defaultActionIdentifier: String? = nil) -> MeetingPromptNotificationRoute? {
    guard let id = userInfo[notificationIDUserInfoKey] as? String, id.hasPrefix("dev.rawkode.enchiridion.meeting.") else { return nil }
    let action: MeetingPromptAction?
    if actionIdentifier == defaultActionIdentifier { action = .start }
    else { action = MeetingPromptAction.allCases.first { $0.notificationActionIdentifier == actionIdentifier } }
    return action.map { .init(notificationID: id, action: $0) }
  }

  /// Notification actions never start recording. They only prove the event is
  /// still current and hand foreground UI a validated Start/Skip intent.
  public nonisolated static func revalidatedAction(_ route: MeetingPromptNotificationRoute, resolver: any MeetingPromptOccurrenceResolving, settings: MeetingTranscriptionSettingsPayload, now: Date = Date()) async -> MeetingPromptOccurrence? {
    guard settings.promptsEnabled, route.action == .start,
      let occurrence = await resolver.occurrence(forNotificationID: route.notificationID),
      occurrence.startsAt <= now.addingTimeInterval(15 * 60),
      occurrence.startsAt >= now.addingTimeInterval(-15 * 60)
    else { return nil }
    let expected = "dev.rawkode.enchiridion.meeting." + stableDigest("\(occurrence.vaultID.rawValue)|\(occurrence.eventPageID.rawValue)|\(occurrence.occurrenceKey)|\(occurrence.revision)")
    return expected == route.notificationID ? occurrence : nil
  }
}

private func stableDigest(_ value: String) -> String {
  var hash: UInt64 = 14_695_981_039_346_656_037
  for byte in value.utf8 { hash = (hash ^ UInt64(byte)) &* 1_099_511_628_211 }
  return String(hash, radix: 16)
}

private actor UserNotificationMeetingPromptCenter: MeetingPromptNotificationCenter {
  private var center: UNUserNotificationCenter? { Bundle.main.bundleURL.pathExtension == "app" ? .current() : nil }
  func pendingIdentifiers() async -> [String] { await center?.pendingNotificationRequests().map(\.identifier) ?? [] }
  func schedule(identifier: String, occurrence: MeetingPromptOccurrence) async throws {
    guard let center else { return }
    let content = UNMutableNotificationContent()
    content.title = occurrence.title
    content.body = "Ready to transcribe this meeting?"
    content.sound = .default
    content.categoryIdentifier = MeetingTranscriptionPromptScheduler.notificationCategoryIdentifier
    content.userInfo = [MeetingTranscriptionPromptScheduler.notificationIDUserInfoKey: identifier]
    let components = Calendar.current.dateComponents([.calendar, .timeZone, .year, .month, .day, .hour, .minute], from: occurrence.startsAt)
    try await center.add(.init(identifier: identifier, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)))
  }
  func cancel(identifiers: [String]) async {
    guard let center else { return }
    center.removePendingNotificationRequests(withIdentifiers: identifiers)
    center.removeDeliveredNotifications(withIdentifiers: identifiers)
  }
}
