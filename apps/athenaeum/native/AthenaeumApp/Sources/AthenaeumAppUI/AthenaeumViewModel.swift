import Foundation
import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

// The native mirror of `web/src/App.tsx` + `DailyNote.tsx` + `Backlinks.tsx` + `GraphView.tsx`'s
// combined data layer, built on real `AthenaeumCore` actors instead of Effect/React hooks: one
// `@MainActor` `ObservableObject` owning the local-authority/CRDT/sync stack for exactly one
// resolved daily note, driving SwiftUI's own `@Published`-based render loop the same way the web
// client's `useEffectQuery`/component `useState` drive React's.
//
// Two `WorkspaceRPCClient` instances are held deliberately, mirroring the write/verify split
// `WorkspaceSyncClientLiveTests.swift` itself established: `WorkspaceSyncClient` owns its own internal
// client for the durable-before-sync write path (node/page/tag/fact/edge creation); `readClient`
// here is a second, independent client used only for read-only queries this stage's
// `WorkspaceSyncClient` doesn't wrap (`listBacklinks`, `runView`, `assignTag`,
// `createRelationDefinition`, `getNode`) — exactly the same methods `Backlinks.tsx`/`GraphView.tsx`
// call directly against `WorkspaceRpcClient` on the web side, without going through the local-SQLite
// write path (those calls have no local table to stay durable-before-sync with; the web client
// makes the identical choice).

@MainActor
public final class AthenaeumViewModel: ObservableObject {
    public enum SyncStatus: Equatable {
        case idle
        case loading
        case syncing
        case synced
        case error(String)
    }

    public struct BacklinkRow: Identifiable, Equatable {
        public let id: String
        public let sourceNodeId: String
        public let sourceTitle: String
    }

    public struct GraphNodeRow: Identifiable, Equatable {
        public let id: String
        public let title: String
        public let createdAt: String
    }

    @Published public private(set) var status: SyncStatus = .loading
    @Published public private(set) var text: String = ""
    /// **Native safety pass** (`docs/rich-text-editor-decisions.md` item 6): `true` once
    /// `PageDocumentStore.isRichTextNote` reports this note uses the web rich-text editor's
    /// block/mark-shaped document. The view renders the editor read-only rather than allowing an
    /// edit `RichTextCompatTests.testNativeSpliceAcrossBlockMarkerDeletesTheMarker` proved can
    /// silently corrupt block-marker structure.
    @Published public private(set) var isRichTextReadOnly: Bool = false
    @Published public private(set) var backlinks: [BacklinkRow] = []
    @Published public private(set) var graphRows: [GraphNodeRow] = []
    @Published public var onlyPerson: Bool = false {
        didSet { if oldValue != onlyPerson { Task { await self.reloadGraphView() } } }
    }
    @Published public var newBacklinkTitle: String = ""
    @Published public private(set) var isLinkingBacklink = false
    @Published public private(set) var linkError: String?

    public let workspaceId: EntityId
    public let dailyNoteTitle: String = dailyNoteTitleForDate(Date())
    private let dailyNoteId: EntityId

    private let localStore: LocalWorkspaceStore
    private let pageStore: PageDocumentStore
    private let syncClient: WorkspaceSyncClient
    private let readClient: WorkspaceRPCClient
    private let session = SyncSessionHandle()
    private var syncTask: Task<Void, Never>?

    /// `bearerCredential` (Phase 4 addition) — a `DevSession`-held dev-auth credential, threaded
    /// straight through to both internal `WorkspaceRPCClient`s. `nil` (the default) is every
    /// pre-Phase-4 call site's exact prior behavior: an anonymous connection, which every method
    /// this view model calls still accepts today for an ungoverned workspace (and, per
    /// `workspace-durable-object.ts`'s own documented scope note, even for a governed one — the
    /// per-method role gate only applies when a credential IS present).
    public init(
        baseURL: URL = WorkspaceConfiguration.resolveBackendURL(),
        workspaceId: EntityId = WorkspaceConfiguration.resolveWorkspaceId(),
        bearerCredential: String? = nil
    ) throws {
        self.workspaceId = workspaceId
        self.dailyNoteId = dailyNoteIdForDate(Date())

        let workspaceURL = baseURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        let writeClient = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
        self.readClient = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
        self.localStore = try LocalWorkspaceStore(path: try WorkspaceConfiguration.localStorePath(workspaceId: workspaceId))
        self.pageStore = PageDocumentStore()
        self.syncClient = WorkspaceSyncClient(
            localStore: localStore, pageStore: pageStore, rpcClient: writeClient, workspaceId: workspaceId
        )
    }

