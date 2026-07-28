import EnchiridionCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct OtherPeopleView: View {
  let store: LibraryStore
  @State private var query = ""

  var body: some View {
    Group {
      if filteredPeople.isEmpty {
        ContentUnavailableView(
          query.isEmpty ? "No Other People" : "No Matches",
          systemImage: "person.2.slash",
          description: Text(
            query.isEmpty
              ? "People found in calendar events stay here until you promote them."
              : "Try a different name or email address."
          )
        )
      } else {
        List(filteredPeople) { person in
          OtherPersonRow(
            page: person,
            contactLink: store.contactLinks[person.id],
            promote: { Task { await store.promotePerson(person.id) } }
          )
        }
      }
    }
    .navigationTitle("Other People")
    .searchable(text: $query, prompt: "Search Other People")
  }

  private var filteredPeople: [PageSnapshot] {
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty else { return store.otherPeople }
    return store.otherPeople.filter { page in
      let contact = store.contactLinks[page.id]?.record
      return page.displayTitle.localizedStandardContains(value)
        || contact?.displayName.localizedStandardContains(value) == true
        || contact?.emails.contains(where: { $0.localizedStandardContains(value) }) == true
    }
  }
}

private struct OtherPersonRow: View {
  let page: PageSnapshot
  let contactLink: PersonContactLink?
  let promote: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      ContactAvatar(contact: contactLink?.record)

      VStack(alignment: .leading, spacing: 2) {
        Text(contactLink?.record.displayName.nilIfBlank ?? page.displayTitle)
          .font(.body.weight(.medium))
        if let detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }

      Spacer(minLength: 12)

      Button("Promote", action: promote)
        .buttonStyle(.bordered)
        .accessibilityHint("Shows this person in views and mention suggestions")
    }
    .padding(.vertical, 3)
  }

  private var detail: String? {
    guard let contact = contactLink?.record else { return personEmail }
    let role = [contact.jobTitle?.nilIfBlank, contact.organizationName?.nilIfBlank]
      .compactMap { $0 }
      .joined(separator: " at ")
    return role.nilIfBlank ?? contact.emails.first?.nilIfBlank ?? personEmail
  }

  private var personEmail: String? {
    for (key, values) in page.objectMetadata.properties
    where key.supertagID == BuiltInSupertags.person && key.fieldID.rawValue == "email" {
      for value in values {
        if case .email(let email) = value { return email.nilIfBlank }
      }
    }
    return nil
  }
}

private struct ContactAvatar: View {
  let contact: DeviceContactRecord?

  var body: some View {
    Group {
      if let image {
        image
          .resizable()
          .scaledToFill()
      } else {
        Image(systemName: contact == nil ? "person.crop.circle" : "person.crop.circle.badge.checkmark")
          .resizable()
          .scaledToFit()
          .foregroundStyle(contact == nil ? Color.secondary : Color.accentColor)
      }
    }
    .frame(width: 34, height: 34)
    .clipShape(.circle)
    .accessibilityHidden(true)
  }

  private var image: Image? {
    guard let data = contact?.thumbnailData else { return nil }
    #if os(macOS)
    guard let value = NSImage(data: data) else { return nil }
    return Image(nsImage: value)
    #else
    guard let value = UIImage(data: data) else { return nil }
    return Image(uiImage: value)
    #endif
  }
}

private extension String {
  var nilIfBlank: String? {
    let value = trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }
}
