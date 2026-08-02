import EnchiridionCore
import SwiftUI

struct CalendarEventRelationshipPresentation: Equatable, Sendable {
  let title: String
  let dateText: String
  let attendeeContextText: String?
  let accessibilityLabel: String
  let accessibilityHint: String

  init(relationship: CalendarMeetingRelationship, dateText: String) {
    title = relationship.event.title
    self.dateText = dateText
    attendeeContextText = Self.attendeeContextText(for: relationship.attendeeContext)
    accessibilityLabel = ([relationship.event.title, dateText, attendeeContextText]
      .compactMap { $0 }
      .joined(separator: ", "))
    accessibilityHint = String(localized: "Imported calendar event. Opens its occurrence note.")
  }

  static func sectionTitle(for timing: CalendarMeetingRelationship.Timing) -> String {
    switch timing {
    case .upcoming: String(localized: "Upcoming events")
    case .past: String(localized: "Past events")
    }
  }

  static func emptyState(for timing: CalendarMeetingRelationship.Timing) -> String {
    switch timing {
    case .upcoming: String(localized: "No upcoming events")
    case .past: String(localized: "No past events")
    }
  }

  static var calendarFooter: String {
    String(localized: "Imported from Calendar. Opening an event creates or opens its occurrence note.")
  }

  private static func attendeeContextText(
    for context: CalendarMeetingRelationship.AttendeeContext?
  ) -> String? {
    guard let context else { return nil }
    return [context.role.flatMap(roleText), context.response.flatMap(responseText)]
      .compactMap { $0 }
      .joined(separator: " · ")
      .nonEmpty
  }

  private static func roleText(_ role: CalendarMeetingRelationship.AttendeeContext.Role) -> String {
    switch role {
    case .organizer: String(localized: "Organizer")
    case .chair: String(localized: "Chair")
    case .optional: String(localized: "Optional attendee")
    }
  }

  private static func responseText(
    _ response: CalendarMeetingRelationship.AttendeeContext.Response
  ) -> String {
    switch response {
    case .awaitingResponse: String(localized: "Awaiting response")
    case .tentative: String(localized: "Tentative")
    case .declined: String(localized: "Declined")
    case .delegated: String(localized: "Delegated")
    case .inProgress: String(localized: "In progress")
    }
  }
}

struct GraphRelationshipsView: View {
  let store: LibraryStore
  let pageID: NodeID
  let onOpenPage: ((PageID) -> Void)?

  @State private var relations: [RelationDefinition] = []
  @State private var outgoing: [KnowledgeEdge] = []
  @State private var backlinks: [GraphBacklink] = []
  @State private var meetings: [CalendarMeetingRelationship] = []
  @State private var issues: [GraphIssue] = []
  @State private var selectedDestination: RelationshipPickerDestination?
  @State private var errorMessage: String?

