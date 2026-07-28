import EnchiridionCore
import SwiftUI

struct SupertagPropertiesView: View {
  let store: LibraryStore
  let pageID: PageID

  private var page: PageSnapshot? { store.page(id: pageID) }

  var body: some View {
    Form {
      if let page {
        Section("Supertags") {
          if page.objectMetadata.supertagIDs.isEmpty {
            Text("Add a Supertag to turn this page into a typed object.")
              .foregroundStyle(.secondary)
          }
          ForEach(page.objectMetadata.supertagIDs) { tagID in
            if let definition = store.supertags.first(where: { $0.id == tagID }) {
              Label(definition.name, systemImage: definition.symbol)
                .contextMenu {
                  Button("Remove \(definition.name)", role: .destructive) {
                    store.removeSupertag(tagID, from: pageID)
                  }
                }
            }
          }
          Menu("Add Supertag", systemImage: "number") {
            ForEach(store.supertags.filter { !page.objectMetadata.supertagIDs.contains($0.id) }) { tag in
              Button { store.addSupertag(tag.id, to: pageID) } label: {
                Label(tag.name, systemImage: tag.symbol)
              }
            }
          }
        }

        if page.hasSupertag(BuiltInSupertags.person) {
          PersonIdentitySection(
            store: store,
            page: page,
            contactLink: store.contactLinks[page.id]
          )
        }

        ForEach(page.objectMetadata.supertagIDs) { tagID in
          if let definition = store.supertags.first(where: { $0.id == tagID }) {
            Section(definition.name) {
              ForEach(definition.fields.filter { !$0.isDeleted }) { field in
                SupertagFieldEditor(
                  store: store,
                  page: page,
                  tag: definition,
                  field: field
                )
              }
            }
          }
        }

        if !page.objectMetadata.conflicts.isEmpty {
          Section("Needs attention") {
            ForEach(page.objectMetadata.conflicts) { conflict in
              Label(
                "Conflicting values for \(fieldName(conflict.key))",
                systemImage: "exclamationmark.triangle"
              )
              .foregroundStyle(.orange)
              ForEach(Array(conflict.candidates.enumerated()), id: \.offset) { _, candidate in
                Button(candidate.map(\.displayValue).joined(separator: ", ")) {
                  store.setProperty(
                    pageID: pageID,
                    supertagID: conflict.key.supertagID,
                    fieldID: conflict.key.fieldID,
                    values: candidate
                  )
                }
              }
            }
          }
        }
      }
    }
    .formStyle(.grouped)
    .navigationTitle("Properties")
  }

  private func fieldName(_ key: SupertagPropertyKey) -> String {
    store.supertags.first(where: { $0.id == key.supertagID })?
      .fields.first(where: { $0.id == key.fieldID })?.name ?? key.fieldID.rawValue
  }
}

private struct PersonIdentitySection: View {
  let store: LibraryStore
  let page: PageSnapshot
  let contactLink: PersonContactLink?

  var body: some View {
    Section("Person") {
      LabeledContent("Visibility", value: page.isOtherPerson ? "Other" : "Promoted")
      if page.isOtherPerson {
        Button("Promote", systemImage: "person.badge.plus") {
          Task { await store.promotePerson(page.id) }
        }
        Text("Promotion makes this person available in views and @ mentions.")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else if page.personOrigin == .calendarAttendee {
        Button("Move to Other", systemImage: "person.crop.circle.badge.minus") {
          Task { await store.movePersonToOther(page.id) }
        }
      }

      if let contact = contactLink?.record {
        Divider()
        LabeledContent("Device contact", value: contact.displayName)
        if let role = contactRole(contact) {
          LabeledContent("Work", value: role)
        }
        if let email = contact.emails.first {
          LabeledContent("Email", value: email)
        }
        if let phone = contact.phoneNumbers.first {
          LabeledContent("Phone", value: phone)
        }
        Button("Copy Contact Details to Person", systemImage: "square.and.arrow.down") {
          copyContactDetails(contact)
        }
        Text("The contact card stays on this device. Copying writes the selected details into this Person page so they can sync.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      if DeviceContactsResolver.authorizationStatus.canReadContacts {
        DeviceContactPickerButton(
          page: page,
          store: store,
          hasExistingLink: contactLink != nil
        )
        if contactLink != nil {
          Button("Unlink Device Contact", systemImage: "person.crop.circle.badge.xmark") {
            Task { await store.removeContactLink(for: page.id) }
          }
        }
      }
    }
  }

  private func contactRole(_ contact: DeviceContactRecord) -> String? {
    let values = [contact.jobTitle, contact.organizationName]
      .compactMap { value -> String? in
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
      }
    guard !values.isEmpty else { return nil }
    return values.joined(separator: " at ")
  }

  private func copyContactDetails(_ contact: DeviceContactRecord) {
    let existingEmails = page.objectMetadata.properties[
      SupertagPropertyKey(supertagID: BuiltInSupertags.person, fieldID: .init(rawValue: "email"))
    ] ?? []
    let emails = Array(Set(existingEmails + contact.emails.map(SupertagValue.email)))
    store.setProperty(
      pageID: page.id,
      supertagID: BuiltInSupertags.person,
      fieldID: .init(rawValue: "email"),
      values: emails
    )
    store.setProperty(
      pageID: page.id,
      supertagID: BuiltInSupertags.person,
      fieldID: .init(rawValue: "phone"),
      values: contact.phoneNumbers.map(SupertagValue.phone)
    )
    if let jobTitle = contact.jobTitle, !jobTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      store.setProperty(
        pageID: page.id,
        supertagID: BuiltInSupertags.person,
        fieldID: .init(rawValue: "role"),
        values: [.text(jobTitle)]
      )
    }
    if let birthday = contact.birthday,
      let year = birthday.year,
      let date = Calendar.current.date(
        from: DateComponents(
          year: year,
          month: birthday.month,
          day: birthday.day
        )
      )
    {
      store.setProperty(
        pageID: page.id,
        supertagID: BuiltInSupertags.person,
        fieldID: .init(rawValue: "birthday"),
        values: [.date(date)]
      )
    }
  }
}

private struct SupertagFieldEditor: View {
  let store: LibraryStore
  let page: PageSnapshot
  let tag: SupertagDefinition
  let field: SupertagFieldDefinition

