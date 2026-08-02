import EnchiridionCore
import SwiftUI

/// A confirmation-first editor for the target of a graph relationship. Suggestions remain local,
/// editable drafts until the person explicitly chooses Create and Link.
struct EntityRelationshipCreationView: View {
  let store: LibraryStore
  let intent: GraphRelationshipAuthoringIntent
  let compatibleTypes: [SupertagDefinition]
  let didCreate: () -> Void

  @Environment(\.dismiss) private var dismiss
  @FocusState private var focusedField: FocusedField?
  @State private var selectedTypeID: SupertagID?
  @State private var title = ""
  @State private var details = ""
  @State private var drafts: [SupertagPropertyKey: EntityRelationshipScalarDraft] = [:]
  @State private var personCandidates: [PersonEmailCandidate] = []
  @State private var selectedExistingPersonID: PageID?
  @State private var personCandidateLookupState: PersonCandidateLookupState = .idle
  @State private var suggestionState: SuggestionState = .idle
  @State private var activeSuggestionRequest: SuggestionRequest?
  @State private var suggestionTask: Task<Void, Never>?
  @State private var errorMessage: String?
  @State private var isCreating = false

  private let autofill = FoundationModelEntityAutofill()

  init(
    store: LibraryStore,
    intent: GraphRelationshipAuthoringIntent,
    compatibleTypes: [SupertagDefinition],
    didCreate: @escaping () -> Void
  ) {
    self.store = store
    self.intent = intent
    self.compatibleTypes = compatibleTypes
    self.didCreate = didCreate
    _selectedTypeID = State(initialValue: compatibleTypes.count == 1 ? compatibleTypes.first?.id : nil)
  }

