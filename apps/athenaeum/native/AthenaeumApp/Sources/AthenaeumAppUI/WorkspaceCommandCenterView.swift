import SwiftUI
import Combine
import AthenaeumDomain
import AthenaeumRPC
import AthenaeumCore

/// The native workspace shell keeps the daily note primary while giving every supporting tool a
/// stable destination. The old workspace was one long scroll of unrelated surfaces, which made a
/// morning note, graph inspection, agent review, and voice capture compete for the same attention.
/// A split view makes the information hierarchy explicit without replacing any of the existing
/// feature views or their real clients.
public struct WorkspaceCommandCenterView: View {
    @ObservedObject private var session: DevSession
    private let workspaceId: EntityId
    @State private var selection: WorkspaceSection = .today
    @State private var showingWorkspaceSwitcher = false
    @State private var searchQuery = ""
    @State private var browseExpanded = false
    @State private var selectedSearchNodeId: String?
    @State private var selectedGraphNodeId: String?
    @State private var selectedDirectEntityDestination: WorkspaceDirectEntityDestination?
    @State private var selectedReferencedTagId: EntityId?
    #if !os(macOS)
    @State private var iOSPath = NavigationPath()
    @State private var showingIOSBrowse = false
    #endif
    @StateObject private var host: WorkspaceCommandCenterHost

    public init(session: DevSession, workspaceId: EntityId) {
        self.session = session
        self.workspaceId = workspaceId
        _host = StateObject(
            wrappedValue: WorkspaceCommandCenterHost(
                baseURL: session.backendURL,
                workspaceId: workspaceId,
                bearerCredential: session.credential
            )
        )
    }

    public var body: some View {
        #if os(macOS)
        macOSShell
        #else
        iOSShell
        #endif
    }

