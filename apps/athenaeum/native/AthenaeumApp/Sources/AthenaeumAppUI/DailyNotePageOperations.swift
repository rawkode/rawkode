import Foundation
import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

/// AppUI's intentionally content-free representation of a native Loro page.  Mapping this at
/// the adapter boundary keeps Core transport details out of SwiftUI and permits deterministic
/// UI fakes without inventing a document projection.
public struct DailyNoteLoroReadOnlyState: Equatable {
    public let format: PageDocumentFormat
    public let schemaVersion: Int
    public let isDirty: Bool

    init(_ projection: LoroPageReadOnlyProjection) {
        format = projection.format
        schemaVersion = projection.schemaVersion
        isDirty = projection.isDirty
    }

    public init(format: PageDocumentFormat, schemaVersion: Int, isDirty: Bool) {
        self.format = format
        self.schemaVersion = schemaVersion
        self.isDirty = isDirty
    }
}

public struct DailyNoteLoroProjectionState: Equatable {
    public let projection: LoroPageProjection
    public init(_ projection: LoroPageProjection) { self.projection = projection }
}

/// A server-owned view of a pre-migration page. Native can render only a server-proven plain
/// text projection and retains the descriptor witness; unsupported legacy content carries no
/// lossy text into AppUI.
public struct DailyNoteLegacyReadOnlyState: Equatable, Sendable {
    public let content: LegacyPageProjectionContent
    public let descriptor: PageDocumentDescriptor
    public let readOnly: Bool
    public let migrationRequired: Bool

    public init(content: LegacyPageProjectionContent, descriptor: PageDocumentDescriptor, readOnly: Bool = true, migrationRequired: Bool = true) {
        self.content = content
        self.descriptor = descriptor
        self.readOnly = readOnly
        self.migrationRequired = migrationRequired
    }

    /// Deterministic test-double convenience. Production constructs this from the tagged RPC
    /// content, never from a raw legacy document.
    public init(text: String, descriptor: PageDocumentDescriptor, readOnly: Bool = true, migrationRequired: Bool = true) {
        self.init(content: .plainText(text), descriptor: descriptor, readOnly: readOnly, migrationRequired: migrationRequired)
    }
}

enum DailyNotePageOperationError: Error, Equatable {
    case invalidLegacyProjection(EntityId)
    case legacyLocalRecoveryRequired(EntityId)
    case legacyPageReadOnly(EntityId)
    /// A server-owned mutation may only run after the active Loro editor has transferred
    /// custody. Keeping this error at the adapter seam lets the view model fail closed without
    /// exposing a transport error or accidentally falling back to a legacy write path.
    case externalMutationUnavailable(EntityId)
}