  var body: some View {
    NavigationStack {
      Form {
        if compatibleTypes.count > 1 {
          Section("Entity type") {
            Picker("Type", selection: $selectedTypeID) {
              Text("Choose a type").tag(nil as SupertagID?)
              ForEach(compatibleTypes) { type in
                Label(type.name, systemImage: type.symbol)
                  .tag(type.id as SupertagID?)
              }
            }
          }
        }

        if let schema = selectedSchema {
          if isLinkingExistingPerson {
            existingPersonSummary
          } else {
            creationFields(for: schema)
          }

          if personCandidateLookupState == .loading {
            personCandidateLoadingState
          } else if personCandidateLookupState == .failed {
            personCandidateLookupFailure
          } else if !personCandidates.isEmpty {
            matchingPeoplePicker
          }
        } else {
          ContentUnavailableView(
            "Choose an entity type",
            systemImage: "tag",
            description: Text("This relationship supports more than one type.")
          )
        }
      }
      .formStyle(.grouped)
      .navigationTitle("Create \(relationshipTitle)")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .scrollDismissesKeyboard(.interactively)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(isCreating ? "Creating…" : primaryActionTitle) {
            Task { await createAndLink() }
          }
          .disabled(!canCreate)
          .accessibilityIdentifier("create-and-link")
          .accessibilityHint(primaryActionAccessibilityHint)
        }
      }
      .task(id: selectedTypeID) {
        resetDraftsForSelectedType()
        focusedField = .name
      }
      .onChange(of: selectedTypeID) {
        invalidateSuggestionRequest()
        clearPersonCandidates()
      }
      .onChange(of: details) {
        invalidateSuggestionRequest()
      }
      .onChange(of: selectedExistingPersonID) {
        invalidateSuggestionRequest()
      }
      .task(id: personCandidateRefreshID) {
        await refreshPersonCandidates()
      }
      .alert("Cannot Create Relationship", isPresented: errorBinding) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(errorMessage ?? "Review the fields and try again.")
      }
    }
    .accessibilityIdentifier("entity-relationship-creation")
    .onDisappear {
      invalidateSuggestionRequest()
    }
    #if os(macOS)
    .frame(minWidth: 440, minHeight: 540)
    #endif
  }

  private var selectedSchema: SupertagDefinition? {
    compatibleTypes.first(where: { $0.id == selectedTypeID })
  }

  private var relationshipTitle: String {
    intent.direction == .forward ? intent.relation.forwardName : intent.relation.inverseName
  }

  private var effectiveFields: [SupertagEffectiveField] {
    guard let selectedTypeID else { return [] }
    return SupertagInheritance.effectiveFields(
      for: selectedTypeID,
      definitions: store.supertags
    )
  }

  private var scalarFields: [SupertagEffectiveField] {
    effectiveFields.filter {
      !$0.definition.isDeleted && $0.definition.type != .entityReference
    }
  }

  private var isPersonSchema: Bool {
    guard let selectedSchema else { return false }
    return SupertagInheritance.effectiveTagIDs(
      for: Set([selectedSchema.id]),
      definitions: store.supertags
    ).contains(BuiltInSupertags.person)
  }

  private var personEmailField: SupertagEffectiveField? {
    scalarFields.first { $0.propertyKey == Self.personEmailPropertyKey }
  }

  private var personEmail: String {
    guard isPersonSchema, let personEmailField else { return "" }
    return (drafts[personEmailField.propertyKey]?.text ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var personCandidateRefreshID: String {
    "\(selectedTypeID?.rawValue ?? "none")-\(personEmail.lowercased())"
  }

  private var canCreate: Bool {
    guard selectedSchema != nil, !isCreating else { return false }
    if isPersonSchema, !personEmail.isEmpty, personCandidateLookupState != .loaded {
      return false
    }
    if isLinkingExistingPerson {
      return !personEmail.isEmpty
    }
    return !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && personCandidates.isEmpty
  }

  private var isLinkingExistingPerson: Bool {
    selectedExistingPersonID != nil
  }

  private var primaryActionTitle: String {
    isLinkingExistingPerson ? "Link Existing Person" : "Create and Link"
  }

  private var primaryActionAccessibilityHint: String {
    isLinkingExistingPerson
      ? "Links the selected existing Person without changing it."
      : "Creates the entity and its relationship together."
  }

  @ViewBuilder
  private func creationFields(for schema: SupertagDefinition) -> some View {
    Section("Identity") {
      TextField("Name", text: $title)
        .focused($focusedField, equals: .name)
        .submitLabel(.next)
        .onSubmit { focusedField = .details }
        .accessibilityIdentifier("entity-relationship-name")
        .accessibilityHint("Required before creating and linking the entity.")
    }

    Section {
      TextField("Details for suggestions", text: $details, axis: .vertical)
        .focused($focusedField, equals: .details)
        .lineLimit(3...8)
        .accessibilityIdentifier("entity-relationship-details")
        .accessibilityHint("Only these details and the selected entity type are used for on-device suggestions.")

      suggestionControl(for: schema)
    } header: {
      Text("On-device suggestions")
    } footer: {
      Text("Suggestions are optional. They remain editable and are not saved until you create and link the entity.")
    }

    if !scalarFields.isEmpty {
      Section(suggestionState == .applied ? "Review suggestions" : "Properties") {
        ForEach(scalarFields) { field in
          scalarFieldEditor(field)
        }
      }
    }
  }

  private var matchingPeoplePicker: some View {
    Section("Matching people") {
      Picker("Use existing Person", selection: $selectedExistingPersonID) {
        Text("Choose a Person").tag(nil as PageID?)
        ForEach(personCandidates) { candidate in
          Text("\(candidate.displayName) · \(candidate.email)")
            .tag(candidate.pageID as PageID?)
        }
      }
      Text("A Person already uses this email. Choose the intended record before linking it.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private var personCandidateLoadingState: some View {
    Section("Matching people") {
      HStack(spacing: 8) {
        ProgressView()
        Text("Checking for existing People")
      }
      Text("Choose an existing Person if this email is already in use.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private var personCandidateLookupFailure: some View {
    Section("Matching people") {
      Label("Couldn’t check existing People", systemImage: "exclamationmark.triangle")
        .foregroundStyle(.secondary)
      Text("Try the email again before creating a Person.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private var existingPersonSummary: some View {
    Section("Link existing Person") {
      if let selectedExistingPerson {
        LabeledContent("Selected") {
          Text("\(selectedExistingPerson.displayName) · \(selectedExistingPerson.email)")
        }
      }
      Text("This links the selected Person without changing its name, details, or properties. Choose a different Person below to change the selection.")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }

  private var selectedExistingPerson: PersonEmailCandidate? {
    personCandidates.first(where: { $0.pageID == selectedExistingPersonID })
  }

  @ViewBuilder
  private func suggestionControl(for schema: SupertagDefinition) -> some View {
    switch suggestionState {
    case .loading:
      HStack(spacing: 8) {
        ProgressView()
        Text("Generating on-device suggestions")
      }
      .accessibilityLabel("Generating on-device suggestions")
    case .unavailable(let message):
      Label(message, systemImage: "apple.intelligence")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    case .failed(let message):
      VStack(alignment: .leading, spacing: 8) {
        Label(message, systemImage: "exclamationmark.triangle")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        suggestionButton(for: schema)
      }
    case .idle, .applied:
      suggestionButton(for: schema)
    }
  }

  private func suggestionButton(for schema: SupertagDefinition) -> some View {
    Button {
      Task { await suggest(for: schema) }
    } label: {
      Label(
        suggestionState == .applied ? "Refresh suggestions" : "Suggest details",
        systemImage: "wand.and.stars"
      )
    }
    .disabled(details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    .accessibilityIdentifier("entity-relationship-suggestions")
    .accessibilityHint("Uses only the details entered above and the selected entity type.")
  }

  @ViewBuilder
  private func scalarFieldEditor(_ field: SupertagEffectiveField) -> some View {
    let definition = field.definition
    switch definition.type {
    case .text, .url, .email, .phone:
      TextField(fieldLabel(field), text: textBinding(for: field), axis: definition.isMultiline ? .vertical : .horizontal)
        .lineLimit(definition.isMultiline ? 2...6 : 1...1)
    case .number:
      TextField(fieldLabel(field), text: textBinding(for: field))
        #if os(iOS)
        .keyboardType(.decimalPad)
        #endif
    case .boolean:
      Picker(fieldLabel(field), selection: textBinding(for: field)) {
        Text("Not set").tag("")
        Text("Yes").tag("true")
        Text("No").tag("false")
      }
    case .date, .dateTime:
      Toggle("Set \(fieldLabel(field))", isOn: dateIncludedBinding(for: field))
      if draft(for: field).includesDate {
        DatePicker(
          fieldLabel(field),
          selection: dateBinding(for: field),
          displayedComponents: definition.type == .date ? .date : [.date, .hourAndMinute]
        )
      }
    case .select:
      Picker(fieldLabel(field), selection: textBinding(for: field)) {
        Text("Not set").tag("")
        ForEach(definition.options) { option in
          Text(option.name).tag(option.id)
        }
      }
    case .entityReference:
      EmptyView()
    }
  }

  private func fieldLabel(_ field: SupertagEffectiveField) -> String {
    let definition = field.definition
    return definition.isRequired ? "\(definition.name) (Required)" : definition.name
  }

  private func draft(for field: SupertagEffectiveField) -> EntityRelationshipScalarDraft {
    drafts[field.propertyKey] ?? .init()
  }

  private func textBinding(for field: SupertagEffectiveField) -> Binding<String> {
    Binding(
      get: { draft(for: field).text },
      set: { value in
        var draft = draft(for: field)
        draft.text = value
        drafts[field.propertyKey] = draft
        if field.propertyKey == Self.personEmailPropertyKey {
          clearPersonCandidates()
        }
      }
    )
  }

  private func dateIncludedBinding(for field: SupertagEffectiveField) -> Binding<Bool> {
    Binding(
      get: { draft(for: field).includesDate },
      set: { value in
        var draft = draft(for: field)
        draft.includesDate = value
        drafts[field.propertyKey] = draft
      }
    )
  }

  private func dateBinding(for field: SupertagEffectiveField) -> Binding<Date> {
    Binding(
      get: { draft(for: field).date },
      set: { value in
        var draft = draft(for: field)
        draft.date = value
        drafts[field.propertyKey] = draft
      }
    )
  }

  private func resetDraftsForSelectedType() {
    invalidateSuggestionRequest()
    drafts = Dictionary(uniqueKeysWithValues: scalarFields.map { ($0.propertyKey, EntityRelationshipScalarDraft()) })
    personCandidates = []
    selectedExistingPersonID = nil
    personCandidateLookupState = .idle
    suggestionState = .idle
  }

  private func refreshPersonCandidates() async {
    guard isPersonSchema, !personEmail.isEmpty else {
      clearPersonCandidates()
      return
    }
    let email = personEmail
    personCandidateLookupState = .loading
    do {
      let candidates = try await store.personEmailCandidates(matchingEmail: email)
      guard !Task.isCancelled, personEmail == email, isPersonSchema else { return }
      personCandidates = candidates
      if !candidates.contains(where: { $0.pageID == selectedExistingPersonID }) {
        selectedExistingPersonID = nil
      }
      personCandidateLookupState = .loaded
    } catch is CancellationError {
      return
    } catch {
      guard personEmail == email, isPersonSchema else { return }
      personCandidates = []
      selectedExistingPersonID = nil
      personCandidateLookupState = .failed
    }
  }

  private func clearPersonCandidates() {
    personCandidates = []
    selectedExistingPersonID = nil
    personCandidateLookupState = .idle
  }

  private func suggest(for schema: SupertagDefinition) async {
    let userProvidedDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !userProvidedDetails.isEmpty else { return }

    invalidateSuggestionRequest()
    let request = SuggestionRequest(schemaID: schema.id, details: userProvidedDetails)
    activeSuggestionRequest = request
    suggestionState = .loading
    suggestionTask = Task {
      let result = await autofill.propose(
        .init(
          schema: schema,
          effectiveFields: effectiveFields,
          userProvidedDetails: userProvidedDetails
        )
      )
      guard !Task.isCancelled, isCurrentSuggestionRequest(request) else { return }

      suggestionTask = nil
      switch result {
      case .proposal(let proposal):
        apply(proposal)
        suggestionState = .applied
      case .unavailable(let availability):
        suggestionState = .unavailable(availability.message)
      case .failed(let message):
        suggestionState = .failed(message)
      }
    }
  }

  private func invalidateSuggestionRequest() {
    suggestionTask?.cancel()
    suggestionTask = nil
    activeSuggestionRequest = nil
    if suggestionState != .idle {
      suggestionState = .idle
    }
  }

  private func isCurrentSuggestionRequest(_ request: SuggestionRequest) -> Bool {
    activeSuggestionRequest == request
      && selectedTypeID == request.schemaID
      && details.trimmingCharacters(in: .whitespacesAndNewlines) == request.details
  }

  private func apply(_ proposal: EntityAutofillProposal) {
    if let suggestedTitle = proposal.title, !suggestedTitle.isEmpty {
      title = suggestedTitle
    }
    for field in scalarFields {
      guard let values = proposal.properties[field.propertyKey] else { continue }
      drafts[field.propertyKey] = .init(values: values)
    }
  }

  private func createAndLink() async {
    guard let schema = selectedSchema else { return }
    isCreating = true
    defer { isCreating = false }
    do {
      let initialProperties = isLinkingExistingPerson ? [:] : try initialProperties()
      let existingPersonResolution = selectedExistingPersonID.map {
        ExistingPersonResolution.useExistingMatchingEmail(
          pageID: $0,
          matchingEmail: personEmail
        )
      }
      _ = try await store.createEntityAndRelationship(
        .init(
          intent: intent,
          selectedTargetTypeID: schema.id,
          title: isLinkingExistingPerson ? "" : title,
          initialProperties: initialProperties,
          existingPersonResolution: existingPersonResolution
        )
      )
      didCreate()
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func initialProperties() throws -> [SupertagPropertyKey: [SupertagValue]] {
    var properties: [SupertagPropertyKey: [SupertagValue]] = [:]
    for field in scalarFields {
      let definition = field.definition
      let values = try draft(for: field).values(for: definition)
      if definition.isRequired, values.isEmpty {
        throw EntityRelationshipCreationError.requiredField(definition.name)
      }
      guard !values.isEmpty else { continue }
      properties[field.propertyKey] = values
    }
    return properties
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }

  private enum FocusedField: Hashable {
    case name
    case details
  }

  private static let personEmailPropertyKey = SupertagPropertyKey(
    supertagID: BuiltInSupertags.person,
    fieldID: .init(rawValue: "email")
  )
}

private struct EntityRelationshipScalarDraft: Hashable {
  var text = ""
  var date = Date()
  var includesDate = false

  init() {}

  init(values: [SupertagValue]) {
    self.init()
    guard let value = values.first else {
      return
    }
    switch value {
    case .text(_), .select(_), .url(_), .email(_), .phone(_):
      text = values.compactMap { value in
        switch value {
        case .text(let value), .select(let value), .url(let value), .email(let value), .phone(let value): value
        default: nil
        }
      }.joined(separator: ", ")
    case .number(let value):
      text = value.formatted()
    case .boolean(let value):
      text = value ? "true" : "false"
    case .date(let value), .dateTime(let value):
      date = value
      includesDate = true
    case .page:
      break
    }
  }

  func values(for field: SupertagFieldDefinition) throws -> [SupertagValue] {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    switch field.type {
    case .text, .url, .email, .phone:
      let strings = field.allowsMultiple
        ? trimmed.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
        : [trimmed]
      return strings.filter { !$0.isEmpty }.map { value in
        switch field.type {
        case .url: .url(value)
        case .email: .email(value)
        case .phone: .phone(value)
        default: .text(value)
        }
      }
    case .number:
      guard !trimmed.isEmpty else { return [] }
      guard let number = Double(trimmed) else {
        throw EntityRelationshipCreationError.invalidNumber(field.name)
      }
      return [.number(number)]
    case .boolean:
      switch trimmed {
      case "true": return [.boolean(true)]
      case "false": return [.boolean(false)]
      default: return []
      }
    case .date:
      return includesDate ? [.date(date)] : []
    case .dateTime:
      return includesDate ? [.dateTime(date)] : []
    case .select:
      return trimmed.isEmpty ? [] : [.select(trimmed)]
    case .entityReference:
      return []
    }
  }
}

private enum SuggestionState: Equatable {
  case idle
  case loading
  case unavailable(String)
  case failed(String)
  case applied
}

private enum PersonCandidateLookupState: Equatable {
  case idle
  case loading
  case loaded
  case failed
}

private struct SuggestionRequest: Equatable {
  let schemaID: SupertagID
  let details: String
}

private enum EntityRelationshipCreationError: LocalizedError {
  case requiredField(String)
  case invalidNumber(String)

  var errorDescription: String? {
    switch self {
    case .requiredField(let name): "\(name) is required."
    case .invalidNumber(let name): "\(name) needs a valid number."
    }
  }
}