    #if os(macOS)
    private var macOSShell: some View {
        NavigationSplitView {
            List(selection: $selection) {
                if !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Section("Search") {
                        if host.isSearching {
                            Label("Searching…", systemImage: "magnifyingglass")
                                .foregroundStyle(.secondary)
                        } else if let error = host.searchError {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(error, systemImage: "exclamationmark.triangle")
                                    .foregroundStyle(.secondary)
                                if WorkspaceSearchPresentation.canRetry(
                                    query: searchQuery,
                                    isSearching: host.isSearching,
                                    errorMessage: error
                                ) {
                                    Button("Retry search") {
                                        selectedSearchNodeId = nil
                                        host.search(query: searchQuery)
                                    }
                                    .buttonStyle(.borderless)
                                    .accessibilityHint("Retries the current note search.")
                                }
                            }
                        } else if host.searchRows.isEmpty {
                            Label("No matching notes", systemImage: "magnifyingglass")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(host.searchRows) { row in
                                Button {
                                    if let localDate = WorkspaceSearchResultPresentation.dailyNoteDate(for: row.id) {
                                        selectedSearchNodeId = nil
                                        openDailyNote(localDate, model: host.model)
                                    } else {
                                        selectedSearchNodeId = row.id
                                    }
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.title)
                                            .lineLimit(1)
                                        if !row.snippet.isEmpty {
                                            Text(row.snippet)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                                .listRowBackground(
                                    selectedSearchNodeId == row.id
                                        ? Color.accentColor.opacity(0.12)
                                        : Color.clear
                                )
                            }
                        }
                    }
                }

                Section("Core") {
                    ForEach(WorkspaceSection.coreSections) { section in
                        Label(section.title, systemImage: section.systemImage)
                            .tag(section)
                    }
                }
                DisclosureGroup("Browse", isExpanded: $browseExpanded) {
                    ForEach(WorkspaceIOSHomePresentation.browseSections) { section in
                        Label(section.title, systemImage: section.systemImage)
                            .tag(section)
                    }
                }
            }
            .listStyle(.sidebar)
            .searchable(text: $searchQuery, placement: .sidebar, prompt: "Search notes")
            .onChange(of: searchQuery) { value in
                selectedSearchNodeId = nil
                host.search(query: value)
            }
            .onChange(of: selection) { _ in
                selectedSearchNodeId = nil
                selectedGraphNodeId = nil
                selectedDirectEntityDestination = nil
                if !WorkspaceSection.coreSections.contains(selection) {
                    browseExpanded = true
                }
            }
            .navigationTitle("Athenaeum")
            .toolbar {
                ToolbarItem {
                    Button {
                        showingWorkspaceSwitcher = true
                    } label: {
                        Label("Switch workspace", systemImage: "square.stack.3d.up")
                    }
                    .help("Switch workspace")
                }
            }
        } detail: {
            detail
                .frame(maxWidth: 900, maxHeight: .infinity, alignment: .topLeading)
                .task { await host.start() }
        }
        .sheet(isPresented: $showingWorkspaceSwitcher) {
            WorkspaceSwitcherView(session: session)
                .frame(minWidth: 360, minHeight: 420)
        }
    }
    #else
    private var iOSShell: some View {
        NavigationStack(path: $iOSPath) {
            iOSHome
                .navigationTitle(WorkspaceIOSHomePresentation.navigationTitle(isToday: host.isSelectedDateToday))
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button {
                            showingIOSBrowse = true
                        } label: {
                            Label("Browse", systemImage: "square.grid.2x2")
                        }
                        .accessibilityHint("Opens search and supporting workspace tools.")
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { showingWorkspaceSwitcher = true } label: {
                            Label("Switch workspace", systemImage: "square.stack.3d.up")
                        }
                        .accessibilityHint("Opens the workspace chooser.")
                    }
                }
                .navigationDestination(for: WorkspaceRoute.self) { route in iOSDestination(route) }
                .task { await host.start() }
        }
        .sheet(isPresented: $showingIOSBrowse) {
            iOSBrowseSheet
        }
        .sheet(isPresented: $showingWorkspaceSwitcher) { WorkspaceSwitcherView(session: session) }
    }

    @ViewBuilder private var iOSHome: some View {
        if let model = host.model {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    iOSContent(WorkspaceIOSHomePresentation.homeSection, model: model)
                }
                .padding(24)
            }
        } else {
            startupError
        }
    }

    private var iOSBrowseSheet: some View {
        NavigationStack {
            List {
                if !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Section("Search") {
                        if host.isSearching {
                            Label("Searching…", systemImage: "magnifyingglass").foregroundStyle(.secondary)
                        } else if let error = host.searchError {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                                if WorkspaceSearchPresentation.canRetry(
                                    query: searchQuery,
                                    isSearching: host.isSearching,
                                    errorMessage: error
                                ) {
                                    Button("Retry search") {
                                        host.search(query: searchQuery)
                                    }
                                    .accessibilityHint("Retries the current note search.")
                                }
                            }
                        } else if host.searchRows.isEmpty {
                            Label("No matching notes", systemImage: "magnifyingglass").foregroundStyle(.secondary)
                        } else {
                            ForEach(host.searchRows) { row in
                                Button {
                                    openIOSBrowseRoute(WorkspaceSearchResultPresentation.route(for: row.id))
                                } label: {
                                    VStack(alignment: .leading) {
                                        Text(row.title)
                                        if !row.snippet.isEmpty {
                                            Text(row.snippet).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Section("Core") {
                    ForEach(WorkspaceIOSHomePresentation.browseCoreSections) { section in
                        Button {
                            openIOSBrowseRoute(.section(section))
                        } label: {
                            Label(section.title, systemImage: section.systemImage)
                        }
                    }
                }
                DisclosureGroup("Browse", isExpanded: $browseExpanded) {
                    ForEach(WorkspaceSection.browseSections) { section in
                        Button {
                            openIOSBrowseRoute(.section(section))
                        } label: {
                            Label(section.title, systemImage: section.systemImage)
                        }
                    }
                }
            }
            .searchable(text: $searchQuery, prompt: "Search notes")
            .onChange(of: searchQuery) { host.search(query: $0) }
            .navigationTitle("Browse")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { showingIOSBrowse = false }
                }
            }
        }
    }

    private func openIOSBrowseRoute(_ route: WorkspaceRoute) {
        if let localDate = WorkspaceIOSHomePresentation.dailyNoteDate(for: route) {
            iOSPath = NavigationPath()
            host.model?.showLocalDate(localDate)
        } else {
            iOSPath.append(route)
        }
        showingIOSBrowse = false
    }

    @ViewBuilder private func iOSDestination(_ route: WorkspaceRoute) -> some View {
        switch route {
        case .section(let section):
            if let model = host.model {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        iOSContent(section, model: model)
                    }
                    .padding(24)
                }
                .navigationTitle(section.title)
            } else {
                startupError
            }
        case .search(let id):
            if let result = host.searchRows.first(where: { $0.id == id }) {
                SearchResultDetailView(result: result, client: host.readClient, onClose: nil)
            } else {
                EmptyStateView(title: "Search result unavailable", systemImage: "exclamationmark.triangle", message: "This result is no longer available.")
            }
        case .dailyNote(let localDate):
            if let model = host.model {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        iOSContent(.today, model: model)
                    }
                    .padding(24)
                }
                .task(id: localDate) {
                    model.showLocalDate(localDate)
                }
                .navigationTitle(WorkspaceIOSHomePresentation.dailyNoteTitle)
            } else {
                startupError
            }
        case .graph(let id):
            if let node = host.model?.graphRows.first(where: { $0.id == id }) {
                GraphNodeDetailView(
                    node: node,
                    client: host.readClient,
                    sourceSection: .graph,
                    onClose: nil
                )
            } else {
                EmptyStateView(title: "Workspace entity unavailable", systemImage: "exclamationmark.triangle", message: "This entity is no longer available.")
            }
        case .entity(let entityNodeId):
            WorkspaceDirectEntityDetailView(
                destination: .entity(entityNodeId),
                client: host.readClient,
                onClose: nil
            )
        case .person(let personNodeId):
            WorkspaceDirectEntityDetailView(
                destination: .person(personNodeId),
                client: host.readClient,
                onClose: nil
            )
        case .employeeUpdate(let employeeUpdateNodeId):
            WorkspaceDirectEntityDetailView(
                destination: .employeeUpdate(employeeUpdateNodeId),
                client: host.readClient,
                onClose: nil
            )
        }
    }
    @ViewBuilder private func iOSContent(_ section: WorkspaceSection, model: AthenaeumViewModel) -> some View {
        switch section {
        case .meetings:
            MeetingsView(backendURL: session.backendURL, workspaceId: workspaceId, bearerCredential: session.credential) { iOSPath.append(WorkspaceRoute.voiceAction) }
        case .apps:
            AppsView(backendURL: session.backendURL, workspaceId: workspaceId, bearerCredential: session.credential) { iOSPath.append(WorkspaceRoute.agentAction) }
        case .graph:
            GraphNodesView(model: model) { iOSPath.append(WorkspaceRoute.graphID($0)) }
        case .brief:
            VStack(alignment: .leading, spacing: 20) {
                TodayBriefView(
                    backendURL: session.backendURL,
                    workspaceId: workspaceId,
                    bearerCredential: session.credential,
                    preparer: { brief, event in
                        try await model.prepareMeetingInDailyNote(brief: brief, event: event)
                    },
                    onOpenDailyNote: { localDate in
                        openDailyNote(localDate, model: model)
                    },
                    onOpenPerson: { personNodeId in
                        openPerson(personNodeId)
                    }
                )
                Divider()
                CalendarDayView(backendURL: session.backendURL, workspaceId: workspaceId, bearerCredential: session.credential) { iOSPath.append(WorkspaceRoute.graphID($0)) }
            }
        default: selectedContent(model: model, section: section)
        }
    }
    #endif

    @ViewBuilder
    private var detail: some View {
        if let result = selectedSearchResult {
            SearchResultDetailView(
                result: result,
                client: host.readClient,
                onClose: { selectedSearchNodeId = nil }
            )
        } else if let destination = selectedDirectEntityDestination {
            WorkspaceDirectEntityDetailView(
                destination: destination,
                client: host.readClient,
                onClose: { selectedDirectEntityDestination = nil }
            )
        } else if let node = selectedGraphNode {
            GraphNodeDetailView(
                node: node,
                client: host.readClient,
                sourceSection: selection,
                onClose: { selectedGraphNodeId = nil }
            )
        } else if let model = host.model {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if selection.showsDestinationHeader {
                        detailHeader
                    }
                    selectedContent(model: model)
                }
                .padding(24)
                .frame(maxWidth: 900, alignment: .leading)
            }
        } else {
            startupError
        }
    }

    private var selectedSearchResult: AthenaeumViewModel.SearchRow? {
        guard let selectedSearchNodeId else { return nil }
        return host.searchRows.first(where: { $0.id == selectedSearchNodeId })
    }

    private var selectedGraphNode: AthenaeumViewModel.GraphNodeRow? {
        guard let selectedGraphNodeId else { return nil }
        return host.model?.graphRows.first(where: { $0.id == selectedGraphNodeId })
    }

    private var detailHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(selection.title)
                .font(.largeTitle.bold())
            Text(selection.subtitle)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    /// The calendar projection follows the selected daily-note date. The identity reset is
    /// intentional: `TodayBriefView` owns a `StateObject` whose loader captures its reference
    /// date, so a historical-note transition must create a fresh model instead of retaining the
    /// previous day's request and lifecycle.
    @ViewBuilder
    private func dailyBrief(model: AthenaeumViewModel) -> some View {
        TodayBriefView(
            backendURL: session.backendURL,
            workspaceId: workspaceId,
            bearerCredential: session.credential,
            preparer: { brief, event in
                try await model.prepareMeetingInDailyNote(brief: brief, event: event)
            },
            onOpenDailyNote: { localDate in openDailyNote(localDate, model: model) },
            onOpenPerson: { personNodeId in openPerson(personNodeId) },
            referenceDate: model.isSelectedDateToday ? nil : model.selectedDate,
            isToday: model.isSelectedDateToday
        )
        .id(model.selectedDate)
    }

    @ViewBuilder
    private func selectedContent(model: AthenaeumViewModel, section: WorkspaceSection? = nil) -> some View {
        switch section ?? selection {
        case .today:
            #if os(macOS)
            HStack(alignment: .top, spacing: 24) {
                DailyNoteView(
                    model: model,
                    standupBackendURL: session.backendURL,
                    standupWorkspaceId: workspaceId,
                    standupBearerCredential: session.credential,
                    onOpenEmployeeUpdate: { nodeId in openEmployeeUpdate(nodeId) },
                    onOpenReference: { reference in openReference(reference) }
                )
                .frame(maxWidth: 600, alignment: .leading)
                dailyBrief(model: model)
                    .frame(minWidth: 280, maxWidth: 360, alignment: .leading)
            }
            #else
            DailyNoteView(
                model: model,
                standupBackendURL: session.backendURL,
                standupWorkspaceId: workspaceId,
                standupBearerCredential: session.credential,
                contextualView: AnyView(dailyBrief(model: model)),
                onOpenEmployeeUpdate: { nodeId in openEmployeeUpdate(nodeId) },
                onOpenReference: { reference in openReference(reference) }
            )
            #endif
        case .supertags:
            SupertagsView(
                backendURL: session.backendURL,
                workspaceId: workspaceId,
                bearerCredential: session.credential,
                onOpenToday: {
                    model.showToday()
                    #if os(macOS)
                    selection = .today
                    #else
                    iOSPath = NavigationPath()
                    #endif
                },
                initialSelectedTagId: selectedReferencedTagId
            )
        case .meetings:
            MeetingsView(
                backendURL: session.backendURL,
                workspaceId: workspaceId,
                bearerCredential: session.credential,
                onOpenVoice: { selection = .voice }
            )
        case .workouts:
            WorkoutsView(
                backendURL: session.backendURL,
                workspaceId: workspaceId,
                bearerCredential: session.credential
            )
        case .apps:
            AppsView(
                backendURL: session.backendURL,
                workspaceId: workspaceId,
                bearerCredential: session.credential,
                onOpenAgent: { selection = .agent }
            )
        case .graph:
            GraphNodesView(model: model) { nodeId in
                selectedGraphNodeId = nodeId
            }
        case .agent:
            PendingChangesView(model: host.agentModel)
        case .brief:
            VStack(alignment: .leading, spacing: 20) {
                TodayBriefView(
                    backendURL: session.backendURL,
                    workspaceId: workspaceId,
                    bearerCredential: session.credential,
                    preparer: { brief, event in
                        try await model.prepareMeetingInDailyNote(brief: brief, event: event)
                    },
                    onOpenDailyNote: { localDate in openDailyNote(localDate, model: model) },
                    onOpenPerson: { personNodeId in openPerson(personNodeId) }
                )
                Divider()
                CalendarDayView(
                    backendURL: session.backendURL,
                    workspaceId: workspaceId,
                    bearerCredential: session.credential,
                    onOpenEntity: { nodeId in
                        selectedGraphNodeId = nodeId
                    }
                )
            }
        case .bookmarks:
            BookmarksView(
                backendURL: session.backendURL,
                workspaceId: workspaceId,
                bearerCredential: session.credential
            )
        case .voice:
            VoiceAssistantView(
                backendURL: session.backendURL,
                workspaceId: workspaceId,
                bearerCredential: session.credential
            )
        case .sharing:
            if let credential = session.credential {
                SharePanelView(
                    backendURL: session.backendURL,
                    workspaceId: workspaceId,
                    bearerCredential: credential
                )
            } else {
                EmptyStateView(
                    title: "Sign in to share",
                    systemImage: "person.2",
                    message: "Sharing is available for an authenticated workspace."
                )
            }
        }
    }

    private func openDailyNote(_ localDate: LocalDate, model: AthenaeumViewModel?) {
        guard let model else { return }
        model.showLocalDate(localDate)
        #if os(macOS)
        selection = .today
        #else
        iOSPath = NavigationPath()
        #endif
    }

    private var startupError: some View {
        VStack(alignment: .leading, spacing: 16) {
            EmptyStateView(
                title: "Couldn't start Athenaeum",
                systemImage: "exclamationmark.triangle",
                message: host.startupError ?? "The local workspace store could not be opened."
            )

            Button("Choose another workspace") {
                session.deselectWorkspace()
            }
            .buttonStyle(.borderedProminent)
            .accessibilityHint("Returns to the workspace chooser so you can recover with another workspace.")
        }
        .padding(32)
    }

    private func openPerson(_ personNodeId: EntityId) {
        #if os(macOS)
        selectedSearchNodeId = nil
        selectedGraphNodeId = nil
        selectedDirectEntityDestination = .person(personNodeId)
        #else
        iOSPath.append(WorkspaceRoute.personID(personNodeId))
        #endif
    }

    private func openEmployeeUpdate(_ employeeUpdateNodeId: EntityId) {
        #if os(macOS)
        selectedSearchNodeId = nil
        selectedGraphNodeId = nil
        selectedDirectEntityDestination = .employeeUpdate(employeeUpdateNodeId)
        #else
        iOSPath.append(WorkspaceRoute.employeeUpdateID(employeeUpdateNodeId))
        #endif
    }

    private func openReference(_ reference: LoroCanonicalSemanticValueV1.InlineReference) {
        switch reference.kind {
        case .entity:
            #if os(macOS)
            selectedSearchNodeId = nil
            selectedGraphNodeId = nil
            selectedDirectEntityDestination = .entity(reference.id)
            #else
            iOSPath.append(.entity(reference.id))
            #endif
        case .supertag:
            selectedReferencedTagId = reference.id
            #if os(macOS)
            selection = .supertags
            #else
            iOSPath.append(.section(.supertags))
            #endif
        }
    }
}

