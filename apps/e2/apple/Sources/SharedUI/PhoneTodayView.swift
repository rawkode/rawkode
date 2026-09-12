import ApsidesCore
import SwiftUI

#if os(iOS)
struct PhoneTodayView: View {
    @ObservedObject var store: WorkspaceStore
    let showAgenda: () -> Void
    let recenter: Int
    @State private var selectedDay = Date()
    @State private var dockRecenter = 0
    @State private var searchPresented = false
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
        DayTimelineView(store: store, recenter: recenter + dockRecenter, selectedDay: $selectedDay)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                notesControl.padding(.top, 8).padding(.bottom, 12)
            }
            .toolbar(.hidden, for: .navigationBar)
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
        VStack(spacing: 10) {
            Capsule().fill(theme.secondary.opacity(0.6)).frame(width: 32, height: 4)
                .accessibilityHidden(true)
            Button { notesPresented = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: "book.closed").font(.title3).frame(width: 36)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Today’s note").font(.caption).foregroundStyle(theme.secondary)
                        Text(notePreview)
                            .font(.subheadline).lineLimit(2).multilineTextAlignment(.leading)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.up").font(.caption)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("dailyNotePreview")
            Divider().overlay(theme.ink.opacity(0.06))
            HStack(spacing: 16) {
                Button {
                    selectedDay = .now
                    dockRecenter += 1
                } label: {
                    Label("Today", systemImage: "arrow.counterclockwise")
                        .font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, minHeight: 48)
                }.buttonStyle(.plain).accessibilityIdentifier("recenterToday")
                Button { notesPresented = true } label: {
                    Image(systemName: "pencil").font(.title2.weight(.medium))
                        .foregroundStyle(theme.base).frame(width: 56, height: 56)
                        .background(theme.accent, in: .circle)
                }.buttonStyle(.plain).accessibilityIdentifier("openDailyNote")
                    .accessibilityLabel("Open today’s note")
                Button { searchPresented = true } label: {
                    Label("Search", systemImage: "magnifyingglass")
                        .font(.subheadline.weight(.medium)).frame(maxWidth: .infinity, minHeight: 48)
                }.buttonStyle(.plain).accessibilityIdentifier("daySearch")
            }
        }
        .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 12)
        .foregroundStyle(theme.ink)
        .glassEffect(.regular, in: .rect(cornerRadius: 30))
        .padding(.horizontal, 12)
        .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
            if value.translation.height < -35 && abs(value.translation.height) > abs(value.translation.width) {
                notesPresented = true
            }
        })
    }

    private func closeNote() async {
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
    @State private var showCalendar = false
    private func matches(_ text: String) -> Bool { text.localizedCaseInsensitiveContains(query) }
    var body: some View {
        NavigationStack {
            List {
                if query.isEmpty {
                    Section("Browse") {
                        NavigationLink("Day calendar") { AgendaView(store: store) }
                        NavigationLink("People") { PeopleView(store: store) }
                        NavigationLink("GitHub") { RepositoryListView(store: store) }
                        NavigationLink("Captures") { CaptureListView(store: store) }
                        NavigationLink("On this device") { LocalDaybookView(store: store, showAgenda: { showCalendar = true }) }
                        NavigationLink("Account & appearance") { SettingsView(store: store, session: store.session) }
                            .accessibilityIdentifier("todaySettings")
                    }
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
            .navigationDestination(isPresented: $showCalendar) { AgendaView(store: store) }
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
