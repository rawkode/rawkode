import Combine
import CryptoKit
import Foundation

struct GraphTask: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    var status: String
    var dueDate: String?
    var priority: String
    var projectId: String?
    var linkedEntityIds: [String]
    var revision: Int
    var bodyDocumentId: String?
}

struct PendingTaskEdit: Codable, Identifiable {
    var id = UUID().uuidString
    var taskID: String?
    var expectedRevision: Int?
    var title: String
    var dueDate: String?
    var priority: String
    var status: String
    var conflict = false
}

/// Account-scoped, atomic local outbox. Failed and conflicting writes remain visible.
@MainActor final class TasksStore: ObservableObject {
    @Published private(set) var tasks: [GraphTask] = []
    @Published private(set) var pending: [PendingTaskEdit] = []
    @Published private(set) var loading = false
    @Published private(set) var hasLoaded = false
    var canCreate: Bool { owner != nil && cacheURL != nil }
    @Published private(set) var sending = false
    @Published private(set) var error: String?
    private var owner: String?
    private var generation = UUID()
    var scopeID: UUID { generation }
    private var cacheURL: URL?
    private let session: NativeSession
    private let directory: URL
    private struct Cache: Codable { var tasks: [GraphTask]; var pending: [PendingTaskEdit] }
    init(session: NativeSession, directory: URL) { self.session = session; self.directory = directory }