private struct SearchResultDetailView: View {
    let result: AthenaeumViewModel.SearchRow
    let client: WorkspaceRPCClient
    let onClose: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label("Search result", systemImage: "magnifyingglass")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                #if os(macOS)
                if let onClose {
                    Button(WorkspaceSearchResultPresentation.backButtonTitle, action: onClose)
                        .keyboardShortcut(.escape, modifiers: [])
                        .accessibilityHint("Returns to the current search results.")
                }
                #endif
            }
            Text(result.title)
                .font(.largeTitle.bold())
            if result.snippet.isEmpty {
                Text("This node matched by title. Open it from the graph or a linked note to continue working with it.")
                    .foregroundStyle(.secondary)
            } else {
                Text(result.snippet)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Text("Search results are read-only previews. Your daily note and graph remain the authoritative work surfaces.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.top, 8)
            EntityPagePreview(nodeId: result.id, client: client)
        }
        .frame(maxWidth: 900, maxHeight: .infinity, alignment: .topLeading)
        .padding(32)
    }
}

private struct GraphNodeDetailView: View {
    let node: AthenaeumViewModel.GraphNodeRow
    let client: WorkspaceRPCClient
    let sourceSection: WorkspaceSection
    let onClose: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Label("Workspace entity", systemImage: "circle.hexagongrid")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                #if os(macOS)
                if let onClose {
                    Button(WorkspaceGraphDetailPresentation.backButtonTitle(for: sourceSection), action: onClose)
                        .keyboardShortcut(.escape, modifiers: [])
                }
                #endif
            }
            Text(node.title)
                .font(.largeTitle.bold())
                .textSelection(.enabled)
            VStack(alignment: .leading, spacing: 8) {
                Label {
                    Text("Created \(node.createdAt)")
                } icon: {
                    Image(systemName: "clock")
                }
                Label {
                    Text(node.id)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                } icon: {
                    Image(systemName: "number")
                }
            }
            .foregroundStyle(.secondary)
            Divider()
            EntityPagePreview(nodeId: node.id, client: client)
        }
        .frame(maxWidth: 900, maxHeight: .infinity, alignment: .topLeading)
        .padding(32)
    }
}