/// Narrow, app-local seam for Daily Note document lifecycle.  It deliberately exposes no
/// cross-format "best effort" operation: the view model must choose a format from a descriptor.
@MainActor
protocol DailyNotePageOperations: AnyObject {
    func resolveNode(id: EntityId, title: String) async throws
    func descriptor(nodeId: EntityId) async throws -> PageDocumentDescriptor
    func resolveOrCreateLoro(nodeId: EntityId, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor
    func hasLocalLoroPage(nodeId: EntityId) async throws -> Bool
    func legacyPageProjection(nodeId: EntityId, descriptor: PageDocumentDescriptor, session: SyncSessionHandle) async throws -> DailyNoteLegacyReadOnlyState
    func hasDirtyLocalAutomerge(nodeId: EntityId) async throws -> Bool
    func localAutomergeHeads(nodeId: EntityId) async throws -> String?
    func loadedAutomergeHeads(nodeId: EntityId) async throws -> String?
    func resolveOrCreateAutomerge(nodeId: EntityId, session: SyncSessionHandle) async throws -> String
    func syncAutomerge(nodeId: EntityId, session: SyncSessionHandle) async throws -> String
    func isAutomergeRichText(nodeId: EntityId) async throws -> Bool
    func applyAutomergeSplice(nodeId: EntityId, index: Int, deleteCount: Int, insertText: String) async throws
    func syncLoroReadOnly(nodeId: EntityId) async throws -> DailyNoteLoroReadOnlyState
    func syncLoroProjection(nodeId: EntityId) async throws -> DailyNoteLoroProjectionState
    func recoverInFlightLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution
    func retryRetainedLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution
    func loroNativePlainEditorEligibility(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility
    func recoverAcceptedLoroLiteralForEditing(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility
    func submitNativePlainText(nodeId: EntityId, base: LoroNativePlainEditorState, proposedText: String) async throws -> LoroNativePlainTextSubmissionDisposition
    /// Value-only rich lifecycle seam. Core retains CRDT bytes, request identity and attribution.
    func loroNativeRichEditorEligibility(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility
    func recoverAcceptedLoroRichLiteralForEditing(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility
    func submitNativeRichDocumentV1(nodeId: EntityId, base: LoroNativeRichEditorState, proposed: LoroNativeRichDocumentV1, commitMessage: String) async throws -> LoroNativeRichDocumentSubmissionDisposition
    func submitNativeRichTaskItemToggle(nodeId: EntityId, base: LoroNativeRichEditorState, command: LoroNativeRichTaskItemToggleCommand, commitMessage: String, surface: NativeRichTaskItemToggleSurface) async throws -> LoroNativeRichDocumentSubmissionDisposition
    func prepareMeetingInDailyNote(_ input: PrepareMeetingInDailyNoteInput) async throws -> PrepareMeetingInDailyNoteOutput
}

extension DailyNotePageOperations {
    /// Compatibility default for deterministic UI fakes. Production overrides this with the
    /// server-owned projection RPC; the fallback still keeps the legacy seam read-only at the
    /// presentation boundary and never exposes document bytes to AppUI.
    func legacyPageProjection(nodeId: EntityId, descriptor: PageDocumentDescriptor, session: SyncSessionHandle) async throws -> DailyNoteLegacyReadOnlyState {
        let text = try await resolveOrCreateAutomerge(nodeId: nodeId, session: session)
        guard case .legacy = descriptor else { throw DailyNotePageOperationError.invalidLegacyProjection(nodeId) }
        return DailyNoteLegacyReadOnlyState(text: text, descriptor: descriptor)
    }

    /// Test doubles that do not model the legacy local cache are clean by default.  The live
    /// adapter overrides this with the SQLite dirty bit so a compatibility projection can never
    /// silently hide an un-synced native edit.
    func hasDirtyLocalAutomerge(nodeId: EntityId) async throws -> Bool { false }

    /// Deterministic fakes that do not model the server-owned Today Brief mutation remain
    /// fail-closed. The live adapter below is the only production implementation; no test seam
    /// can silently turn an external mutation into a local or legacy write.
    func prepareMeetingInDailyNote(_ input: PrepareMeetingInDailyNoteInput) async throws -> PrepareMeetingInDailyNoteOutput {
        throw DailyNotePageOperationError.externalMutationUnavailable(input.dailyNoteId)
    }

    /// Deterministic fakes that do not model the server-owned checklist mutation remain
    /// fail-closed. The live adapter below is the only production implementation.
    func submitNativeRichTaskItemToggle(nodeId: EntityId, base: LoroNativeRichEditorState, command: LoroNativeRichTaskItemToggleCommand, commitMessage: String, surface: NativeRichTaskItemToggleSurface) async throws -> LoroNativeRichDocumentSubmissionDisposition {
        throw DailyNotePageOperationError.externalMutationUnavailable(nodeId)
    }
}

@MainActor
final class LiveDailyNotePageOperations: DailyNotePageOperations {
    private let localStore: LocalWorkspaceStore
    private let syncClient: WorkspaceSyncClient
    private let readClient: WorkspaceRPCClient
    /// One caller-owned node intent per deterministic daily-note identity. Keeping this alongside
    /// the page intent prevents a retry from minting a second node ledger command.
    private var nodeCreationIntents: [String: CreationIntent] = [:]

    init(localStore: LocalWorkspaceStore, syncClient: WorkspaceSyncClient, readClient: WorkspaceRPCClient) {
        self.localStore = localStore
        self.syncClient = syncClient
        self.readClient = readClient
    }

    func resolveNode(id: EntityId, title: String) async throws {
        let intent: CreationIntent
        if let existing = nodeCreationIntents[id.rawValue] {
            intent = existing
        } else {
            let created = CreationIntent(
                requestId: UUID().uuidString.lowercased(),
                commitMessage: "Create the daily note entity.",
                attribution: MutationAttribution(kind: "humanUi", surface: "macos")
            )
            nodeCreationIntents[id.rawValue] = created
            intent = created
        }
        _ = try await syncClient.resolveOrCreateNode(id: id, title: title, creationIntent: intent)
    }
    func descriptor(nodeId: EntityId) async throws -> PageDocumentDescriptor { try await readClient.getPageDocumentDescriptor(nodeId: nodeId.rawValue) }
    func resolveOrCreateLoro(nodeId: EntityId, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor {
        do {
            return try await readClient.getPageDocumentDescriptor(nodeId: nodeId.rawValue)
        } catch AthenaeumDomainError.pageNotFound {
            return try await readClient.createLoroPage(nodeId: nodeId.rawValue, creationIntent: creationIntent)
        }
    }
    func hasLocalLoroPage(nodeId: EntityId) async throws -> Bool { try await localStore.loroPage(nodeId: nodeId) != nil }
    func hasDirtyLocalAutomerge(nodeId: EntityId) async throws -> Bool { try await localStore.isPageDirty(nodeId: nodeId) }
    func localAutomergeHeads(nodeId: EntityId) async throws -> String? { try await localStore.page(nodeId: nodeId)?.headsHash }
    func loadedAutomergeHeads(nodeId: EntityId) async throws -> String? {
        // The shipped app never decodes legacy snapshots. The durable SQLite row above is the
        // complete local-legacy witness; an in-memory Automerge replica cannot exist here.
        nil
    }
    func legacyPageProjection(nodeId: EntityId, descriptor: PageDocumentDescriptor, session: SyncSessionHandle) async throws -> DailyNoteLegacyReadOnlyState {
        let projection = try await readClient.getLegacyPageProjection(nodeId: nodeId.rawValue)
        guard projection.descriptor == descriptor else { throw DailyNotePageOperationError.invalidLegacyProjection(nodeId) }
        guard case .legacy(_, let storageVersion, let automerge) = projection.descriptor else {
            throw DailyNotePageOperationError.invalidLegacyProjection(nodeId)
        }
        switch try await localStore.persistLegacyProjectionWitness(
            nodeId: nodeId,
            storageVersion: storageVersion,
            docId: automerge.docId,
            headsHash: automerge.headsHash,
            bytesSha256: automerge.bytesSha256
        ) {
        case .persisted, .alreadyPersisted:
            break
        case .recoveryRequired:
            throw DailyNotePageOperationError.legacyLocalRecoveryRequired(nodeId)
        }
        return DailyNoteLegacyReadOnlyState(
            content: projection.content,
            descriptor: projection.descriptor,
            readOnly: projection.readOnly,
            migrationRequired: projection.migrationRequired
        )
    }
    func resolveOrCreateAutomerge(nodeId: EntityId, session: SyncSessionHandle) async throws -> String {
        let descriptor = try await readClient.getPageDocumentDescriptor(nodeId: nodeId.rawValue)
        let state = try await legacyPageProjection(nodeId: nodeId, descriptor: descriptor, session: session)
        guard case .plainText(let text) = state.content else { throw DailyNotePageOperationError.invalidLegacyProjection(nodeId) }
        return text
    }
    func syncAutomerge(nodeId: EntityId, session: SyncSessionHandle) async throws -> String {
        let descriptor = try await readClient.getPageDocumentDescriptor(nodeId: nodeId.rawValue)
        let state = try await legacyPageProjection(nodeId: nodeId, descriptor: descriptor, session: session)
        guard case .plainText(let text) = state.content else { throw DailyNotePageOperationError.invalidLegacyProjection(nodeId) }
        return text
    }
    /// Native no longer decodes legacy Automerge snapshots. The projection is always read-only;
    /// this compatibility flag keeps the existing view-model route and test seam source-stable.
    func isAutomergeRichText(nodeId: EntityId) async throws -> Bool { true }
    func applyAutomergeSplice(nodeId: EntityId, index: Int, deleteCount: Int, insertText: String) async throws {
        throw DailyNotePageOperationError.legacyPageReadOnly(nodeId)
    }
    func syncLoroReadOnly(nodeId: EntityId) async throws -> DailyNoteLoroReadOnlyState { DailyNoteLoroReadOnlyState(try await syncClient.syncLoroPageReadOnly(nodeId: nodeId)) }
    func syncLoroProjection(nodeId: EntityId) async throws -> DailyNoteLoroProjectionState { DailyNoteLoroProjectionState(try await syncClient.syncLoroPageProjectionReadOnly(nodeId: nodeId)) }
    func recoverInFlightLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution { try await syncClient.recoverInFlightLoroSemanticCheckpoint(nodeId: nodeId) }
    func retryRetainedLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution { try await syncClient.retryRetainedLoroSemanticCheckpoint(nodeId: nodeId) }
    func loroNativePlainEditorEligibility(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility { try await syncClient.loroNativePlainEditorEligibility(nodeId: nodeId) }
    func recoverAcceptedLoroLiteralForEditing(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility { try await syncClient.recoverAcceptedLoroLiteralForEditing(nodeId: nodeId) }
    func submitNativePlainText(nodeId: EntityId, base: LoroNativePlainEditorState, proposedText: String) async throws -> LoroNativePlainTextSubmissionDisposition { try await syncClient.submitNativePlainText(nodeId: nodeId, base: base, proposedText: proposedText) }
    func loroNativeRichEditorEligibility(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility { try await syncClient.loroNativeRichEditorEligibility(nodeId: nodeId) }
    func recoverAcceptedLoroRichLiteralForEditing(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility { try await syncClient.recoverAcceptedLoroRichLiteralForEditing(nodeId: nodeId) }
    func submitNativeRichDocumentV1(nodeId: EntityId, base: LoroNativeRichEditorState, proposed: LoroNativeRichDocumentV1, commitMessage: String) async throws -> LoroNativeRichDocumentSubmissionDisposition { try await syncClient.submitNativeRichDocumentV1(nodeId: nodeId, base: base, proposed: proposed, commitMessage: commitMessage) }
    func submitNativeRichTaskItemToggle(nodeId: EntityId, base: LoroNativeRichEditorState, command: LoroNativeRichTaskItemToggleCommand, commitMessage: String, surface: NativeRichTaskItemToggleSurface) async throws -> LoroNativeRichDocumentSubmissionDisposition { try await syncClient.submitNativeRichTaskItemToggle(nodeId: nodeId, base: base, command: command, commitMessage: commitMessage, surface: surface) }
    func prepareMeetingInDailyNote(_ input: PrepareMeetingInDailyNoteInput) async throws -> PrepareMeetingInDailyNoteOutput {
        try await readClient.prepareMeetingInDailyNote(input)
    }
}
