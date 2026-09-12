import SwiftUI

enum WorkspaceDestination: String, CaseIterable, Identifiable, Hashable {
    case today = "Today", localNotes = "On this device", inbox = "Captures", agenda = "Day calendar", people = "People", github = "GitHub"
    var id: String { rawValue }
    var symbol: String {
        switch self { case .today: "sun.max"; case .localNotes: "internaldrive"; case .inbox: "tray"; case .agenda: "calendar"; case .people: "person.2"; case .github: "chevron.left.forwardslash.chevron.right" }
    }
}
struct WorkspaceView: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: WorkspaceDestination? = .today
    @State private var todayRecenter = 0
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
        .onChange(of: scenePhase) { _, phase in if phase == .active { store.importSpool() } }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("apsidesCaptureArrived"))) { _ in store.importSpool() }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("apsidesShowToday"))) { _ in selection = .today; contextPath = []; todayRecenter += 1; store.selectedDay = .now }
        .onOpenURL { url in if ["apsides", "enchiridion"].contains(url.scheme ?? "") {
            if url.host == "capture" { store.capturePresented = true }
            if url.host == "today" { selection = .today; contextPath = []; todayRecenter += 1; store.selectedDay = .now }
        } }
    }
    private var desktop: some View {
        NavigationSplitView {
            List(WorkspaceDestination.allCases, selection: $selection) { destination in
                Label(destination.rawValue, systemImage: destination.symbol).tag(destination)
            }
            .navigationTitle("Enchiridion")
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
        NavigationStack(path: $contextPath) {
            PhoneTodayView(store: store, showAgenda: showAgenda, recenter: todayRecenter)
                .navigationDestination(for: WorkspaceDestination.self) { destination($0) }
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
        case .localNotes: LocalDaybookView(store: store, showAgenda: showAgenda)
        case .today: TodayView(store: store, showAgenda: showAgenda)
        case .inbox: CaptureListView(store: store)
        case .agenda: AgendaView(store: store)
        case .people: PeopleView(store: store)
        case .github: RepositoryListView(store: store)
        }
    }
    private func showAgenda() { selection = .agenda; contextPath = [.agenda] }
}