/// A verified direct entity reference. The route keeps the opaque `EntityId` all the way to the
/// RPC reader; the decoded wire ID must match before a page preview may be composed.
enum WorkspaceDirectEntityDestination: Hashable {
    case entity(EntityId)
    case person(EntityId)
    case employeeUpdate(EntityId)

    var nodeId: EntityId {
        switch self {
        case .entity(let nodeId), .person(let nodeId), .employeeUpdate(let nodeId): return nodeId
        }
    }

    var presentation: WorkspaceDirectEntityPresentation {
        switch self {
        case .entity: return .entity
        case .person: return .person
        case .employeeUpdate: return .employeeUpdate
        }
    }
}

struct WorkspaceDirectEntityNode: Equatable, Sendable {
    let id: EntityId
    let title: String
}

typealias WorkspaceDirectEntityReader = (EntityId) async throws -> WorkspaceDirectEntityNode

enum WorkspaceDirectEntityLoadError: Error {
    case mismatchedNodeIdentity
}

enum WorkspaceDirectEntityLoadState: Equatable {
    case idle
    case loading
    case loaded(WorkspaceDirectEntityNode)
    case notFound
    case failed
}

struct WorkspaceDirectEntityPresentation: Equatable {
    let title: String
    let systemImage: String
    let loadingTitle: String
    let missingTitle: String
    let missingMessage: String
    let failureMessage: String
    let retryTitle: String
    let retryingTitle: String
    let retryHint: String