    // MARK: - Load

    /// Resolve-or-create today's daily note (same deterministic id both clients share — see
    /// `DailyNoteID.swift`), pull its current content in via a real sync-session round trip, then
    /// load backlinks + the read-only graph view. Mirrors `DailyNote.tsx`'s `resolveDailyNote`
    /// composed with `App.tsx`'s mount-time effects.
    public func start() async {
        status = .loading
        do {
            _ = try await syncClient.resolveOrCreateNode(id: dailyNoteId, title: dailyNoteTitle)
            let resolvedText = try await syncClient.resolveOrCreatePage(nodeId: dailyNoteId, session: session)
            text = resolvedText
            isRichTextReadOnly = try await pageStore.isRichTextNote(nodeId: dailyNoteId)
            status = .synced
        } catch {
            status = .error(String(describing: error))
            return
        }
        await reloadBacklinks()
        await reloadGraphView()
    }

    // MARK: - Editing (mirrors `DailyNote.tsx`'s `handleChange`/`scheduleSync`)

    /// Called on every `TextEditor` change. Diffs against the last-known text, applies the result
    /// as a real local Automerge change (never a direct server write) — awaited immediately, so
    /// the CRDT mutation and its `LocalWorkspaceStore` snapshot (durable-before-sync) are committed
    /// before this method returns control to SwiftUI — then debounces a real sync-session round
    /// trip 500ms later, same shape/timing as the web client's `setTimeout`, cancelling any
    /// still-pending debounce from a previous keystroke first.
    public func handleTextChange(_ newText: String) {
        // Native safety pass: `DailyNoteView` already disables the `TextEditor` binding when
        // `isRichTextReadOnly` is set, so this should be unreachable in the UI — but guard here
        // too rather than relying solely on the view layer, matching this store's own
        // fail-closed-in-more-than-one-place posture.
        guard !isRichTextReadOnly else { return }
        guard let edit = diffText(before: text, after: newText) else { return }
        text = newText

        syncTask?.cancel()
        syncTask = Task {
            do {
                _ = try await pageStore.applyLocalSplice(
                    nodeId: dailyNoteId, index: edit.index, deleteCount: edit.deleteCount, insertText: edit.insertText
                )
            } catch PageDocumentStoreError.richTextNoteReadOnlyOnNative {
                // Discovered late (e.g. a rich edit synced in between load and this keystroke) —
                // flip into the same read-only state the view checks up front, with the same
                // user-facing message, rather than surfacing a raw error string.
                isRichTextReadOnly = true
                return
            } catch {
                status = .error(String(describing: error))
                return
            }

            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            await runSync()
        }
    }

    private func runSync() async {
        status = .syncing
        do {
            let converged = try await syncClient.syncPage(nodeId: dailyNoteId, session: session)
            text = converged
            isRichTextReadOnly = try await pageStore.isRichTextNote(nodeId: dailyNoteId)
            status = .synced
        } catch {
            status = .error(String(describing: error))
        }
    }

    // MARK: - Backlinks (mirrors `Backlinks.tsx`)

