import Foundation

/// A canonical email address used for Person identity and exact contact matching.
///
/// The normalizer deliberately performs only conservative normalization: surrounding
/// whitespace is removed and casing is folded. It never guesses at a malformed address.
public enum PersonEmail {
  public static func normalize(_ value: String) throws -> String {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let parts = normalized.split(separator: "@", omittingEmptySubsequences: false)
    guard !normalized.isEmpty,
      !normalized.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }),
      parts.count == 2,
      !parts[0].isEmpty,
      !parts[1].isEmpty
    else { throw PersonEmailValidationError.invalid(value) }
    return normalized
  }

  /// Produces the conservative comparison key used for legacy stored values.
  /// Invalid legacy data remains invalid for new writes, but case and surrounding
  /// whitespace do not prevent it from being found or cleaned up.
  public static func normalizedForComparison(_ value: String) -> String {
    (try? normalize(value)) ?? value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }
}

public enum PersonEmailValidationError: Error, Equatable, LocalizedError, Sendable {
  case invalid(String)

  public var errorDescription: String? {
    switch self {
    case .invalid: "Enter an email address with one @ and nonempty local and domain parts."
    }
  }
}

/// Resolves the visible Person label without allowing a device contact to overwrite authored data.
public enum PersonDisplayName {
  /// The stable email fallback for a Person. Invalid values never take part in identity or display.
  public static func canonicalEmail(from emails: [String]) -> String? {
    Array(Set(emails.compactMap { try? PersonEmail.normalize($0) })).sorted().first
  }

  /// Whether a title is an un-authored fallback that may be replaced by a locally linked contact.
  ///
  /// A local-part title is considered a fallback only for the old calendar-attendee projection that
  /// generated it. A manually named Person with the same text remains authored data.
  public static func isSafeFallbackTitle(
    _ title: String,
    emails: [String],
    origin: PersonOrigin?
  ) -> Bool {
    let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedTitle.isEmpty,
      normalizedTitle.localizedCaseInsensitiveCompare("Untitled") != .orderedSame
    else { return true }

    let normalizedEmails = Set(emails.compactMap { try? PersonEmail.normalize($0) })
    let comparableTitle = PersonEmail.normalizedForComparison(normalizedTitle)
    if normalizedEmails.contains(comparableTitle) { return true }

    guard origin == .calendarAttendee else { return false }
    return normalizedEmails.contains { email in
      comparableTitle == String(email.prefix { $0 != "@" })
    }
  }

  public static func linkedContactName(
    emails: [String],
    contactLink: PersonContactLink?
  ) -> String? {
    guard let contactLink,
      Set(emails.compactMap { try? PersonEmail.normalize($0) }).contains(
        PersonEmail.normalizedForComparison(contactLink.matchedEmail)
      )
    else { return nil }
    let name = contactLink.record.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? nil : name
  }

  public static func resolved(
    title: String,
    emails: [String],
    origin: PersonOrigin?,
    contactLink: PersonContactLink?
  ) -> String {
    let canonicalTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard isSafeFallbackTitle(canonicalTitle, emails: emails, origin: origin) else {
      return canonicalTitle
    }
    if let contactName = linkedContactName(emails: emails, contactLink: contactLink) {
      return contactName
    }
    return canonicalEmail(from: emails) ?? "Untitled"
  }

  public static func contactNameSuggestion(
    title: String,
    emails: [String],
    origin: PersonOrigin?,
    contactLink: PersonContactLink?
  ) -> String? {
    guard isSafeFallbackTitle(title, emails: emails, origin: origin),
      let name = linkedContactName(emails: emails, contactLink: contactLink),
      name != title.trimmingCharacters(in: .whitespacesAndNewlines)
    else { return nil }
    return name
  }
}

public enum PersonContactNameAdoptionOutcome: Sendable {
  case adopted(PageSnapshot)
  case unchanged(PageSnapshot)
  case unavailable
}

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
    PersonEmail.normalizedForComparison(email)
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