    static let person = WorkspaceDirectEntityPresentation(
        title: "Person", systemImage: "person", loadingTitle: "Loading person…",
        missingTitle: "Person unavailable", missingMessage: "This person is no longer available in this workspace.",
        failureMessage: "Person details are unavailable right now.", retryTitle: "Retry person",
        retryingTitle: "Retrying person…", retryHint: "Retries the person details read."
    )
    static let entity = WorkspaceDirectEntityPresentation(
        title: "Workspace entity", systemImage: "circle.hexagongrid", loadingTitle: "Loading entity…",
        missingTitle: "Entity unavailable", missingMessage: "This referenced entity is no longer available in this workspace.",
        failureMessage: "Referenced entity details are unavailable right now.", retryTitle: "Retry entity",
        retryingTitle: "Retrying entity…", retryHint: "Retries the referenced entity details read."
    )
    static let employeeUpdate = WorkspaceDirectEntityPresentation(
        title: "Employee update", systemImage: "doc.text", loadingTitle: "Loading employee update…",
        missingTitle: "Employee update unavailable", missingMessage: "This employee update is no longer available in this workspace.",
        failureMessage: "Employee update details are unavailable right now.", retryTitle: "Retry employee update",
        retryingTitle: "Retrying employee update…", retryHint: "Retries the employee update details read."
    )

    static func state(for error: Error) -> WorkspaceDirectEntityLoadState {
        guard let domainError = error as? AthenaeumDomainError else { return .failed }
        if case .nodeNotFound = domainError {
            return .notFound
        }
        return .failed
    }

    static func canComposePagePreview(
        state: WorkspaceDirectEntityLoadState,
        for nodeId: EntityId
    ) -> Bool {
        guard case .loaded(let node) = state else { return false }
        return node.id == nodeId
    }

