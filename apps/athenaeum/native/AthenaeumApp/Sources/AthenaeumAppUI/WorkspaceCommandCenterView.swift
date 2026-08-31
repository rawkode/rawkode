import SwiftUI
import Combine
import AthenaeumDomain
import AthenaeumRPC
import AthenaeumCore
#if os(macOS)
import AppKit
#endif

/// The Today note is the primary work surface. Keep the calendar brief beside it only when both
/// remain useful at a desktop reading width; the same two subviews are laid out vertically when
/// the window or Dynamic Type would otherwise compress prose or actions.
enum TodayWorkspaceComposition {
    enum Mode: Equatable {
        case horizontal
        case stacked
    }

    static let minimumHorizontalWidth: CGFloat = 864

    static func mode(availableWidth: CGFloat?, isAccessibilitySize: Bool) -> Mode {
        guard !isAccessibilitySize else { return .stacked }
        guard let availableWidth else { return .horizontal }
        return availableWidth >= minimumHorizontalWidth ? .horizontal : .stacked
    }
}

/// Recall is a presentation concern over the existing single search lane. The generation fence
/// makes a deferred focus request inert when a newer shortcut has superseded it.
enum WorkspaceRecallPresentation {
    enum Phase: Equatable {
        case revealThenFocus
        case focus
    }

    struct Request: Equatable {
        let generation: Int
        let phase: Phase
        let query: String
        let selectedResultID: String?
    }

    static func request(
        generation: Int,
        sidebarIsVisible: Bool,
        query: String,
        selectedResultID: String?
    ) -> Request {
        .init(
            generation: generation,
            phase: sidebarIsVisible ? .focus : .revealThenFocus,
            query: query,
            selectedResultID: selectedResultID
        )
    }

    static func mayApplyDeferredFocus(requestGeneration: Int, currentGeneration: Int) -> Bool {
        requestGeneration == currentGeneration
    }
}

/// The macOS bridge retries only while its request is still current. This is kept independent of
/// AppKit so the ownership and retry contract can be verified without a hosted SwiftUI window.
enum SidebarSearchFocusPresentation {
    static let maximumAttempts = 8
    static let searchFieldIdentifier = "athenaeum.workspace.sidebar-search"
    static let searchPrompt = "Search notes"

    enum Disposition: Equatable {
        case retry
        case complete
        case stale
        case exhausted
    }

    static func disposition(
        requestGeneration: Int,
        activeGeneration: Int,
        attempt: Int,
        didFocus: Bool
    ) -> Disposition {
        guard requestGeneration == activeGeneration else { return .stale }
        guard !didFocus else { return .complete }
        return attempt + 1 < maximumAttempts ? .retry : .exhausted
    }

    static func acceptsSearchField(
        isInSidebarColumn: Bool,
        identifier: String?,
        placeholder: String?
    ) -> Bool {
        guard isInSidebarColumn else { return false }
        return identifier == searchFieldIdentifier || placeholder == searchPrompt
    }
}

#if os(macOS)
/// macOS 13 predates SwiftUI's searchable presentation/focus APIs. SwiftUI still owns the query
/// and split visibility; this tiny bridge only asks the sidebar's existing NSSearchField to become
/// first responder after the sidebar has been installed.
struct SidebarSearchFocusBridge: NSViewRepresentable {
    let requestGeneration: Int
    @Binding var activeGeneration: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView { NSView(frame: .zero) }

    func updateNSView(_ view: NSView, context: Context) {
        let coordinator = context.coordinator
        guard requestGeneration > 0,
              requestGeneration != coordinator.completedGeneration,
              requestGeneration != coordinator.pendingGeneration
        else { return }
        coordinator.pendingGeneration = requestGeneration
        scheduleFocus(from: view, requestGeneration: requestGeneration, activeGeneration: $activeGeneration, coordinator: coordinator, attempt: 0)
    }

    private func scheduleFocus(
        from view: NSView,
        requestGeneration: Int,
        activeGeneration: Binding<Int>,
        coordinator: Coordinator,
        attempt: Int
    ) {
        DispatchQueue.main.async {
            guard coordinator.pendingGeneration == requestGeneration else { return }
            guard activeGeneration.wrappedValue == requestGeneration else {
                coordinator.pendingGeneration = nil
                return
            }
            let searchField = Self.sidebarSearchField(from: view)
            let didFocus = searchField.flatMap { field in
                field.window.map { $0.makeFirstResponder(field) }
            } ?? false
            switch SidebarSearchFocusPresentation.disposition(
                requestGeneration: requestGeneration,
                activeGeneration: activeGeneration.wrappedValue,
                attempt: attempt,
                didFocus: didFocus
            ) {
            case .complete:
                coordinator.completedGeneration = requestGeneration
                coordinator.pendingGeneration = nil
            case .retry:
                self.scheduleFocus(
                    from: view,
                    requestGeneration: requestGeneration,
                    activeGeneration: activeGeneration,
                    coordinator: coordinator,
                    attempt: attempt + 1
                )
            case .stale, .exhausted:
                if coordinator.pendingGeneration == requestGeneration {
                    coordinator.pendingGeneration = nil
                }
            }
        }
    }