  var body: some View {
    List {
      if !pageIssues.isEmpty {
        Section("Needs Attention") {
          ForEach(pageIssues) { issue in
            Label(issue.message, systemImage: "exclamationmark.triangle")
              .foregroundStyle(.orange)
          }
        }
      }

      if isPerson {
        meetingsSection(timing: .upcoming)
          .accessibilityIdentifier("meeting-section-upcoming")
        meetingsSection(timing: .past)
          .accessibilityIdentifier("meeting-section-past")
      }

      Section("Relationships") {
        if outgoing.isEmpty {
          Text("No relationships yet")
            .foregroundStyle(.secondary)
        }
        ForEach(outgoing) { edge in
          relationshipRow(edge)
        }
        Menu {
          ForEach(authoringDestinations) { destination in
            Button(destination.title) { selectedDestination = destination }
          }
        } label: {
          Label("Add Relationship", systemImage: "plus")
        }
        .accessibilityIdentifier("create-relationship")
        .disabled(authoringDestinations.isEmpty)
      }

      Section("Backlinks") {
        if backlinks.isEmpty {
          Text("No pages point here")
            .foregroundStyle(.secondary)
        }
        ForEach(backlinks) { backlink in
          Button {
            onOpenPage?(backlink.edge.sourceNodeID)
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(backlink.sourceTitle)
                  .foregroundStyle(.primary)
                Text(backlink.relation.inverseName)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              Image(systemName: "arrow.up.left")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            }
          }
          .buttonStyle(.plain)
        }
      }
    }
    .formStyle(.grouped)
    .task(id: "\(pageID.rawValue)-\(store.calendarRelationshipGeneration)") { await load() }
    .sheet(item: $selectedDestination) { destination in
      GraphRelationshipTargetPicker(
        store: store,
        sourceID: pageID,
        relation: destination.relation,
        direction: destination.direction
      ) {
        selectedDestination = nil
        Task { await load() }
      }
    }
    .alert("Relationship Error", isPresented: errorBinding) {
      Button("Dismiss Error", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "The relationship could not be changed.")
    }
  }

  @ViewBuilder
  private func meetingsSection(
    timing: CalendarMeetingRelationship.Timing
  ) -> some View {
    let visibleMeetings = meetings.filter { $0.timing == timing }
    Section {
      if visibleMeetings.isEmpty {
        Text(CalendarEventRelationshipPresentation.emptyState(for: timing))
          .foregroundStyle(.secondary)
      } else {
        ForEach(visibleMeetings) { meeting in
          calendarMeetingRow(meeting)
        }
      }
    } header: {
      Label(CalendarEventRelationshipPresentation.sectionTitle(for: timing), systemImage: "calendar")
    } footer: {
      Text(CalendarEventRelationshipPresentation.calendarFooter)
    }
  }

  private func calendarMeetingRow(_ meeting: CalendarMeetingRelationship) -> some View {
    let presentation = CalendarEventRelationshipPresentation(
      relationship: meeting,
      dateText: meetingDateText(meeting.event)
    )
    return Button {
      Task {
        if let pageID = await store.openCalendarEventPage(meeting.event) {
          onOpenPage?(pageID)
        }
      }
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Image(systemName: "calendar")
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text(presentation.title)
            .foregroundStyle(.primary)
            .lineLimit(2)
          Text(presentation.dateText)
            .font(.subheadline)
            .foregroundStyle(.secondary)
          if let attendeeContextText = presentation.attendeeContextText {
            Text(attendeeContextText)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
          .accessibilityHidden(true)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("meeting-row-\(meeting.id)")
    .accessibilityLabel(presentation.accessibilityLabel)
    .accessibilityHint(presentation.accessibilityHint)
  }

  private var authoringDestinations: [RelationshipPickerDestination] {
    guard let page = store.page(id: pageID) else { return [] }
    let effectiveTags = SupertagInheritance.effectiveTagIDs(
      for: Set(page.objectMetadata.supertagIDs),
      definitions: store.supertags
    )
    return relations.flatMap { relation in
      var destinations: [RelationshipPickerDestination] = []
      if relation.sourceTagIDs.isEmpty || !effectiveTags.isDisjoint(with: relation.sourceTagIDs) {
        destinations.append(.init(relation: relation, direction: .forward))
      }
      if relation.targetTagIDs.isEmpty || !effectiveTags.isDisjoint(with: relation.targetTagIDs) {
        destinations.append(.init(relation: relation, direction: .inverse))
      }
      return destinations
    }
  }

  private var isPerson: Bool {
    guard let page = store.page(id: pageID) else { return false }
    let effectiveTags = SupertagInheritance.effectiveTagIDs(
      for: Set(page.objectMetadata.supertagIDs),
      definitions: store.supertags
    )
    return effectiveTags.contains(BuiltInSupertags.person)
  }

  private var pageIssues: [GraphIssue] {
    issues.filter { $0.nodeID == pageID }
  }

  @ViewBuilder
  private func relationshipRow(_ edge: KnowledgeEdge) -> some View {
    let relation = relations.first(where: { $0.id == edge.relationID })
    let target = store.page(id: edge.targetNodeID)
    HStack {
      Button {
        onOpenPage?(edge.targetNodeID)
      } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text(target?.displayTitle ?? "Unavailable page")
            .foregroundStyle(target == nil ? .secondary : .primary)
          Text(relation?.forwardName ?? edge.relationID.rawValue)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .buttonStyle(.plain)
      Spacer()
      if hasCardinalityConflict(edge) {
        Button("Keep This") {
          Task { await resolveConflict(keeping: edge) }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .help("Keep this relationship and remove the other conflicting values")
      }
      if edge.origin == .user {
        Button(role: .destructive) {
          Task { await remove(edge) }
        } label: {
          Label("Remove Relationship", systemImage: "minus.circle")
            .labelStyle(.iconOnly)
        }
        .buttonStyle(.borderless)
      }
    }
  }

  private func meetingDateText(_ event: CalendarEventSnapshot) -> String {
    event.startDate.formatted(
      date: .abbreviated,
      time: event.isAllDay ? .omitted : .shortened
    )
  }

  private func load() async {
    do {
      async let loadedRelations = store.graphRelationDefinitions()
      async let loadedOutgoing = store.graphOutgoingEdges(from: pageID)
      async let loadedBacklinks = store.graphBacklinks(to: pageID)
      async let loadedIssues = store.graphIssues()
      let loadedMeetings = isPerson
        ? try await store.calendarMeetingRelationships(for: pageID)
        : []
      relations = try await loadedRelations
      outgoing = try await loadedOutgoing
      backlinks = try await loadedBacklinks
      issues = try await loadedIssues
      meetings = loadedMeetings
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func remove(_ edge: KnowledgeEdge) async {
    do {
      try await store.removeGraphEdge(edge.id)
      await load()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func hasCardinalityConflict(_ edge: KnowledgeEdge) -> Bool {
    pageIssues.contains {
      $0.kind == .cardinalityViolation && $0.edgeID == edge.id
        && $0.relationID == edge.relationID
    }
  }

  private func resolveConflict(keeping edge: KnowledgeEdge) async {
    do {
      try await store.resolveGraphCardinalityConflict(
        relationID: edge.relationID,
        keeping: edge.id
      )
      await load()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}

private extension String {
  var nonEmpty: String? {
    isEmpty ? nil : self
  }
}

private struct RelationshipPickerDestination: Identifiable, Hashable {
  let relation: RelationDefinition
  let direction: GraphRelationshipDirection

  var id: String { "\(relation.id.rawValue)-\(direction.rawValue)" }
  var title: String { direction == .forward ? relation.forwardName : relation.inverseName }
}

private struct GraphRelationshipTargetPicker: View {
  let store: LibraryStore
  let sourceID: PageID
  let relation: RelationDefinition
  let direction: GraphRelationshipDirection
  let didCreate: () -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @State private var intent: GraphRelationshipAuthoringIntent?
  @State private var creationDestination: RelationshipCreationDestination?
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      Group {
        if let intent {
          let matchingCandidates = candidates(for: intent)
          List {
            Section {
              if matchingCandidates.isEmpty {
                ContentUnavailableView(
                  query.isEmpty ? "No compatible entities" : "No matching entities",
                  systemImage: query.isEmpty ? "square.stack.3d.up.slash" : "magnifyingglass",
                  description: Text(
                    query.isEmpty
                      ? "Create a compatible entity below to add this relationship."
                      : "Try another search or create a compatible entity below."
                  )
                )
                .accessibilityIdentifier("empty-compatible-relations")
              } else {
                ForEach(matchingCandidates) { page in
                  Button {
                    Task { await create(targetID: page.id, intent: intent) }
                  } label: {
                    VStack(alignment: .leading, spacing: 2) {
                      Text(displayName(for: page))
                        .foregroundStyle(.primary)
                      Text(typeNames(for: page))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                  }
                  .buttonStyle(.plain)
                }
              }
            } header: {
              Text("Existing entities")
            }

            Section {
              Button {
                creationDestination = .init(intent: intent)
              } label: {
                Label(createTitle(for: intent), systemImage: "plus")
              }
              .accessibilityIdentifier("create-compatible-relation")
            } header: {
              Text("Create")
            }
          }
          .sheet(item: $creationDestination) { destination in
            EntityRelationshipCreationView(
              store: store,
              intent: destination.intent,
              compatibleTypes: compatibleTypes(for: destination.intent)
            ) {
              creationDestination = nil
              dismiss()
              didCreate()
            }
          }
        } else if errorMessage == nil {
          ProgressView("Loading relationship options")
        } else {
          ContentUnavailableView(
            "Relationship unavailable",
            systemImage: "exclamationmark.triangle",
            description: Text(errorMessage ?? "This relationship can no longer be added.")
          )
        }
      }
      .navigationTitle("Add \(title)")
      .searchable(text: $query, prompt: "Find a page")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
      .task(id: "\(sourceID.rawValue)-\(relation.id.rawValue)-\(direction.rawValue)") {
        await loadIntent()
      }
      .alert("Cannot Add Relationship", isPresented: errorBinding) {
        Button("OK", role: .cancel) {}
      } message: {
        Text(errorMessage ?? "Choose a compatible page.")
      }
    }
    #if os(macOS)
    .frame(minWidth: 420, minHeight: 480)
    #endif
  }

  private var title: String {
    direction == .forward ? relation.forwardName : relation.inverseName
  }

  private func candidates(for intent: GraphRelationshipAuthoringIntent) -> [PageSnapshot] {
    let allPages = Dictionary(
      (store.pages + store.otherPeople).map { ($0.id, $0) },
      uniquingKeysWith: { first, _ in first }
    ).values
    return allPages.filter {
      $0.id != sourceID && $0.deletedAt == nil
        && (query.isEmpty || displayName(for: $0).localizedStandardContains(query))
        && isCompatibleTarget($0, intent: intent)
    }.sorted {
      displayName(for: $0).localizedStandardCompare(displayName(for: $1)) == .orderedAscending
    }
  }

  private func compatibleTypes(for intent: GraphRelationshipAuthoringIntent) -> [SupertagDefinition] {
    store.supertags.filter {
      !($0.isDeleted) && intent.compatibleTargetTypeIDs.contains($0.id)
    }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }

  private func createTitle(for intent: GraphRelationshipAuthoringIntent) -> String {
    let types = compatibleTypes(for: intent)
    guard types.count == 1, let type = types.first else { return "Create compatible entity" }
    return "Create \(type.name)"
  }

  private func isCompatibleTarget(_ page: PageSnapshot, intent: GraphRelationshipAuthoringIntent) -> Bool {
    let effectiveTags = SupertagInheritance.effectiveTagIDs(
      for: Set(page.objectMetadata.supertagIDs),
      definitions: store.supertags
    )
    return intent.compatibleTargetTypeIDs.contains { effectiveTags.contains($0) }
  }

  private func displayName(for page: PageSnapshot) -> String {
    let effectiveTags = SupertagInheritance.effectiveTagIDs(
      for: Set(page.objectMetadata.supertagIDs),
      definitions: store.supertags
    )
    return effectiveTags.contains(BuiltInSupertags.person)
      ? store.personDisplayName(for: page)
      : page.displayTitle
  }

  private func typeNames(for page: PageSnapshot) -> String {
    let names = page.objectMetadata.supertagIDs.compactMap { id in
      store.supertags.first(where: { $0.id == id })?.name
    }
    return names.isEmpty ? "Page" : names.joined(separator: " · ")
  }

  private func loadIntent() async {
    do {
      intent = try await store.graphRelationshipAuthoringIntent(
        relationID: relation.id,
        presentedSourceID: sourceID,
        direction: direction
      )
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func create(targetID: PageID, intent: GraphRelationshipAuthoringIntent) async {
    do {
      let endpoints = intent.canonicalEndpoints(selectedTargetID: targetID)
      _ = try await store.createGraphEdge(
        relationID: relation.id,
        from: endpoints.source,
        to: endpoints.target
      )
      dismiss()
      didCreate()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}

private struct RelationshipCreationDestination: Identifiable {
  let intent: GraphRelationshipAuthoringIntent

  var id: String {
    "\(intent.relation.id.rawValue)-\(intent.presentedSourceID.rawValue)-\(intent.direction.rawValue)"
  }
}

struct GraphIssuesView: View {
  let store: LibraryStore
  let onOpenPage: ((PageID) -> Void)?
  @State private var issues: [GraphIssue] = []
  @State private var errorMessage: String?

  var body: some View {
    List(issues) { issue in
      Button {
        onOpenPage?(issue.nodeID)
      } label: {
        VStack(alignment: .leading, spacing: 4) {
          Text(store.page(id: issue.nodeID)?.displayTitle ?? "Unavailable page")
            .foregroundStyle(.primary)
          Text(issue.message)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }
      .buttonStyle(.plain)
    }
    .overlay {
      if issues.isEmpty, errorMessage == nil {
        ContentUnavailableView(
          "Graph is consistent",
          systemImage: "checkmark.circle",
          description: Text("Relationship conflicts and unresolved targets appear here.")
        )
      }
    }
    .navigationTitle("Needs Attention")
    .task { await load() }
    .refreshable { await load() }
    .alert("Cannot Load Graph Issues", isPresented: errorBinding) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(errorMessage ?? "Graph issues could not be loaded.")
    }
  }

  private func load() async {
    do {
      issues = try await store.graphIssues()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { if !$0 { errorMessage = nil } }
    )
  }
}