    static func canRetry(state: WorkspaceDirectEntityLoadState) -> Bool {
        state == .failed
    }
}

@MainActor
final class WorkspaceDirectEntityLoader: ObservableObject {
    @Published private(set) var state: WorkspaceDirectEntityLoadState = .idle

    private let readNode: WorkspaceDirectEntityReader
    private var generation = 0

    init(readNode: @escaping WorkspaceDirectEntityReader) {
        self.readNode = readNode
    }

    /// A newer route or retry wins. A late result is intentionally invisible rather than being
    /// able to overwrite the current direct entity destination.
    func load(nodeId: EntityId) async {
        generation &+= 1
        let activeGeneration = generation
        state = .loading
        do {
            let node = try await readNode(nodeId)
            guard activeGeneration == generation else { return }
            guard node.id == nodeId else {
                state = .failed
                return
            }
            state = .loaded(node)
        } catch {
            guard activeGeneration == generation else { return }
            state = WorkspaceDirectEntityPresentation.state(for: error)
        }
    }
}

private struct WorkspaceDirectEntityDetailView: View {
    let destination: WorkspaceDirectEntityDestination
    let client: WorkspaceRPCClient
    let onClose: (() -> Void)?
    @StateObject private var loader: WorkspaceDirectEntityLoader
    @State private var isRetrying = false

    init(
        destination: WorkspaceDirectEntityDestination,
        client: WorkspaceRPCClient,
        onClose: (() -> Void)?
    ) {
        self.destination = destination
        self.client = client
        self.onClose = onClose
        _loader = StateObject(
            wrappedValue: WorkspaceDirectEntityLoader(readNode: { requestedNodeId in
                let node = try await client.getNode(nodeId: requestedNodeId.rawValue)
                guard node.id == requestedNodeId.rawValue else {
                    throw WorkspaceDirectEntityLoadError.mismatchedNodeIdentity
                }
                return WorkspaceDirectEntityNode(id: requestedNodeId, title: node.title)
            })
        )
    }

    var body: some View {
        let presentation = destination.presentation
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(presentation.title, systemImage: presentation.systemImage)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                #if os(macOS)
                if let onClose {
                    Button("Back", action: onClose)
                        .keyboardShortcut(.escape, modifiers: [])
                        .accessibilityHint("Returns to the current workspace destination.")
                }
                #endif
            }

            switch loader.state {
            case .idle, .loading:
                ProgressView(presentation.loadingTitle)
                    .foregroundStyle(.secondary)
            case .loaded(let node) where node.id == destination.nodeId:
                Text(node.title)
                    .font(.largeTitle.bold())
                    .textSelection(.enabled)
                EntityPagePreview(nodeId: node.id.rawValue, client: client)
                    .id(node.id)
            case .loaded:
                ProgressView(presentation.loadingTitle)
                    .foregroundStyle(.secondary)
            case .notFound:
                EmptyStateView(
                    title: presentation.missingTitle,
                    systemImage: "exclamationmark.triangle",
                    message: presentation.missingMessage
                )
            case .failed:
                VStack(alignment: .leading, spacing: 8) {
                    Label(
                        presentation.failureMessage,
                        systemImage: "exclamationmark.triangle"
                    )
                        .foregroundStyle(.secondary)
                    Button(isRetrying ? presentation.retryingTitle : presentation.retryTitle) {
                        retry()
                    }
                    .buttonStyle(.bordered)
                    .disabled(
                        isRetrying || !WorkspaceDirectEntityPresentation.canRetry(state: loader.state)
                    )
                    .accessibilityHint(presentation.retryHint)
                }
            }
        }
        .frame(maxWidth: 900, maxHeight: .infinity, alignment: .topLeading)
        .padding(32)
        .task(id: destination) {
            isRetrying = false
            await loader.load(nodeId: destination.nodeId)
        }
    }

    private func retry() {
        guard !isRetrying else { return }
        isRetrying = true
        Task { @MainActor in
            await loader.load(nodeId: destination.nodeId)
            isRetrying = false
        }
    }
}

enum WorkspaceEntityPagePreviewLoadState: Equatable {
    case idle
    case loading
    case loaded(String)
    case unavailable
    case failed
}

enum WorkspaceEntityPagePreviewPresentation {
    static let failureMessage = "Page content is unavailable right now."

    static func canRetry(state: WorkspaceEntityPagePreviewLoadState) -> Bool {
        state == .failed
    }

    /// The retry marker belongs to the view because it only closes the gap before SwiftUI
    /// renders the existing loading state. Page reads, routing, and their RPC inputs remain
    /// unchanged.
    static func canStartRetry(
        state: WorkspaceEntityPagePreviewLoadState,
        retryingNodeId: String?
    ) -> Bool {
        canRetry(state: state) && retryingNodeId == nil
    }

    static func loadingTitle(nodeId: String, retryingNodeId: String?) -> String {
        retryingNodeId == nodeId ? "Retrying page…" : "Loading page…"
    }