    /// Search only the direct NavigationSplitView child that owns this background view. A detail
    /// search field therefore cannot win merely because it is elsewhere in the window hierarchy.
    static func sidebarSearchField(from view: NSView) -> NSSearchField? {
        guard let sidebarColumn = sidebarColumnHost(from: view) else { return nil }
        let fields = searchFields(in: sidebarColumn)
        if let marked = fields.first(where: {
            SidebarSearchFocusPresentation.acceptsSearchField(
                isInSidebarColumn: true,
                identifier: $0.identifier?.rawValue,
                placeholder: $0.placeholderString
            ) && $0.identifier?.rawValue == SidebarSearchFocusPresentation.searchFieldIdentifier
        }) {
            return marked
        }
        guard let promptMatched = fields.first(where: {
            SidebarSearchFocusPresentation.acceptsSearchField(
                isInSidebarColumn: true,
                identifier: $0.identifier?.rawValue,
                placeholder: $0.placeholderString
            )
        }) else { return nil }
        promptMatched.identifier = NSUserInterfaceItemIdentifier(SidebarSearchFocusPresentation.searchFieldIdentifier)
        return promptMatched
    }

    private static func sidebarColumnHost(from view: NSView) -> NSView? {
        var current: NSView? = view
        while let candidate = current {
            if candidate.superview is NSSplitView { return candidate }
            current = candidate.superview
        }
        return nil
    }

    private static func searchFields(in view: NSView) -> [NSSearchField] {
        var fields: [NSSearchField] = []
        if let field = view as? NSSearchField { fields.append(field) }
        for subview in view.subviews {
            fields.append(contentsOf: searchFields(in: subview))
        }
        return fields
    }

    final class Coordinator {
        var pendingGeneration: Int?
        var completedGeneration = 0
    }
}
#endif

private struct TodayNoteBriefLayout: Layout {
    let isAccessibilitySize: Bool
    private let spacing: CGFloat = 24
    private let preferredNoteWidth: CGFloat = 600
    private let minimumBriefWidth: CGFloat = 280

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Void
    ) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let availableWidth = proposal.width
        switch TodayWorkspaceComposition.mode(availableWidth: availableWidth, isAccessibilitySize: isAccessibilitySize) {
        case .horizontal:
            let widths = horizontalWidths(totalWidth: availableWidth ?? TodayWorkspaceComposition.minimumHorizontalWidth)
            let note = subviews[0].sizeThatFits(.init(width: widths.note, height: proposal.height))
            let brief = subviews[1].sizeThatFits(.init(width: widths.brief, height: proposal.height))
            return .init(width: availableWidth ?? widths.note + spacing + widths.brief, height: max(note.height, brief.height))
        case .stacked:
            let note = subviews[0].sizeThatFits(.init(width: availableWidth, height: proposal.height))
            let brief = subviews[1].sizeThatFits(.init(width: availableWidth, height: proposal.height))
            return .init(
                width: availableWidth ?? max(note.width, brief.width),
                height: note.height + spacing + brief.height
            )
        }
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Void
    ) {
        guard subviews.count == 2 else { return }
        switch TodayWorkspaceComposition.mode(availableWidth: bounds.width, isAccessibilitySize: isAccessibilitySize) {
        case .horizontal:
            let widths = horizontalWidths(totalWidth: bounds.width)
            subviews[0].place(at: bounds.origin, proposal: .init(width: widths.note, height: bounds.height))
            subviews[1].place(
                at: .init(x: bounds.minX + widths.note + spacing, y: bounds.minY),
                proposal: .init(width: widths.brief, height: bounds.height)
            )
        case .stacked:
            let noteSize = subviews[0].sizeThatFits(.init(width: bounds.width, height: nil))
            subviews[0].place(at: bounds.origin, proposal: .init(width: bounds.width, height: noteSize.height))
            subviews[1].place(
                at: .init(x: bounds.minX, y: bounds.minY + noteSize.height + spacing),
                proposal: .init(width: bounds.width, height: nil)
            )
        }
    }

    private func horizontalWidths(totalWidth: CGFloat) -> (note: CGFloat, brief: CGFloat) {
        let note = min(preferredNoteWidth, max(totalWidth - spacing - minimumBriefWidth, 0))
        return (note, max(totalWidth - spacing - note, 0))
    }
}

