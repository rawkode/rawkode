import EnchiridionCore
import SwiftUI

struct SupertagPropertiesView: View {
  let store: LibraryStore
  let pageID: PageID
  let navigationTitle: String

  init(
    store: LibraryStore,
    pageID: PageID,
    navigationTitle: String = "Properties"
  ) {
    self.store = store
    self.pageID = pageID
    self.navigationTitle = navigationTitle
  }

  private var page: PageSnapshot? { store.page(id: pageID) }

  var body: some View {
    Form {
      if let page {
        conflictsSection(for: page)

        if page.hasSupertag(BuiltInSupertags.person) {
          PersonIdentitySection(
            store: store,
            page: page,
            contactLink: store.contactLinks[page.id]
          )
        }

        ForEach(visibleDefinitions(on: page)) { definition in
          if !visibleFields(in: definition, on: page).isEmpty {
            Section(definition.name) {
              ForEach(visibleFields(in: definition, on: page)) { field in
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

        Section("Types") {
          if page.objectMetadata.supertagIDs.isEmpty {
            Text("Add a type to define properties for this page.")
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
          Menu("Add Type", systemImage: "number") {
            ForEach(store.supertags.filter { !page.objectMetadata.supertagIDs.contains($0.id) }) { tag in
              Button { store.addSupertag(tag.id, to: pageID) } label: {
                Label(tag.name, systemImage: tag.symbol)
              }
            }
          }
        }
      }
    }
    .formStyle(.grouped)
    .navigationTitle(navigationTitle)
  }

  @ViewBuilder
  private func conflictsSection(for page: PageSnapshot) -> some View {
    if !page.objectMetadata.conflicts.isEmpty {
      Section("Needs Attention") {
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

  private func visibleFields(
    in definition: SupertagDefinition,
    on page: PageSnapshot
  ) -> [SupertagFieldDefinition] {
    definition.fields.enumerated()
      .filter { _, field in
        !field.isDeleted
          && !(definition.isBuiltIn && field.id.rawValue == "notes")
          && !(
            definition.id == BuiltInSupertags.project
              && field.id == ProjectFields.closedAt.fieldID
          )
      }
      .sorted { lhs, rhs in
        let lhsRank = fieldRank(lhs.element, in: definition, on: page)
        let rhsRank = fieldRank(rhs.element, in: definition, on: page)
        return lhsRank == rhsRank ? lhs.offset < rhs.offset : lhsRank < rhsRank
      }
      .map(\.element)
  }

  private func visibleDefinitions(on page: PageSnapshot) -> [SupertagDefinition] {
    var ordered: [SupertagDefinition] = []
    var visited: Set<TagID> = []
    func append(_ id: TagID) {
      guard visited.insert(id).inserted,
        let definition = store.supertags.first(where: { $0.id == id })
      else { return }
      for parentID in definition.parentIDs { append(parentID) }
      ordered.append(definition)
    }
    for tagID in page.objectMetadata.supertagIDs { append(tagID) }
    return ordered
  }

  private func fieldRank(
    _ field: SupertagFieldDefinition,
    in definition: SupertagDefinition,
    on page: PageSnapshot
  ) -> Int {
    let key = SupertagPropertyKey(supertagID: definition.id, fieldID: field.id)
    let isPopulated = !(page.objectMetadata.properties[key] ?? []).isEmpty
    if field.isRequired && isPopulated { return 0 }
    if field.isRequired { return 1 }
    if isPopulated { return 2 }
    return 3
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
      PersonNameEditor(page: page, store: store)

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
  @FocusState private var isTextFieldFocused: Bool

  private var key: SupertagPropertyKey {
    .init(supertagID: tag.id, fieldID: field.id)
  }

  private var values: [SupertagValue] { page.objectMetadata.properties[key] ?? [] }

  var body: some View {
    Group {
      switch field.type {
      case .text, .url, .email, .phone:
        TextField(fieldLabel, text: $text, axis: field.isMultiline ? .vertical : .horizontal)
          .lineLimit(field.isMultiline ? 2...8 : 1...1)
          .focused($isTextFieldFocused)
          .onSubmit(saveText)
          .onChange(of: isTextFieldFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { saveText() }
          }
      case .number:
        LabeledContent(fieldLabel) {
          TextField("0", value: $number, format: .number)
            .multilineTextAlignment(.trailing)
            .onSubmit { save([.number(number)]) }
        }
      case .boolean:
        Toggle(fieldLabel, isOn: $boolean)
          .onChange(of: boolean) { _, value in save([.boolean(value)]) }
      case .date, .dateTime:
        DatePicker(
          fieldLabel,
          selection: $date,
          displayedComponents: field.type == .date ? .date : [.date, .hourAndMinute]
        )
        .onChange(of: date) { _, value in
          save(field.type == .date ? [.date(value)] : [.dateTime(value)])
        }
      case .select:
        VStack(alignment: .leading, spacing: 5) {
          Picker(fieldLabel, selection: $selectedOption) {
            Text("None").tag("")
            ForEach(selectableOptions) { option in Text(option.name).tag(option.id) }
          }
          .disabled(isClosedProjectStatus)
          .onChange(of: selectedOption) { _, value in
            save(value.isEmpty ? [] : [.select(value)])
          }

          if isBuiltInProjectStatus {
            Text(projectStatusGuidance)
              .font(.caption)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
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
          LabeledContent(fieldLabel) {
            Text(selectedPageNames.isEmpty ? "None" : selectedPageNames)
              .foregroundStyle(selectedPageNames.isEmpty ? .secondary : .primary)
          }
        }
      }
    }
    .task(id: values) { hydrate() }
    .onDisappear {
      if field.type == .text || field.type == .url || field.type == .email
        || field.type == .phone
      {
        saveText()
      }
    }
  }

  private var fieldLabel: String {
    field.isRequired ? "\(field.name) (Required)" : field.name
  }

  private var isBuiltInProjectStatus: Bool {
    tag.id == BuiltInSupertags.project && field.id == ProjectFields.status.fieldID
  }

  private var isClosedProjectStatus: Bool {
    currentProjectStatus?.isOpen == false
  }

  private var selectableOptions: [SupertagSelectOption] {
    guard isBuiltInProjectStatus else { return field.options }
    let currentOptionID = currentProjectStatus?.rawValue ?? selectedOption
    return field.options.filter { option in
      guard let status = ProjectStatus(rawValue: option.id) else { return false }
      return status.isOpen || option.id == currentOptionID
    }
  }

  private var currentProjectStatus: ProjectStatus? {
    guard isBuiltInProjectStatus else { return nil }
    if let status = page.projectData?.status { return status }
    guard case .select(let value)? = values.first else { return nil }
    return ProjectStatus(rawValue: value)
  }

  private var projectStatusGuidance: String {
    isClosedProjectStatus
      ? "Reopen this project from its task list. Its tasks stay as they are."
      : "Complete or cancel this project from its task list so unfinished tasks can be resolved safely."
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
    guard values != self.values else { return }
    store.setProperty(pageID: page.id, supertagID: tag.id, fieldID: field.id, values: values)
  }
}