    func bind(accountID: String?) {
        guard owner != accountID else { return }
        generation = UUID()
        owner = accountID; tasks = []; pending = []; error = nil; cacheURL = nil; loading = false; sending = false; hasLoaded = false
        guard let accountID else { return }
        let key = SHA256.hash(data: Data((session.origin.absoluteString + "|" + accountID).utf8)).map { String(format: "%02x", $0) }.joined()
        cacheURL = directory.appendingPathComponent("tasks-\(key).json")
        do {
            guard let cacheURL, FileManager.default.fileExists(atPath: cacheURL.path) else { return }
            let saved = try JSONDecoder().decode(Cache.self, from: Data(contentsOf: cacheURL))
            tasks = saved.tasks; pending = saved.pending; hasLoaded = true
        } catch { self.error = "Your saved tasks could not be opened. The original file is unchanged."; cacheURL = nil }
    }
    func seedDemo() {
        guard ProcessInfo.processInfo.arguments.contains("--demo"), tasks.isEmpty else { return }
        let today = TaskDay.key(.now)
        let next = TaskDay.key(Calendar.current.date(byAdding: .day, value: 2, to: .now)!)
        hasLoaded = true
        tasks = [
            GraphTask(id: "demo-1", title: "Shape the voice workspace", status: "open", dueDate: today, priority: "high", linkedEntityIds: [], revision: 1),
            GraphTask(id: "demo-2", title: "Book a little time to think", status: "open", dueDate: today, priority: "none", linkedEntityIds: [], revision: 1),
            GraphTask(id: "demo-3", title: "Plan the next Rawkode Live", status: "open", dueDate: next, priority: "medium", linkedEntityIds: [], revision: 1),
            GraphTask(id: "demo-4", title: "Explore meeting notes", status: "open", dueDate: nil, priority: "none", linkedEntityIds: [], revision: 1),
            GraphTask(id: "demo-5", title: "Make space for focused work", status: "completed", dueDate: today, priority: "none", linkedEntityIds: [], revision: 2)
        ]
    }
    private func persist(tasks: [GraphTask], pending: [PendingTaskEdit]) throws {
        guard let cacheURL else { throw CocoaError(.fileWriteUnknown) }
        let data = try JSONEncoder().encode(Cache(tasks: tasks, pending: pending))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: cacheURL, options: [.atomic, .completeFileProtectionUnlessOpen])
        #else
        try data.write(to: cacheURL, options: .atomic)
        #endif
        self.tasks = tasks; self.pending = pending
    }
    func refresh() async {
        guard !loading, let owner, session.accountID == owner else { return }
        let generation = self.generation
        let initialRevisions = Dictionary(tasks.map { ($0.id, $0.revision) }, uniquingKeysWith: max)
        loading = true; defer { if self.generation == generation { loading = false } }
        do {
            struct Page: Decodable { let tasks: [GraphTask]; let nextCursor: String? }
            var all: [GraphTask] = []; var cursor: String?; var cursors = Set<String>()
            repeat {
                var query = [URLQueryItem(name: "limit", value: "100")]
                if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
                let bytes = try await session.read(path: "api/tasks", limit: 1_000_000, queryItems: query)
                let page = try JSONDecoder().decode(Page.self, from: bytes)
                guard self.generation == generation, owner == self.owner, session.accountID == owner else { return }
                all += page.tasks; cursor = page.nextCursor
                if let cursor, !cursors.insert(cursor).inserted { throw NativeSession.SessionError.invalidResponse }
            } while cursor != nil
            // A refresh begun before a successful mutation cannot roll its revision back.
            var merged = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, b in a.revision >= b.revision ? a : b })
            for task in tasks where task.revision != initialRevisions[task.id] && task.revision > (merged[task.id]?.revision ?? -1) { merged[task.id] = task }
            try persist(tasks: Array(merged.values), pending: pending); hasLoaded = true; error = nil
        } catch { guard self.generation == generation else { return }; self.error = "Couldn’t refresh tasks. Your saved tasks are still available. \(error.localizedDescription)" }
    }
    func save(_ edit: PendingTaskEdit, expectedScope: UUID) async -> Bool {
        guard expectedScope == generation else { error = "The account changed. Open a new task in this account."; return false }
        guard owner != nil else { error = "Connect your account before adding tasks."; return false }
        guard !edit.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, edit.title.utf16.count <= 500 else { return false }
        do { try persist(tasks: tasks, pending: pending + [edit]) }
        catch { self.error = "Couldn’t save this task on your device. Keep this window open and try again."; return false }
        Task { [weak self] in
            guard let self, self.scopeID == expectedScope else { return }
            await self.sync()
        }
        return true
    }
    func discard(_ id: String) {
        do { try persist(tasks: tasks, pending: pending.filter { $0.id != id }) }
        catch { self.error = "Couldn’t remove the pending change." }
    }
    func sync() async {
        guard !sending, let owner, session.accountID == owner else { return }
        let generation = self.generation
        sending = true; defer { if self.generation == generation { sending = false } }
        while let edit = pending.first(where: { !$0.conflict }) {
            guard self.generation == generation, self.owner == owner, session.accountID == owner else { return }
            do {
                var body: [String: Any] = ["title": edit.title, "dueDate": edit.dueDate as Any? ?? NSNull(), "priority": edit.priority]
                if let revision = edit.expectedRevision { body["expectedRevision"] = revision; body["status"] = edit.status }
                else { body["requestId"] = edit.id }
                let path = edit.taskID.map { "api/tasks/\($0)" } ?? "api/tasks"
                let data = try await session.read(path: path, body: JSONSerialization.data(withJSONObject: body), limit: 64_000, allowConflict: true, allowCreated: true)
                struct Reply: Decodable { let task: GraphTask?; let error: String? }
                let reply = try JSONDecoder().decode(Reply.self, from: data)
                guard self.generation == generation, self.owner == owner, session.accountID == owner else { return }
                if reply.error != nil {
                    let retained = pending.map { value in var next = value; if next.id == edit.id { next.conflict = true }; return next }
                    var current = tasks
                    if let task = reply.task { current.removeAll { $0.id == task.id }; current.append(task) }
                    try persist(tasks: current, pending: retained)
                    error = "A task changed elsewhere. Your edit is kept below; review the latest task before trying again."
                    continue
                }
                guard let task = reply.task else { throw NativeSession.SessionError.invalidResponse }
                try persist(tasks: tasks.filter { $0.id != task.id } + [task], pending: pending.filter { $0.id != edit.id })
                error = nil
            } catch { guard self.generation == generation else { return }; self.error = "Changes saved on this device, waiting to sync. \(error.localizedDescription)"; return }
        }
    }
}

/// Due days are local calendar dates, never UTC timestamps.
enum TaskDay {
    static func key(_ date: Date) -> String {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
