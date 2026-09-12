import SwiftUI

/// Two small entry controls for comparing how today's note fits around the day.
enum NotesEntryStyle: String, CaseIterable, Identifiable {
    case floatingButton, pullUpHandle
    var id: String { rawValue }
    var label: String { self == .floatingButton ? "Floating button" : "Pull-up handle" }
}

#if os(iOS)
struct PhoneTodayView: View {
    @ObservedObject var store: WorkspaceStore
    let showAgenda: () -> Void
    let recenter: Int
    @AppStorage("notesEntryStyle", store: ApsidesPreferences.store) private var entryStyle: NotesEntryStyle = .floatingButton
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
        DayTimelineView(store: store, recenter: recenter)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                notesControl.padding(.top, 8).padding(.bottom, 12)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { store.settingsPresented = true } label: {
                        Label("Settings", systemImage: "gearshape")
                    }.accessibilityIdentifier("todaySettings")
                }
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
            .onReceive(NotificationCenter.default.publisher(for: Notification.Name("apsidesOpenDailyNote"))) { _ in
                notesPresented = true
            }
    }

    private var notesControl: some View {
        Button { notesPresented = true } label: {
            Group {
                if entryStyle == .floatingButton {
                    Label("Today’s note", systemImage: "square.and.pencil")
                        .font(.headline).padding(.horizontal, 22).padding(.vertical, 15)
                } else {
                    VStack(spacing: 7) {
                        Capsule().fill(theme.secondary.opacity(0.65)).frame(width: 32, height: 4)
                        Text("Today’s note").font(.subheadline.weight(.semibold))
                    }.padding(.horizontal, 36).padding(.vertical, 12)
                }
            }
            .foregroundStyle(theme.ink)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .accessibilityIdentifier("openDailyNote")
        .accessibilityLabel("Open today’s note")
        .accessibilityHint(entryStyle == .pullUpHandle ? "Tap or swipe up to write" : "Opens your daily notebook")
        .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { value in
            guard entryStyle == .pullUpHandle,
                  value.translation.height < -35,
                  abs(value.translation.height) > abs(value.translation.width) else { return }
            notesPresented = true
        })
    }

    private func closeNote() async {
        store.session.makeEditorWebView().endEditing(false)
        guard await store.session.editorCanLeave() else { closeError = true; return }
        notesPresented = false
    }
}
#endif
