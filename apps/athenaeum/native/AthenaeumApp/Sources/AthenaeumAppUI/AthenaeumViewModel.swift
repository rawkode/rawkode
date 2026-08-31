import Foundation
import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

public enum DailyNoteSupertagAssignmentState: Equatable {
    case idle
    case loading
    case failed
    case emptyCatalog
    case loaded(tags: [RPCTag], appliedTagIds: Set<String>)
}

/// The note-level picker owns one read/mutate capability. Keeping this seam separate from the
/// broader page-operation stack lets tests exercise stale snapshots and uncertain responses
/// without manufacturing a second page or sync owner.
protocol DailyNoteSupertagClient {
    func listTags() async throws -> [RPCTag]
    func runView(viewName: String, viewSpec: CapnWebValue) async throws -> [CapnWebValue]
    /// The inline capture surface reads the server-resolved own + inherited field ordering rather
    /// than trying to rebuild tag closure from a local cache.
    func listTagFields(tagId: String) async throws -> [RPCResolvedTagField]
    func applySupertag(
        nodeId: String,
        tagId: String,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution,
        fieldValues: [ApplySupertagFieldValue]?
    ) async throws -> ApplySupertagOutput
    /// This stays on the RPC client, not `WorkspaceSyncClient`: a field receipt is an authority
    /// acknowledgement that must be matched against the frozen inline-capture intent.
    func addFact(
        nodeId: String,
        predicateId: String,
        value: CapnWebValue,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution,
        id: String?
    ) async throws -> RPCFact
}

extension WorkspaceRPCClient: DailyNoteSupertagClient {}

/// Single-flight custody for one note-level external mutation. A completion carries the token it
/// claimed; a delayed completion from an older claim can therefore never release a newer claim.
struct DailyNoteSupertagMutationGate: Equatable {
    private(set) var nextToken = 0
    private(set) var activeToken: Int?

    mutating func claim() -> Int? {
        guard activeToken == nil else { return nil }
        nextToken &+= 1
        activeToken = nextToken
        return nextToken
    }

    @discardableResult
    mutating func release(_ token: Int) -> Bool {
        guard activeToken == token else { return false }
        activeToken = nil
        return true
    }
}

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
// `WorkspaceSyncClient` doesn't wrap (`listBacklinks`, `runView`, `assignTag`, `applySupertag`,
// `createRelationDefinition`, `getNode`) — exactly the same methods `Backlinks.tsx`/`GraphView.tsx`
// call directly against `WorkspaceRpcClient` on the web side, without going through the local-SQLite
// write path (those calls have no local table to stay durable-before-sync with; the web client
// makes the identical choice).

@MainActor
public final class AthenaeumViewModel: ObservableObject {
    public enum PagePresentation: Equatable {
        case unavailable
        case automergeEditable
        case automergeRichTextReadOnly
        case legacyMigrationRequired(LegacyPageProjectionContent)
        case loroReadOnly(DailyNoteLoroReadOnlyState)
        case loroProjectedReadOnly(DailyNoteLoroProjectionState)
        case loroPlainEditable
        case loroRichEditable
        case retainedLocalChangeConflict(String)
    }

    public enum LoroRecoveryAction: Equatable {
        case continueRecovery
        case retrySavedChange
        case recoverSavedEditableVersion
        case recoverSavedRichEditableVersion
        case reloadEditor
        case discardRichDraftAndReload
    }

    private struct PageRouteWitness: Equatable {
        let nodeId: EntityId
        let format: PageDocumentFormat
        let storageVersion: Int
        let schemaVersion: Int
        let snapshotSHA256: String
        let automerge: AutomergePageDocumentDescriptor?

        init(_ descriptor: PageDocumentDescriptor) {
            nodeId = descriptor.nodeId
            format = descriptor.activeFormat
            storageVersion = descriptor.storageVersion
            switch descriptor {
            case .legacy(_, _, let witness):
                snapshotSHA256 = ""
                schemaVersion = 0
                automerge = witness
            case .migratedLoro(_, _, let witness, let loro):
                snapshotSHA256 = loro.snapshotSha256
                schemaVersion = loro.schemaVersion
                automerge = witness
            case .nativeLoro(_, _, let loro):
                snapshotSHA256 = loro.snapshotSha256
                schemaVersion = loro.schemaVersion
                automerge = nil
            }
        }

        var coreWitness: LoroPageRouteWitness {
            return LoroPageRouteWitness(nodeId: nodeId, format: format, storageVersion: storageVersion, schemaVersion: schemaVersion, snapshotSHA256: snapshotSHA256)
        }

        init(_ route: LoroPageRouteWitness) {
            nodeId = route.nodeId
            format = .loroV1
            storageVersion = route.storageVersion
            schemaVersion = route.schemaVersion
            snapshotSHA256 = route.snapshotSHA256
            automerge = nil
        }
    }

