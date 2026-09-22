import Foundation

public struct NoteSnapshot: Codable, Equatable, Sendable {
    public var document: NoteDocument
    public var revision: Int?
    public init(document: NoteDocument, revision: Int?) {
        self.document = document; self.revision = revision
    }
}

/// One immutable account/document context. Each request and durable draft belongs to
/// this instance, never to the screen's subsequently selected day.
@MainActor public final class NotePersistence {
    private final class WeakContext {
        weak var value: NotePersistence?
        init(_ value: NotePersistence) { self.value = value }
    }
    private static var contexts: [URL: WeakContext] = [:]
    // A disk failure must not turn dismissal or account switching into data loss.
    // Retain only failed contexts until an atomic write succeeds.
    private static var unsavedContexts: [URL: NotePersistence] = [:]

    /// Reopening while a save is in flight reuses its writer and newest draft.
    /// Weak entries release idle contexts without retaining account sessions.
    public static func open(url: URL, read: @escaping () async throws -> NoteSnapshot,
                            write: @escaping (NoteDocument, Int?) async throws -> Int) throws -> NotePersistence {
        let key = url.standardizedFileURL
        if let existing = unsavedContexts[key] ?? contexts[key]?.value { return existing }
        contexts = contexts.filter { $0.value.value != nil }
        let context = try NotePersistence(url: key, read: read, write: write)
        contexts[key] = WeakContext(context)
        return context
    }

    private struct Draft: Codable {
        var base: NoteSnapshot
        var document: NoteDocument
        var attempted: NoteDocument?
    }
    public private(set) var document: NoteDocument
    public private(set) var conflict = false
    public private(set) var sending = false
    public private(set) var error: String?
    public private(set) var locallySaved = true
    public var changed: (() -> Void)?
    public var dirty: Bool { document != draft.base.document || draft.attempted != nil }
    private var refreshing = false
    private var saveAfterRefresh = false
    private var draft: Draft
    private let url: URL
    private let read: () async throws -> NoteSnapshot
    private let write: (NoteDocument, Int?) async throws -> Int

    public init(url: URL, read: @escaping () async throws -> NoteSnapshot,
                write: @escaping (NoteDocument, Int?) async throws -> Int) throws {
        self.url = url; self.read = read; self.write = write
        if FileManager.default.fileExists(atPath: url.path) {
            draft = try JSONDecoder().decode(Draft.self, from: Data(contentsOf: url))
        } else {
            draft = Draft(base: NoteSnapshot(document: NoteDocument(), revision: nil), document: NoteDocument())
        }
        // Decode through the canonical validator as well as Codable. Reject a
        // corrupt or future-format cache instead of presenting a destructive blank.
        _ = try NoteDocument.decode(draft.document.encoded())
        _ = try NoteDocument.decode(draft.base.document.encoded())
        if let attempted = draft.attempted { _ = try NoteDocument.decode(attempted.encoded()) }
        document = draft.document
    }

    private func persist() throws {
        locallySaved = false
        defer {
            let key = url.standardizedFileURL
            if locallySaved { Self.unsavedContexts.removeValue(forKey: key) }
            else { Self.unsavedContexts[key] = self }
        }
        let data = try JSONEncoder().encode(draft)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        locallySaved = true
    }

    /// Disk retry is independent of server conflicts and remote dirty state.
    @discardableResult public func retryLocalSave() -> Bool {
        defer { changed?() }
        do { try persist(); error = nil; return true }
        catch { self.error = error.localizedDescription; return false }
    }

    public func edit(_ document: NoteDocument) throws {
        self.document = document
        draft.document = document
        defer { changed?() }
        do { try persist(); error = nil } catch { self.error = error.localizedDescription; throw error }
    }

    /// Reconcile an uncertain acknowledgement by content. A differing remote edit
    /// is a conflict; refreshing never discards the local draft.
    private func reconcile(_ remote: NoteSnapshot) throws {
        if let attempted = draft.attempted, remote.document == attempted {
            draft.base = remote; draft.attempted = nil; conflict = false
        } else if remote == draft.base {
            draft.attempted = nil; conflict = false
        } else if !dirty {
            draft.base = remote; draft.document = remote.document; document = remote.document
            conflict = false
        } else {
            conflict = true
        }
        try persist()
    }

    public func refresh() async {
        guard !sending else { return }
        sending = true; refreshing = true; changed?()
        defer {
            sending = false; refreshing = false; changed?()
            if saveAfterRefresh {
                saveAfterRefresh = false
                Task { await self.save() }
            }
        }
        do { try reconcile(try await read()); error = nil }
        catch { self.error = error.localizedDescription }
    }

    public func save() async {
        if !locallySaved, !retryLocalSave() { return }
        if refreshing { saveAfterRefresh = true; return }
        guard !sending, !conflict else { return }
        sending = true; changed?()
        defer { sending = false; changed?() }
        do {
            // A prior request may have committed even if its reply was lost.
            if draft.attempted != nil { try reconcile(try await read()) }
            while dirty && !conflict {
                let sent = document
                draft.attempted = sent
                try persist() // Record uncertain intent before starting transport.
                do {
                    let revision = try await write(sent, draft.base.revision)
                    draft.base = NoteSnapshot(document: sent, revision: revision)
                    draft.attempted = nil
                    try persist()
                    error = nil
                } catch {
                    let transportError = error
                    // Do not retry a write until the server has been reconciled.
                    do { try reconcile(try await read()) }
                    catch { self.error = transportError.localizedDescription; return }
                    if conflict { self.error = transportError.localizedDescription; return }
                    if draft.base.document != sent { self.error = transportError.localizedDescription; return }
                    self.error = nil // The lost acknowledgement was confirmed; send newer local edits.
                }
            }
        } catch { self.error = error.localizedDescription }
    }
}
