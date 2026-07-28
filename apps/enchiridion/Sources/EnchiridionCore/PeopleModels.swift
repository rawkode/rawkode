import Foundation

public enum PersonVisibility: String, Codable, CaseIterable, Hashable, Sendable {
  case other
  case promoted
}

public enum PersonOrigin: String, Codable, CaseIterable, Hashable, Sendable {
  case calendarAttendee
  case manual
}

public struct PersonContactCandidate: Codable, Hashable, Sendable, Identifiable {
  public var pageID: PageID
  public var email: String
  public var displayName: String
  public var visibility: PersonVisibility

  public var id: String { "\(pageID.rawValue):\(email)" }

  public init(
    pageID: PageID,
    email: String,
    displayName: String,
    visibility: PersonVisibility
  ) {
    self.pageID = pageID
    self.email = DeviceContactRecord.normalizedEmail(email)
    self.displayName = displayName
    self.visibility = visibility
  }
}

public struct ContactBirthday: Codable, Hashable, Sendable {
  public var year: Int?
  public var month: Int
  public var day: Int

  public init(year: Int? = nil, month: Int, day: Int) {
    self.year = year
    self.month = month
    self.day = day
  }
}

/// A platform-neutral, deliberately small projection of a device contact.
/// Platform adapters may build this from Contacts without making EnchiridionCore depend on it.
public struct DeviceContactRecord: Codable, Hashable, Sendable, Identifiable {
  public var identifier: String
  public var displayName: String
  public var organizationName: String?
  public var jobTitle: String?
  public var emails: [String]
  public var phoneNumbers: [String]
  public var birthday: ContactBirthday?
  public var thumbnailData: Data?

  public var id: String { identifier }
  public var normalizedEmails: [String] {
    Array(Set(emails.map(Self.normalizedEmail).filter { !$0.isEmpty })).sorted()
  }

  public init(
    identifier: String,
    displayName: String,
    organizationName: String? = nil,
    jobTitle: String? = nil,
    emails: [String] = [],
    phoneNumbers: [String] = [],
    birthday: ContactBirthday? = nil,
    thumbnailData: Data? = nil
  ) {
    self.identifier = identifier
    self.displayName = displayName
    self.organizationName = organizationName
    self.jobTitle = jobTitle
    self.emails = emails
    self.phoneNumbers = phoneNumbers
    self.birthday = birthday
    self.thumbnailData = thumbnailData
  }

  public static func normalizedEmail(_ email: String) -> String {
    email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }
}

public struct PersonContactLink: Codable, Hashable, Sendable, Identifiable {
  public var pageID: PageID
  public var contactIdentifier: String
  public var matchedEmail: String
  public var record: DeviceContactRecord
  public var refreshedAt: Date

  public var id: PageID { pageID }

  public init(
    pageID: PageID,
    contactIdentifier: String,
    matchedEmail: String,
    record: DeviceContactRecord,
    refreshedAt: Date
  ) {
    self.pageID = pageID
    self.contactIdentifier = contactIdentifier
    self.matchedEmail = DeviceContactRecord.normalizedEmail(matchedEmail)
    self.record = record
    self.refreshedAt = refreshedAt
  }
}

public protocol DeviceContactResolving: Sendable {
  /// Returns a single exact-email match. Ambiguous or unavailable matches return nil.
  func contact(matchingEmail normalizedEmail: String) async throws -> DeviceContactRecord?

  /// Returns the contact with this stable device identifier when it remains visible to the app.
  /// This preserves an explicit user selection even when its email is shared by multiple contacts.
  func contact(identifier: String) async throws -> DeviceContactRecord?
}

extension DeviceContactResolving {
  public func contact(identifier: String) async throws -> DeviceContactRecord? { nil }
}

/// The access state reported by a platform Contacts adapter.
///
/// EnchiridionCore deliberately does not query Contacts directly. App runtimes should observe
/// authorization changes for the lifetime of the process and pass the latest state to
/// `LibraryStore.deviceContactsAuthorizationDidChange(_:)`.
public enum DeviceContactsAuthorization: String, Codable, Hashable, Sendable {
  case notDetermined
  case restricted
  case denied
  case limited
  case authorized

  public var permitsEnrichment: Bool {
    switch self {
    case .limited, .authorized: true
    case .notDetermined, .restricted, .denied: false
    }
  }
}

public enum CalendarEventOmissionRules {
  public static let defaultPrefixes = ["Blocked"]

  public static func normalizedPrefixes(_ prefixes: [String]) -> [String] {
    var seen: Set<String> = []
    return prefixes.compactMap { prefix in
      let display = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !display.isEmpty else { return nil }
      let key = comparisonKey(display)
      guard seen.insert(key).inserted else { return nil }
      return display
    }
  }

  public static func shouldOmit(title: String, prefixes: [String]) -> Bool {
    let normalizedTitle = comparisonKey(title)
    return normalizedPrefixes(prefixes).contains { normalizedTitle.hasPrefix(comparisonKey($0)) }
  }

  private static func comparisonKey(_ value: String) -> String {
    value.folding(
      options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
      locale: Locale(identifier: "en_US_POSIX")
    )
  }
}