    private struct DailyNoteSupertagReadClaim: Equatable {
        let selection: DailyNoteSelection
        let pageGeneration: Int
        let witness: PageRouteWitness
        let token: Int

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.selection.nodeId == rhs.selection.nodeId &&
                lhs.selection.date == rhs.selection.date &&
                lhs.pageGeneration == rhs.pageGeneration &&
                lhs.witness == rhs.witness &&
                lhs.token == rhs.token
        }
    }

    private struct PendingDailyNoteSupertagIntent: Equatable {
        let claim: DailyNoteSupertagReadClaim
        let nodeId: EntityId
        let tagId: EntityId
        let requestId: String
        let commitMessage: String
        let attribution: MutationAttribution

        func selectionMatches(_ claim: DailyNoteSupertagReadClaim) -> Bool {
            self.claim.selection.nodeId == claim.selection.nodeId &&
                self.claim.selection.date == claim.selection.date &&
                self.nodeId == claim.selection.nodeId
        }

        func rebinding(to claim: DailyNoteSupertagReadClaim) -> Self {
            .init(
                claim: claim,
                nodeId: nodeId,
                tagId: tagId,
                requestId: requestId,
                commitMessage: commitMessage,
                attribution: attribution
            )
        }
    }

    /// Field capture can only start from the exact editor command that rendered a typed
    /// `supertagRef`. The editor acknowledgement is retained in full so no later command that
    /// happens to have the same tag/range can borrow this route witness.
    private struct DailyNoteInlineSupertagFieldCaptureClaim: Equatable {
        let acknowledgement: LoroNativeRichTextInlineReferenceInsertionAcknowledgement
        let tagID: EntityId
        let readClaim: DailyNoteSupertagReadClaim
    }

    private struct DailyNoteInlineSupertagFieldCaptureSession {
        let capture: DailyNoteInlineSupertagFieldCapture
        let claim: DailyNoteInlineSupertagFieldCaptureClaim
        var factsByPredicate: [String: Fact]
    }

    /// A capture UUID identifies one rendered command, while custody must survive a later
    /// command for the same still-live note. The route deliberately excludes the transient
    /// membership-read token: a reconciliation read may refresh that token without creating a
    /// new safe place to mint a fact/request pair.
    private struct DailyNoteInlineSupertagFactCustodyRoute: Equatable {
        let nodeID: EntityId
        let date: Date
        let pageGeneration: Int
        let witness: PageRouteWitness

        init(nodeID: EntityId, date: Date, pageGeneration: Int, witness: PageRouteWitness) {
            self.nodeID = nodeID
            self.date = date
            self.pageGeneration = pageGeneration
            self.witness = witness
        }

        init(_ claim: DailyNoteSupertagReadClaim) {
            nodeID = claim.selection.nodeId
            date = claim.selection.date
            pageGeneration = claim.pageGeneration
            witness = claim.witness
        }
    }

    /// This is the complete stable `addFact` operation. It is held unchanged through transport
    /// failure so retry cannot accidentally mint a second fact or change the ledger fingerprint.
    private struct PendingDailyNoteInlineSupertagFactIntent: Equatable {
        let captureClaim: DailyNoteInlineSupertagFieldCaptureClaim
        let factID: EntityId
        let requestID: String
        let nodeID: EntityId
        let predicateID: String
        let value: JSONValue
        let commitMessage: String
        let attribution: MutationAttribution

        var custodyRoute: DailyNoteInlineSupertagFactCustodyRoute {
            .init(captureClaim.readClaim)
        }
    }

    private enum DailyNotePageRouteError: Error {
        case descriptorNodeMismatch
        case routeChanged
        case retainedLocalAutomergeChange
        case loroRecoveryInProgress
    }

    /// Ownership of one Core recovery operation for the currently presented page.  This is
    /// deliberately separate from route freshness: a lifecycle reset may make a completion
    /// stale, but it must not make a second recovery eligible while the original Core call is
    /// still running.
    private struct LoroRecoveryFlight: Equatable {
        let nodeId: EntityId
        let pageGeneration: Int
        let token: Int
    }

    /// Rich drafts deliberately have a separate value-only lane.  The wrapper never owns a
    /// Core handle or bytes; this session is the UI's immutable base plus visible Draft A.
    private struct LoroRichSession {
        let base: LoroNativeRichEditorState
        var draft: LoroNativeRichDocumentV1
        let selection: DailyNoteSelection
        let generation: Int
    }

    /// The immutable identities for one backlink node-plus-edge operation. Keeping this by
    /// title/target lets a retry after an uncertain response replay the same ledger request ids
    /// instead of creating another node or edge; a different title or target gets a fresh hire.
    private struct BacklinkOperation: Equatable {
        let title: String
        let targetNodeId: EntityId
        let nodeId: EntityId
        let nodeRequestId: String
        let edgeRequestId: String
    }

    public enum SyncStatus: Equatable {
        case idle
        case loading
        case syncing
        case pending(String)
        case synced
        case conflict(String)
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

    public struct SearchRow: Identifiable, Equatable {
        public let id: String
        public let title: String
        public let snippet: String
    }

    @Published public private(set) var status: SyncStatus = .loading
    @Published public private(set) var text: String = ""
    /// Native Loro editing deliberately has its own draft surface. It is never routed through
    /// Automerge's text value or splice handler.
    @Published public private(set) var loroPlainDraft: String = ""
    @Published public private(set) var loroRichDraft: LoroNativeRichDocumentV1?
    /// `true` when the explicitly selected route is not editable in the native plain-text editor.
    /// Legacy projections and unsupported rich structure remain read-only rather than inviting a
    /// cross-format or structurally unsafe local mutation.
    @Published public private(set) var isRichTextReadOnly: Bool = false
    /// The active document format is explicit.  In particular, a Loro document never enters the
    /// flat Automerge editor merely because a load raced with a descriptor transition.
    @Published public private(set) var pagePresentation: PagePresentation = .unavailable
    @Published public private(set) var loroRecoveryAction: LoroRecoveryAction?
    @Published public private(set) var loroNotice: String?
    @Published public private(set) var backlinks: [BacklinkRow] = []
    /// Backlinks are a secondary asynchronous read. An empty collection is meaningful only
    /// after that read has completed successfully for the current note selection.
    @Published public private(set) var hasLoadedBacklinks = false
    @Published public private(set) var graphRows: [GraphNodeRow] = []
    @Published public private(set) var hasLoadedGraph = false
    @Published public private(set) var graphRowsOnlyPerson: Bool?
    @Published public private(set) var isLoadingGraph = false
    @Published public private(set) var graphLoadErrorMessage: String?
    @Published public private(set) var graphPersonTagError: String?
    @Published public var onlyPerson: Bool = false {
        didSet {
            guard oldValue != onlyPerson else { return }
            let requestedOnlyPerson = onlyPerson
            let token = reserveGraphRead()
            Task { await self.reloadGraphView(onlyPerson: requestedOnlyPerson, token: token) }
        }
    }
    @Published public var newBacklinkTitle: String = ""
    @Published public private(set) var isLinkingBacklink = false
    @Published public private(set) var linkError: String?
    @Published public private(set) var selectedDate: Date
    @Published public private(set) var isNavigating = false
    /// Recovery work is explicit and single-flight so the recovery action can reflect that it is
    /// already in progress rather than launching a duplicate Core operation.
    @Published public private(set) var isLoroRecoveryInProgress = false
    /// A one-shot, authority-backed completion. It is intentionally published only after the
    /// preparation receipt and the replacement page route agree on the active daily note.
    @Published public private(set) var preparationCompletion: PrepareMeetingInDailyNoteOutput?
    /// Changes for every authority-admitted completion, including an idempotent replay of the
    /// same occurrence key. Views observe this rather than comparing receipt fields.
    @Published public private(set) var preparationCompletionGeneration = 0
    /// Changes only after a guarded native human edit enters either editable Loro draft lane.
    @Published public private(set) var acceptedHumanEditGeneration = 0
    @Published public private(set) var dailyNoteSupertagAssignmentState: DailyNoteSupertagAssignmentState = .idle
    @Published public private(set) var isDailyNoteSupertagMutationInFlight = false
    /// The field form observes this only for presentation. The model retains the full immutable
    /// operation so closing/re-rendering the form cannot change a retry's fact/request identity.
    @Published public private(set) var isDailyNoteInlineSupertagFieldMutationInFlight = false

    public let workspaceId: EntityId
    /// The deterministic node currently presented by the daily-note route. Secondary projections
    /// use this identity rather than the wall clock so historical notes cannot inherit today’s
    /// workforce updates.
    public var dailyNoteId: EntityId { activeSelection.nodeId }
    /// Monotonically changes whenever the daily-note route presentation is reset. Inline editor
    /// commands capture this witness so an asynchronous selection cannot publish into a later
    /// reload of the same note (where the node id and date may still match).
    public var dailyNoteOperationGeneration: Int { pageOperationGeneration }
    public var dailyNoteTitle: String { dailyNoteTitleForDate(selectedDate, calendar: navigator.calendar) }
    public var isSelectedDateToday: Bool { navigator.calendar.isDateInToday(selectedDate) }
    public var selectedDateLabel: String {
        let formatter = DateFormatter()
        formatter.calendar = navigator.calendar
        formatter.timeZone = navigator.calendar.timeZone
        formatter.dateStyle = .full
        formatter.timeStyle = .none
        return formatter.string(from: selectedDate)
    }
    /// The representable receives immutable value state only.  It is absent unless the rich
    /// presentation and its lane-typed session were established atomically.
    public var loroRichEditorState: LoroNativeRichEditorState? {
        guard case .loroRichEditable = pagePresentation else { return nil }
        guard let session = loroRichSession else { return nil }
        return session.base.replacingDocument(session.draft)
    }

    /// The optional starter is deliberately limited to today's untouched, first-version native
    /// Loro note. A later version or any authored structure stays in the ordinary free-writing
    /// flow, including historical notes.
    public var isPlanTodayStarterAvailable: Bool {
        guard !isEditorInputDisabled,
              isToday(selection: activeSelection),
              case .loroRichEditable = pagePresentation,
              let session = loroRichSession,
              isCurrent(session.selection, generation: session.generation),
              session.base.route.storageVersion == 1,
              LoroNativePlanTodayStarter.isCanonicalEmpty(session.base.document),
              LoroNativePlanTodayStarter.isCanonicalEmpty(session.draft)
        else { return false }
        return true
    }

    /// Seeds ordinary canonical document content through the existing rich draft custody. This
    /// intentionally does not create a special persistence path: it follows the same debounce,
    /// ledger commit and recovery behavior as a human rich-text edit.
    @discardableResult
    public func applyPlanTodayStarter() -> Bool {
        guard isPlanTodayStarterAvailable else { return false }
        handleLoroRichDocumentChange(LoroNativePlanTodayStarter.document)
        return loroRichDraft == LoroNativePlanTodayStarter.document
    }
    public var isEditorInputDisabled: Bool { isRichTextReadOnly || isNavigating || loroSubmitEntered || loroDraftBlocked || externalMutationInFlight }
    /// An uncertain tag write keeps this route pinned until its immutable semantic request has
    /// been reconciled or retried; another daily note must never inherit that operation.
    public var isDailyNoteSupertagRetryAvailable: Bool {
        pendingDailyNoteSupertagIntent != nil && !externalMutationInFlight && !isNavigating && !loroDraftBlocked
    }
    /// Membership is an editor-adjacent command, not a generic page action. A read-only or
    /// projected page has no native editing custody, even when its projection happens to be
    /// clean, so it must never start the catalog/membership RPC pair.
    public var isDailyNoteSupertagAssignmentEligible: Bool {
        Self.isDailyNoteSupertagPresentationEligible(pagePresentation) && isDailyNoteSupertagPresentationSafe
    }

    /// Returns the latest authoritative membership decision for an existing tag. `nil` means the
    /// catalog/membership read is not ready, so an inline reference must wait instead of guessing.
    public func isDailyNoteSupertagApplied(tagId: String) -> Bool? {
        guard case .loaded(_, let appliedTagIds) = dailyNoteSupertagAssignmentState else { return nil }
        return appliedTagIds.contains(tagId)
    }

    static func isDailyNoteSupertagPresentationEligible(_ presentation: PagePresentation) -> Bool {
        presentation == .loroPlainEditable || presentation == .loroRichEditable
    }

    /// The command center may open a direct entity from Today while this same model owns the
    /// workspace's local store, Loro document store, and per-node operation gate.  Expose the
    /// existing read-only seam without creating a second sync owner for those previews.
    var readOnlyPageOperations: any DailyNotePageOperations { pageOperations }

    /// Claims the completion before presentation can move focus or announce it. This makes a
    /// delayed DailyNote mount and an ordinary observation update converge on one delivery.
    public func consumePreparationCompletion() -> PrepareMeetingInDailyNoteOutput? {
        defer { preparationCompletion = nil }
        return preparationCompletion
    }

    private let localStore: LocalWorkspaceStore
    private let syncClient: WorkspaceSyncClient
    private let readClient: WorkspaceRPCClient
    private let dailyNoteSupertagClient: any DailyNoteSupertagClient
    private let pageOperations: any DailyNotePageOperations
    /// Internal test seam for verifying that a successful primary page route continues into the
    /// backlinks/graph lifecycle. Production leaves this unset.
    private let secondaryLifecycleObserver: (() -> Void)?
    private var navigator: DailyNoteNavigator
    private var activeSelection: DailyNoteSelection
    private var navigationTask: Task<Void, Never>?
    private var navigationIntent = DailyNoteNavigationIntent()
    private var localCommitQueue = DailyNoteCommitQueue()
    private var syncTask: Task<Void, Never>?
    private var syncTasksByNodeId: [String: Task<Void, Never>] = [:]
    private var nodeOperationTails: [String: Task<Void, Never>] = [:]
    private var pageOperationGeneration = 0
    private let nativeLoroEditingEnabled: Bool
    private var loroEditorBase: LoroNativePlainEditorState?
    private var loroRichSession: LoroRichSession?
    private var loroRichDraftRevision = 0
    private var loroRichDebounceTask: Task<Void, Never>?
    private var loroDraftRevision = 0
    private var loroDebounceTask: Task<Void, Never>?
    private var loroSubmitEntered = false
    private var loroDraftBlocked = false
    /// A server-owned Today Brief mutation shares the daily-note editor's custody boundary. While
    /// it is set, date navigation and local input are rejected until the authoritative Loro page
    /// has been reloaded through this view model.
    private var externalMutationInFlight = false
    private var nextLoroRecoveryToken = 0
    private var loroRecoveryFlight: LoroRecoveryFlight?
    private var pendingLoroNavigationDate: Date?
    /// One immutable creation intent per deterministic daily-note node. If the create RPC has an
    /// uncertain outcome, retrying the load must reuse the same request identity and attribution
    /// rather than creating a second ledger command.
    private var loroCreationIntents: [String: CreationIntent] = [:]
    private var pendingBacklinkOperations: [String: BacklinkOperation] = [:]
    /// A graph result belongs to the filter intent that reserved it, not to whichever read happens
    /// to finish last. This stays actor-isolated with the published graph state.
    private var graphReadGeneration = 0
    private var dailyNoteSupertagReadGeneration = 0
    private var dailyNoteSupertagMutationGate = DailyNoteSupertagMutationGate()
    private var dailyNoteSupertagReadClaim: DailyNoteSupertagReadClaim?
    private var pendingDailyNoteSupertagIntent: PendingDailyNoteSupertagIntent?
    private var dailyNoteInlineSupertagFieldMutationGate = DailyNoteSupertagMutationGate()
    private var dailyNoteInlineSupertagFieldCaptureSessions: [UUID: DailyNoteInlineSupertagFieldCaptureSession] = [:]
    private var pendingDailyNoteInlineSupertagFactIntents: [UUID: [String: PendingDailyNoteInlineSupertagFactIntent]] = [:]
    private var presentedPageRouteWitness: PageRouteWitness?
    /// Test-only completion witness for deterministic out-of-order graph-read fixtures.
    private let graphReadCompletionObserver: (() -> Void)?

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
        var navigator = DailyNoteNavigator()
        let initialSelection = navigator.currentSelection()
        self.navigator = navigator
        self.activeSelection = initialSelection
        self.selectedDate = initialSelection.date

        let workspaceURL = baseURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        let writeClient = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
        self.readClient = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
        self.dailyNoteSupertagClient = self.readClient
        self.localStore = try LocalWorkspaceStore(path: try WorkspaceConfiguration.localStorePath(workspaceId: workspaceId))
        self.syncClient = WorkspaceSyncClient(
            localStore: localStore, rpcClient: writeClient, workspaceId: workspaceId
        )
        self.pageOperations = LiveDailyNotePageOperations(
            localStore: localStore, syncClient: syncClient, readClient: readClient
        )
        self.secondaryLifecycleObserver = nil
        self.graphReadCompletionObserver = nil
        self.nativeLoroEditingEnabled = true
    }

    /// Test-only composition root. The public network/local-store initializer above remains the
    /// production API; tests may substitute the narrow document lifecycle seam and read-only RPC
    /// client, plus a graph-read completion witness, without changing production construction.
    init(
        workspaceId: EntityId,
        pageOperations: any DailyNotePageOperations,
        date: Date = Date(),
        secondaryLifecycleObserver: (() -> Void)? = nil,
        readClient: WorkspaceRPCClient? = nil,
        dailyNoteSupertagClient: (any DailyNoteSupertagClient)? = nil,
        graphReadCompletionObserver: (() -> Void)? = nil,
        nativeLoroEditingEnabled: Bool? = nil
    ) throws {
        self.workspaceId = workspaceId
        var navigator = DailyNoteNavigator()
        let initialSelection = navigator.request(date: date)
        self.navigator = navigator
        self.activeSelection = initialSelection
        self.selectedDate = initialSelection.date
        let url = URL(string: "http://127.0.0.1")!
        let testReadClient = readClient ?? WorkspaceRPCClient(baseURL: url, workspaceId: workspaceId.rawValue)
        self.readClient = testReadClient
        self.dailyNoteSupertagClient = dailyNoteSupertagClient ?? testReadClient
        self.localStore = try LocalWorkspaceStore(path: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("athenaeum-ui-test-\(UUID().uuidString).sqlite").path)
        self.syncClient = WorkspaceSyncClient(localStore: localStore, rpcClient: testReadClient, workspaceId: workspaceId)
        self.pageOperations = pageOperations
        self.secondaryLifecycleObserver = secondaryLifecycleObserver
        self.graphReadCompletionObserver = graphReadCompletionObserver
        self.nativeLoroEditingEnabled = nativeLoroEditingEnabled ?? true
    }

    deinit {
        navigationTask?.cancel()
        localCommitQueue.cancel()
        syncTask?.cancel()
        loroDebounceTask?.cancel()
        for task in syncTasksByNodeId.values {
            task.cancel()
        }
        for task in nodeOperationTails.values {
            task.cancel()
        }
    }

    // MARK: - Load

    /// Resolve-or-create the selected daily note (same deterministic id both clients share — see
    /// `DailyNoteID.swift`), pull its current content in via a real sync-session round trip, then
    /// load backlinks + the read-only graph view. Each selection owns one cached sync handle, so
    /// returning to a day does not leak a new server session.
    public func start() async {
        guard !isLoroRecoveryInProgress, pendingDailyNoteSupertagIntent == nil else { return }
        resetPagePresentation()
        status = .loading
        isNavigating = true
        let selection = activeSelection
        await loadDailyNote(selection)
    }

    /// Requests another civil day. The current local edit chain is allowed to finish before the
    /// active context changes; this is the durable-before-navigation boundary that prevents a
    /// fast previous/next click from discarding the last typed splice.
    public func showDate(_ date: Date) {
        let normalizedDate = navigator.calendar.startOfDay(for: date)
        guard normalizedDate != selectedDate, !isLoroRecoveryInProgress, !externalMutationInFlight,
              pendingDailyNoteSupertagIntent == nil else { return }

        // A native Loro draft is a single value-level Core submission.  Do not reset the editor
        // or cancel an entered call merely because navigation was requested; successful custody
        // is the only boundary at which the next day may replace this selection.
        if case .loroPlainEditable = pagePresentation, loroDraftBlocked {
            // A pre-custody failure has an explicit recovery boundary. Navigation must preserve
            // the visible A draft and action, not silently replay it into Core.
            return
        }
        if case .loroRichEditable = pagePresentation, loroDraftBlocked {
            // Rich Draft A has the same explicit-discard boundary as the plain lane.  A failed
            // rich submission must never be replayed merely because the user requested a date.
            return
        }
        if case .loroPlainEditable = pagePresentation, let base = loroEditorBase, loroPlainDraft != base.text {
            pendingLoroNavigationDate = normalizedDate
            if loroSubmitEntered { isNavigating = true; return }
            if isNavigating { return }
            isNavigating = true
            loroDebounceTask?.cancel()
            let selection = activeSelection
            let generation = pageOperationGeneration
            navigationTask = Task { [weak self] in
                await self?.flushLoroDraftForNavigation(selection: selection, generation: generation, base: base)
            }
            return
        }
        if case .loroRichEditable = pagePresentation, let session = loroRichSession, session.draft != session.base.document {
            pendingLoroNavigationDate = normalizedDate
            if loroSubmitEntered { isNavigating = true; return }
            if isNavigating { return }
            isNavigating = true
            loroRichDebounceTask?.cancel()
            let selection = activeSelection
            let generation = pageOperationGeneration
            navigationTask = Task { [weak self] in
                await self?.submitLoroRichDraftForNavigation(selection: selection, generation: generation, session: session)
            }
            return
        }

        navigationTask?.cancel()
        let departingNodeId = activeSelection.nodeId.rawValue
        navigationIntent.begin(departingNodeId: departingNodeId)
        syncTasksByNodeId[departingNodeId]?.cancel()
        syncTasksByNodeId.removeValue(forKey: departingNodeId)
        if activeSelection.nodeId == dailyNoteIdForDate(selectedDate, calendar: navigator.calendar) {
            syncTask = nil
        }
        isNavigating = true
        // Invalidate visible/editor state before waiting for the durable departing edit.  That
        // wait is intentionally non-cancellable, but it must not leave a stale format route able
        // to publish into the next navigation intent.
        resetPagePresentation()

        let pendingLocalCommit = localCommitQueue.pending
        navigationTask = Task { [weak self, pendingLocalCommit] in
            // This task is intentionally not the task that owns the local write. Cancellation of
            // navigation must never cancel the durable splice it is waiting for.
            let committed = await pendingLocalCommit?.value ?? true
            guard !Task.isCancelled, let self else { return }
            guard committed else {
                self.navigationIntent.cancel()
                self.isNavigating = false
                return
            }
            self.syncTasksByNodeId[departingNodeId]?.cancel()
            self.syncTasksByNodeId.removeValue(forKey: departingNodeId)
            if self.activeSelection.nodeId.rawValue == departingNodeId {
                self.syncTask = nil
            }
            self.navigationIntent.cancel()
            let selection = self.beginNavigation(to: normalizedDate)
            await self.loadDailyNote(selection)
        }
    }

    /// Selects a civil date using the navigator's calendar. Today Brief dates are already local
    /// calendar values from the Worker, so translating them through a UTC-midnight `Date` would
    /// select the previous note west of UTC.
    public func showLocalDate(_ localDate: LocalDate) {
        let parts = localDate.rawValue.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = navigator.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return }
        showDate(date)
    }

    private func flushLoroDraftForNavigation(selection: DailyNoteSelection, generation: Int, base: LoroNativePlainEditorState) async {
        guard isCurrent(selection, generation: generation), !loroSubmitEntered else { return }
        loroSubmitEntered = true
        defer { loroSubmitEntered = false }
        let draft = loroPlainDraft
        do {
            let result = try await pageOperations.submitNativePlainText(nodeId: selection.nodeId, base: base, proposedText: draft)
            guard isCurrent(selection, generation: generation) else { return }
            switch result {
            case .submitted, .submittedNeedsReload, .noChange:
                await continuePendingLoroNavigation(selection: selection, generation: generation)
            case .checkpointResolutionRequired:
                isNavigating = false
                preserveLoroDraftFailure(draft, message: "This draft is waiting for recovery.", action: .continueRecovery, selection: selection, generation: generation)
            case .unauthenticated:
                isNavigating = false
                preserveLoroDraftFailure(draft, message: "Sign in before navigating away from this saved draft.", action: .continueRecovery, selection: selection, generation: generation)
            case .ineligible, .staleEditorState, .invalidProposedText:
                isNavigating = false
                preserveLoroDraftFailure(draft, message: "This draft could not be saved. Reload the editor before navigating.", action: .reloadEditor, selection: selection, generation: generation)
            }
        } catch {
            guard isCurrent(selection, generation: generation) else { return }
            isNavigating = false
            preserveLoroDraftFailure(draft, message: "This draft could not be saved: \(error)", action: .reloadEditor, selection: selection, generation: generation)
        }
    }

    private func submitLoroRichDraftForNavigation(selection: DailyNoteSelection, generation: Int, session: LoroRichSession) async {
        guard isCurrent(selection, generation: generation), !loroSubmitEntered else { return }
        loroSubmitEntered = true
        defer { loroSubmitEntered = false }
        do {
            let result = try await pageOperations.submitNativeRichDocumentV1(nodeId: selection.nodeId, base: session.base, proposed: session.draft, commitMessage: "Update daily note content")
            guard isCurrent(selection, generation: generation) else { return }
            switch result {
            case .submitted, .submittedNeedsReload, .noChange:
                await continuePendingLoroNavigation(selection: selection, generation: generation)
            case .checkpointResolutionRequired(let resolution):
                isNavigating = false
                preserveLoroRichDraftFailure(session, message: "This rich draft is waiting for recovery before navigating.", action: richRecoveryAction(for: resolution), selection: selection, generation: generation)
            case .unauthenticated:
                isNavigating = false
                preserveLoroRichDraftFailure(session, message: "Sign in before navigating away from this rich draft.", action: .continueRecovery, selection: selection, generation: generation)
            case .ineligible, .staleEditorState, .invalidProposedDocument, .invalidCommitMessage:
                isNavigating = false
                preserveLoroRichDraftFailure(session, message: "This rich draft could not be saved. Reload it explicitly before navigating.", action: .discardRichDraftAndReload, selection: selection, generation: generation)
            }
        } catch {
            guard isCurrent(selection, generation: generation) else { return }
            isNavigating = false
            preserveLoroRichDraftFailure(session, message: "This rich draft could not be saved: \(error)", action: .discardRichDraftAndReload, selection: selection, generation: generation)
        }
    }

    private func continuePendingLoroNavigation(selection: DailyNoteSelection, generation: Int) async {
        guard isCurrent(selection, generation: generation) else { return }
        guard let target = pendingLoroNavigationDate else { isNavigating = false; return }
        pendingLoroNavigationDate = nil
        resetPagePresentation()
        let next = beginNavigation(to: target)
        await loadDailyNote(next)
    }

    private func beginNavigation(to date: Date) -> DailyNoteSelection {
        preparationCompletion = nil
        let selection = navigator.request(date: date)
        selectedDate = selection.date
        status = .loading
        backlinks = []
        hasLoadedBacklinks = false
        linkError = nil
        isLinkingBacklink = false
        navigationIntent.cancel()
        return selection
    }

    /// Explicit recovery after a failed local write or load. The queue is only cleared here,
    /// after the durable local snapshot has been reloaded, so a failed optimistic edit cannot be
    /// silently hidden by a later keystroke or navigation attempt.
    public func retryCurrentNote() {
        // A generic retry must not reset the route while an explicit recovery owns the
        // checkpoint. Resetting here would invalidate that recovery's generation, then route
        // this same native Loro page through `routeLoro` and start a second Core recovery.
        guard !isNavigating, !isLoroRecoveryInProgress, pendingDailyNoteSupertagIntent == nil else { return }
        navigationTask?.cancel()
        navigationIntent.cancel()
        localCommitQueue.clear()
        status = .loading
        isNavigating = true
        resetPagePresentation()
        backlinks = []
        hasLoadedBacklinks = false
        linkError = nil
        let selection = activeSelection
        navigationTask = Task { [weak self] in
            guard let self else { return }
            await self.loadDailyNote(selection)
        }
    }

    public func showPreviousDay() {
        guard let date = navigator.calendar.date(byAdding: .day, value: -1, to: selectedDate) else { return }
        showDate(date)
    }

    public func showNextDay() {
        guard let date = navigator.calendar.date(byAdding: .day, value: 1, to: selectedDate) else { return }
        showDate(date)
    }

    public func showToday() {
        showDate(Date())
    }

    /// Runs a server-owned Today Brief mutation through the same custody owner as the active
    /// daily-note editor. Native must never call the RPC beside an editable Loro draft: a clean
    /// editor (or a converged read-only projection on iOS) is reserved, the Worker performs the
    /// semantic change, and the page is reloaded before the editor can accept input again.
    public func prepareMeetingInDailyNote(
        brief: RPCTodayBrief,
        event: RPCTodayBriefEvent,
        routeIsCurrent: @escaping () -> Bool = { true }
    ) async throws -> PrepareMeetingInDailyNoteOutput {
        let intent = try LoroMutationIntentV1(
            requestId: UUID().uuidString.lowercased(),
            commitMessage: "Prepare meeting context in daily note.",
            attribution: .humanUi(surface: "macos")
        )
        let input = try PrepareMeetingInDailyNoteInput(
            workspaceId: workspaceId,
            dailyNoteId: dailyNoteIdForLocalDate(brief.localDate),
            localDate: brief.localDate,
            timeZone: brief.timeZone,
            occurrenceKey: event.occurrenceKey,
            intent: intent
        )
        return try await prepareMeetingInDailyNote(input, routeIsCurrent: routeIsCurrent)
    }

    /// Standalone Today Briefs may describe a different civil day from the note currently on
    /// screen. Join the one navigation task that `showLocalDate` creates rather than polling
    /// the render state; after that finite handshake, recheck the exact node/date before the
    /// ordinary custody-aware preparation route claims a mutation.
    public func prepareMeetingFromStandaloneBrief(
        brief: RPCTodayBrief,
        event: RPCTodayBriefEvent,
        routeIsCurrent: @escaping () -> Bool = { true }
    ) async throws -> PrepareMeetingInDailyNoteOutput {
        let expectedNodeId = dailyNoteIdForLocalDate(brief.localDate)
        let expectedDate = brief.localDate.rawValue
        guard routeIsCurrent() else {
            throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
        }
        if activeSelection.nodeId != expectedNodeId {
            guard routeIsCurrent() else {
                throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
            }
            showLocalDate(brief.localDate)
            guard let navigationTask else {
                throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
            }
            await navigationTask.value
        }
        guard !Task.isCancelled,
              routeIsCurrent(),
              activeSelection.nodeId == expectedNodeId,
              localDateStamp(activeSelection.date, calendar: navigator.calendar) == expectedDate,
              !isNavigating
        else { throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId) }
        do {
            let output = try await prepareMeetingInDailyNote(
                brief: brief,
                event: event,
                routeIsCurrent: routeIsCurrent
            )
            guard !Task.isCancelled, routeIsCurrent() else {
                preparationCompletion = nil
                throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
            }
            return output
        } catch {
            if !routeIsCurrent() { preparationCompletion = nil }
            throw error
        }
    }

    /// Shared mutation entry point for native Today Brief surfaces. Keeping the input form public
    /// also gives future native widgets/extensions one custody-aware route without granting them a
    /// second direct RPC client.
    public func prepareMeetingInDailyNote(
        _ input: PrepareMeetingInDailyNoteInput,
        routeIsCurrent: @escaping () -> Bool = { true }
    ) async throws -> PrepareMeetingInDailyNoteOutput {
        let expectedNodeId = dailyNoteIdForLocalDate(input.localDate)
        guard input.workspaceId == workspaceId,
              input.dailyNoteId == expectedNodeId,
              activeSelection.nodeId == expectedNodeId,
              localDateStamp(activeSelection.date, calendar: navigator.calendar) == input.localDate.rawValue,
              routeIsCurrent(),
              !isNavigating,
              !loroSubmitEntered,
              !isLoroRecoveryInProgress,
              !externalMutationInFlight
        else { throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId) }

        switch pagePresentation {
        case .loroPlainEditable:
            // A native draft is the one mutable surface that can be lost by an external page
            // mutation. Refuse custody when it is dirty or already blocked for recovery.
            guard let base = loroEditorBase, loroPlainDraft == base.text, !loroDraftBlocked else {
                throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
            }
        case .loroRichEditable:
            guard let session = loroRichSession, session.draft == session.base.document, !loroDraftBlocked else {
                throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
            }
        case .loroReadOnly(let projection):
            guard !projection.isDirty else { throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId) }
        case .loroProjectedReadOnly(let projection):
            guard !projection.projection.isDirty else { throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId) }
        default:
            // Legacy Automerge and closed/recovery presentations have no safe Loro custody
            // boundary. They must not be mutated by a Today Brief action.
            throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
        }

        loroDebounceTask?.cancel()
        loroDebounceTask = nil
        loroRichDebounceTask?.cancel()
        loroRichDebounceTask = nil
        loroRichDraftRevision &+= 1
        externalMutationInFlight = true
        loroSubmitEntered = true
        isNavigating = true
        status = .syncing
        let selection = activeSelection

        defer {
            externalMutationInFlight = false
            loroSubmitEntered = false
        }

        do {
            guard routeIsCurrent() else {
                throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
            }
            let output = try await pageOperations.prepareMeetingInDailyNote(input)
            guard routeIsCurrent() else {
                preparationCompletion = nil
                throw DailyNotePageOperationError.externalMutationUnavailable(expectedNodeId)
            }
            guard output.dailyNoteId == expectedNodeId,
                  output.localDate == input.localDate,
                  output.occurrenceKey == input.occurrenceKey
            else { throw TodayBriefPreparationError.invalidOutput }

            // The RPC has advanced server authority. Clear the old route and let the normal Loro
            // loader establish a fresh descriptor/projection before releasing editor custody.
            resetPagePresentation()
            let reloadGeneration = pageOperationGeneration
            await loadDailyNote(selection)
            guard isCurrent(selection, generation: reloadGeneration),
                  routeIsCurrent(),
                  status == .synced,
                  acceptsPreparationCompletionPresentation
            else { throw TodayBriefPreparationError.invalidOutput }
            preparationCompletion = output
            preparationCompletionGeneration &+= 1
            return output
        } catch {
            // A response can be lost after the Worker commits. Reconcile from authority even on
            // failure; if reload also fails, loadDailyNote leaves the page closed/read-only and
            // the original error remains visible to Today Brief for an explicit retry.
            resetPagePresentation()
            await loadDailyNote(selection)
            throw error
        }
    }

    private var acceptsPreparationCompletionPresentation: Bool {
        switch pagePresentation {
        case .loroPlainEditable, .loroRichEditable:
            return true
        case .loroReadOnly(let projection):
            return !projection.isDirty
        case .loroProjectedReadOnly(let projection):
            return !projection.projection.isDirty
        default:
            return false
        }
    }

    private func loadDailyNote(_ selection: DailyNoteSelection) async {
        guard navigator.isLatest(selection) else { return }
        activeSelection = selection
        let previousOperation = nodeOperationTails[selection.nodeId.rawValue]
        let operation = Task { [weak self, previousOperation] in
            await previousOperation?.value
            guard !Task.isCancelled, let self else { return }
            await self.performLoad(selection)
        }
        nodeOperationTails[selection.nodeId.rawValue] = operation
        await operation.value
    }

    private func performLoad(_ selection: DailyNoteSelection) async {
        let generation = pageOperationGeneration
        do {
            try await pageOperations.resolveNode(id: selection.nodeId, title: selection.title)
            guard isCurrent(selection, generation: generation) else { return }
            var descriptor: PageDocumentDescriptor?
            do {
                descriptor = try await pageOperations.descriptor(nodeId: selection.nodeId)
            } catch AthenaeumDomainError.pageNotFound(let nodeId) {
                guard nodeId == selection.nodeId.rawValue else { throw AthenaeumDomainError.pageNotFound(nodeId: nodeId) }
                guard try await !pageOperations.hasLocalLoroPage(nodeId: selection.nodeId) else {
                    publishConflict("A local Loro page is waiting for its remote descriptor.", selection: selection, generation: generation)
                    return
                }
                // New pages are Loro by construction. Automerge is entered only by the explicit
                // `.legacy` descriptor branch below, so a missing descriptor can never silently
                // create a legacy page after the web/native clients have switched formats.
                descriptor = try await pageOperations.resolveOrCreateLoro(
                    nodeId: selection.nodeId,
                    creationIntent: loroCreationIntent(for: selection.nodeId)
                )
            }
            if let descriptor {
                guard descriptor.nodeId == selection.nodeId else { throw DailyNotePageRouteError.descriptorNodeMismatch }
                guard isCurrent(selection, generation: generation) else { return }
                presentedPageRouteWitness = PageRouteWitness(descriptor)

                switch descriptor {
                case .legacy:
                    let witness = PageRouteWitness(descriptor)
                    guard try await !pageOperations.hasDirtyLocalAutomerge(nodeId: selection.nodeId) else {
                        publishConflict("An unsynced legacy Automerge edit is preserved locally. Sync or recover it before opening the server projection.", selection: selection, generation: generation)
                        return
                    }
                    let projection = try await pageOperations.legacyPageProjection(
                        nodeId: selection.nodeId,
                        descriptor: descriptor,
                        session: selection.session
                    )
                    guard projection.readOnly, projection.migrationRequired,
                          PageRouteWitness(projection.descriptor) == witness
                    else { throw DailyNotePageRouteError.routeChanged }
                    let after = try await pageOperations.descriptor(nodeId: selection.nodeId)
                    guard PageRouteWitness(after) == witness else { throw DailyNotePageRouteError.routeChanged }
                    guard isCurrent(selection, generation: generation) else { return }
                    switch projection.content {
                    case .plainText(let text):
                        // The live adapter reports legacy projections as rich/read-only. Keep
                        // the presentation decision behind that adapter so deterministic UI
                        // fakes can exercise the old route without decoding Automerge.
                        let rich = try await pageOperations.isAutomergeRichText(nodeId: selection.nodeId)
                        publishAutomerge(text: text, richText: rich)
                    case .richTextUnsupported, .tooLarge:
                        publishLegacyMigrationRequired(projection.content)
                    }
                case .migratedLoro(_, _, let automerge, _):
                    guard try await !pageOperations.hasDirtyLocalAutomerge(nodeId: selection.nodeId) else {
                        publishConflict(
                            "An unsynced legacy Automerge edit is preserved locally. Recover it before opening this migrated Loro page.",
                            selection: selection,
                            generation: generation
                        )
                        return
                    }
                    guard try await hasNoRetainedAutomergeChange(nodeId: selection.nodeId, expectedHeadsHash: automerge.headsHash) else {
                        publishConflict("Potential local Automerge divergence prevents opening this migrated Loro page.", selection: selection, generation: generation)
                        return
                    }
                    try await routeLoro(descriptor: descriptor, selection: selection, generation: generation, nativeEditableCandidate: false)
                case .nativeLoro:
                    guard try await pageOperations.localAutomergeHeads(nodeId: selection.nodeId) == nil,
                          try await pageOperations.loadedAutomergeHeads(nodeId: selection.nodeId) == nil
                    else {
                        publishConflict("Potential local Automerge divergence prevents opening this native Loro page.", selection: selection, generation: generation)
                        return
                    }
                    try await routeLoro(descriptor: descriptor, selection: selection, generation: generation, nativeEditableCandidate: true)
                }
            }
        } catch DailyNotePageRouteError.loroRecoveryInProgress {
            guard isCurrent(selection, generation: generation) else { return }
            publishLoroClosed(
                "A saved change is already being recovered. Wait for it to finish before loading another Loro page.",
                action: nil,
                selection: selection,
                generation: generation
            )
            return
        } catch DailyNotePageOperationError.legacyLocalRecoveryRequired(let nodeId) where nodeId == selection.nodeId {
            guard isCurrent(selection, generation: generation) else { return }
            publishConflict(
                "An unsynced legacy page is preserved locally. Recover it before opening the server projection.",
                selection: selection,
                generation: generation
            )
            return
        } catch {
            guard isCurrent(selection, generation: generation) else { return }
            status = .error(String(describing: error))
            isNavigating = false
            return
        }
        await reloadSecondaryLifecycle(for: selection)
    }

    private func reloadSecondaryLifecycle(for selection: DailyNoteSelection) async {
        secondaryLifecycleObserver?()
        await reloadBacklinks(for: selection)
        guard isCurrent(selection) else { return }
        await reloadGraphView()
        guard isCurrent(selection) else { return }
        await refreshDailyNoteSupertags()
    }

    // MARK: - Note-level Supertag assignment

    /// Reads both sides of the assignment decision from server authority. A tag selector is never
    /// enabled from an old catalog or an optimistic local membership cache.
    public func refreshDailyNoteSupertags(allowDirtyRichDraft: Bool = false) async {
        guard isDailyNoteSupertagReadEligible(allowDirtyRichDraft: allowDirtyRichDraft) else {
            dailyNoteSupertagReadGeneration &+= 1
            dailyNoteSupertagReadClaim = nil
            dailyNoteSupertagAssignmentState = .idle
            return
        }
        // An ambiguous operation remains the same operation across a reconciliation read. The
        // read fence itself must change, but the request id/reason/attribution must not.
        let retainedIntent = pendingDailyNoteSupertagIntent
        dailyNoteSupertagReadGeneration &+= 1
        let token = dailyNoteSupertagReadGeneration
        dailyNoteSupertagReadClaim = nil
        dailyNoteSupertagAssignmentState = .loading
        let selection = activeSelection
        let generation = pageOperationGeneration
        do {
            guard let witness = presentedPageRouteWitness,
                  witness.nodeId == selection.nodeId,
                  witness.format == .loroV1 else {
                throw DailyNotePageRouteError.routeChanged
            }
            let claim = DailyNoteSupertagReadClaim(selection: selection, pageGeneration: generation, witness: witness, token: token)
            async let catalog = dailyNoteSupertagClient.listTags()
            async let rows = dailyNoteSupertagClient.runView(viewName: "graph_node_tags", viewSpec: Self.dailyNoteTagMembershipViewSpec(nodeId: selection.nodeId))
            let (tags, membershipRows) = try await (catalog, rows)
            for tag in tags {
                guard (try? EntityId(validating: tag.id)) != nil else {
                    throw CapnWebError.malformedMessage("invalid daily-note Supertag catalog")
                }
            }
            let tagIDs = Set(tags.map(\.id))
            var applied = Set<String>()
            for row in membershipRows {
                guard let rowNodeId = try row.field("nodeId").stringValue,
                      let rowTagId = try row.field("tagId").stringValue,
                      rowNodeId == selection.nodeId.rawValue,
                      (try? EntityId(validating: rowTagId)) != nil,
                      tagIDs.contains(rowTagId)
                else { throw CapnWebError.malformedMessage("invalid daily-note tag membership") }
                applied.insert(rowTagId)
            }
            guard isCurrentDailyNoteSupertagRead(claim) else { return }
            dailyNoteSupertagReadClaim = claim
            dailyNoteSupertagAssignmentState = tags.isEmpty ? .emptyCatalog : .loaded(tags: tags, appliedTagIds: applied)
            if let retainedIntent,
               retainedIntent.selectionMatches(claim),
               retainedIntent.claim.witness == claim.witness {
                pendingDailyNoteSupertagIntent = retainedIntent.rebinding(to: claim)
            }
        } catch {
            guard token == dailyNoteSupertagReadGeneration, isCurrent(selection, generation: generation) else { return }
            dailyNoteSupertagReadClaim = nil
            dailyNoteSupertagAssignmentState = .failed
        }
    }

    /// Applies a tag and returns true only after the authoritative membership reread confirms it.
    /// A successful mutation response alone is not enough: the read model is the semantic source
    /// consumed by both the direct picker and inline reference flow.
    @discardableResult
    public func applyDailyNoteSupertag(tagId: String, allowDirtyRichDraft: Bool = false) async -> Bool {
        guard case .loaded(let tags, let applied) = dailyNoteSupertagAssignmentState,
              !applied.contains(tagId),
              let tag = tags.first(where: { $0.id == tagId }),
              let decodedTagId = try? EntityId(validating: tag.id),
              let readClaim = dailyNoteSupertagReadClaim,
              pendingDailyNoteSupertagIntent == nil,
              !externalMutationInFlight,
              !isNavigating, !loroSubmitEntered, !isLoroRecoveryInProgress, !loroDraftBlocked,
              (isDailyNoteSupertagPresentationSafe ||
               (allowDirtyRichDraft && isDailyNoteSupertagReadEligible(allowDirtyRichDraft: true)))
        else { return false }

        let intent = PendingDailyNoteSupertagIntent(
            claim: readClaim,
            nodeId: readClaim.selection.nodeId,
            tagId: decodedTagId,
            requestId: UUID().uuidString.lowercased(),
            commitMessage: "Apply \(tag.name) to this daily note.",
            attribution: MutationAttribution(kind: "humanUi", surface: Self.nativeSurface)
        )
        // Claim synchronously before the first suspension. A second tap observes this identity
        // and cannot independently mint a request id during the descriptor check below.
        pendingDailyNoteSupertagIntent = intent
        guard let mutationToken = dailyNoteSupertagMutationGate.claim() else {
            pendingDailyNoteSupertagIntent = nil
            return false
        }
        isDailyNoteSupertagMutationInFlight = true
        externalMutationInFlight = true
        if allowDirtyRichDraft, case .loroRichEditable = pagePresentation {
            // The inline trigger is a local draft. Pause its page debounce while the independent
            // graph mutation is in flight; the eventual typed-reference insertion will schedule
            // the page submission again, while a failed mutation can explicitly resume the draft.
            loroRichDebounceTask?.cancel()
            loroRichDebounceTask = nil
            loroRichDraftRevision &+= 1
        }
        return await submitClaimedDailyNoteSupertag(
            intent,
            mutationToken: mutationToken,
            allowDirtyRichDraft: allowDirtyRichDraft
        )
    }

    @discardableResult
    public func retryDailyNoteSupertagAssignment() async -> Bool {
        guard let intent = pendingDailyNoteSupertagIntent, !externalMutationInFlight,
              isCurrent(intent.claim.selection, generation: intent.claim.pageGeneration),
              !isNavigating, !loroSubmitEntered, !isLoroRecoveryInProgress, !loroDraftBlocked,
              isDailyNoteSupertagPresentationSafe else { return false }
        guard let mutationToken = dailyNoteSupertagMutationGate.claim() else { return false }
        isDailyNoteSupertagMutationInFlight = true
        externalMutationInFlight = true
        return await submitClaimedDailyNoteSupertag(
            intent,
            mutationToken: mutationToken,
            allowDirtyRichDraft: false
        )
    }

    private func submitClaimedDailyNoteSupertag(
        _ intent: PendingDailyNoteSupertagIntent,
        mutationToken: Int,
        allowDirtyRichDraft: Bool
    ) async -> Bool {
        guard pendingDailyNoteSupertagIntent == intent,
              isCurrentDailyNoteSupertagRead(intent.claim),
              !isNavigating, !loroSubmitEntered, !isLoroRecoveryInProgress, !loroDraftBlocked,
              (isDailyNoteSupertagPresentationSafe ||
               (allowDirtyRichDraft && isDailyNoteSupertagReadEligible(allowDirtyRichDraft: true)))
        else {
            releaseDailyNoteSupertagMutation(mutationToken)
            return false
        }
        defer {
            // A delayed A completion must never release B's mutation gate.
            releaseDailyNoteSupertagMutation(mutationToken)
        }
        do {
            let output = try await dailyNoteSupertagClient.applySupertag(
                nodeId: intent.nodeId.rawValue,
                tagId: intent.tagId.rawValue,
                requestId: intent.requestId,
                commitMessage: intent.commitMessage,
                attribution: intent.attribution,
                fieldValues: nil
            )
            guard output.nodeId == intent.nodeId, output.tagId == intent.tagId,
                  isCurrentDailyNoteSupertagRead(intent.claim)
            else { return false }
            // Keep the intent until the authoritative membership read confirms the write. A
            // successful RPC response is not itself a read-model snapshot; clearing custody here
            // would make a response-loss/reconciliation failure look like a completed assignment.
            await refreshDailyNoteSupertags(allowDirtyRichDraft: allowDirtyRichDraft)
            if case .loaded(_, let applied) = dailyNoteSupertagAssignmentState,
               applied.contains(intent.tagId.rawValue) {
                pendingDailyNoteSupertagIntent = nil
                return true
            }
            return false
        } catch {
            guard isCurrentDailyNoteSupertagRead(intent.claim) else { return false }
            // Response loss is ambiguous. Reconcile first; only a still-unconfirmed exact intent
            // remains retryable, retaining its immutable request identity.
            await refreshDailyNoteSupertags(allowDirtyRichDraft: allowDirtyRichDraft)
            if case .loaded(_, let applied) = dailyNoteSupertagAssignmentState,
               applied.contains(intent.tagId.rawValue) {
                pendingDailyNoteSupertagIntent = nil
                return true
            }
            return false
        }
    }

    private func releaseDailyNoteSupertagMutation(_ mutationToken: Int) {
        guard dailyNoteSupertagMutationGate.release(mutationToken) else { return }
        isDailyNoteSupertagMutationInFlight = false
        externalMutationInFlight = false
    }

    // MARK: - Inline Supertag field capture

    /// A failed field write remains retryable only through its original capture. A later
    /// acknowledgement for the same live note must not create a replacement fact/request pair
    /// just because its command UUID differs.
    func canDismissDailyNoteInlineSupertagFieldCapture(captureID: UUID) -> Bool {
        guard let session = dailyNoteInlineSupertagFieldCaptureSessions[captureID] else { return true }
        return !hasUnresolvedDailyNoteInlineSupertagFactIntent(on: .init(session.claim.readClaim))
    }

    /// Used when a platform popover is dismissed outside the form's Done button. Re-present the
    /// original capture while its frozen operation is unresolved so retry remains reachable.
    func retainedDailyNoteInlineSupertagFieldCaptureRequiringResolution(
        captureID: UUID
    ) -> DailyNoteInlineSupertagFieldCapture? {
        guard let session = dailyNoteInlineSupertagFieldCaptureSessions[captureID],
              isCurrentDailyNoteInlineSupertagFieldCapture(session.claim),
              hasUnresolvedDailyNoteInlineSupertagFactIntent(on: .init(session.claim.readClaim))
        else { return nil }
        return session.capture
    }

    private func currentDailyNoteInlineSupertagFactCustodyRoute() -> DailyNoteInlineSupertagFactCustodyRoute? {
        guard let witness = presentedPageRouteWitness else { return nil }
        return .init(
            nodeID: activeSelection.nodeId,
            date: activeSelection.date,
            pageGeneration: pageOperationGeneration,
            witness: witness
        )
    }

    private func hasUnresolvedDailyNoteInlineSupertagFactIntent(
        on route: DailyNoteInlineSupertagFactCustodyRoute
    ) -> Bool {
        pendingDailyNoteInlineSupertagFactIntents.values.contains { intents in
            intents.values.contains { $0.custodyRoute == route }
        }
    }

    /// Reads the effective schema and current facts only after the rich editor has acknowledged
    /// the exact typed insertion. A field popover is therefore never driven by a picker result,
    /// a textual `#tag` observation, or an unacknowledged/no-op engine command.
    func prepareDailyNoteInlineSupertagFieldCapture(
        acknowledgement: LoroNativeRichTextInlineReferenceInsertionAcknowledgement
    ) async -> DailyNoteInlineSupertagFieldCapture? {
        guard acknowledgement.trigger == .supertag,
              acknowledgement.reference.kind == .supertag,
              !acknowledgement.reference.label.isEmpty,
              !externalMutationInFlight,
              isDailyNoteSupertagReadEligible(allowDirtyRichDraft: true),
              let currentRoute = currentDailyNoteInlineSupertagFactCustodyRoute(),
              !hasUnresolvedDailyNoteInlineSupertagFactIntent(on: currentRoute)
        else { return nil }

        // The membership decision is reread before the independent schema/fact reads. A local
        // picker catalog must never imply that the tag is still attached to this note.
        await refreshDailyNoteSupertags(allowDirtyRichDraft: true)
        guard case .loaded(_, let appliedTagIDs) = dailyNoteSupertagAssignmentState,
              appliedTagIDs.contains(acknowledgement.reference.id.rawValue),
              let readClaim = dailyNoteSupertagReadClaim,
              isCurrentDailyNoteSupertagRead(readClaim)
        else { return nil }

        let claim = DailyNoteInlineSupertagFieldCaptureClaim(
            acknowledgement: acknowledgement,
            tagID: acknowledgement.reference.id,
            readClaim: readClaim
        )
        do {
            async let effectiveFields = dailyNoteSupertagClient.listTagFields(tagId: claim.tagID.rawValue)
            async let graphFactRows = dailyNoteSupertagClient.runView(
                viewName: "graph_facts",
                viewSpec: Self.dailyNoteInlineSupertagFactsViewSpec(nodeId: claim.readClaim.selection.nodeId)
            )
            let (fields, rows) = try await (effectiveFields, graphFactRows)

            let predicateIDs = Set(fields.map(\.field.id))
            guard fields.count == predicateIDs.count,
                  fields.allSatisfy({
                      EntityId.isValid($0.field.id) &&
                          EntityId.isValid($0.field.tagId) &&
                          !$0.field.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  }),
                  isCurrentDailyNoteInlineSupertagFieldCapture(claim),
                  !hasUnresolvedDailyNoteInlineSupertagFactIntent(on: .init(claim.readClaim))
            else { return nil }

            let factsByPredicate = try Self.decodeDailyNoteInlineSupertagFacts(
                rows,
                expectedNodeID: claim.readClaim.selection.nodeId,
                permittedPredicateIDs: predicateIDs
            )
            guard isCurrentDailyNoteInlineSupertagFieldCapture(claim) else { return nil }

            let capture = DailyNoteInlineSupertagFieldCapture(
                commandID: acknowledgement.commandID,
                tagID: claim.tagID,
                tagName: acknowledgement.reference.label,
                fields: fields.map { .init(resolved: $0, existingFact: factsByPredicate[$0.field.id]) }
            )
            // An empty effective schema is a successful no-UI outcome. In particular, it must
            // not steal editor focus or create a blank popover merely because a `#` reference
            // was inserted.
            guard !capture.fields.isEmpty else { return nil }
            dailyNoteInlineSupertagFieldCaptureSessions[capture.commandID] = .init(
                capture: capture,
                claim: claim,
                factsByPredicate: factsByPredicate
            )
            return capture
        } catch {
            // This is intentionally silent at the editor boundary: an unreadable schema/facts
            // snapshot cannot be safely guessed, so no capture surface is presented.
            return nil
        }
    }

    /// Starts exactly one fact operation for a loaded field. A failed operation remains in the
    /// session as the immutable retry target; a changed draft cannot silently replace it.
    @discardableResult
    func saveDailyNoteInlineSupertagField(
        captureID: UUID,
        fieldID: String,
        value: JSONValue
    ) async -> Bool {
        guard let session = dailyNoteInlineSupertagFieldCaptureSessions[captureID],
              let field = session.capture.fields.first(where: { $0.id == fieldID })
        else { return false }

        if let retained = pendingDailyNoteInlineSupertagFactIntents[captureID]?[fieldID] {
            // A retry has to replay every custody-bearing value, not merely the request id.
            guard retained.value == value else { return false }
            return await submitDailyNoteInlineSupertagFact(retained, captureID: captureID, fieldID: fieldID)
        }

        guard !externalMutationInFlight,
              isCurrentDailyNoteInlineSupertagFieldCapture(session.claim),
              !hasUnresolvedDailyNoteInlineSupertagFactIntent(on: .init(session.claim.readClaim))
        else { return false }
        let existingFact = session.factsByPredicate[fieldID] ?? field.existingFact
        guard let factID = existingFact?.id ?? (try? EntityId(validating: UUID().uuidString.lowercased())) else {
            return false
        }
        let intent = PendingDailyNoteInlineSupertagFactIntent(
            captureClaim: session.claim,
            factID: factID,
            requestID: UUID().uuidString.lowercased(),
            nodeID: session.claim.readClaim.selection.nodeId,
            predicateID: fieldID,
            value: value,
            commitMessage: "Update the \(field.resolved.field.name) field on #\(session.capture.tagName).",
            attribution: MutationAttribution(kind: "humanUi", surface: Self.nativeSurface)
        )
        var intents = pendingDailyNoteInlineSupertagFactIntents[captureID] ?? [:]
        intents[fieldID] = intent
        pendingDailyNoteInlineSupertagFactIntents[captureID] = intents
        return await submitDailyNoteInlineSupertagFact(intent, captureID: captureID, fieldID: fieldID)
    }

    /// Replays the frozen operation verbatim. Callers cannot supply a replacement value, fact
    /// id, route, or attribution here because those would turn an uncertain response into a new
    /// logical mutation.
    @discardableResult
    func retryDailyNoteInlineSupertagField(captureID: UUID, fieldID: String) async -> Bool {
        guard let intent = pendingDailyNoteInlineSupertagFactIntents[captureID]?[fieldID] else { return false }
        return await submitDailyNoteInlineSupertagFact(intent, captureID: captureID, fieldID: fieldID)
    }

    private func submitDailyNoteInlineSupertagFact(
        _ intent: PendingDailyNoteInlineSupertagFactIntent,
        captureID: UUID,
        fieldID: String
    ) async -> Bool {
        guard dailyNoteInlineSupertagFieldCaptureSessions[captureID]?.claim == intent.captureClaim,
              pendingDailyNoteInlineSupertagFactIntents[captureID]?[fieldID] == intent,
              !externalMutationInFlight,
              isCurrentDailyNoteInlineSupertagFieldCapture(intent.captureClaim),
              let mutationToken = dailyNoteInlineSupertagFieldMutationGate.claim()
        else { return false }

        isDailyNoteInlineSupertagFieldMutationInFlight = true
        externalMutationInFlight = true
        defer {
            releaseDailyNoteInlineSupertagFieldMutation(mutationToken)
        }

        do {
            let receipt = try await dailyNoteSupertagClient.addFact(
                nodeId: intent.nodeID.rawValue,
                predicateId: intent.predicateID,
                value: Self.capnWebValue(intent.value),
                requestId: intent.requestID,
                commitMessage: intent.commitMessage,
                attribution: intent.attribution,
                id: intent.factID.rawValue
            )
            guard dailyNoteInlineSupertagFieldCaptureSessions[captureID]?.claim == intent.captureClaim,
                  pendingDailyNoteInlineSupertagFactIntents[captureID]?[fieldID] == intent,
                  isCurrentDailyNoteInlineSupertagFieldCapture(intent.captureClaim),
                  receipt.id == intent.factID.rawValue,
                  receipt.nodeId == intent.nodeID.rawValue,
                  receipt.predicateId == intent.predicateID,
                  receipt.pending == nil,
                  let receiptValue = try? Self.jsonValue(receipt.value),
                  receiptValue == intent.value
            else { return false }

            var session = dailyNoteInlineSupertagFieldCaptureSessions[captureID]!
            session.factsByPredicate[intent.predicateID] = Fact(
                id: intent.factID,
                nodeId: intent.nodeID,
                predicateId: intent.predicateID,
                value: intent.value
            )
            dailyNoteInlineSupertagFieldCaptureSessions[captureID] = session
            clearPendingDailyNoteInlineSupertagFact(captureID: captureID, fieldID: fieldID)
            return true
        } catch {
            // Preserve the entire immutable intent for an exact retry. A transport error cannot
            // be interpreted as permission to mint a new fact/request pair.
            return false
        }
    }

    private func releaseDailyNoteInlineSupertagFieldMutation(_ mutationToken: Int) {
        guard dailyNoteInlineSupertagFieldMutationGate.release(mutationToken) else { return }
        isDailyNoteInlineSupertagFieldMutationInFlight = false
        externalMutationInFlight = false
    }

    private func clearPendingDailyNoteInlineSupertagFact(captureID: UUID, fieldID: String) {
        guard var intents = pendingDailyNoteInlineSupertagFactIntents[captureID] else { return }
        intents.removeValue(forKey: fieldID)
        if intents.isEmpty {
            pendingDailyNoteInlineSupertagFactIntents.removeValue(forKey: captureID)
        } else {
            pendingDailyNoteInlineSupertagFactIntents[captureID] = intents
        }
    }

    private func isCurrentDailyNoteInlineSupertagFieldCapture(
        _ claim: DailyNoteInlineSupertagFieldCaptureClaim
    ) -> Bool {
        guard claim.acknowledgement.trigger == .supertag,
              claim.acknowledgement.reference.kind == .supertag,
              claim.acknowledgement.reference.id == claim.tagID,
              currentDailyNoteInlineSupertagFactCustodyRoute() == .init(claim.readClaim),
              let currentReadClaim = dailyNoteSupertagReadClaim,
              isCurrentDailyNoteSupertagRead(currentReadClaim),
              isDailyNoteSupertagReadEligible(allowDirtyRichDraft: true),
              case .loaded(_, let appliedTagIDs) = dailyNoteSupertagAssignmentState
        else { return false }
        return appliedTagIDs.contains(claim.tagID.rawValue)
    }

    private static func decodeDailyNoteInlineSupertagFacts(
        _ rows: [CapnWebValue],
        expectedNodeID: EntityId,
        permittedPredicateIDs: Set<String>
    ) throws -> [String: Fact] {
        var facts: [String: Fact] = [:]
        for row in rows {
            guard let id = try row.field("id").stringValue.flatMap({ try? EntityId(validating: $0) }),
                  let nodeID = try row.field("nodeId").stringValue.flatMap({ try? EntityId(validating: $0) }),
                  let predicateID = try row.field("predicateId").stringValue,
                  let encodedValue = try row.field("value").stringValue,
                  nodeID == expectedNodeID
            else { throw CapnWebError.malformedMessage("malformed inline Supertag graph fact") }
            guard permittedPredicateIDs.contains(predicateID) else { continue }
            guard facts[predicateID] == nil,
                  let value = try? JSONDecoder().decode(JSONValue.self, from: Data(encodedValue.utf8))
            else { throw CapnWebError.malformedMessage("ambiguous inline Supertag graph fact") }
            facts[predicateID] = .init(id: id, nodeId: nodeID, predicateId: predicateID, value: value)
        }
        return facts
    }

    private static func capnWebValue(_ value: JSONValue) -> CapnWebValue {
        switch value {
        case .null: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return .number(value)
        case .string(let value): return .string(value)
        case .array(let values): return .array(values.map(capnWebValue))
        case .object(let fields): return .object(fields.mapValues(capnWebValue))
        }
    }

    private static func jsonValue(_ value: CapnWebValue) throws -> JSONValue {
        switch value {
        case .null: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return .number(value)
        case .string(let value): return .string(value)
        case .array(let values): return .array(try values.map(jsonValue))
        case .object(let fields): return .object(try fields.mapValues(jsonValue))
        case .bytes, .undefined, .error:
            throw CapnWebError.malformedMessage("non-JSON inline Supertag fact receipt")
        }
    }

    /// Resumes a rich draft whose debounce was paused for an inline membership confirmation. The
    /// inline host calls this only when confirmation fails or the live editor context disappears;
    /// a successful typed-reference insertion schedules the ordinary debounce itself.
    public func resumeLoroRichDraftSubmissionIfNeeded() {
        guard !isEditorInputDisabled,
              !loroDraftBlocked,
              case .loroRichEditable = pagePresentation,
              let session = loroRichSession,
              session.draft != session.base.document else { return }
        loroRichDebounceTask?.cancel()
        loroRichDraftRevision &+= 1
        let revision = loroRichDraftRevision
        let selection = activeSelection
        let generation = pageOperationGeneration
        loroRichDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.submitLoroRichDraft(selection: selection, generation: generation, revision: revision)
        }
    }

    private var isDailyNoteSupertagPresentationSafe: Bool {
        switch pagePresentation {
        case .loroPlainEditable:
            return loroEditorBase != nil && loroPlainDraft == loroEditorBase?.text
        case .loroRichEditable:
            return loroRichSession != nil && loroRichSession?.draft == loroRichSession?.base.document
        default: return false
        }
    }

    private func isDailyNoteSupertagReadEligible(allowDirtyRichDraft: Bool) -> Bool {
        guard Self.isDailyNoteSupertagPresentationEligible(pagePresentation),
              !isNavigating, !loroSubmitEntered, !isLoroRecoveryInProgress, !loroDraftBlocked
        else { return false }
        if allowDirtyRichDraft, case .loroRichEditable = pagePresentation {
            return loroRichSession != nil
        }
        return isDailyNoteSupertagPresentationSafe
    }

    private func isCurrentDailyNoteSupertagRead(_ claim: DailyNoteSupertagReadClaim) -> Bool {
        guard claim.token == dailyNoteSupertagReadGeneration,
              isCurrent(claim.selection, generation: claim.pageGeneration),
              presentedPageRouteWitness == claim.witness else { return false }
        return true
    }

    private static var nativeSurface: String {
        #if os(macOS)
        return "macos"
        #else
        return "ios"
        #endif
    }

    private func isCurrent(_ selection: DailyNoteSelection) -> Bool {
        navigator.isCurrent(selection, activeNodeId: activeSelection.nodeId)
    }

    private func isToday(selection: DailyNoteSelection) -> Bool {
        navigator.calendar.isDateInToday(selection.date)
    }

    private func isCurrent(_ selection: DailyNoteSelection, generation: Int) -> Bool {
        pageOperationGeneration == generation && isCurrent(selection)
    }

    private func loroCreationIntent(for nodeId: EntityId) -> CreationIntent {
        if let existing = loroCreationIntents[nodeId.rawValue] { return existing }
        let intent = CreationIntent(
            requestId: UUID().uuidString.lowercased(),
            commitMessage: "Create daily note",
            attribution: MutationAttribution(kind: "humanUi", surface: "macos")
        )
        loroCreationIntents[nodeId.rawValue] = intent
        return intent
    }

    /// A page operation is eligible to mutate Automerge state only while the exact load/retry
    /// generation that scheduled it is still presenting the flat Automerge editor.  Node identity
    /// alone is insufficient: a retry can select the same node after its descriptor activates
    /// Loro.
    private func isCurrentAutomergeEditable(_ selection: DailyNoteSelection, generation: Int) -> Bool {
        guard isCurrent(selection, generation: generation) else { return false }
        guard case .automergeEditable = pagePresentation else { return false }
        return true
    }

    /// Loro recovery always precedes any read/projection sync.  The UI receives only Core's
    /// closed values; all request identity, attribution, document handles and bytes remain Core
    /// private. A committed recovery is deliberately not followed by a sync: it must first pass
    /// a fresh descriptor witness check.
    private func routeLoro(
        descriptor: PageDocumentDescriptor,
        selection: DailyNoteSelection,
        generation: Int,
        nativeEditableCandidate: Bool
    ) async throws {
        // Claim before entering Core. A lifecycle reload can invalidate this route's generation,
        // but cannot clear this ownership and thereby authorize a duplicate recovery.
        guard let flight = claimLoroRecoveryFlight(selection: selection, generation: generation) else {
            throw DailyNotePageRouteError.loroRecoveryInProgress
        }
        defer { finishLoroRecoveryFlight(flight) }
        let recovery = try await pageOperations.recoverInFlightLoroSemanticCheckpoint(nodeId: selection.nodeId)
        guard isCurrent(selection, generation: generation) else { return }
        switch recovery {
        case .none:
            let projection = try await pageOperations.syncLoroProjection(nodeId: selection.nodeId)
            guard projection.projection.route == PageRouteWitness(descriptor).coreWitness else { throw DailyNotePageRouteError.routeChanged }
            guard isCurrent(selection, generation: generation) else { return }
            if nativeEditableCandidate && nativeLoroEditingEnabled {
                try await admitNativeLoroEditorOrProjection(
                    descriptor: descriptor,
                    selection: selection,
                    generation: generation,
                    projection: projection
                )
            } else {
                publishLoroProjection(projection)
            }
        case .committed:
            let fresh = try await pageOperations.descriptor(nodeId: selection.nodeId)
            guard fresh.nodeId == selection.nodeId,
                  case .nativeLoro = fresh
            else { throw DailyNotePageRouteError.routeChanged }
            guard nativeEditableCandidate && nativeLoroEditingEnabled else {
                publishLoroClosed("A saved change completed. Reload this note to view it.", action: .reloadEditor, selection: selection, generation: generation)
                return
            }
            try await admitNativeLoroEditorWithoutSync(selection: selection, generation: generation, expectedRoute: PageRouteWitness(fresh).coreWitness)
        case .inFlight:
            publishLoroClosed("A saved change is still being recovered.", action: .continueRecovery, selection: selection, generation: generation)
        case .retainedRetry:
            publishLoroClosed("A saved change can be retried.", action: .retrySavedChange, selection: selection, generation: generation)
        case .retainedConflict, .retainedRequestIdentity:
            publishLoroClosed("A saved change needs resolution before this page can be opened.", action: nil, selection: selection, generation: generation)
        case .deniedAuthorizationOrSession:
            publishLoroClosed("Sign in and continue recovery before opening this page.", action: .continueRecovery, selection: selection, generation: generation)
        }
    }

    private func admitNativeLoroEditorOrProjection(
        descriptor: PageDocumentDescriptor,
        selection: DailyNoteSelection,
        generation: Int,
        projection: DailyNoteLoroProjectionState
    ) async throws {
        if prefersPlanTodayRichAdmission(descriptor: descriptor, selection: selection, projection: projection) {
            switch try await pageOperations.loroNativeRichEditorEligibility(nodeId: selection.nodeId) {
            case .editable(let state):
                guard state.route == projection.projection.route else { throw DailyNotePageRouteError.routeChanged }
                if LoroNativePlanTodayStarter.isCanonicalEmpty(state.document) {
                    publishLoroRichEditable(state, selection: selection, generation: generation)
                    return
                }
                // A projection/rich-admission disagreement is not a reason to replace user
                // content. Revert to the ordinary plain-first admission policy.
            case .ineligible:
                // The rich lane is optional for the starter. Its explicit ineligibility falls
                // through to the existing plain editor rather than making a new page read-only.
                break
            case .checkpointResolutionRequired(let resolution):
                publishLoroResolution(resolution, selection: selection, generation: generation)
                return
            case .unauthenticated:
                publishLoroClosed("Sign in to recover this page for editing.", action: .continueRecovery, selection: selection, generation: generation)
                return
            }
        }

        try await admitNativeLoroPlainThenRich(
            selection: selection,
            generation: generation,
            expectedRoute: projection.projection.route,
            projection: projection,
            allowRichFallback: !prefersPlanTodayRichAdmission(descriptor: descriptor, selection: selection, projection: projection)
        )
    }

    private func admitNativeLoroPlainThenRich(
        selection: DailyNoteSelection,
        generation: Int,
        expectedRoute: LoroPageRouteWitness,
        projection: DailyNoteLoroProjectionState? = nil,
        allowRichFallback: Bool = true
    ) async throws {
        switch try await pageOperations.loroNativePlainEditorEligibility(nodeId: selection.nodeId) {
        case .editable(let state):
            guard state.route == expectedRoute else { throw DailyNotePageRouteError.routeChanged }
            publishLoroEditable(state, selection: selection, generation: generation)
        case .ineligible:
            // Plain admission is authoritative for its lane. Only an explicitly ineligible
            // value may enter the separate rich lane; terminal outcomes never fall through.
            guard allowRichFallback else {
                if let projection {
                    publishLoroProjection(projection)
                    loroRecoveryAction = .recoverSavedRichEditableVersion
                    loroNotice = "Try to recover a saved editable rich-text version."
                } else {
                    publishLoroClosed("Reload this page before editing.", action: .recoverSavedRichEditableVersion, selection: selection, generation: generation)
                }
                return
            }
            switch try await pageOperations.loroNativeRichEditorEligibility(nodeId: selection.nodeId) {
            case .editable(let state):
                guard state.route == expectedRoute else { throw DailyNotePageRouteError.routeChanged }
                publishLoroRichEditable(state, selection: selection, generation: generation)
            case .ineligible:
                if let projection {
                    publishLoroProjection(projection)
                    loroRecoveryAction = .recoverSavedRichEditableVersion
                    loroNotice = "Try to recover a saved editable rich-text version."
                } else {
                    publishLoroClosed("Reload this page before editing.", action: .recoverSavedRichEditableVersion, selection: selection, generation: generation)
                }
            case .checkpointResolutionRequired(let resolution):
                publishLoroResolution(resolution, selection: selection, generation: generation)
            case .unauthenticated:
                publishLoroClosed("Sign in to recover this page for editing.", action: .continueRecovery, selection: selection, generation: generation)
            }
        case .checkpointResolutionRequired(let resolution):
            publishLoroResolution(resolution, selection: selection, generation: generation)
        case .unauthenticated:
            publishLoroClosed("Sign in to recover this page for editing.", action: .continueRecovery, selection: selection, generation: generation)
        }
    }

    private func prefersPlanTodayRichAdmission(
        descriptor: PageDocumentDescriptor,
        selection: DailyNoteSelection,
        projection: DailyNoteLoroProjectionState
    ) -> Bool {
        guard isToday(selection: selection),
              !projection.projection.isDirty,
              case let .nativeLoro(_, storageVersion, _) = descriptor,
              storageVersion == 1,
              case let .document(children) = projection.projection.root,
              children.count == 1,
              case let .paragraph(children) = children[0],
              children.isEmpty
        else { return false }
        return true
    }

    private func prefersPlanTodayRichAdmission(
        selection: DailyNoteSelection,
        route: LoroPageRouteWitness,
        document: LoroNativeRichDocumentV1
    ) -> Bool {
        isToday(selection: selection) &&
            route.storageVersion == 1 &&
            LoroNativePlanTodayStarter.isCanonicalEmpty(document)
    }

    private func admitNativeLoroEditorWithoutSync(
        selection: DailyNoteSelection,
        generation: Int,
        expectedRoute: LoroPageRouteWitness,
        retainedDraft: String? = nil,
        recoveryAction: LoroRecoveryAction? = nil
    ) async throws {
        if recoveryAction == nil, isToday(selection: selection), expectedRoute.storageVersion == 1 {
            switch try await pageOperations.loroNativeRichEditorEligibility(nodeId: selection.nodeId) {
            case .editable(let state):
                guard state.route == expectedRoute else { throw DailyNotePageRouteError.routeChanged }
                if prefersPlanTodayRichAdmission(selection: selection, route: state.route, document: state.document) {
                    publishLoroRichEditable(state, selection: selection, generation: generation)
                    return
                }
            case .ineligible:
                break
            case .checkpointResolutionRequired(let resolution):
                publishLoroResolution(resolution, selection: selection, generation: generation)
                return
            case .unauthenticated:
                publishLoroClosed("Sign in to recover this page for editing.", action: .continueRecovery, selection: selection, generation: generation)
                return
            }
        }

        switch try await pageOperations.loroNativePlainEditorEligibility(nodeId: selection.nodeId) {
        case .editable(let state):
            guard state.route == expectedRoute else { throw DailyNotePageRouteError.routeChanged }
            publishLoroEditable(state, selection: selection, generation: generation)
        case .ineligible:
            if let recoveryAction {
                publishLoroRecoveryFailure(retainedDraft, message: "Reload this page before editing.", action: recoveryAction, selection: selection, generation: generation)
            } else {
                switch try await pageOperations.loroNativeRichEditorEligibility(nodeId: selection.nodeId) {
                case .editable(let state):
                    guard state.route == expectedRoute else { throw DailyNotePageRouteError.routeChanged }
                    publishLoroRichEditable(state, selection: selection, generation: generation)
                case .ineligible:
                    publishLoroClosed("Reload this page before editing.", action: .recoverSavedRichEditableVersion, selection: selection, generation: generation)
                case .checkpointResolutionRequired(let resolution):
                    publishLoroResolution(resolution, selection: selection, generation: generation)
                case .unauthenticated:
                    publishLoroClosed("Sign in to recover this page for editing.", action: .continueRecovery, selection: selection, generation: generation)
                }
            }
        case .checkpointResolutionRequired(let resolution):
            if let recoveryAction {
                publishLoroRecoveryResolution(resolution, retainedDraft: retainedDraft, action: recoveryAction, selection: selection, generation: generation)
            } else {
                publishLoroResolution(resolution, selection: selection, generation: generation)
            }
        case .unauthenticated:
            if let recoveryAction {
                publishLoroRecoveryFailure(retainedDraft, message: "Sign in to recover this page for editing.", action: recoveryAction, selection: selection, generation: generation)
            } else {
                publishLoroClosed("Sign in to recover this page for editing.", action: .continueRecovery, selection: selection, generation: generation)
            }
        }
    }

    private func publishLoroResolution(_ resolution: LoroSemanticCheckpointResolution, selection: DailyNoteSelection, generation: Int) {
        switch resolution {
        case .inFlight, .deniedAuthorizationOrSession: publishLoroClosed("A saved change needs recovery.", action: .continueRecovery, selection: selection, generation: generation)
        case .retainedRetry: publishLoroClosed("A saved change can be retried.", action: .retrySavedChange, selection: selection, generation: generation)
        case .retainedConflict, .retainedRequestIdentity: publishLoroClosed("A saved change needs resolution.", action: nil, selection: selection, generation: generation)
        case .none, .committed: publishLoroClosed("Reload this page before editing.", action: .reloadEditor, selection: selection, generation: generation)
        }
    }

    private func resetPagePresentation() {
        pageOperationGeneration &+= 1
        dailyNoteSupertagReadGeneration &+= 1
        dailyNoteSupertagReadClaim = nil
        dailyNoteSupertagAssignmentState = .idle
        presentedPageRouteWitness = nil
        // Preserve a claimed semantic request only while its route remains live. A route change
        // must not expose a retry that could target the newly selected note.
        pendingDailyNoteSupertagIntent = nil
        // The editor command acknowledgement and every frozen fact intent are route-scoped.
        // Dropping their lookup entries makes all suspended schema/fact reads and receipts stale;
        // an in-flight owner still releases only its own mutation token in its deferred finish.
        dailyNoteInlineSupertagFieldCaptureSessions.removeAll()
        pendingDailyNoteInlineSupertagFactIntents.removeAll()
        syncTask?.cancel()
        syncTask = nil
        syncTasksByNodeId[activeSelection.nodeId.rawValue]?.cancel()
        syncTasksByNodeId.removeValue(forKey: activeSelection.nodeId.rawValue)
        text = ""
        isRichTextReadOnly = false
        loroRecoveryAction = nil
        loroNotice = nil
        // First make the rich surface unobservable, then release its value state.
        pagePresentation = .unavailable
        loroEditorBase = nil
        loroPlainDraft = ""
        loroRichSession = nil
        loroRichDraft = nil
        loroDebounceTask?.cancel()
        loroDebounceTask = nil
        loroRichDebounceTask?.cancel()
        loroRichDebounceTask = nil
        loroSubmitEntered = false
        loroDraftBlocked = false
        // Do not clear an entered Core recovery here. This reset can make its completion stale,
        // but only that call may release its page-scoped flight.
        isLoroRecoveryInProgress = loroRecoveryFlight != nil
        pendingLoroNavigationDate = nil
    }

    /// Test-only generation seam. Production routes may not invalidate an active Loro recovery;
    /// this verifies a stale completion remains unable to publish if the route is superseded.
    func invalidatePageRouteForTesting() {
        resetPagePresentation()
    }

    /// Claims the shared recovery flight synchronously, before any Core recovery method is
    /// awaited. Every caller must finish with this exact value so a stale completion cannot
    /// release a newer owner.
    private func claimLoroRecoveryFlight(selection: DailyNoteSelection, generation: Int) -> LoroRecoveryFlight? {
        guard loroRecoveryFlight == nil else { return nil }
        nextLoroRecoveryToken &+= 1
        let flight = LoroRecoveryFlight(
            nodeId: selection.nodeId,
            pageGeneration: generation,
            token: nextLoroRecoveryToken
        )
        loroRecoveryFlight = flight
        isLoroRecoveryInProgress = true
        return flight
    }

    private func finishLoroRecoveryFlight(_ flight: LoroRecoveryFlight) {
        guard loroRecoveryFlight == flight else { return }
        loroRecoveryFlight = nil
        isLoroRecoveryInProgress = false
    }

    private func publishAutomerge(text: String, richText: Bool) {
        loroRichSession = nil
        loroRichDraft = nil
        self.text = text
        isRichTextReadOnly = richText
        pagePresentation = richText ? .automergeRichTextReadOnly : .automergeEditable
        status = .synced
        isNavigating = false
    }

    private func publishLegacyMigrationRequired(_ content: LegacyPageProjectionContent) {
        text = ""
        isRichTextReadOnly = true
        loroPlainDraft = ""
        loroEditorBase = nil
        loroRichSession = nil
        loroRichDraft = nil
        loroRecoveryAction = nil
        loroNotice = nil
        pagePresentation = .legacyMigrationRequired(content)
        status = .synced
        isNavigating = false
    }

    private func publishLoro(_ projection: DailyNoteLoroReadOnlyState) {
        loroRichSession = nil
        loroRichDraft = nil
        text = ""
        isRichTextReadOnly = false
        pagePresentation = .loroReadOnly(projection)
        status = .synced
        isNavigating = false
    }

    private func publishLoroProjection(_ projection: DailyNoteLoroProjectionState) {
        loroRichSession = nil
        loroRichDraft = nil
        text = ""
        isRichTextReadOnly = false
        pagePresentation = .loroProjectedReadOnly(projection)
        presentedPageRouteWitness = PageRouteWitness(projection.projection.route)
        status = projection.projection.isDirty ? .pending("Local Loro replica has not converged") : .synced
        isNavigating = false
    }

    private func publishLoroEditable(_ state: LoroNativePlainEditorState, selection: DailyNoteSelection, generation: Int) {
        guard isCurrent(selection, generation: generation) else { return }
        loroPlainDraft = state.text
        loroRichSession = nil
        loroRichDraft = nil
        isRichTextReadOnly = false
        loroEditorBase = state
        loroRecoveryAction = nil
        loroNotice = nil
        loroDraftBlocked = false
        pagePresentation = .loroPlainEditable
        presentedPageRouteWitness = PageRouteWitness(state.route)
        status = .synced
        isNavigating = false
    }

    private func publishLoroRichEditable(_ state: LoroNativeRichEditorState, selection: DailyNoteSelection, generation: Int) {
        guard isCurrent(selection, generation: generation) else { return }
        // Establish both state and Draft A before the presentation becomes observable.
        let session = LoroRichSession(base: state, draft: state.document, selection: selection, generation: generation)
        loroRichSession = session
        loroRichDraft = session.draft
        loroEditorBase = nil
        loroPlainDraft = ""
        isRichTextReadOnly = false
        loroRecoveryAction = nil
        loroNotice = nil
        loroDraftBlocked = false
        pagePresentation = .loroRichEditable
        presentedPageRouteWitness = PageRouteWitness(state.route)
        status = .synced
        isNavigating = false
    }

    private func publishLoroClosed(_ message: String, action: LoroRecoveryAction?, selection: DailyNoteSelection, generation: Int) {
        guard isCurrent(selection, generation: generation) else { return }
        text = ""
        isRichTextReadOnly = true
        pagePresentation = .retainedLocalChangeConflict(message)
        loroEditorBase = nil
        loroPlainDraft = ""
        loroRichSession = nil
        loroRichDraft = nil
        loroRecoveryAction = action
        loroNotice = message
        status = .conflict(message)
        isNavigating = false
    }

    private func preserveLoroDraftFailure(_ draft: String, message: String, action: LoroRecoveryAction, selection: DailyNoteSelection, generation: Int) {
        guard isCurrent(selection, generation: generation) else { return }
        loroPlainDraft = draft
        isRichTextReadOnly = false
        loroDraftBlocked = true
        loroRecoveryAction = action
        loroNotice = message
        pagePresentation = .loroPlainEditable
        // Keep the native draft editor and its action visible. `.error` selects the top-level
        // retry/reset view branch, which would hide this explicitly retained A draft.
        status = .pending(message)
        isNavigating = false
    }

    private func preserveLoroRichDraftFailure(_ session: LoroRichSession, message: String, action: LoroRecoveryAction?, selection: DailyNoteSelection, generation: Int) {
        guard isCurrent(selection, generation: generation) else { return }
        loroRichSession = session
        loroRichDraft = session.draft
        isRichTextReadOnly = false
        loroDraftBlocked = true
        loroRecoveryAction = action
        loroNotice = message
        pagePresentation = .loroRichEditable
        status = .pending(message)
        isNavigating = false
    }

    private func publishConflict(_ message: String, selection: DailyNoteSelection, generation: Int) {
        guard isCurrent(selection, generation: generation) else { return }
        text = ""
        isRichTextReadOnly = false
        pagePresentation = .retainedLocalChangeConflict(message)
        status = .conflict(message)
        isNavigating = false
    }

    /// All semantic recovery is user initiated. In particular, eligibility and initial loading
    /// never install the accepted literal cache.
    public func performLoroRecoveryAction() {
        guard let action = loroRecoveryAction, !isNavigating, !isLoroRecoveryInProgress else { return }
        let selection = activeSelection
        let generation = pageOperationGeneration
        let retainedDraft = loroDraftBlocked ? loroPlainDraft : nil
        let retainedRichSession = loroDraftBlocked ? loroRichSession : nil
        guard let flight = claimLoroRecoveryFlight(selection: selection, generation: generation) else { return }
        Task { [weak self] in
            guard let self else { return }
            defer { self.finishLoroRecoveryFlight(flight) }
            do {
                switch action {
                case .continueRecovery:
                    let resolution = try await self.pageOperations.recoverInFlightLoroSemanticCheckpoint(nodeId: selection.nodeId)
                    guard self.isCurrent(selection, generation: generation) else { return }
                    if resolution == .committed, let retainedRichSession {
                        self.preserveLoroRichDraftFailure(retainedRichSession, message: "Recovery completed. Discard this rich draft explicitly to reload authority.", action: .discardRichDraftAndReload, selection: selection, generation: generation)
                    } else if let retainedRichSession {
                        self.preserveLoroRichDraftFailure(retainedRichSession, message: "Recovery did not establish editable rich-text authority.", action: self.richRecoveryAction(for: resolution), selection: selection, generation: generation)
                    } else if resolution == .committed {
                        let descriptor = try await self.pageOperations.descriptor(nodeId: selection.nodeId)
                        guard descriptor.nodeId == selection.nodeId, case .nativeLoro = descriptor else { throw DailyNotePageRouteError.routeChanged }
                        try await self.admitNativeLoroEditorWithoutSync(selection: selection, generation: generation, expectedRoute: PageRouteWitness(descriptor).coreWitness, retainedDraft: retainedDraft, recoveryAction: action)
                    } else { self.publishLoroRecoveryResolution(resolution, retainedDraft: retainedDraft, action: action, selection: selection, generation: generation) }
                case .retrySavedChange:
                    let resolution = try await self.pageOperations.retryRetainedLoroSemanticCheckpoint(nodeId: selection.nodeId)
                    guard self.isCurrent(selection, generation: generation) else { return }
                    if resolution == .committed, let retainedRichSession {
                        self.preserveLoroRichDraftFailure(retainedRichSession, message: "Recovery completed. Discard this rich draft explicitly to reload authority.", action: .discardRichDraftAndReload, selection: selection, generation: generation)
                    } else if let retainedRichSession {
                        self.preserveLoroRichDraftFailure(retainedRichSession, message: "Recovery did not establish editable rich-text authority.", action: self.richRecoveryAction(for: resolution), selection: selection, generation: generation)
                    } else if resolution == .committed {
                        let descriptor = try await self.pageOperations.descriptor(nodeId: selection.nodeId)
                        guard descriptor.nodeId == selection.nodeId, case .nativeLoro = descriptor else { throw DailyNotePageRouteError.routeChanged }
                        try await self.admitNativeLoroEditorWithoutSync(selection: selection, generation: generation, expectedRoute: PageRouteWitness(descriptor).coreWitness, retainedDraft: retainedDraft, recoveryAction: action)
                    } else { self.publishLoroRecoveryResolution(resolution, retainedDraft: retainedDraft, action: action, selection: selection, generation: generation) }
                case .recoverSavedEditableVersion:
                    let eligibility = try await self.pageOperations.recoverAcceptedLoroLiteralForEditing(nodeId: selection.nodeId)
                    guard self.isCurrent(selection, generation: generation) else { return }
                    switch eligibility {
                    case .editable(let state):
                        let descriptor = try await self.pageOperations.descriptor(nodeId: selection.nodeId)
                        guard descriptor.nodeId == selection.nodeId,
                              case .nativeLoro = descriptor,
                              PageRouteWitness(descriptor).coreWitness == state.route
                        else { throw DailyNotePageRouteError.routeChanged }
                        self.publishLoroEditable(state, selection: selection, generation: generation)
                    case .checkpointResolutionRequired(let resolution): self.publishLoroRecoveryResolution(resolution, retainedDraft: retainedDraft, action: action, selection: selection, generation: generation)
                    case .ineligible: self.publishLoroRecoveryFailure(retainedDraft, message: "No saved editable version is available.", action: action, selection: selection, generation: generation)
                    case .unauthenticated: self.publishLoroRecoveryFailure(retainedDraft, message: "Sign in to recover this page for editing.", action: action, selection: selection, generation: generation)
                    }
                case .recoverSavedRichEditableVersion:
                    let eligibility = try await self.pageOperations.recoverAcceptedLoroRichLiteralForEditing(nodeId: selection.nodeId)
                    guard self.isCurrent(selection, generation: generation) else { return }
                    switch eligibility {
                    case .editable(let state):
                        let descriptor = try await self.pageOperations.descriptor(nodeId: selection.nodeId)
                        guard descriptor.nodeId == selection.nodeId, case .nativeLoro = descriptor,
                              PageRouteWitness(descriptor).coreWitness == state.route else { throw DailyNotePageRouteError.routeChanged }
                        self.publishLoroRichEditable(state, selection: selection, generation: generation)
                    case .checkpointResolutionRequired(let resolution):
                        self.publishLoroResolution(resolution, selection: selection, generation: generation)
                    case .ineligible:
                        self.publishLoroClosed("No saved editable rich-text version is available.", action: action, selection: selection, generation: generation)
                    case .unauthenticated:
                        self.publishLoroClosed("Sign in to recover this page for editing.", action: action, selection: selection, generation: generation)
                    }
                case .reloadEditor:
                    // A post-commit cache invalidation is not a normal read retry. Re-establish
                    // literal authority only through Core's explicit accepted-evidence recovery.
                    let eligibility = try await self.pageOperations.recoverAcceptedLoroLiteralForEditing(nodeId: selection.nodeId)
                    guard self.isCurrent(selection, generation: generation) else { return }
                    switch eligibility {
                    case .editable(let state):
                        let descriptor = try await self.pageOperations.descriptor(nodeId: selection.nodeId)
                        guard descriptor.nodeId == selection.nodeId, case .nativeLoro = descriptor,
                              PageRouteWitness(descriptor).coreWitness == state.route else { throw DailyNotePageRouteError.routeChanged }
                        self.publishLoroEditable(state, selection: selection, generation: generation)
                    case .checkpointResolutionRequired(let resolution): self.publishLoroRecoveryResolution(resolution, retainedDraft: retainedDraft, action: action, selection: selection, generation: generation)
                    case .ineligible: self.publishLoroRecoveryFailure(retainedDraft, message: "No saved editable version is available.", action: action, selection: selection, generation: generation)
                    case .unauthenticated: self.publishLoroRecoveryFailure(retainedDraft, message: "Sign in to recover this page for editing.", action: action, selection: selection, generation: generation)
                    }
                case .discardRichDraftAndReload:
                    guard let retainedRichSession else { return }
                    let eligibility = try await self.pageOperations.loroNativeRichEditorEligibility(nodeId: selection.nodeId)
                    guard self.isCurrent(selection, generation: generation) else { return }
                    guard case .editable(let state) = eligibility else {
                        self.preserveLoroRichDraftFailure(retainedRichSession, message: "Reload did not establish an editable rich-text page.", action: .discardRichDraftAndReload, selection: selection, generation: generation)
                        return
                    }
                    let descriptor = try await self.pageOperations.descriptor(nodeId: selection.nodeId)
                    guard descriptor.nodeId == selection.nodeId, case .nativeLoro = descriptor,
                          PageRouteWitness(descriptor).coreWitness == state.route else { throw DailyNotePageRouteError.routeChanged }
                    self.publishLoroRichEditable(state, selection: selection, generation: generation)
                }
            } catch {
                guard self.isCurrent(selection, generation: generation) else { return }
                if let retainedRichSession {
                    self.preserveLoroRichDraftFailure(retainedRichSession, message: "Recovery failed: \(error)", action: action, selection: selection, generation: generation)
                } else {
                    self.publishLoroRecoveryFailure(retainedDraft, message: "Recovery failed: \(error)", action: action, selection: selection, generation: generation)
                }
            }
        }
    }

    private func publishLoroRecoveryResolution(_ resolution: LoroSemanticCheckpointResolution, retainedDraft: String?, action: LoroRecoveryAction, selection: DailyNoteSelection, generation: Int) {
        if let retainedDraft {
            preserveLoroDraftFailure(retainedDraft, message: "Recovery did not establish an editable page.", action: action, selection: selection, generation: generation)
        } else {
            publishLoroResolution(resolution, selection: selection, generation: generation)
        }
    }

    private func richRecoveryAction(for resolution: LoroSemanticCheckpointResolution) -> LoroRecoveryAction? {
        switch resolution {
        case .inFlight, .deniedAuthorizationOrSession:
            .continueRecovery
        case .retainedRetry:
            .retrySavedChange
        case .retainedConflict, .retainedRequestIdentity:
            nil
        case .none, .committed:
            .discardRichDraftAndReload
        }
    }

    private func publishLoroRecoveryFailure(_ retainedDraft: String?, message: String, action: LoroRecoveryAction, selection: DailyNoteSelection, generation: Int) {
        if let retainedDraft {
            preserveLoroDraftFailure(retainedDraft, message: message, action: action, selection: selection, generation: generation)
        } else {
            publishLoroClosed(message, action: action, selection: selection, generation: generation)
        }
    }

    private func hasNoRetainedAutomergeChange(nodeId: EntityId, expectedHeadsHash: String) async throws -> Bool {
        if let durable = try await pageOperations.localAutomergeHeads(nodeId: nodeId), durable != expectedHeadsHash {
            return false
        }
        if let loaded = try await pageOperations.loadedAutomergeHeads(nodeId: nodeId), loaded != expectedHeadsHash {
            return false
        }
        return true
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
        guard case .automergeEditable = pagePresentation, !isNavigating else { return }
        guard let edit = diffText(before: text, after: newText) else { return }
        text = newText

        let selection = activeSelection
        let generation = pageOperationGeneration
        _ = localCommitQueue.enqueue { [weak self] () -> Bool in
            // This can run after a durable preceding commit.  Revalidate immediately before the
            // mutation so retry/format activation for the same node cannot write Automerge into a
            // Loro presentation.
            guard let self, self.isCurrentAutomergeEditable(selection, generation: generation) else { return false }
            do {
                try await self.pageOperations.applyAutomergeSplice(
                    nodeId: selection.nodeId, index: edit.index, deleteCount: edit.deleteCount, insertText: edit.insertText
                )
            } catch DailyNotePageOperationError.legacyPageReadOnly {
                // Discovered late (e.g. a rich edit synced in between load and this keystroke) —
                // flip into the same read-only state the view checks up front, with the same
                // user-facing message, rather than surfacing a raw error string.
                guard self.isCurrentAutomergeEditable(selection, generation: generation) else { return false }
                self.isRichTextReadOnly = true
                self.pagePresentation = .automergeRichTextReadOnly
                if self.isNavigating { self.isNavigating = false }
                return false
            } catch {
                guard self.isCurrentAutomergeEditable(selection, generation: generation) else { return false }
                self.status = .error(String(describing: error))
                if self.isNavigating { self.isNavigating = false }
                return false
            }

            guard self.isCurrentAutomergeEditable(selection, generation: generation) else { return false }
            self.scheduleSync(for: selection, generation: generation)
            return true
        }
    }

    func handleLoroPlainTextChange(_ newText: String) {
        guard !isNavigating, !loroSubmitEntered, !loroDraftBlocked, let base = loroEditorBase else { return }
        guard !newText.contains("\n"), !newText.contains("\r") else {
            loroPlainDraft = base.text
            loroNotice = "Native plain-text editing does not allow line breaks."
            return
        }
        guard newText != loroPlainDraft else { return }
        preparationCompletion = nil
        acceptedHumanEditGeneration &+= 1
        loroPlainDraft = newText
        loroNotice = nil
        loroDraftRevision &+= 1
        let revision = loroDraftRevision
        let selection = activeSelection
        let generation = pageOperationGeneration
        loroDebounceTask?.cancel()
        loroDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.submitLoroDraft(selection: selection, generation: generation, revision: revision, base: base)
        }
    }

    private func submitLoroDraft(selection: DailyNoteSelection, generation: Int, revision: Int, base: LoroNativePlainEditorState) async {
        guard isCurrent(selection, generation: generation), !isNavigating,
              !loroSubmitEntered, revision == loroDraftRevision,
              case .loroPlainEditable = pagePresentation else { return }
        guard loroPlainDraft != base.text else { return }
        loroSubmitEntered = true
        let draft = loroPlainDraft
        do {
            let result = try await pageOperations.submitNativePlainText(nodeId: selection.nodeId, base: base, proposedText: draft)
            guard isCurrent(selection, generation: generation), case .loroPlainEditable = pagePresentation else { loroSubmitEntered = false; return }
            switch result {
            case .submitted:
                switch try await pageOperations.loroNativePlainEditorEligibility(nodeId: selection.nodeId) {
                case .editable(let fresh):
                    let descriptor = try await pageOperations.descriptor(nodeId: selection.nodeId)
                    guard descriptor.nodeId == selection.nodeId, case .nativeLoro = descriptor,
                          fresh.route == PageRouteWitness(descriptor).coreWitness else { throw DailyNotePageRouteError.routeChanged }
                    publishLoroEditable(fresh, selection: selection, generation: generation)
                    // Entered submissions freeze this dedicated draft surface. No later draft is
                    // accepted while Core owns A, so there is deliberately no implicit B submit.
                // `.submitted` already transferred custody of A. A subsequent non-admission
                // result is therefore rendered as Core's closed state, not as an unaccepted
                // draft preservation path.
                case .checkpointResolutionRequired(let resolution): publishLoroResolution(resolution, selection: selection, generation: generation)
                case .ineligible:
                    publishLoroClosed("Your change was saved. Reload this page before editing again.", action: .reloadEditor, selection: selection, generation: generation)
                case .unauthenticated:
                    publishLoroClosed("Your change was saved. Sign in to continue editing.", action: .continueRecovery, selection: selection, generation: generation)
                }
            case .submittedNeedsReload:
                publishLoroClosed("Your change was saved. Recover the saved editable version before editing again.", action: .recoverSavedEditableVersion, selection: selection, generation: generation)
            case .noChange: break
            case .unauthenticated: preserveLoroDraftFailure(draft, message: "Sign in before continuing this edit.", action: .continueRecovery, selection: selection, generation: generation)
            case .checkpointResolutionRequired:
                // Core has not admitted this submission; retain A until the explicit recovery
                // action resolves it instead of replacing the visible draft with a closed card.
                preserveLoroDraftFailure(draft, message: "This draft is waiting for recovery.", action: .continueRecovery, selection: selection, generation: generation)
            case .ineligible: preserveLoroDraftFailure(draft, message: "Reload this page before editing.", action: .reloadEditor, selection: selection, generation: generation)
            case .staleEditorState: preserveLoroDraftFailure(draft, message: "This editor is stale. Reload it before continuing.", action: .reloadEditor, selection: selection, generation: generation)
            case .invalidProposedText: preserveLoroDraftFailure(draft, message: "Native plain-text editing does not allow this draft.", action: .reloadEditor, selection: selection, generation: generation)
            }
            loroSubmitEntered = false
            if pendingLoroNavigationDate != nil, case .submitted = result {
                await continuePendingLoroNavigation(selection: selection, generation: generation)
            } else if pendingLoroNavigationDate != nil, case .submittedNeedsReload = result {
                await continuePendingLoroNavigation(selection: selection, generation: generation)
            } else if pendingLoroNavigationDate != nil, case .noChange = result {
                await continuePendingLoroNavigation(selection: selection, generation: generation)
            }
        } catch {
            loroSubmitEntered = false
            guard isCurrent(selection, generation: generation) else { return }
            preserveLoroDraftFailure(draft, message: "Could not save this edit: \(error)", action: .reloadEditor, selection: selection, generation: generation)
        }
    }

    func handleLoroRichDocumentChange(_ document: LoroNativeRichDocumentV1) {
        guard !isNavigating, !loroSubmitEntered, !loroDraftBlocked,
              case .loroRichEditable = pagePresentation,
              var session = loroRichSession,
              session.selection.nodeId == activeSelection.nodeId,
              session.generation == pageOperationGeneration,
              isCurrent(session.selection, generation: session.generation) else { return }
        guard document != session.draft else { return }
        preparationCompletion = nil
        acceptedHumanEditGeneration &+= 1
        session.draft = document
        loroRichSession = session
        loroRichDraft = document
        loroNotice = nil
        loroRichDraftRevision &+= 1
        let revision = loroRichDraftRevision
        let selection = activeSelection
        let generation = pageOperationGeneration
        loroRichDebounceTask?.cancel()
        loroRichDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.submitLoroRichDraft(selection: selection, generation: generation, revision: revision)
        }
    }

    func handleLoroRichSelectionChange(_: LoroNativeRichTextSelection) {
        // Selection is ephemeral native presentation state; it never creates durable work.
    }

    func handleLoroRichRejectedInput(_: LoroNativeRichTextEditorRejection) {
        guard case .loroRichEditable = pagePresentation,
              !loroSubmitEntered, !loroDraftBlocked,
              let session = loroRichSession,
              session.selection.nodeId == activeSelection.nodeId,
              session.generation == pageOperationGeneration else { return }
        loroNotice = "That rich-text edit is not supported."
    }

    private func submitLoroRichDraft(selection: DailyNoteSelection, generation: Int, revision: Int) async {
        guard isCurrent(selection, generation: generation), !isNavigating, !loroSubmitEntered,
              revision == loroRichDraftRevision, case .loroRichEditable = pagePresentation,
              let session = loroRichSession, session.selection.nodeId == selection.nodeId,
              session.generation == generation, session.draft != session.base.document else { return }
        // Freeze the exact A/base pair before the first await. Later wrapper callbacks are
        // rejected by `loroSubmitEntered`, so Core owns one deterministic value submission.
        loroSubmitEntered = true
        let frozen = session
        var acceptedByCore = false
        do {
            let result = try await pageOperations.submitNativeRichDocumentV1(
                nodeId: selection.nodeId, base: frozen.base, proposed: frozen.draft,
                commitMessage: "Update daily note content"
            )
            guard isCurrent(selection, generation: generation), case .loroRichEditable = pagePresentation else { loroSubmitEntered = false; return }
            switch result {
            case .submitted:
                // Re-admission is a read-side check.  Core has already accepted A, so a later
                // descriptor/eligibility failure must never put it back into the discardable
                // local-draft lane.
                acceptedByCore = true
                switch try await pageOperations.loroNativeRichEditorEligibility(nodeId: selection.nodeId) {
                case .editable(let fresh):
                    let descriptor = try await pageOperations.descriptor(nodeId: selection.nodeId)
                    guard descriptor.nodeId == selection.nodeId, case .nativeLoro = descriptor,
                          fresh.route == PageRouteWitness(descriptor).coreWitness else { throw DailyNotePageRouteError.routeChanged }
                    publishLoroRichEditable(fresh, selection: selection, generation: generation)
                case .checkpointResolutionRequired(let resolution): publishLoroResolution(resolution, selection: selection, generation: generation)
                case .ineligible: publishLoroClosed("Your change was saved. Reload this page before editing again.", action: .recoverSavedRichEditableVersion, selection: selection, generation: generation)
                case .unauthenticated: publishLoroClosed("Your change was saved. Sign in to continue editing.", action: .continueRecovery, selection: selection, generation: generation)
                }
            case .submittedNeedsReload:
                publishLoroClosed("Your change was saved. Reload this page before editing again.", action: .recoverSavedRichEditableVersion, selection: selection, generation: generation)
            case .noChange:
                publishLoroRichEditable(frozen.base, selection: selection, generation: generation)
            case .unauthenticated:
                preserveLoroRichDraftFailure(frozen, message: "Sign in before continuing this edit.", action: .continueRecovery, selection: selection, generation: generation)
            case .checkpointResolutionRequired(let resolution):
                let action = richRecoveryAction(for: resolution)
                preserveLoroRichDraftFailure(frozen, message: "This draft is waiting for recovery.", action: action, selection: selection, generation: generation)
            case .ineligible, .staleEditorState, .invalidProposedDocument, .invalidCommitMessage:
                preserveLoroRichDraftFailure(frozen, message: "This rich draft could not be saved. Reload it explicitly before continuing.", action: .discardRichDraftAndReload, selection: selection, generation: generation)
            }
            loroSubmitEntered = false
            if pendingLoroNavigationDate != nil {
                switch result {
                case .submitted, .submittedNeedsReload, .noChange:
                    await continuePendingLoroNavigation(selection: selection, generation: generation)
                default: break
                }
            }
        } catch {
            loroSubmitEntered = false
            guard isCurrent(selection, generation: generation) else { return }
            if acceptedByCore {
                publishLoroClosed("Your change was saved. Recover the saved editable version before editing again.", action: .recoverSavedRichEditableVersion, selection: selection, generation: generation)
                if pendingLoroNavigationDate != nil {
                    await continuePendingLoroNavigation(selection: selection, generation: generation)
                }
            } else {
                preserveLoroRichDraftFailure(frozen, message: "Could not save this rich edit: \(error)", action: .discardRichDraftAndReload, selection: selection, generation: generation)
            }
        }
    }

    private func scheduleSync(for selection: DailyNoteSelection, generation: Int) {
        guard isCurrentAutomergeEditable(selection, generation: generation) else { return }
        guard !navigationIntent.suppressesSync(for: selection.nodeId.rawValue) else { return }
        syncTasksByNodeId[selection.nodeId.rawValue]?.cancel()
        let task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, let self else { return }
            await self.runSync(for: selection, generation: generation)
        }
        syncTasksByNodeId[selection.nodeId.rawValue] = task
        if isCurrent(selection) { syncTask = task }
    }

    private func runSync(for selection: DailyNoteSelection, generation: Int) async {
        let previousOperation = nodeOperationTails[selection.nodeId.rawValue]
        let operation = Task { [weak self, previousOperation] in
            await previousOperation?.value
            guard !Task.isCancelled, let self else { return }
            guard self.isCurrentAutomergeEditable(selection, generation: generation) else { return }
            await self.performSync(for: selection, generation: generation)
        }
        nodeOperationTails[selection.nodeId.rawValue] = operation
        await operation.value
    }

    private func performSync(for selection: DailyNoteSelection, generation: Int) async {
        guard isCurrentAutomergeEditable(selection, generation: generation) else { return }
        status = .syncing
        do {
            let converged = try await pageOperations.syncAutomerge(nodeId: selection.nodeId, session: selection.session)
            guard isCurrentAutomergeEditable(selection, generation: generation) else { return }
            let richTextReadOnly = try await pageOperations.isAutomergeRichText(nodeId: selection.nodeId)
            guard isCurrentAutomergeEditable(selection, generation: generation) else { return }
            text = converged
            isRichTextReadOnly = richTextReadOnly
            pagePresentation = richTextReadOnly ? .automergeRichTextReadOnly : .automergeEditable
            status = .synced
        } catch {
            guard isCurrentAutomergeEditable(selection, generation: generation) else { return }
            status = .error(String(describing: error))
        }
    }

    // MARK: - Backlinks (mirrors `Backlinks.tsx`)

    public func reloadBacklinks() async {
        await reloadBacklinks(for: activeSelection)
    }

    private func reloadBacklinks(for selection: DailyNoteSelection) async {
        do {
            let edges = try await readClient.listBacklinks(nodeId: selection.nodeId.rawValue)
            var rows: [BacklinkRow] = []
            for edge in edges {
                let node = try await readClient.getNode(nodeId: edge.sourceNodeId)
                rows.append(BacklinkRow(id: edge.id, sourceNodeId: edge.sourceNodeId, sourceTitle: node.title))
            }
            guard isCurrent(selection) else { return }
            backlinks = rows
            hasLoadedBacklinks = true
        } catch {
            // Backlinks are a secondary section — a failure here shouldn't blank out an
            // already-loaded daily note, so it's logged via `linkError` rather than `status`.
            guard isCurrent(selection) else { return }
            linkError = Self.backlinksLoadFailureMessage(for: error)
        }
    }

    static func backlinksLoadFailureMessage(for _: Error) -> String {
        "Backlinks couldn’t be loaded right now. Reopen this note to check them again."
    }

    /// An unknown or failed backlinks read must not be represented as a successful empty list.
    static func shouldShowEmptyBacklinks(
        isEmpty: Bool,
        hasLoadedBacklinks: Bool,
        errorMessage: String?
    ) -> Bool {
        isEmpty && hasLoadedBacklinks && errorMessage == nil
    }

    static func shouldShowBacklinksLoading(
        hasLoadedBacklinks: Bool,
        errorMessage: String?
    ) -> Bool {
        !hasLoadedBacklinks && errorMessage == nil
    }

    /// Mirrors `Backlinks.tsx`'s "+ Create + link" affordance: lazily create/reuse one "mentions"
    /// relation definition for this workspace (mirrors `mentions-relation.ts`'s
    /// `ensureMentionsRelationDefinition`, cached in `UserDefaults` instead of `localStorage`),
    /// create a new node with the entered title, and link it to the selected daily note as a backlink.
    public func createAndLinkBacklink() async {
        let title = newBacklinkTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        let selection = activeSelection
        let operationKey = "\(selection.nodeId.rawValue)\u{001F}\(title)"
        let operation: BacklinkOperation
        if let pending = pendingBacklinkOperations[operationKey] {
            operation = pending
        } else {
            let next = BacklinkOperation(
                title: title,
                targetNodeId: selection.nodeId,
                nodeId: try! EntityId(validating: UUID().uuidString.lowercased()),
                nodeRequestId: UUID().uuidString.lowercased(),
                edgeRequestId: UUID().uuidString.lowercased()
            )
            pendingBacklinkOperations[operationKey] = next
            operation = next
        }
        isLinkingBacklink = true
        linkError = nil
        defer {
            if isCurrent(selection) {
                isLinkingBacklink = false
            }
        }

        do {
            let relationDefinitionId = try await ensureMentionsRelationDefinition()
            let node = try await syncClient.createNodeWithIntent(
                title: operation.title,
                id: operation.nodeId,
                requestId: operation.nodeRequestId,
                commitMessage: "Create the node before linking it from this daily note.",
                attribution: MutationAttribution(kind: "humanUi", surface: "macos")
            )
            _ = try await syncClient.createEdge(
                relationDefinitionId: relationDefinitionId,
                sourceNodeId: node.id,
                targetNodeId: operation.targetNodeId,
                requestId: operation.edgeRequestId,
                commitMessage: "Link the new note to this daily note.",
                attribution: MutationAttribution(kind: "humanUi", surface: "macos")
            )
            pendingBacklinkOperations.removeValue(forKey: operationKey)
            guard isCurrent(selection) else { return }
            newBacklinkTitle = ""
            await reloadBacklinks(for: selection)
        } catch {
            if isCurrent(selection) {
                linkError = Self.backlinkCreationFailureMessage(for: error)
            }
        }
    }

    /// A failed response may follow a server-side node or edge mutation, so retain the title and
    /// direct the user to review the current backlinks instead of implying a safe blind retry.
    static func backlinkCreationFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the backlink was created. Your title is still here. Review backlinks before taking another action."
    }

    private func ensureMentionsRelationDefinition() async throws -> EntityId {
        let key = "athenaeum.mentionsRelationDefinitionId.\(workspaceId.rawValue)"
        let pendingKey = "athenaeum.pendingMentionsRelationDefinition.\(workspaceId.rawValue)"
        if let cached = UserDefaults.standard.string(forKey: key), let id = try? EntityId(validating: cached) {
            return id
        }
        let requestId: String
        if let pending = UserDefaults.standard.dictionary(forKey: pendingKey),
           pending["forwardName"] as? String == "mentions",
           pending["inverseName"] as? String == "mentioned by",
           pending["sourceTagId"] as? String == BaseTagIds.project.rawValue,
           pending["targetTagId"] as? String == BaseTagIds.project.rawValue,
           pending["cardinality"] as? String == "many-to-many",
           let pendingRequestId = pending["requestId"] as? String,
           !pendingRequestId.isEmpty,
           pendingRequestId.count <= 200 {
            requestId = pendingRequestId
        } else {
            requestId = UUID().uuidString.lowercased()
        }
        UserDefaults.standard.set([
            "forwardName": "mentions", "inverseName": "mentioned by",
            "sourceTagId": BaseTagIds.project.rawValue, "targetTagId": BaseTagIds.project.rawValue,
            "cardinality": "many-to-many", "requestId": requestId
        ], forKey: pendingKey)
        let relationDefinition = try await readClient.createRelationDefinition(
            forwardName: "mentions", inverseName: "mentioned by",
            sourceTagId: BaseTagIds.project.rawValue, targetTagId: BaseTagIds.project.rawValue,
            cardinality: "many-to-many", requestId: requestId,
            commitMessage: "Ensure the workspace mention relation exists.",
            attribution: MutationAttribution(kind: "humanUi", surface: "macos")
        )
        guard let validatedId = try? EntityId(validating: relationDefinition.id) else {
            throw CapnWebError.malformedMessage("createRelationDefinition response contained an invalid relation id")
        }
        UserDefaults.standard.set(validatedId.rawValue, forKey: key)
        UserDefaults.standard.removeObject(forKey: pendingKey)
        return validatedId
    }

    // MARK: - Graph view (mirrors `GraphView.tsx`)

    public func reloadGraphView() async {
        let requestedOnlyPerson = onlyPerson
        let token = reserveGraphRead()
        await reloadGraphView(onlyPerson: requestedOnlyPerson, token: token)
    }

    /// Starts a graph read only after its filter and ownership token were synchronously reserved.
    /// The transport may finish in any order, but only the still-current token can settle UI state.
    private func reloadGraphView(onlyPerson requestedOnlyPerson: Bool, token: Int) async {
        defer { graphReadCompletionObserver?() }
        let viewSpec = Self.graphNodesViewSpec(onlyPerson: requestedOnlyPerson)
        do {
            let rows = try await readClient.runView(viewName: "graph_nodes", viewSpec: viewSpec)
            let decodedRows = try rows.map { row in
                guard let id = try row.field("id").stringValue,
                      let title = try row.field("title").stringValue,
                      let createdAt = try row.field("createdAt").stringValue
                else { throw CapnWebError.malformedMessage("malformed graph_nodes row: \(row)") }
                return GraphNodeRow(id: id, title: title, createdAt: createdAt)
            }
            guard token == graphReadGeneration else { return }
            graphRows = decodedRows
            hasLoadedGraph = true
            graphRowsOnlyPerson = requestedOnlyPerson
            graphLoadErrorMessage = nil
            isLoadingGraph = false
        } catch {
            guard token == graphReadGeneration else { return }
            graphLoadErrorMessage = Self.graphLoadFailureMessage(for: error)
            isLoadingGraph = false
        }
    }

    /// Reserve before launching any task so an older unstructured task cannot inherit a newer
    /// filter intent when it eventually begins. Overflow is intentionally defined as wraparound;
    /// only equality against the most recently reserved token matters.
    private func reserveGraphRead() -> Int {
        graphReadGeneration &+= 1
        isLoadingGraph = true
        graphLoadErrorMessage = nil
        return graphReadGeneration
    }

    /// The graph is a read-only browse surface. Transport and server details do not help a user
    /// recover, so keep them out of the UI and offer only a safe re-read of the existing view.
    static func graphLoadFailureMessage(for _: Error) -> String {
        "The node list could not be loaded. Nothing has been changed. Retry to check it again."
    }

    static func canRetryGraphLoad(errorMessage: String?, isLoadingGraph: Bool) -> Bool {
        errorMessage != nil && !isLoadingGraph
    }

    /// An empty graph is meaningful only after a successful read. Before then, or following a
    /// failed read, the result set is unknown and must not be presented as an empty workspace.
    static func shouldShowEmptyGraph(
        isEmpty: Bool,
        hasLoadedGraph: Bool,
        graphRowsOnlyPerson: Bool?,
        onlyPerson: Bool,
        isLoadingGraph: Bool,
        errorMessage: String?
    ) -> Bool {
        isEmpty &&
            hasLoadedGraph &&
            graphRowsOnlyPerson == onlyPerson &&
            !isLoadingGraph &&
            errorMessage == nil
    }

    static func shouldShowGraphLoading(
        hasLoadedGraph: Bool,
        graphRowsOnlyPerson: Bool?,
        onlyPerson: Bool,
        isLoadingGraph: Bool,
        errorMessage: String?
    ) -> Bool {
        isLoadingGraph ||
            ((!hasLoadedGraph || graphRowsOnlyPerson != onlyPerson) && errorMessage == nil)
    }

    static func shouldShowCachedGraphRows(
        isEmpty: Bool,
        hasLoadedGraph: Bool,
        graphRowsOnlyPerson: Bool?,
        onlyPerson: Bool
    ) -> Bool {
        !isEmpty && hasLoadedGraph && graphRowsOnlyPerson == onlyPerson
    }

    public func assignPersonTag(nodeId: String) async {
        graphPersonTagError = nil
        do {
            try await readClient.assignTag(
                nodeId: nodeId,
                tagId: BaseTagIds.person.rawValue,
                requestId: UUID().uuidString.lowercased(),
                commitMessage: "Mark this graph entity as a person.",
                attribution: MutationAttribution(kind: "humanUi", surface: "macos")
            )
            await reloadGraphView()
        } catch {
            graphPersonTagError = Self.graphPersonTagFailureMessage(for: error)
        }
    }

    /// A failed assignment response does not establish whether the mutation reached the server.
    /// Keep its transport detail out of both the Graph and unrelated Backlinks surfaces.
    static func graphPersonTagFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that this entity was tagged Person. Review the graph before taking another action."
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

    static func dailyNoteTagMembershipViewSpec(nodeId: EntityId) -> CapnWebValue {
        .object([
            "filter": .object([
                "op": .string("eq"),
                "field": .object(["kind": .string("column"), "column": .string("nodeId")]),
                "value": .string(nodeId.rawValue)
            ]),
            "view": .string("table"),
            "visibleColumns": .array([.string("nodeId"), .string("tagId")]),
            "rowLimit": .int(100)
        ])
    }

    /// `graph_facts.value` is intentionally requested as raw JSON text. The capture decoder is
    /// the one typed recovery point, matching the Web field popover and keeping fact identity in
    /// the same server-owned read model used for replacement/upsert decisions.
    static func dailyNoteInlineSupertagFactsViewSpec(nodeId: EntityId) -> CapnWebValue {
        .object([
            "filter": .object([
                "op": .string("eq"),
                "field": .object(["kind": .string("column"), "column": .string("nodeId")]),
                "value": .string(nodeId.rawValue)
            ]),
            "view": .string("table"),
            "visibleColumns": .array([.string("id"), .string("nodeId"), .string("predicateId"), .string("value")]),
            "rowLimit": .int(500)
        ])
    }
}
