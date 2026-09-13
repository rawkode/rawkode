import ApsidesCore
import SwiftUI

#if os(iOS)
struct PhoneTodayView: View {
    @ObservedObject var store: WorkspaceStore
    let showAgenda: () -> Void
    let recenter: Int
    @State private var selectedDay = Date()
    @State private var dockRecenter = 0
    @State private var sidebarPresented = false
    @State private var destination: PhoneDestination?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private enum PhoneDestination: String, Identifiable {
        case tasks, calendar, people, github, captures, meetings, localNotes
        var id: String { rawValue }
    }
    @State private var searchPresented = false
    @State private var voicePresented = false
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @StateObject private var editor: WebEditorController
    @State private var notesPresented = false
    @State private var closeError = false

    init(store: WorkspaceStore, showAgenda: @escaping () -> Void, recenter: Int = 0) {
        self.recenter = recenter
        self.store = store
        self.showAgenda = showAgenda
        _editor = StateObject(wrappedValue: WebEditorController(session: store.session))
    }

    var body: some View {
        DayTimelineView(store: store, recenter: recenter + dockRecenter, selectedDay: $selectedDay, openSidebar: { setSidebar(true) })
            .safeAreaInset(edge: .bottom, spacing: 0) {
                GlassEffectContainer(spacing: 8) {
                HStack(alignment: .center, spacing: 12) {
                    Button {
                        selectedDay = .now
                        dockRecenter += 1
                    } label: {
                        Text("Today")
                            .font(.body.weight(.medium))
                            .padding(.horizontal, 20)
                            .frame(minHeight: 50).contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(theme.ink)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .accessibilityLabel("Return to today")
                    .accessibilityHint("Centres the timeline on the current time")
                    .accessibilityIdentifier("recenterToday")
                    notesControl
                }
                }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
            }
            .accessibilityHidden(sidebarPresented)
            .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
                if value.startLocation.x < 24 && value.translation.width > 60 && abs(value.translation.width) > abs(value.translation.height) * 1.5 {
                    setSidebar(true)
                }
            })
            .overlay { if sidebarPresented { sidebar } }
            .navigationDestination(item: $destination) { value in
                switch value {
                case .tasks: TasksView(workspace: store)
                case .calendar: AgendaView(store: store)
                case .people: PeopleView(store: store)
                case .github: RepositoryListView(store: store)
                case .captures: CaptureListView(store: store)
                case .meetings: MeetingCaptureLibraryView(store: store)
                case .localNotes: LocalDaybookView(store: store, showAgenda: showAgenda)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $voicePresented) { VoiceConversationView(session: store.session, conversation: store.voice) }
            .sheet(isPresented: $searchPresented) {
                DaySearchView(store: store)
            }
            .sheet(isPresented: $notesPresented, onDismiss: { Task { await store.refresh() } }) {
                NavigationStack {
                    TodayView(store: store, showAgenda: showAgenda, editor: editor)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { Task { await closeNote() } }
                                    .accessibilityIdentifier("closeDailyNote")
                            }
                        }
                }
                .interactiveDismissDisabled()
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(theme.canvas)
                // The session retains the WKWebView and pending saves across dismissal.
                .alert("Your note is still saving", isPresented: $closeError) {
                    Button("Keep editing", role: .cancel) {}
                } message: {
                    Text("Wait for All changes saved, then close your note again.")
                }
            }
            .onChange(of: recenter) { _, _ in selectedDay = .now }
            .onReceive(NotificationCenter.default.publisher(for: Notification.Name("apsidesOpenDailyNote"))) { _ in
                notesPresented = true
            }
    }

    private var notePreview: String {
        if !editor.preview.isEmpty { return editor.preview }
        if let saved = store.vault.dailyNotePreview,
           saved.matches(accountID: store.vault.accountID, day: DayIdentity.key(.now)),
           !saved.text.isEmpty { return saved.text }
        if store.demo { return "Try the simpler onboarding flow." }
        return "Open your note and keep the thought."
    }

    private var notesControl: some View {
        VStack(spacing: 5) {
            Capsule().fill(theme.secondary.opacity(0.6)).frame(width: 32, height: 4)
                .accessibilityHidden(true)
            Button { notesPresented = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "book.closed").font(.body).frame(width: 24)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Today’s note").font(.caption).foregroundStyle(theme.secondary)
                        Text(notePreview)
                            .font(.subheadline).lineLimit(1).multilineTextAlignment(.leading)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.up").font(.caption)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("dailyNotePreview")

        }
        .padding(.horizontal, 16).padding(.top, 7).padding(.bottom, 8)
        .foregroundStyle(theme.ink)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 28))
        .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
            if value.translation.height < -35 && abs(value.translation.height) > abs(value.translation.width) {
                notesPresented = true
            }
        })
    }

    private func setSidebar(_ visible: Bool) {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { sidebarPresented = visible }
    }

    private func sidebarAction(_ title: String, symbol: String, id: String, isGitHub: Bool = false, action: @escaping () -> Void) -> some View {
        Button {
            setSidebar(false)
            action()
        } label: {
            Label { Text(title) } icon: {
                if isGitHub { GitHubMark().frame(width: 22, height: 22) }
                else { Image(systemName: symbol) }
            }
                .font(.body.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier(id)
    }

    private var sidebar: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Button { setSidebar(false) } label: { Color.black.opacity(0.3).ignoresSafeArea() }
                    .buttonStyle(.plain).accessibilityLabel("Close sidebar")
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Enchiridion").font(.title2.weight(.semibold))
                        Spacer()
                        Button { setSidebar(false) } label: {
                            Image(systemName: "xmark").frame(width: 44, height: 44)
                        }.buttonStyle(.plain).accessibilityLabel("Close sidebar").accessibilityIdentifier("sidebarClose")
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            sidebarAction("Tasks", symbol: "checklist", id: "openTasks") { destination = .tasks }
                            sidebarAction("Voice", symbol: "waveform", id: "openVoiceConversation") { voicePresented = true }
                            sidebarAction("Search", symbol: "magnifyingglass", id: "daySearch") { searchPresented = true }
                            Divider().padding(.vertical, 8)
                            sidebarAction("Day calendar", symbol: "calendar", id: "sidebarCalendar") { destination = .calendar }
                            sidebarAction("People", symbol: "person.2", id: "sidebarPeople") { destination = .people }
                            sidebarAction("GitHub", symbol: "", id: "sidebarGitHub", isGitHub: true) { destination = .github }
                            sidebarAction("Captures", symbol: "tray", id: "sidebarCaptures") { destination = .captures }
                            sidebarAction("Meeting capture", symbol: "mic", id: "meetingCaptureBrowse") { destination = .meetings }
                            sidebarAction("On this device", symbol: "internaldrive", id: "sidebarLocalNotes") { destination = .localNotes }
                        }
                    }
                    Divider()
                    sidebarAction("Quick capture", symbol: "square.and.pencil", id: "quickCapture") { store.capturePresented = true }
                    sidebarAction("Account & appearance", symbol: "gearshape", id: "todaySettings") { store.settingsPresented = true }
                }
                .padding(20)
                .frame(width: min(340, geometry.size.width * 0.88), height: geometry.size.height)
                .foregroundStyle(theme.ink).tint(theme.accent)
                .background(theme.canvas.opacity(0.9))
                .glassEffect(.regular, in: .rect(cornerRadius: 26))
                .accessibilityAddTraits(.isModal)
                .accessibilityAction(.escape) { setSidebar(false) }
                .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
                    if value.translation.width < -60 && abs(value.translation.width) > abs(value.translation.height) * 1.5 { setSidebar(false) }
                })
                .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
    }

    private func closeNote() async {
        if ApsidesPreferences.store.bool(forKey: "apsidesNativeEditor") {
            guard store.nativeNote.flush() else { closeError = true; return }
            notesPresented = false
            return
        }
        store.session.makeEditorWebView().endEditing(false)
        guard await store.session.editorCanLeave() else { closeError = true; return }
        if let preview = await editor.refreshPreview() { store.saveNotePreview(preview) }
        notesPresented = false
    }
}
/// Search operates on the saved projection; it never starts an integration sync.
private struct DaySearchView: View {
    @ObservedObject var store: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var query = ""
    private func matches(_ text: String) -> Bool { text.localizedCaseInsensitiveContains(query) }
    var body: some View {
        NavigationStack {
            List {
                if query.isEmpty {
                    ContentUnavailableView("Search your workspace", systemImage: "magnifyingglass", description: Text("Find saved events, people, GitHub activity, and captures."))
                        .listRowBackground(Color.clear)
                } else {
                    Section("Saved calendar") {
                        ForEach((store.calendarContext?.snapshot.events ?? store.snapshot?.events ?? []).filter { matches($0.title) }) { event in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(event.title).font(.headline)
                                if let start = event.start { Text(start, format: .dateTime.weekday().hour().minute()).font(.caption) }
                                if let calendar = event.calendar { Text(calendar).font(.caption).foregroundStyle(theme.secondary) }
                            }
                        }
                    }
                    Section("People") {
                        ForEach((store.context?.people ?? []).filter { matches($0.name + " " + $0.emails.joined(separator: " ")) }) { person in
                            NavigationLink(person.name) { PersonDetailView(person: person) }
                        }
                    }
                    Section("GitHub activity") {
                        ForEach((store.context?.activity ?? []).filter { matches($0.title + " " + $0.repository) }) { item in
                            GitHubActivityCard(item: item)
                        }
                    }
                    Section("Captures") {
                        ForEach(store.captures.filter { matches($0.text) }) { capture in
                            Text(capture.text)
                        }
                    }
                    Text("Search includes data saved on this device.").font(.caption).foregroundStyle(theme.secondary)
                }
            }
            .searchable(text: $query, prompt: "Events, people, GitHub, captures")
            .scrollContentBackground(.hidden).background(theme.canvas).foregroundStyle(theme.ink)
            .navigationTitle("Search")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("closeDaySearch") }
                ToolbarItem(placement: .topBarLeading) {
                    Button { store.capturePresented = true; dismiss() } label: { Label("Capture", systemImage: "square.and.pencil") }
                        .accessibilityIdentifier("quickCapture")
                }
            }
        }.tint(theme.accent)
    }
}
#endif