  @State private var text = ""
  @State private var number = 0.0
  @State private var boolean = false
  @State private var date = Date()
  @State private var selectedOption = ""
  @State private var selectedPages: Set<PageID> = []

  private var key: SupertagPropertyKey {
    .init(supertagID: tag.id, fieldID: field.id)
  }

  private var values: [SupertagValue] { page.objectMetadata.properties[key] ?? [] }

  var body: some View {
    Group {
      switch field.type {
      case .text, .url, .email, .phone:
        TextField(field.name, text: $text, axis: field.isMultiline ? .vertical : .horizontal)
          .lineLimit(field.isMultiline ? 2...8 : 1...1)
          .onSubmit(saveText)
      case .number:
        LabeledContent(field.name) {
          TextField("0", value: $number, format: .number)
            .multilineTextAlignment(.trailing)
            .onSubmit { save([.number(number)]) }
        }
      case .boolean:
        Toggle(field.name, isOn: $boolean)
          .onChange(of: boolean) { _, value in save([.boolean(value)]) }
      case .date, .dateTime:
        DatePicker(
          field.name,
          selection: $date,
          displayedComponents: field.type == .date ? .date : [.date, .hourAndMinute]
        )
        .onChange(of: date) { _, value in
          save(field.type == .date ? [.date(value)] : [.dateTime(value)])
        }
      case .select:
        Picker(field.name, selection: $selectedOption) {
          Text("None").tag("")
          ForEach(field.options) { option in Text(option.name).tag(option.id) }
        }
        .onChange(of: selectedOption) { _, value in save(value.isEmpty ? [] : [.select(value)]) }
      case .entityReference:
        Menu {
          ForEach(referenceCandidates) { candidate in
            Button {
              if field.allowsMultiple {
                if selectedPages.contains(candidate.id) { selectedPages.remove(candidate.id) }
                else { selectedPages.insert(candidate.id) }
              } else {
                selectedPages = [candidate.id]
              }
              save(selectedPages.map(SupertagValue.page))
            } label: {
              if selectedPages.contains(candidate.id) {
                Label(candidate.displayTitle, systemImage: "checkmark")
              } else {
                Text(candidate.displayTitle)
              }
            }
          }
        } label: {
          LabeledContent(field.name) {
            Text(selectedPageNames.isEmpty ? "None" : selectedPageNames)
              .foregroundStyle(selectedPageNames.isEmpty ? .secondary : .primary)
          }
        }
      }
    }
    .task(id: values) { hydrate() }
  }

  private var referenceCandidates: [PageSnapshot] {
    store.pages.filter { candidate in
      candidate.deletedAt == nil && field.allowedSupertagIDs.contains(where: candidate.hasSupertag)
    }
  }

  private var selectedPageNames: String {
    selectedPages.compactMap { store.page(id: $0)?.displayTitle }.joined(separator: ", ")
  }

  private func hydrate() {
    text = values.compactMap { value -> String? in
      switch value {
      case .text(let value), .url(let value), .email(let value), .phone(let value): value
      default: nil
      }
    }.joined(separator: field.allowsMultiple ? ", " : "")
    if case .number(let value)? = values.first { number = value }
    if case .boolean(let value)? = values.first { boolean = value }
    if case .date(let value)? = values.first { date = value }
    if case .dateTime(let value)? = values.first { date = value }
    if case .select(let value)? = values.first { selectedOption = value } else { selectedOption = "" }
    selectedPages = Set(values.compactMap { if case .page(let id) = $0 { id } else { nil } })
  }

  private func saveText() {
    let parts = field.allowsMultiple
      ? text.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
      : [text.trimmingCharacters(in: .whitespacesAndNewlines)]
    let values: [SupertagValue] = parts.filter { !$0.isEmpty }.map { value in
      switch field.type {
      case .url: .url(value)
      case .email: .email(value)
      case .phone: .phone(value)
      default: .text(value)
      }
    }
    save(values)
  }

  private func save(_ values: [SupertagValue]) {
    store.setProperty(pageID: page.id, supertagID: tag.id, fieldID: field.id, values: values)
  }
}