    public func reloadBacklinks() async {
        do {
            let edges = try await readClient.listBacklinks(nodeId: dailyNoteId.rawValue)
            var rows: [BacklinkRow] = []
            for edge in edges {
                let node = try await readClient.getNode(nodeId: edge.sourceNodeId)
                rows.append(BacklinkRow(id: edge.id, sourceNodeId: edge.sourceNodeId, sourceTitle: node.title))
            }
            backlinks = rows
        } catch {
            // Backlinks are a secondary section — a failure here shouldn't blank out an
            // already-loaded daily note, so it's logged via `linkError` rather than `status`.
            linkError = "Failed to load backlinks: \(error)"
        }
    }

    /// Mirrors `Backlinks.tsx`'s "+ Create + link" affordance: lazily create/reuse one "mentions"
    /// relation definition for this workspace (mirrors `mentions-relation.ts`'s
    /// `ensureMentionsRelationDefinition`, cached in `UserDefaults` instead of `localStorage`),
    /// create a new node with the entered title, and link it to today's note as a backlink.
    public func createAndLinkBacklink() async {
        let title = newBacklinkTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        isLinkingBacklink = true
        linkError = nil
        defer { isLinkingBacklink = false }

        do {
            let relationDefinitionId = try await ensureMentionsRelationDefinition()
            let node = try await syncClient.createNode(title: title)
            _ = try await syncClient.createEdge(
                relationDefinitionId: relationDefinitionId, sourceNodeId: node.id, targetNodeId: dailyNoteId
            )
            newBacklinkTitle = ""
            await reloadBacklinks()
        } catch {
            linkError = "Failed to create + link node: \(error)"
        }
    }

    private func ensureMentionsRelationDefinition() async throws -> EntityId {
        let key = "athenaeum.mentionsRelationDefinitionId.\(workspaceId.rawValue)"
        if let cached = UserDefaults.standard.string(forKey: key), let id = try? EntityId(validating: cached) {
            return id
        }
        let relationDefinition = try await readClient.createRelationDefinition(
            forwardName: "mentions", inverseName: "mentioned by",
            sourceTagId: BaseTagIds.project.rawValue, targetTagId: BaseTagIds.project.rawValue,
            cardinality: "many-to-many"
        )
        UserDefaults.standard.set(relationDefinition.id, forKey: key)
        return try EntityId(validating: relationDefinition.id)
    }

    // MARK: - Graph view (mirrors `GraphView.tsx`)

    public func reloadGraphView() async {
        let viewSpec = Self.graphNodesViewSpec(onlyPerson: onlyPerson)
        do {
            let rows = try await readClient.runView(viewName: "graph_nodes", viewSpec: viewSpec)
            graphRows = try rows.map { row in
                guard let id = try row.field("id").stringValue,
                      let title = try row.field("title").stringValue,
                      let createdAt = try row.field("createdAt").stringValue
                else { throw CapnWebError.malformedMessage("malformed graph_nodes row: \(row)") }
                return GraphNodeRow(id: id, title: title, createdAt: createdAt)
            }
        } catch {
            linkError = "Failed to load graph view: \(error)"
        }
    }

    public func assignPersonTag(nodeId: String) async {
        do {
            try await readClient.assignTag(nodeId: nodeId, tagId: BaseTagIds.person.rawValue)
            await reloadGraphView()
        } catch {
            linkError = "Failed to assign Person tag: \(error)"
        }
    }

    /// The wire shape `packages/domain/src/view-spec.ts`'s `ViewSpec` encodes to, built directly
    /// as a `CapnWebValue` — see `WorkspaceRPCClient.runView`'s doc comment for why this stage's
    /// `AthenaeumRPC` deliberately doesn't mirror the full predicate-tree schema as Swift types.
    static func graphNodesViewSpec(onlyPerson: Bool) -> CapnWebValue {
        var fields: [String: CapnWebValue] = [
            "sortColumn": .string("createdAt"),
            "sortDescending": .bool(true),
            "view": .string("table"),
            "visibleColumns": .array([.string("id"), .string("title"), .string("createdAt")]),
            "rowLimit": .int(50)
        ]
        if onlyPerson {
            fields["filter"] = .object(["op": .string("hasTag"), "tagId": .string(BaseTagIds.person.rawValue)])
        }
        return .object(fields)
    }
}
