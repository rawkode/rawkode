import ApsidesCore
import Combine
import CryptoKit
import SwiftUI

/// Today's note in the native editor: read through the authenticated session,
/// edited as the canonical Tiptap tree, written back with revision checks.
struct NativeNoteScreen: View {
    @ObservedObject var store: WorkspaceStore
    @ObservedObject private var controller: NativeNoteController
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    init(store: WorkspaceStore) {
        self.store = store
        _controller = ObservedObject(wrappedValue: store.nativeNote)
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
                if !controller.locallySaved {
                    Button("Retry saving") { Task { await controller.save() } }.font(.caption)
                } else if controller.conflict {
                    Button("Check latest") { Task { await controller.load() } }.font(.caption)
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
    @Published private(set) var locallySaved = true
    @Published private(set) var documentID: String
    let model: NoteEditorModel

    private unowned let store: WorkspaceStore
    private var persistence: NotePersistence?
    private var loadedAccount: String?
    private var generation = UUID()
    private var debounce: Task<Void, Never>?
    private var subscriptions = Set<AnyCancellable>()

    init(store: WorkspaceStore) {
        self.store = store
        documentID = "daily:" + DayIdentity.key(.now)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-testing"),
           store.session.origin.scheme == "http",
           ["localhost", "127.0.0.1"].contains(store.session.origin.host ?? ""),
           let fixtureID = ProcessInfo.processInfo.environment["APSIDES_NATIVE_TEST_DOCUMENT_ID"],
           fixtureID.hasPrefix("native-test:"),
           fixtureID.range(of: "^[a-zA-Z0-9:_-]{1,128}$", options: .regularExpression) != nil {
            documentID = fixtureID
        }
        #endif
        model = NoteEditorModel(document: NoteDocument(), directory: SessionEntityDirectory(session: store.session))
        model.$revision.dropFirst().sink { [weak self] _ in self?.scheduleSave() }.store(in: &subscriptions)
        store.session.$accountID.dropFirst().sink { [weak self] account in
            guard let self, let loadedAccount = self.loadedAccount, account != loadedAccount else { return }
            self.flush()
            self.generation = UUID()
            self.persistence = nil
            self.state = .loading
            Task { await self.load() }
        }.store(in: &subscriptions)
    }

    var statusSymbol: String {
        if conflict { return "exclamationmark.triangle" }
        if saveError != nil { return "arrow.clockwise" }
        return persistence?.dirty == false ? "checkmark.circle" : "circle.dotted"
    }

    func dayChanged() {
        let today = "daily:" + DayIdentity.key(.now)
        guard today != documentID else { return }
        guard flush() else { return }
        generation = UUID()
        persistence = nil
        state = .loading
        documentID = today
    }

    func load() async {
        if let persistence, case .ready = state {
            let token = generation
            await persistence.refresh()
            guard generation == token, self.persistence === persistence else { return }
            if model.document != persistence.document {
                state = .loading
                model.replaceDocument(persistence.document)
                state = .ready
            }
            updateStatus(persistence)
            return
        }
        debounce?.cancel()
        let token = UUID()
        generation = token
        let id = documentID
        state = .loading
        let session = store.session
        if !session.isConnected { try? await session.verifyConnection() }
        guard token == generation else { return }
        guard let account = session.accountID ?? store.vault.accountID else {
            state = .failed("Sign in to your Enchiridion website to open today’s note.")
            return
        }
        do {
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("Enchiridion/NativeNotes", isDirectory: true)
            let identity = session.origin.absoluteString + "|" + account + "|" + id
            let key = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
            let context = try NotePersistence.open(url: directory.appendingPathComponent(key + ".json"), read: {
                guard session.accountID == account else { throw CocoaError(.userCancelled) }
                let data = try await session.document(id: id)
                guard session.accountID == account,
                      let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw NativeSession.SessionError.invalidResponse
                }
                if envelope["document"] is NSNull { return NoteSnapshot(document: NoteDocument(), revision: nil) }
                guard let stored = envelope["document"] as? [String: Any], stored["id"] as? String == id,
                      let revision = stored["revision"] as? Int, let note = stored["note"] else {
                    throw NativeSession.SessionError.invalidResponse
                }
                return NoteSnapshot(document: try NoteDocument.decode(JSONSerialization.data(withJSONObject: note)), revision: revision)
            }, write: { document, revision in
                guard session.isConnected, session.accountID == account else { throw CocoaError(.userCancelled) }
                let result = try await session.saveDocument(id: id, note: document.jsonObject(), expectedRevision: revision)
                guard session.accountID == account else { throw CocoaError(.userCancelled) }
                return result
            })
            loadedAccount = account
            persistence = context
            // Expose a durable draft immediately, including while offline.
            model.replaceDocument(context.document)
            state = .ready
            context.changed = { [weak self, weak context] in
                guard let self, let context, self.generation == token else { return }
                self.updateStatus(context)
            }
            updateStatus(context)
            await context.refresh()
            guard generation == token, session.accountID == account else { return }
            if model.document != context.document {
                state = .loading
                model.replaceDocument(context.document)
                state = .ready
            }
            updateStatus(context)
        } catch {
            guard generation == token else { return }
            state = .failed("Your saved draft could not be opened. Nothing was overwritten. " + error.localizedDescription)
        }
    }

    private func updateStatus(_ context: NotePersistence) {
        conflict = context.conflict
        saveError = context.error
        locallySaved = context.locallySaved
        if !locallySaved {
            status = "Unable to save on this device. Keep this note open and retry."
        } else if conflict {
            status = "Changed elsewhere. Your local draft is kept; check latest to retry safely."
        } else if context.sending {
            status = "Syncing…"
        } else if let error = context.error {
            status = "Waiting to sync: " + error
        } else {
            status = context.dirty ? "Saved on this device" : "All changes saved"
            if !context.dirty, let account = loadedAccount,
               let preview = DailyNotePreview(accountID: account, day: String(documentID.dropFirst("daily:".count)), editorText: context.document.plainText) {
                _ = store.saveNotePreview(preview)
            }
        }
    }

    private func scheduleSave() {
        guard case .ready = state, let persistence else { return }
        do { try persistence.edit(model.document) }
        catch { saveError = error.localizedDescription; status = "Unable to save on this device"; return }
        debounce?.cancel()
        // Only the delay is cancellable. Once handed off, transport owns its
        // lifetime and serializes subsequent edits through the same context.
        debounce = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(1_200)) } catch { return }
            guard let self else { return }
            self.debounce = nil
            Task { await persistence.save() }
        }
    }

    func save() async {
        guard let persistence else { return }
        await persistence.save()
    }

    @discardableResult func flush() -> Bool {
        debounce?.cancel()
        debounce = nil
        guard case .ready = state, let persistence else { return true }
        do { try persistence.edit(model.document) }
        catch { saveError = error.localizedDescription; status = "Unable to save on this device"; return false }
        Task { await persistence.save() }
        return true
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
