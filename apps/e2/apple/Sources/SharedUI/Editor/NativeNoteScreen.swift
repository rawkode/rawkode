import ApsidesCore
import Combine
import SwiftUI

/// Today's note in the native editor: read through the authenticated session,
/// edited as the canonical Tiptap tree, written back with revision checks.
struct NativeNoteScreen: View {
    @ObservedObject var store: WorkspaceStore
    @StateObject private var controller: NativeNoteController
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    init(store: WorkspaceStore) {
        self.store = store
        _controller = StateObject(wrappedValue: NativeNoteController(store: store))
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            theme.canvas.ignoresSafeArea()
            switch controller.state {
            case .loading:
                VStack(alignment: .leading, spacing: 14) {
                    Text("Opening your notebook").font(.system(.title2, design: .serif))
                    ProgressView().tint(theme.accent)
                }.padding(24).foregroundStyle(theme.ink)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Unable to open your notebook", systemImage: "book.closed")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") { Task { await controller.load() } }.buttonStyle(.borderedProminent)
                    Button("Account settings") { store.settingsPresented = true }
                }
            case .ready:
                NoteEditorView(model: controller.model)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: controller.statusSymbol).foregroundStyle(controller.conflict ? .orange : theme.secondary)
                Text(controller.status).font(.caption).foregroundStyle(theme.secondary)
                Spacer()
                if controller.conflict {
                    Button("Reload latest") { Task { await controller.load() } }.font(.caption)
                } else if controller.saveError != nil {
                    Button("Retry") { Task { await controller.save() } }.font(.caption)
                }
            }
            .padding(.horizontal, 20).frame(height: 30)
            .background(theme.canvas)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("saveStatus")
        }
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(theme.canvas, for: .navigationBar)
        #endif
        .task(id: controller.documentID) { await controller.load() }
        .onDisappear { controller.flush() }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged).receive(on: RunLoop.main)) { _ in controller.dayChanged() }
    }
}

@MainActor
final class NativeNoteController: ObservableObject {
    enum State { case loading, failed(String), ready }

    @Published private(set) var state: State = .loading
    @Published private(set) var status = "Opening…"
    @Published private(set) var conflict = false
    @Published private(set) var saveError: String?
    @Published private(set) var documentID: String
    let model: NoteEditorModel

    private let store: WorkspaceStore
    private var revision: Int?
    private var savedDocument: NoteDocument?
    private var loadedAccount: String?
    private var saveTask: Task<Void, Never>?
    private var subscriptions = Set<AnyCancellable>()

    init(store: WorkspaceStore) {
        self.store = store
        documentID = "daily:" + DayIdentity.key(.now)
        model = NoteEditorModel(document: NoteDocument(), directory: SessionEntityDirectory(session: store.session))
        model.$revision.dropFirst().sink { [weak self] _ in self?.scheduleSave() }.store(in: &subscriptions)
    }

    var statusSymbol: String {
        if conflict { return "exclamationmark.triangle" }
        if saveError != nil { return "arrow.clockwise" }
        return savedDocument == model.document ? "checkmark.circle" : "circle.dotted"
    }

    func dayChanged() {
        let today = "daily:" + DayIdentity.key(.now)
        guard today != documentID else { return }
        flush()
        documentID = today
    }

    func load() async {
        saveTask?.cancel()
        state = .loading
        conflict = false
        saveError = nil
        let session = store.session
        // A relaunch keeps the sign-in cookie but not the verified identity.
        if !session.isConnected { try? await session.verifyConnection() }
        guard session.isConnected, let account = session.accountID else {
            state = .failed("Sign in to your Enchiridion website to open today’s note.")
            return
        }
        do {
            let data = try await session.document(id: documentID)
            guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeSession.SessionError.invalidResponse }
            let document: NoteDocument
            if let stored = envelope["document"] as? [String: Any] {
                guard stored["id"] as? String == documentID, let revision = stored["revision"] as? Int, let note = stored["note"] else {
                    throw NativeSession.SessionError.invalidResponse
                }
                document = try NoteDocument.decode(JSONSerialization.data(withJSONObject: note))
                self.revision = revision
            } else if envelope["document"] is NSNull {
                document = NoteDocument()
                revision = nil
            } else {
                throw NativeSession.SessionError.invalidResponse
            }
            loadedAccount = account
            savedDocument = document
            model.replaceDocument(document)
            state = .ready
            status = revision == nil ? "New note for today" : "All changes saved"
        } catch let error as NoteDocument.FormatError {
            state = .failed("This note uses content this app cannot edit yet. Open it on the web; nothing was changed. \(error.localizedDescription)")
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func scheduleSave() {
        guard case .ready = state, !conflict else { return }
        status = "Unsaved changes"
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1_200))
            guard !Task.isCancelled else { return }
            await self?.save()
        }
    }

    /// Write the current document if it differs from the last acknowledged one.
    func save() async {
        guard case .ready = state, !conflict else { return }
        let document = model.document
        guard document != savedDocument else { status = revision == nil ? "New note for today" : "All changes saved"; return }
        let session = store.session
        guard session.isConnected, session.accountID == loadedAccount else {
            saveError = "Sign in again to save this note. Your edits stay on screen."
            status = "Not saved: signed out"
            return
        }
        status = "Saving…"
        saveError = nil
        do {
            let note = try document.jsonObject()
            let stored = try await session.saveDocument(id: documentID, note: note, expectedRevision: revision)
            revision = stored
            savedDocument = document
            status = model.document == document ? "All changes saved" : "Unsaved changes"
            if let preview = DailyNotePreview(accountID: loadedAccount ?? "", day: String(documentID.dropFirst("daily:".count)), editorText: document.plainText) {
                _ = store.saveNotePreview(preview)
            }
            if model.document != document { scheduleSave() }
        } catch NativeSession.SessionError.documentConflict {
            conflict = true
            status = "This note changed elsewhere. Reload to see it; your unsaved edits here are not uploaded."
        } catch {
            saveError = error.localizedDescription
            status = "Not saved: \(error.localizedDescription)"
        }
    }

    /// Best effort on the way out; a cancelled task cannot be awaited from `onDisappear`.
    func flush() {
        saveTask?.cancel()
        guard case .ready = state, model.document != savedDocument else { return }
        Task { await save() }
    }
}

/// `@` and `#` search through the authenticated GraphQL entities query.
struct SessionEntityDirectory: EntityDirectory {
    let session: NativeSession

    func search(_ query: String) async throws -> [EntityMatch] {
        let data = try await session.entities(query: query)
        guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = body["data"] as? [String: Any], let me = payload["me"] as? [String: Any],
              let entities = me["entities"] as? [[String: Any]] else {
            if let errors = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["errors"] as? [[String: Any]],
               let message = errors.first?["message"] as? String { throw DirectoryError.server(message) }
            throw NativeSession.SessionError.invalidResponse
        }
        return entities.compactMap { entity in
            guard let id = entity["id"] as? String, NoteIdentifier.isValid(id), let label = entity["label"] as? String, !label.isEmpty else { return nil }
            return EntityMatch(id: id, label: label)
        }
    }

    enum DirectoryError: LocalizedError {
        case server(String)
        var errorDescription: String? { switch self { case .server(let message): message } }
    }
}