/// Standalone calendar brief actions cross an asynchronous note navigation boundary. The shell
/// owns a monotonic claim so a late completion cannot pull the user back to Today after they have
/// chosen another section (including an A -> B -> A route that reuses the same note).
@MainActor
final class WorkspaceStandaloneBriefRouteCoordinator: ObservableObject {
    private(set) var generation = 0

    func claim() -> Int {
        generation &+= 1
        return generation
    }

    func invalidate() {
        generation &+= 1
    }

    func isCurrent(_ claim: Int) -> Bool {
        claim == generation
    }

    @discardableResult
    func finish(_ claim: Int) -> Bool {
        guard claim == generation else { return false }
        generation &+= 1
        return true
    }
}

enum WorkspaceStandaloneBriefRouteError: Error, Equatable {
    case staleRoute
}

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
    #if os(macOS)
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var recallRequestGeneration = 0
    @State private var sidebarSearchFocusRequest = 0
    #endif
    #if !os(macOS)
    @State private var iOSPath = NavigationPath()
    @State private var showingIOSBrowse = false
    #endif
    @StateObject private var standaloneBriefRoutes: WorkspaceStandaloneBriefRouteCoordinator
    @StateObject private var host: WorkspaceCommandCenterHost

    public init(session: DevSession, workspaceId: EntityId) {
        self.session = session
        self.workspaceId = workspaceId
        _standaloneBriefRoutes = StateObject(wrappedValue: WorkspaceStandaloneBriefRouteCoordinator())
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
        NavigationSplitView(columnVisibility: $columnVisibility) {
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
                                        standaloneBriefRoutes.invalidate()
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
            .background(
                SidebarSearchFocusBridge(
                    requestGeneration: sidebarSearchFocusRequest,
                    activeGeneration: $recallRequestGeneration
                )
            )
            .onChange(of: searchQuery) { value in
                selectedSearchNodeId = nil
                host.search(query: value)
            }
            .onChange(of: selection) { _ in
                standaloneBriefRoutes.invalidate()
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
                    Button("Search workspace", systemImage: "magnifyingglass") {
                        openWorkspaceRecall()
                    }
                    .keyboardShortcut("k", modifiers: .command)
                    .help("Search workspace")
                }
                ToolbarItem {
                    Button(WorkspaceSection.agent.title, systemImage: WorkspaceSection.agent.systemImage) {
                        selection = .agent
                    }
                    .keyboardShortcut("j", modifiers: .command)
                    .help("Open agent review")
                }
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

    private func openWorkspaceRecall() {
        recallRequestGeneration += 1
        let request = WorkspaceRecallPresentation.request(
            generation: recallRequestGeneration,
            sidebarIsVisible: columnVisibility != .detailOnly,
            query: searchQuery,
            selectedResultID: selectedSearchNodeId
        )
        // Preserve the existing query/results/selection: recall only makes the real sidebar search
        // available and focuses it. A yielded main-actor turn lets NavigationSplitView install a
        // previously hidden sidebar before the macOS 13 bridge asks its existing field to focus.
        if request.phase == .revealThenFocus {
            columnVisibility = .all
        }
        Task { @MainActor in
            await Task.yield()
            guard WorkspaceRecallPresentation.mayApplyDeferredFocus(
                requestGeneration: request.generation,
                currentGeneration: recallRequestGeneration
            ) else { return }
            sidebarSearchFocusRequest = request.generation
        }
    }
    #else
    private var iOSShell: some View {
        NavigationStack(path: $iOSPath) {
            iOSHome
                .navigationTitle(WorkspaceIOSHomePresentation.navigationTitle(isToday: host.isSelectedDateToday))
                .navigationBarTitleDisplayMode(.inline)
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
                        Button {
                            iOSPath.append(WorkspaceRoute.agentAction)
                        } label: {
                            Label(WorkspaceSection.agent.title, systemImage: WorkspaceSection.agent.systemImage)
                        }
                        .accessibilityHint(WorkspaceSection.agent.subtitle)
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
                .onChange(of: iOSPath.count) { _ in
                    standaloneBriefRoutes.invalidate()
                }
        }
        .sheet(isPresented: $showingIOSBrowse) {
            iOSBrowseSheet
        }
        .sheet(isPresented: $showingWorkspaceSwitcher) { WorkspaceSwitcherView(session: session) }
    }

    @ViewBuilder private var iOSHome: some View {
        if let model = host.model {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        iOSContent(
                            WorkspaceIOSHomePresentation.homeSection,
                            model: model,
                            onReviewStandup: {
                                withAnimation { proxy.scrollTo(DailyNoteStandupPresentation.anchorID, anchor: .top) }
                            },
                            onFocusMeetingPreparation: { identity in
                                withAnimation { proxy.scrollTo(identity, anchor: .center) }
                            }
                        )
                    }
                    .padding(24)
                }
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
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            iOSContent(
                                section,
                                model: model,
                                onReviewStandup: {
                                    withAnimation { proxy.scrollTo(DailyNoteStandupPresentation.anchorID, anchor: .top) }
                                },
                                onFocusMeetingPreparation: { identity in
                                    withAnimation { proxy.scrollTo(identity, anchor: .center) }
                                }
                            )
                        }
                        .padding(24)
                    }
                }
                .navigationTitle(section.title)
            } else {
                startupError
            }
        case .search(let id):
            if let result = host.searchRows.first(where: { $0.id == id }) {
                SearchResultDetailView(result: result, pageOperations: host.pageOperations, onClose: nil)
            } else {
                EmptyStateView(title: "Search result unavailable", systemImage: "exclamationmark.triangle", message: "This result is no longer available.")
            }
        case .dailyNote(let localDate):
            if let model = host.model {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            iOSContent(
                                .today,
                                model: model,
                                onReviewStandup: {
                                    withAnimation { proxy.scrollTo(DailyNoteStandupPresentation.anchorID, anchor: .top) }
                                },
                                onFocusMeetingPreparation: { identity in
                                    withAnimation { proxy.scrollTo(identity, anchor: .center) }
                                }
                            )
                        }
                        .padding(24)
                    }
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
                    pageOperations: host.pageOperations,
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
                pageOperations: host.pageOperations,
                onClose: nil
            )
        case .person(let personNodeId):
            WorkspaceDirectEntityDetailView(
                destination: .person(personNodeId),
                client: host.readClient,
                pageOperations: host.pageOperations,
                onClose: nil
            )
        case .employeeUpdate(let employeeUpdateNodeId):
            WorkspaceDirectEntityDetailView(
                destination: .employeeUpdate(employeeUpdateNodeId),
                client: host.readClient,
                pageOperations: host.pageOperations,
                onClose: nil
            )
        }
    }
    @ViewBuilder private func iOSContent(
        _ section: WorkspaceSection,
        model: AthenaeumViewModel,
        onReviewStandup: (() -> Void)? = nil,
        onFocusMeetingPreparation: ((LoroMeetingPreparationIdentity) -> Void)? = nil
    ) -> some View {
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
                        let claim = standaloneBriefRoutes.claim()
                        let output = try await model.prepareMeetingFromStandaloneBrief(
                            brief: brief,
                            event: event,
                            routeIsCurrent: { standaloneBriefRoutes.isCurrent(claim) }
                        )
                        guard standaloneBriefRoutes.finish(claim) else {
                            throw WorkspaceStandaloneBriefRouteError.staleRoute
                        }
                        iOSPath = NavigationPath()
                        return output
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
        default: selectedContent(
            model: model,
            section: section,
            onReviewStandup: onReviewStandup,
            onFocusMeetingPreparation: onFocusMeetingPreparation
        )
        }
    }
    #endif

    @ViewBuilder
    private var detail: some View {
        if let result = selectedSearchResult {
            SearchResultDetailView(
                result: result,
                pageOperations: host.pageOperations,
                onClose: { selectedSearchNodeId = nil }
            )
        } else if let destination = selectedDirectEntityDestination {
            WorkspaceDirectEntityDetailView(
                destination: destination,
                client: host.readClient,
                pageOperations: host.pageOperations,
                onClose: { selectedDirectEntityDestination = nil }
            )
        } else if let node = selectedGraphNode {
            GraphNodeDetailView(
                node: node,
                pageOperations: host.pageOperations,
                sourceSection: selection,
                onClose: { selectedGraphNodeId = nil }
            )
        } else if let model = host.model {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if selection.showsDestinationHeader {
                            detailHeader
                        }
                        selectedContent(
                            model: model,
                            onReviewStandup: {
                                withAnimation { proxy.scrollTo(DailyNoteStandupPresentation.anchorID, anchor: .top) }
                            },
                            onFocusMeetingPreparation: { identity in
                                withAnimation { proxy.scrollTo(identity, anchor: .center) }
                            }
                        )
                    }
                    .padding(24)
                    .frame(maxWidth: 900, alignment: .leading)
                }
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
    private func selectedContent(
        model: AthenaeumViewModel,
        section: WorkspaceSection? = nil,
        onReviewStandup: (() -> Void)? = nil,
        onFocusMeetingPreparation: ((LoroMeetingPreparationIdentity) -> Void)? = nil
    ) -> some View {
        switch section ?? selection {
        case .today:
            #if os(macOS)
            TodayNoteBriefLayout(isAccessibilitySize: dynamicTypeSize.isAccessibilitySize) {
                DailyNoteView(
                    model: model,
                    standupBackendURL: session.backendURL,
                    standupWorkspaceId: workspaceId,
                    standupBearerCredential: session.credential,
                    onOpenEmployeeUpdate: { nodeId in openEmployeeUpdate(nodeId) },
                    onReviewStandup: onReviewStandup,
                    onFocusMeetingPreparation: onFocusMeetingPreparation,
                    onOpenReference: { reference in openReference(reference) },
                    mentionSearchClient: host.readClient
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
                onReviewStandup: onReviewStandup,
                onFocusMeetingPreparation: onFocusMeetingPreparation,
                onOpenReference: { reference in openReference(reference) },
                mentionSearchClient: host.readClient
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
                standaloneBriefRoutes.invalidate()
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
                        let claim = standaloneBriefRoutes.claim()
                        let output = try await model.prepareMeetingFromStandaloneBrief(
                            brief: brief,
                            event: event,
                            routeIsCurrent: { standaloneBriefRoutes.isCurrent(claim) }
                        )
                        guard standaloneBriefRoutes.finish(claim) else {
                            throw WorkspaceStandaloneBriefRouteError.staleRoute
                        }
                        selection = .today
                        return output
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
                        standaloneBriefRoutes.invalidate()
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
        standaloneBriefRoutes.invalidate()
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
        standaloneBriefRoutes.invalidate()
        #if os(macOS)
        selectedSearchNodeId = nil
        selectedGraphNodeId = nil
        selectedDirectEntityDestination = .person(personNodeId)
        #else
        iOSPath.append(WorkspaceRoute.personID(personNodeId))
        #endif
    }

    private func openEmployeeUpdate(_ employeeUpdateNodeId: EntityId) {
        standaloneBriefRoutes.invalidate()
        #if os(macOS)
        selectedSearchNodeId = nil
        selectedGraphNodeId = nil
        selectedDirectEntityDestination = .employeeUpdate(employeeUpdateNodeId)
        #else
        iOSPath.append(WorkspaceRoute.employeeUpdateID(employeeUpdateNodeId))
        #endif
    }

    private func openReference(_ reference: LoroCanonicalSemanticValueV1.InlineReference) {
        standaloneBriefRoutes.invalidate()
        switch reference.kind {
        case .entity:
            #if os(macOS)
            selectedSearchNodeId = nil
            selectedGraphNodeId = nil
            selectedDirectEntityDestination = .entity(reference.id)
            #else
            iOSPath.append(WorkspaceRoute.entityID(reference.id))
            #endif
        case .supertag:
            selectedReferencedTagId = reference.id
            #if os(macOS)
            selection = .supertags
            #else
            iOSPath.append(WorkspaceRoute.section(.supertags))
            #endif
        }
    }
}

private struct SearchResultDetailView: View {
    let result: AthenaeumViewModel.SearchRow
    let pageOperations: (any DailyNotePageOperations)?
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
            EntityPagePreview(nodeId: result.id, pageOperations: pageOperations)
        }
        .frame(maxWidth: 900, maxHeight: .infinity, alignment: .topLeading)
        .padding(32)
    }
}

