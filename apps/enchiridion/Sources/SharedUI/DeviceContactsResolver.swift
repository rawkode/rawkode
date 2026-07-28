import Contacts
import EnchiridionCore
import Foundation

enum DeviceContactsAuthorizationStatus: Equatable, Sendable {
  case notDetermined
  case restricted
  case denied
  case limited
  case authorized

  var title: String {
    switch self {
    case .notDetermined: "Not requested"
    case .restricted: "Restricted"
    case .denied: "Denied"
    case .limited: "Selected contacts"
    case .authorized: "Allowed"
    }
  }

  var canReadContacts: Bool {
    self == .limited || self == .authorized
  }

  var coreValue: DeviceContactsAuthorization {
    switch self {
    case .notDetermined: .notDetermined
    case .restricted: .restricted
    case .denied: .denied
    case .limited: .limited
    case .authorized: .authorized
    }
  }
}

/// The only bridge between Enchiridion and the device Contacts database.
/// It performs exact-email lookups and returns the deliberately small Core projection.
final class DeviceContactsResolver: DeviceContactResolving, @unchecked Sendable {
  private let contactStore: CNContactStore

  init(contactStore: CNContactStore = CNContactStore()) {
    self.contactStore = contactStore
  }

  static var authorizationStatus: DeviceContactsAuthorizationStatus {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .notDetermined: .notDetermined
    case .restricted: .restricted
    case .denied: .denied
    case .authorized: .authorized
#if os(iOS)
    case .limited: .limited
#endif
    @unknown default: .restricted
    }
  }

  func requestAccess() async throws -> Bool {
    try await withCheckedThrowingContinuation { continuation in
      contactStore.requestAccess(for: .contacts) { allowed, error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume(returning: allowed)
        }
      }
    }
  }

  func contact(matchingEmail email: String) async throws -> DeviceContactRecord? {
    guard Self.authorizationStatus.canReadContacts else { return nil }
    let normalizedEmail = DeviceContactRecord.normalizedEmail(email)
    guard !normalizedEmail.isEmpty else { return nil }

    let predicate = CNContact.predicateForContacts(matchingEmailAddress: normalizedEmail)
    let contacts = try contactStore.unifiedContacts(matching: predicate, keysToFetch: Self.keysToFetch())
      .filter { contact in
        contact.emailAddresses.contains {
          DeviceContactRecord.normalizedEmail($0.value as String) == normalizedEmail
        }
      }
    guard contacts.count == 1, let contact = contacts.first else { return nil }
    return Self.record(from: contact)
  }

  func contact(identifier: String) async throws -> DeviceContactRecord? {
    guard Self.authorizationStatus.canReadContacts else { return nil }
    let contact = try contactStore.unifiedContact(withIdentifier: identifier, keysToFetch: Self.keysToFetch())
    return Self.record(from: contact)
  }

  private static func keysToFetch() -> [CNKeyDescriptor] {
    [
      CNContactIdentifierKey as CNKeyDescriptor,
      CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
      CNContactOrganizationNameKey as CNKeyDescriptor,
      CNContactJobTitleKey as CNKeyDescriptor,
      CNContactEmailAddressesKey as CNKeyDescriptor,
      CNContactPhoneNumbersKey as CNKeyDescriptor,
      CNContactBirthdayKey as CNKeyDescriptor,
      CNContactThumbnailImageDataKey as CNKeyDescriptor,
    ]
  }

  static func record(from contact: CNContact) -> DeviceContactRecord {
    let fallbackName = contact.organizationName.nilIfBlank
      ?? contact.emailAddresses.first.map { $0.value as String }
      ?? "Contact"
    let birthday = contact.birthday.flatMap { components -> ContactBirthday? in
      guard let month = components.month, let day = components.day else { return nil }
      return ContactBirthday(year: components.year, month: month, day: day)
    }
    return DeviceContactRecord(
      identifier: contact.identifier,
      displayName: CNContactFormatter.string(from: contact, style: .fullName)?.nilIfBlank ?? fallbackName,
      organizationName: contact.organizationName.nilIfBlank,
      jobTitle: contact.jobTitle.nilIfBlank,
      emails: contact.emailAddresses.map { $0.value as String },
      phoneNumbers: contact.phoneNumbers.map { $0.value.stringValue },
      birthday: birthday,
      thumbnailData: contact.thumbnailImageData
    )
  }
}

private extension String {
  var nilIfBlank: String? {
    let value = trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }
}