    static func retryingNodeId(
        afterCompleting nodeId: String,
        retryingNodeId: String?
    ) -> String? {
        retryingNodeId == nodeId ? nil : retryingNodeId
    }
}

private struct EntityPagePreview: View {
    let nodeId: String
    let client: WorkspaceRPCClient
    @State private var state: WorkspaceEntityPagePreviewLoadState = .idle
    @State private var retryingNodeId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Page content", systemImage: "doc.text")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
            switch state {
            case .idle, .loading:
                ProgressView(
                    WorkspaceEntityPagePreviewPresentation.loadingTitle(
                        nodeId: nodeId,
                        retryingNodeId: retryingNodeId
                    )
                )
                    .foregroundStyle(.secondary)
            case .loaded(let text):
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("This entity has an empty page.")
                        .foregroundStyle(.secondary)
                } else {
                    ScrollView {
                        Text(text)
                            .font(.body)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 280)
                }
            case .unavailable:
                Text("No page document is attached to this entity yet.")
                    .foregroundStyle(.secondary)
            case .failed:
                VStack(alignment: .leading, spacing: 6) {
                    Label(WorkspaceEntityPagePreviewPresentation.failureMessage, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                    if WorkspaceEntityPagePreviewPresentation.canRetry(state: state) {
                        Button(
                            retryingNodeId == nodeId ? "Retrying page…" : "Retry page"
                        ) {
                            retryPage()
                        }
                        .buttonStyle(.bordered)
                        .disabled(
                            !WorkspaceEntityPagePreviewPresentation.canStartRetry(
                                state: state,
                                retryingNodeId: retryingNodeId
                            )
                        )
                        .accessibilityHint("Retries the page content read for this entity.")
                    }
                }
            }
        }
        .task(id: nodeId) {
            await loadPage()
        }
    }

    private func retryPage() {
        guard WorkspaceEntityPagePreviewPresentation.canStartRetry(
            state: state,
            retryingNodeId: retryingNodeId
        ) else { return }

        let retryNodeId = nodeId
        retryingNodeId = retryNodeId
        Task {
            await loadPage()
            retryingNodeId = WorkspaceEntityPagePreviewPresentation.retryingNodeId(
                afterCompleting: retryNodeId,
                retryingNodeId: retryingNodeId
            )
        }
    }

    private func loadPage() async {
        state = .loading
        do {
            let page = try await client.getPageText(nodeId: nodeId)
            state = .loaded(page.text)
        } catch let error as AthenaeumDomainError {
            if case .pageNotFound = error {
                state = .unavailable
            } else {
                state = .failed
            }
        } catch {
            state = .failed
        }
    }
}

private struct EmptyStateView: View {
    let title: String
    let systemImage: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, minHeight: 180)
    }
}

enum WorkspaceSection: String, CaseIterable, Identifiable, Hashable {
    case today
    case supertags
    case meetings
    case workouts
    case apps
    case graph
    case agent
    case brief
    case bookmarks
    case voice
    case sharing

    /// Keep the native sidebar's information hierarchy in lockstep with the web shell: Today and
    /// Supertags are the daily work surfaces; everything else is an occasional browse destination.
    static let coreSections: [WorkspaceSection] = [.today, .supertags]
    static let browseSections: [WorkspaceSection] = [
        .brief, .meetings, .workouts, .graph, .bookmarks, .apps, .voice, .agent, .sharing
    ]

    var id: String { rawValue }

    /// Today owns its own writing header. Other destinations retain the shell's contextual title.
    var showsDestinationHeader: Bool { self != .today }

    var title: String {
        switch self {
        case .today: return "Today"
        case .supertags: return "Supertags"
        case .meetings: return "Meetings"
        case .workouts: return "Workouts"
        case .apps: return "Apps"
        case .graph: return "Graph"
        case .agent: return "Agent review"
        case .brief: return "Calendar brief"
        case .bookmarks: return "Bookmarks"
        case .voice: return "Voice"
        case .sharing: return "Sharing"
        }
    }

    var subtitle: String {
        switch self {
        case .today: return "Write, review, and orient from your daily note."
        case .supertags: return "Inspect the typed vocabulary behind your entities."
        case .meetings: return "Review recorded conversations and their transcripts."
        case .workouts: return "Review imported health context as typed entities."
        case .apps: return "Inspect agent-authored applications and code snapshots."
        case .graph: return "Explore the connected entities in this workspace."
        case .agent: return "Inspect proposed changes before they enter the brain."
        case .brief: return "See the server-owned schedule for today."
        case .bookmarks: return "Capture references without leaving the workspace."
        case .voice: return "Capture a live conversation and its resulting work."
        case .sharing: return "Manage authenticated workspace sharing."
        }
    }

    var systemImage: String {
        switch self {
        case .today: return "sun.max"
        case .supertags: return "number.square"
        case .meetings: return "waveform"
        case .workouts: return "figure.run"
        case .apps: return "square.stack.3d.up"
        case .graph: return "circle.hexagongrid"
        case .agent: return "checkmark.shield"
        case .brief: return "calendar"
        case .bookmarks: return "bookmark"
        case .voice: return "waveform"
        case .sharing: return "person.2"
        }
    }
}