private struct GraphNodeDetailView: View {
    let node: AthenaeumViewModel.GraphNodeRow
    let pageOperations: (any DailyNotePageOperations)?
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
            EntityPagePreview(nodeId: node.id, pageOperations: pageOperations)
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
    let pageOperations: (any DailyNotePageOperations)?
    let onClose: (() -> Void)?
    @StateObject private var loader: WorkspaceDirectEntityLoader
    @State private var isRetrying = false

    init(
        destination: WorkspaceDirectEntityDestination,
        client: WorkspaceRPCClient,
        pageOperations: (any DailyNotePageOperations)?,
        onClose: (() -> Void)?
    ) {
        self.destination = destination
        self.client = client
        self.pageOperations = pageOperations
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
                EntityPagePreview(nodeId: node.id.rawValue, pageOperations: pageOperations)
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

/// Exact route identity captured before a read begins and compared after it completes.  The
/// concrete descriptor variant matters: migrated and native Loro pages must not alias merely
/// because their active format, storage revision, and snapshot hash happen to match.
struct WorkspacePageDescriptorWitness: Equatable, Sendable {
    enum Variant: String, Equatable, Sendable {
        case legacy
        case migratedLoro
        case nativeLoro
    }

    let variant: Variant
    let nodeId: EntityId
    let activeFormat: PageDocumentFormat
    let storageVersion: Int
    let schemaVersion: Int?
    let snapshotSHA256: String?

    init(_ descriptor: PageDocumentDescriptor) {
        nodeId = descriptor.nodeId
        activeFormat = descriptor.activeFormat
        storageVersion = descriptor.storageVersion
        switch descriptor {
        case .legacy:
            variant = .legacy
            schemaVersion = nil
            snapshotSHA256 = nil
        case .migratedLoro(_, _, _, let loro):
            variant = .migratedLoro
            schemaVersion = loro.schemaVersion
            snapshotSHA256 = loro.snapshotSha256
        case .nativeLoro(_, _, let loro):
            variant = .nativeLoro
            schemaVersion = loro.schemaVersion
            snapshotSHA256 = loro.snapshotSha256
        }
    }
}

enum WorkspaceEntityPagePreviewContent: Equatable {
    case loro(DailyNoteLoroProjectionState)
    case legacy(String)

    var isEmpty: Bool {
        switch self {
        case .legacy(let text):
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .loro(let state):
            return !WorkspaceEntityPagePreviewContent.hasVisibleText(state.projection.root)
        }
    }

    private static func hasVisibleText(_ node: LoroPageProjectionNode) -> Bool {
        switch node {
        case .text(let value, _): return !value.isEmpty
        case .document(let children), .meetingPreparation(_, let children), .paragraph(let children), .heading(_, let children):
            return children.contains(where: hasVisibleText)
        case .unsupported:
            // Unsupported content is still content. It must not be mistaken for an empty page.
            return true
        }
    }
}

enum WorkspaceEntityPagePreviewLoadState: Equatable {
    case idle
    case loading
    case loadedEmpty
    case loadedContent(WorkspaceEntityPagePreviewContent)
    case missing
    case unsupported
    case stale
    case failed
}

enum WorkspaceEntityPagePreviewLoadError: Error, Equatable {
    case stale
    case unsupported
    case workspaceUnavailable
    case invalidNode
}

enum WorkspaceEntityPagePreviewPresentation {
    static let missingMessage = "No page document is attached to this entity yet."
    static let unsupportedMessage = "This page format cannot be previewed safely here."
    static let staleMessage = "This page changed while it was opening. Retry to inspect the latest version."
    static let failureMessage = "Page content is unavailable right now."

    static func state(for error: Error) -> WorkspaceEntityPagePreviewLoadState {
        if let error = error as? WorkspaceEntityPagePreviewLoadError {
            switch error {
            case .stale: return .stale
            case .unsupported, .invalidNode: return .unsupported
            case .workspaceUnavailable: return .failed
            }
        }
        if let error = error as? AthenaeumDomainError {
            switch error {
            case .pageNotFound: return .missing
            case .pageFormatMismatch: return .unsupported
            default: return .failed
            }
        }
        if let error = error as? LoroPageProjectionError {
            switch error {
            case .malformedKnownContent, .limitExceeded: return .unsupported
            case .pageNotPublished: return .failed
            }
        }
        if let error = error as? WorkspaceSyncClientError {
            switch error {
            case .invalidLoroDescriptor: return .stale
            case .pageNotFoundLocally, .missingLoroCreationIntent, .invalidLoroSyncResponse, .invalidNodeCreationInput: return .failed
            }
        }
        return .failed
    }

    static func canRetry(state: WorkspaceEntityPagePreviewLoadState) -> Bool {
        state == .failed || state == .stale
    }

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

/// A main-actor, format-aware read-only loader.  It receives the existing workspace page
/// operations seam instead of constructing a preview-local sync client or document store.
@MainActor
final class WorkspaceEntityPagePreviewLoader: ObservableObject {
    @Published private(set) var state: WorkspaceEntityPagePreviewLoadState = .idle

    private let readDescriptor: (EntityId) async throws -> PageDocumentDescriptor
    private let readLegacy: (EntityId, PageDocumentDescriptor, SyncSessionHandle) async throws -> DailyNoteLegacyReadOnlyState
    private let readLoro: (EntityId) async throws -> DailyNoteLoroProjectionState
    private var generation = 0

    init(
        readDescriptor: @escaping (EntityId) async throws -> PageDocumentDescriptor,
        readLegacy: @escaping (EntityId, PageDocumentDescriptor, SyncSessionHandle) async throws -> DailyNoteLegacyReadOnlyState,
        readLoro: @escaping (EntityId) async throws -> DailyNoteLoroProjectionState
    ) {
        self.readDescriptor = readDescriptor
        self.readLegacy = readLegacy
        self.readLoro = readLoro
    }

    func markUnsupported() {
        state = .unsupported
    }

    /// After the initial descriptor has selected a storage lane, a disappearing or changing page
    /// is a concurrent replacement. Keep that phase distinction explicit so the UI can offer a
    /// retry instead of claiming the page never existed.
    private func readAfterSelection<Value>(_ operation: () async throws -> Value) async throws -> Value {
        do {
            return try await operation()
        } catch let error as AthenaeumDomainError {
            switch error {
            case .pageNotFound, .pageFormatMismatch:
                throw WorkspaceEntityPagePreviewLoadError.stale
            default:
                throw error
            }
        }
    }

    /// Route changes and retries increment the same generation. A late completion is ignored,
    /// so node A can never replace node B's page preview.
    func load(nodeId: EntityId) async {
        generation &+= 1
        let activeGeneration = generation
        state = .loading
        do {
            let descriptor = try await readDescriptor(nodeId)
            guard descriptor.nodeId == nodeId else { throw WorkspaceEntityPagePreviewLoadError.stale }
            let selectedWitness = WorkspacePageDescriptorWitness(descriptor)
            let content: WorkspaceEntityPagePreviewContent

            switch descriptor {
            case .legacy:
                let projection = try await readAfterSelection {
                    try await readLegacy(nodeId, descriptor, SyncSessionHandle())
                }
                guard WorkspacePageDescriptorWitness(projection.descriptor) == selectedWitness else {
                    throw WorkspaceEntityPagePreviewLoadError.stale
                }
                switch projection.content {
                case .plainText(let text): content = .legacy(text)
                case .richTextUnsupported, .tooLarge:
                    throw WorkspaceEntityPagePreviewLoadError.unsupported
                }
                let confirmed = try await readAfterSelection { try await readDescriptor(nodeId) }
                guard WorkspacePageDescriptorWitness(confirmed) == selectedWitness else {
                    throw WorkspaceEntityPagePreviewLoadError.stale
                }
            case .migratedLoro, .nativeLoro:
                guard selectedWitness.activeFormat == .loroV1,
                      let schemaVersion = selectedWitness.schemaVersion,
                      let snapshotSHA256 = selectedWitness.snapshotSHA256
                else { throw WorkspaceEntityPagePreviewLoadError.unsupported }
                let projection = try await readAfterSelection { try await readLoro(nodeId) }
                let route = projection.projection.route
                guard route.nodeId == nodeId,
                      route.format == .loroV1,
                      route.storageVersion == selectedWitness.storageVersion,
                      route.schemaVersion == schemaVersion,
                      route.snapshotSHA256 == snapshotSHA256
                else { throw WorkspaceEntityPagePreviewLoadError.stale }
                let confirmed = try await readAfterSelection { try await readDescriptor(nodeId) }
                guard WorkspacePageDescriptorWitness(confirmed) == selectedWitness else {
                    throw WorkspaceEntityPagePreviewLoadError.stale
                }
                content = .loro(projection)
            }

            guard activeGeneration == generation else { return }
            state = content.isEmpty ? .loadedEmpty : .loadedContent(content)
        } catch {
            guard activeGeneration == generation else { return }
            state = WorkspaceEntityPagePreviewPresentation.state(for: error)
        }
    }
}

private struct EntityPagePreview: View {
    let nodeId: String
    let pageOperations: (any DailyNotePageOperations)?
    @StateObject private var loader: WorkspaceEntityPagePreviewLoader
    @State private var retryingNodeId: String?

    init(nodeId: String, pageOperations: (any DailyNotePageOperations)?) {
        self.nodeId = nodeId
        self.pageOperations = pageOperations
        _loader = StateObject(wrappedValue: WorkspaceEntityPagePreviewLoader(
            readDescriptor: { id in
                guard let pageOperations else { throw WorkspaceEntityPagePreviewLoadError.workspaceUnavailable }
                return try await pageOperations.descriptor(nodeId: id)
            },
            readLegacy: { id, descriptor, session in
                guard let pageOperations else { throw WorkspaceEntityPagePreviewLoadError.workspaceUnavailable }
                return try await pageOperations.legacyPageProjection(nodeId: id, descriptor: descriptor, session: session)
            },
            readLoro: { id in
                guard let pageOperations else { throw WorkspaceEntityPagePreviewLoadError.workspaceUnavailable }
                return try await pageOperations.syncLoroProjection(nodeId: id)
            }
        ))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Page content", systemImage: "doc.text")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
            switch loader.state {
            case .idle, .loading:
                ProgressView(
                    WorkspaceEntityPagePreviewPresentation.loadingTitle(
                        nodeId: nodeId,
                        retryingNodeId: retryingNodeId
                    )
                )
                    .foregroundStyle(.secondary)
            case .loadedEmpty:
                Text("This entity has an empty page.")
                    .foregroundStyle(.secondary)
            case .loadedContent(let content):
                ScrollView {
                    switch content {
                    case .legacy(let text):
                        Text(text)
                            .font(.body)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    case .loro(let state):
                        ReadOnlyLoroProjectionView(node: state.projection.root)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .frame(maxHeight: 280)
            case .missing:
                Text(WorkspaceEntityPagePreviewPresentation.missingMessage)
                    .foregroundStyle(.secondary)
            case .unsupported:
                Text(WorkspaceEntityPagePreviewPresentation.unsupportedMessage)
                    .foregroundStyle(.secondary)
            case .stale:
                previewRecovery(
                    message: WorkspaceEntityPagePreviewPresentation.staleMessage,
                    retryLabel: retryingNodeId == nodeId ? "Retrying page…" : "Retry page"
                )
            case .failed:
                previewRecovery(
                    message: WorkspaceEntityPagePreviewPresentation.failureMessage,
                    retryLabel: retryingNodeId == nodeId ? "Retrying page…" : "Retry page"
                )
            }
        }
        .task(id: nodeId) {
            guard let id = try? EntityId(validating: nodeId) else {
                loader.markUnsupported()
                return
            }
            await loader.load(nodeId: id)
        }
    }

    @ViewBuilder
    private func previewRecovery(message: String, retryLabel: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
            Button(retryLabel) { retryPage() }
                .buttonStyle(.bordered)
                .disabled(
                    !WorkspaceEntityPagePreviewPresentation.canStartRetry(
                        state: loader.state,
                        retryingNodeId: retryingNodeId
                    )
                )
                .accessibilityHint("Retries the page content read for this entity.")
        }
    }

    private func retryPage() {
        guard WorkspaceEntityPagePreviewPresentation.canStartRetry(
            state: loader.state,
            retryingNodeId: retryingNodeId
        ), let id = try? EntityId(validating: nodeId) else { return }
        let retryNodeId = nodeId
        retryingNodeId = retryNodeId
        Task { @MainActor in
            await loader.load(nodeId: id)
            retryingNodeId = WorkspaceEntityPagePreviewPresentation.retryingNodeId(
                afterCompleting: retryNodeId,
                retryingNodeId: retryingNodeId
            )
        }
    }
}

/// Value-only SwiftUI rendering for a synchronized Loro projection.  It deliberately has no
/// editor, sync plugin, mutation callback, or entity/tag action; text remains selectable.
private struct ReadOnlyLoroProjectionView: View {
    let node: LoroPageProjectionNode

    var body: some View { render(node) }

    private func render(_ node: LoroPageProjectionNode) -> AnyView {
        switch node {
        case .document(let children):
            return AnyView(VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(children.enumerated()), id: \.offset) { _, child in render(child) }
            }.accessibilityElement(children: .contain).accessibilityLabel("Read-only Loro page"))
        case .meetingPreparation(_, let children):
            return AnyView(VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(children.enumerated()), id: \.offset) { _, child in render(child) }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Prepared meeting context"))
        case .paragraph(let children):
            return AnyView(HStack(spacing: 0) { ForEach(Array(children.enumerated()), id: \.offset) { _, child in render(child) } })
        case .heading(_, let children):
            return AnyView(HStack(spacing: 0) { ForEach(Array(children.enumerated()), id: \.offset) { _, child in render(child) } }
                .font(.title3.weight(.semibold)))
        case .text(let value, let marks):
            var text = Text(value)
            if marks.contains(.strong) { text = text.bold() }
            if marks.contains(.emphasis) { text = text.italic() }
            if marks.contains(.code) { text = text.font(.system(.body, design: .monospaced)) }
            if marks.contains(.link) { text = text.foregroundColor(.accentColor).underline() }
            let presentation = LoroProjectionTextPresentation(marks: marks)
            return AnyView(HStack(spacing: 0) {
                if presentation.allowsTextSelection { text.textSelection(.enabled) } else { text.textSelection(.disabled) }
                if let suffix = presentation.visibleSuffix { Text(suffix).foregroundStyle(.secondary) }
            }.accessibilityLabel(presentation.accessibilityLabel ?? value))
        case .unsupported:
            return AnyView(Text("Unsupported content").foregroundStyle(.secondary).italic().accessibilityLabel("Unsupported read-only content"))
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
        // Today’s selected date is the primary heading inside DailyNoteView. An empty shell title
        // avoids repeating "Today" above that date while retaining a title for historical notes.
        isToday ? "" : dailyNoteTitle
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
    /// Direct entity previews borrow the exact page-operation object owned by the daily-note
    /// model. This keeps Loro leases, local replicas, and legacy witnesses on one workspace
    /// custody path instead of creating a second preview-local sync owner.
    var pageOperations: (any DailyNotePageOperations)? { model?.readOnlyPageOperations }

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
