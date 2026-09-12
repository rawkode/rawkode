import SwiftUI

enum WorkspaceDestination: String, CaseIterable, Identifiable, Hashable {
    case today = "Today", inbox = "Captures", agenda = "Day calendar", people = "People", github = "GitHub"
    var id: String { rawValue }
    var symbol: String {
        switch self { case .today: "sun.max"; case .inbox: "tray"; case .agenda: "calendar"; case .people: "person.2"; case .github: "chevron.left.forwardslash.chevron.right" }
    }
}
struct WorkspaceView: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: WorkspaceDestination? = .today
    @State private var phoneTab = 0
    @State private var contextPath: [WorkspaceDestination] = []
    @Namespace private var captureTransition
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    var body: some View {
        Group {
            #if os(macOS)
            desktop
            #else
            if sizeClass == .regular { desktop } else { phone }
            #endif
        }
        .sheet(isPresented: $store.capturePresented) {
            CaptureSheet(store: store)
                #if os(iOS)
                .navigationTransition(.zoom(sourceID: "capture", in: captureTransition))
                #endif
        }
        .sheet(isPresented: $store.settingsPresented) { SettingsView(store: store, session: store.session) }
        .safeAreaInset(edge: .bottom) {
            if let error = store.storageError {
                HStack { Label(error, systemImage: "exclamationmark.triangle"); if !store.isReadOnly { Button("Retry save", action: store.retrySave) } }
                    .font(.callout).padding().background(.regularMaterial).accessibilityIdentifier("storageError")
            }
        }
        .overlay(alignment: .top) { if store.demo { Text("Sample data · local preview").font(.caption).padding(6).background(.regularMaterial) } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { store.importSpool() } }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("apsidesCaptureArrived"))) { _ in store.importSpool() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("apsidesShowToday"))) { _ in selection = .today; phoneTab = 0; store.selectedDay = .now }
        .onOpenURL { url in if url.scheme == "apsides" {
            if url.host == "capture" { store.capturePresented = true }
            if url.host == "today" { selection = .today; phoneTab = 0; store.selectedDay = .now }
        } }
    }
    private var desktop: some View {
        NavigationSplitView {
            List(WorkspaceDestination.allCases, selection: $selection) { destination in
                Label(destination.rawValue, systemImage: destination.symbol).tag(destination)
            }
            .navigationTitle("Apsides")
            .navigationSplitViewColumnWidth(min: 170, ideal: 200, max: 240)
            .safeAreaInset(edge: .bottom) {
                Button { store.settingsPresented = true } label: { Label("Settings", systemImage: "gearshape") }.buttonStyle(.plain).padding()
            }
        } detail: {
            destination(selection ?? .today)
                .toolbar { captureButton }
        }
    }
    #if os(iOS)
    private var phone: some View {
        TabView(selection: $phoneTab) {
            NavigationStack { TodayView(store: store, showAgenda: showAgenda).toolbar { captureButton } }
                .tabItem { Label("Today", systemImage: "sun.max") }.tag(0)
            NavigationStack { CaptureListView(store: store).toolbar { captureButton } }
                .tabItem { Label("Captures", systemImage: "tray") }.tag(1)
            NavigationStack(path: $contextPath) {
                List {
                    NavigationLink("Day calendar", value: WorkspaceDestination.agenda)
                    NavigationLink("People", value: WorkspaceDestination.people)
                    NavigationLink("GitHub", value: WorkspaceDestination.github)
                    Button("Account & appearance") { store.settingsPresented = true }
                }.listRowBackground(theme.canvas).scrollContentBackground(.hidden)
                .background(theme.base).foregroundStyle(theme.ink).navigationTitle("Context").toolbar { captureButton }
                .navigationDestination(for: WorkspaceDestination.self) { destination($0) }
            }.tabItem { Label("Context", systemImage: "square.stack.3d.up") }.tag(2)
        }
    }
    #endif
    private var captureButton: some ToolbarContent {
        ToolbarItem {
            Button { store.capturePresented = true } label: { Label("Capture", systemImage: "square.and.pencil") }
                .buttonStyle(.glassProminent)
                .matchedTransitionSource(id: "capture", in: captureTransition)
                .disabled(store.isReadOnly).accessibilityIdentifier("quickCapture")
        }
    }
    @ViewBuilder private func destination(_ selected: WorkspaceDestination) -> some View {
        switch selected {
        case .today: TodayView(store: store, showAgenda: showAgenda)
        case .inbox: CaptureListView(store: store)
        case .agenda: AgendaView(store: store)
        case .people: PeopleView(store: store)
        case .github: RepositoryListView(store: store)
        }
    }
    private func showAgenda() { selection = .agenda; phoneTab = 2; contextPath = [.agenda] }
}