enum WorkspaceIOSHomePresentation {
    static let homeSection: WorkspaceSection = .today
    static let browseCoreSections: [WorkspaceSection] = [.supertags]
    static let browseSections = WorkspaceSection.browseSections
    static let dailyNoteTitle = "Daily note"

    static func navigationTitle(isToday: Bool) -> String {
        isToday ? "Today" : dailyNoteTitle
    }

    static func dailyNoteDate(for route: WorkspaceRoute) -> LocalDate? {
        guard case .dailyNote(let localDate) = route else { return nil }
        return localDate
    }
}

enum WorkspaceRoute: Hashable {
    case section(WorkspaceSection)
    case search(String)
    case dailyNote(LocalDate)
    case graph(String)
    case entity(EntityId)
    case person(EntityId)
    case employeeUpdate(EntityId)
    static let voiceAction = WorkspaceRoute.section(.voice)
    static let agentAction = WorkspaceRoute.section(.agent)
    static func graphID(_ id: String) -> WorkspaceRoute { .graph(id) }
    static func searchID(_ id: String) -> WorkspaceRoute { .search(id) }
    static func personID(_ id: EntityId) -> WorkspaceRoute { .person(id) }
    static func entityID(_ id: EntityId) -> WorkspaceRoute { .entity(id) }
    static func employeeUpdateID(_ id: EntityId) -> WorkspaceRoute { .employeeUpdate(id) }
}

enum WorkspaceGraphDetailPresentation {
    static func backButtonTitle(for sourceSection: WorkspaceSection) -> String {
        sourceSection == .brief ? "Back to calendar" : "Back to graph"
    }
}

enum WorkspaceSearchResultPresentation {
    static let backButtonTitle = "Back to search"

    static func dailyNoteDate(for nodeId: String) -> LocalDate? {
        localDateFromDailyNoteId(nodeId)
    }

    static func route(for nodeId: String) -> WorkspaceRoute {
        guard let localDate = dailyNoteDate(for: nodeId) else { return .search(nodeId) }
        return .dailyNote(localDate)
    }
}

enum WorkspaceSearchPresentation {
    static let failureMessage = "Search is unavailable right now."

    static func canRetry(query: String, isSearching: Bool, errorMessage: String?) -> Bool {
        errorMessage != nil &&
            !isSearching &&
            !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum WorkspaceStartupPresentation {
    static let failureMessage = "Athenaeum couldn’t start this workspace. Choose another workspace to try again."

    static func failureMessage(for _: Error) -> String {
        failureMessage
    }
}

@MainActor
private final class WorkspaceCommandCenterHost: ObservableObject {
    let model: AthenaeumViewModel?
    let agentModel: AgentEditViewModel
    let startupError: String?
    @Published private(set) var searchRows: [AthenaeumViewModel.SearchRow] = []
    @Published private(set) var searchError: String?
    @Published private(set) var isSearching = false
    @Published private(set) var isSelectedDateToday = true

    private let searchClient: WorkspaceRPCClient
    private var searchTask: Task<Void, Never>?
    private var selectedDateObserver: AnyCancellable?
    private var didStart = false

    var readClient: WorkspaceRPCClient { searchClient }

    init(baseURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        agentModel = AgentEditViewModel(
            baseURL: baseURL,
            workspaceId: workspaceId,
            bearerCredential: bearerCredential
        )
        let workspaceURL = baseURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        searchClient = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
        do {
            model = try AthenaeumViewModel(
                baseURL: baseURL,
                workspaceId: workspaceId,
                bearerCredential: bearerCredential
            )
            startupError = nil
            isSelectedDateToday = model?.isSelectedDateToday ?? true
            if let model {
                selectedDateObserver = model.$selectedDate
                    .receive(on: RunLoop.main)
                    .sink { [weak self, weak model] _ in
                        guard let self, let model else { return }
                        self.isSelectedDateToday = model.isSelectedDateToday
                    }
            }
        } catch {
            model = nil
            startupError = WorkspaceStartupPresentation.failureMessage(for: error)
        }
    }

    deinit {
        searchTask?.cancel()
    }

    func search(query: String) {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searchError = nil
        guard !trimmed.isEmpty else {
            searchRows = []
            isSearching = false
            return
        }

        isSearching = true
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled, let self else { return }
            do {
                let results = try await self.searchClient.searchNodes(query: trimmed, limit: 20)
                guard !Task.isCancelled else { return }
                self.searchRows = results.map {
                    AthenaeumViewModel.SearchRow(id: $0.nodeId.rawValue, title: $0.title, snippet: $0.snippet)
                }
                self.searchError = nil
            } catch {
                guard !Task.isCancelled else { return }
                self.searchRows = []
                self.searchError = WorkspaceSearchPresentation.failureMessage
            }
            self.isSearching = false
        }
    }

    func start() async {
        guard !didStart else { return }
        didStart = true
        if let model {
            await model.start()
        }
        await agentModel.start()
    }
}
