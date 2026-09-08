import SwiftUI
import AthenaeumDomain
import AthenaeumRPC

struct PendingSupertagIntent: Equatable {
    let name: String
    let parentIds: [String]
    let requestId: String
    let rationale: String
    let attribution: MutationAttribution
}

/// Frozen at the moment the user chooses to define a field. Retrying must replay this exact
/// semantic operation rather than silently adopting a changed selection or draft.
struct PendingTagFieldIntent: Equatable {
    let tagId: String
    let name: String
    let valueKind: RPCTagFieldValueKind
    let sortOrder: Int
    let requestId: String
    let rationale: String
    let attribution: MutationAttribution
}

/// Immutable CAS command; retries are legal only while every semantic field is identical.
struct PendingTagUpdateIntent: Equatable {
    let tagId: String
    let expectedRevision: String
    let name: String
    let parentIds: [String]
    let requestId: String
    let commitMessage: String
    let attribution: MutationAttribution

    var signature: String {
        let values = [tagId, expectedRevision, name] + parentIds + [commitMessage, attribution.version, attribution.kind, attribution.surface ?? "", attribution.jobId ?? "", attribution.runId ?? "", attribution.source ?? ""]
        return values.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
    }
}

struct SupertagEditDraft: Equatable {
    var revision: String
    var name: String
    /// Server order is semantic. Preserve it exactly; newly selected parents append in the
    /// deterministic catalog order in which the user chose them.
    var selectedParentIds: [String]
}

@MainActor
protocol SupertagsCatalogTransport {
    func listTags() async throws -> [RPCTag]
    func listTagFields(tagId: String) async throws -> [RPCResolvedTagField]
    func createTag(intent: PendingSupertagIntent) async throws -> RPCTag
    func getTag(tagId: String) async throws -> RPCTagRead
    func updateTag(intent: PendingTagUpdateIntent) async throws -> RPCTagRead
    func defineTagField(intent: PendingTagFieldIntent) async throws -> RPCTagFieldDefinition
}

private struct WorkspaceSupertagsCatalogTransport: SupertagsCatalogTransport {
    let client: WorkspaceRPCClient

    func listTags() async throws -> [RPCTag] {
        try await client.listTags()
    }

    func listTagFields(tagId: String) async throws -> [RPCResolvedTagField] {
        try await client.listTagFields(tagId: tagId)
    }

    func createTag(intent: PendingSupertagIntent) async throws -> RPCTag {
        try await client.createTag(
            name: intent.name,
            parentIds: intent.parentIds,
            requestId: intent.requestId,
            commitMessage: intent.rationale,
            attribution: intent.attribution
        )
    }

    func getTag(tagId: String) async throws -> RPCTagRead { try await client.getTag(tagId: tagId) }

    func updateTag(intent: PendingTagUpdateIntent) async throws -> RPCTagRead {
        try await client.updateTag(tagId: intent.tagId, expectedRevision: intent.expectedRevision, name: intent.name, parentIds: intent.parentIds, requestId: intent.requestId, commitMessage: intent.commitMessage, attribution: intent.attribution)
    }

    func defineTagField(intent: PendingTagFieldIntent) async throws -> RPCTagFieldDefinition {
        try await client.defineTagField(tagId: intent.tagId, name: intent.name, valueKind: intent.valueKind, sortOrder: intent.sortOrder, requestId: intent.requestId, commitMessage: intent.rationale, attribution: intent.attribution)
    }
}

/// Native type-system browser and root-tag creator/field definer.
@MainActor
final class SupertagsViewModel: ObservableObject {
    @Published private(set) var tags: [RPCTag] = []
    @Published private(set) var hasLoadedTags = false
    /// Last successful server snapshots. A receipt never becomes a snapshot: until this is true,
    /// the form remains disabled and no follow-on write can be derived from stale data.
    @Published private(set) var fieldsByTagId: [String: [RPCResolvedTagField]] = [:]
    @Published private(set) var hasSuccessfulFieldSnapshotTagIds: Set<String> = []
    @Published private(set) var fieldsLoadingTagIds: Set<String> = []
    @Published private(set) var fieldErrorsByTagId: [String: String] = [:]
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var isCreating = false
    @Published private(set) var creationErrorMessage: String?
    @Published private(set) var pendingCreationIntent: PendingSupertagIntent?
    @Published private(set) var isDefiningField = false
    @Published private(set) var fieldDefinitionErrorMessage: String?
    @Published private(set) var pendingFieldDefinitionIntent: PendingTagFieldIntent?
    @Published private(set) var editDraft: SupertagEditDraft?
    @Published private(set) var isLoadingEditBaseline = false
    @Published private(set) var isSavingEdit = false
    @Published private(set) var editErrorMessage: String?
    @Published private(set) var pendingTagUpdateIntent: PendingTagUpdateIntent?

    private let transport: any SupertagsCatalogTransport
    /// A create receipt is stronger evidence than a stale catalog projection. There is no delete
    /// route in this surface, so retain confirmed tags for this view-model's lifetime.
    private var confirmedCreatedTagsById: [String: RPCTag] = [:]
    /// Accepted receipts are durable model-lifetime custody, merged over later stale reads.
    private var confirmedDefinedFieldsByTagId: [String: [String: RPCResolvedTagField]] = [:]
    private var fieldReadGenerationByTagId: [String: UUID] = [:]
    private var confirmedUpdatedTagsById: [String: RPCTag] = [:]
    private var editGeneration = 0
    private var editSelectedTagId: String?

    init(backendURL: URL, workspaceId: EntityId, bearerCredential: String?) {
        let workspaceURL = backendURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.transport = WorkspaceSupertagsCatalogTransport(
            client: WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
        )
    }

    init(transport: any SupertagsCatalogTransport) {
        self.transport = transport
    }

    func refresh(preserving confirmedTag: RPCTag? = nil) async {
        if let confirmedTag { confirmedCreatedTagsById[confirmedTag.id] = confirmedTag }
        isLoading = true
        defer { isLoading = false }
        do {
            let catalog = try await transport.listTags()
            tags = Self.mergingConfirmedTags(Array(confirmedTagsById.values), into: catalog)
            hasLoadedTags = true
            errorMessage = nil
            if let editSelectedTagId, !tags.contains(where: { $0.id == editSelectedTagId }) {
                cancelEditing()
            }
        } catch {
            errorMessage = confirmedTag == nil && confirmedTagsById.isEmpty
                ? Self.catalogLoadFailureMessage(for: error)
                : Self.catalogReconciliationFailureMessage(for: error)
        }
    }

    /// Catalog read failures can contain backend or credential-adjacent detail. Keep the existing
    /// refresh, selection, and field state available without treating an unavailable catalog as empty.
    static func catalogLoadFailureMessage(for _: Error) -> String {
        "Supertags couldn’t be loaded. Nothing has been changed. Refresh to check the catalog again."
    }

    static func catalogReconciliationFailureMessage(for _: Error) -> String {
        "A Supertag was changed, but the catalog couldn’t be refreshed. Refresh later to check the catalog."
    }

    func refreshFields(for tagId: String, force: Bool = false) async {
        guard force || !fieldsLoadingTagIds.contains(tagId) else { return }
        let generation = UUID()
        fieldReadGenerationByTagId[tagId] = generation
        fieldsLoadingTagIds.insert(tagId)
        fieldErrorsByTagId[tagId] = nil

        do {
            let snapshot = try await transport.listTagFields(tagId: tagId)
            guard fieldReadGenerationByTagId[tagId] == generation else { return }
            fieldsByTagId[tagId] = snapshot
            hasSuccessfulFieldSnapshotTagIds.insert(tagId)
            fieldErrorsByTagId[tagId] = nil
        } catch {
            guard fieldReadGenerationByTagId[tagId] == generation else { return }
            fieldErrorsByTagId[tagId] = Self.fieldLoadFailureMessage(for: error)
        }
        guard fieldReadGenerationByTagId[tagId] == generation else { return }
        fieldsLoadingTagIds.remove(tagId)
    }

    /// Field reads can contain backend or credential-adjacent detail. The selected tag and its
    /// existing refresh path remain available without exposing that detail.
    static func fieldLoadFailureMessage(for _: Error) -> String {
        "Fields couldn’t be loaded. Nothing has been changed. Retry these fields or refresh the catalog."
    }

    /// A per-tag retry is meaningful only for the current tag and must not compete with its
    /// existing in-flight field request.
    static func canRetryFields(tagId: String?, isLoadingFields: Bool) -> Bool {
        tagId != nil && !isLoadingFields
    }

    /// A catalog is empty only after a confirmed, idle, successful read. Until then the catalog
    /// remains unknown and must not direct someone to create a tag they may already have.
    static func shouldShowEmptyCatalog(
        isEmpty: Bool,
        hasLoadedTags: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        isEmpty && hasLoadedTags && !isLoading && errorMessage == nil
    }

    /// Preserve a successful catalog through later refreshes. Only the first unresolved catalog
    /// read takes over the content area with a loading presentation.
    static func shouldShowCatalogLoading(
        hasLoadedTags: Bool,
        isLoading: Bool,
        errorMessage: String?
    ) -> Bool {
        !hasLoadedTags && (isLoading || errorMessage == nil)
    }

    static func sortedTags(_ tags: [RPCTag]) -> [RPCTag] {
        tags.sorted { left, right in
            if left.builtin != right.builtin { return left.builtin && !right.builtin }
            return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
        }
    }

    /// A confirmed create receipt is authoritative for this screen even if its following catalog
    /// read fails or is temporarily stale. Prefer the receipt when ids collide.
    static func mergingConfirmedTags(_ confirmedTags: [RPCTag], into catalog: [RPCTag]) -> [RPCTag] {
        let confirmedIds = Set(confirmedTags.map(\.id))
        return sortedTags(confirmedTags + catalog.filter { !confirmedIds.contains($0.id) })
    }

    static func canonicalizedDraft(_ raw: String) -> String {
        normalizeTagNameV1(raw)
    }

    func beginEditing(tagId: String) async {
        guard !isLoadingEditBaseline, !isSavingEdit,
              let tag = tag(withId: tagId), !tag.builtin else { return }
        editGeneration &+= 1
        let generation = editGeneration
        editSelectedTagId = tagId
        isLoadingEditBaseline = true
        editErrorMessage = nil
        do {
            let read = try await transport.getTag(tagId: tagId)
            guard generation == editGeneration, editSelectedTagId == tagId,
                  read.tag.id == tagId, !read.tag.builtin else {
                if generation == editGeneration { isLoadingEditBaseline = false; editErrorMessage = "We couldn’t load the latest schema. Retry before editing." }
                return
            }
            editDraft = SupertagEditDraft(revision: read.revision, name: read.tag.name, selectedParentIds: read.tag.parentIds)
            pendingTagUpdateIntent = nil
        } catch {
            guard generation == editGeneration, editSelectedTagId == tagId else { return }
            editErrorMessage = "We couldn’t load the latest schema. Retry before editing."
        }
        guard generation == editGeneration, editSelectedTagId == tagId else { return }
        isLoadingEditBaseline = false
    }

    func cancelEditing() {
        editGeneration &+= 1
        editSelectedTagId = nil
        editDraft = nil
        pendingTagUpdateIntent = nil
        editErrorMessage = nil
        isLoadingEditBaseline = false
        // The transport request may still complete, but its generation is now stale and its
        // receipt is deliberately ignored. Do not leave the model permanently locked after a
        // user cancels or a catalog refresh removes the selected tag.
        isSavingEdit = false
    }

    func updateEditDraft(name: String? = nil, parentId: String? = nil) {
        guard var draft = editDraft, !isSavingEdit else { return }
        if let name { draft.name = name }
        if let parentId {
            if let index = draft.selectedParentIds.firstIndex(of: parentId) { draft.selectedParentIds.remove(at: index) }
            else { draft.selectedParentIds.append(parentId) }
        }
        // A changed semantic command must never inherit an uncertain response's request id.
        if let pendingTagUpdateIntent,
           pendingTagUpdateIntent.signature != updateSignature(tagId: pendingTagUpdateIntent.tagId, draft: draft) {
            self.pendingTagUpdateIntent = nil
        }
        editDraft = draft
    }

    func reloadEditBaselinePreservingDraft() async {
        guard let tagId = editSelectedTagId, let draft = editDraft, !isLoadingEditBaseline, !isSavingEdit else { return }
        editGeneration &+= 1
        let generation = editGeneration
        isLoadingEditBaseline = true
        do {
            let read = try await transport.getTag(tagId: tagId)
            guard generation == editGeneration, editSelectedTagId == tagId, read.tag.id == tagId, !read.tag.builtin else {
                if generation == editGeneration { isLoadingEditBaseline = false; editErrorMessage = "We couldn’t load the latest schema. Your draft is still here." }
                return
            }
            editDraft = SupertagEditDraft(revision: read.revision, name: draft.name, selectedParentIds: draft.selectedParentIds)
            pendingTagUpdateIntent = nil
            editErrorMessage = nil
        } catch {
            guard generation == editGeneration, editSelectedTagId == tagId else { return }
            editErrorMessage = "We couldn’t load the latest schema. Your draft is still here."
        }
        guard generation == editGeneration, editSelectedTagId == tagId else { return }
        isLoadingEditBaseline = false
    }

    func saveEdit(tagId: String, surface: String) async -> RPCTag? {
        guard !isSavingEdit, !isLoadingEditBaseline, editSelectedTagId == tagId,
              let current = tag(withId: tagId), !current.builtin, let draft = editDraft else { return nil }
        let name = Self.canonicalizedDraft(draft.name)
        guard !name.isEmpty else { return nil }
        let parents = orderedParents(for: draft, excluding: tagId)
        let signature = updateSignature(tagId: tagId, draft: SupertagEditDraft(revision: draft.revision, name: name, selectedParentIds: parents), surface: surface)
        let intent: PendingTagUpdateIntent
        if let pendingTagUpdateIntent, pendingTagUpdateIntent.signature == signature { intent = pendingTagUpdateIntent }
        else {
            intent = PendingTagUpdateIntent(tagId: tagId, expectedRevision: draft.revision, name: name, parentIds: parents, requestId: UUID().uuidString.lowercased(), commitMessage: "Update the \(name) Supertag schema.", attribution: MutationAttribution(kind: "humanUi", surface: surface))
            pendingTagUpdateIntent = intent
        }
        editGeneration &+= 1
        let generation = editGeneration
        isSavingEdit = true
        editErrorMessage = nil
        defer { if generation == editGeneration { isSavingEdit = false } }
        do {
            let receipt = try await transport.updateTag(intent: intent)
            guard generation == editGeneration, editSelectedTagId == tagId, Self.matches(receipt: receipt, intent: intent) else {
                if generation == editGeneration { editErrorMessage = Self.editFailureMessage() }
                return nil
            }
            confirmedUpdatedTagsById[tagId] = receipt.tag
            tags = Self.mergingConfirmedTags(Array(confirmedTagsById.values), into: tags)
            editDraft = nil
            pendingTagUpdateIntent = nil
            editSelectedTagId = nil
            return receipt.tag
        } catch {
            guard generation == editGeneration, editSelectedTagId == tagId else { return nil }
            editErrorMessage = "We couldn’t save this schema. Your draft is still here; retry or reload the latest version."
            return nil
        }
    }

    static func editFailureMessage() -> String { "We couldn’t confirm that this Supertag was updated. Your draft is still here." }

    static func matches(receipt: RPCTagRead, intent: PendingTagUpdateIntent) -> Bool {
        receipt.tag.id == intent.tagId && !receipt.tag.builtin && receipt.tag.name == intent.name && receipt.tag.parentIds == intent.parentIds && receipt.revision.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private func orderedParents(for draft: SupertagEditDraft, excluding tagId: String) -> [String] {
        draft.selectedParentIds.filter { parentId in
            parentId != tagId && tags.contains(where: { candidate in candidate.id == parentId })
        }
    }

    private var confirmedTagsById: [String: RPCTag] {
        confirmedCreatedTagsById.merging(confirmedUpdatedTagsById) { _, updated in updated }
    }

    private func updateSignature(tagId: String, draft: SupertagEditDraft, surface: String = "ios-supertags") -> String {
        let parents = orderedParents(for: draft, excluding: tagId)
        let attribution = MutationAttribution(kind: "humanUi", surface: surface)
        return PendingTagUpdateIntent(tagId: tagId, expectedRevision: draft.revision, name: Self.canonicalizedDraft(draft.name), parentIds: parents, requestId: "", commitMessage: "Update the \(Self.canonicalizedDraft(draft.name)) Supertag schema.", attribution: attribution).signature
    }

    static func canCreate(name: String, rationale: String) -> Bool {
        !canonicalizedDraft(name).isEmpty &&
            !canonicalizedDraft(rationale).isEmpty &&
            canonicalizedDraft(rationale).utf16.count <= 500
    }

    func startRootTagCreation(name: String, rationale: String, surface: String) async -> RPCTag? {
        guard !isCreating, pendingCreationIntent == nil else { return nil }
        let canonicalName = Self.canonicalizedDraft(name)
        let canonicalRationale = Self.canonicalizedDraft(rationale)
        guard Self.canCreate(name: canonicalName, rationale: canonicalRationale) else { return nil }
        let intent = PendingSupertagIntent(
            name: canonicalName,
            parentIds: [],
            requestId: UUID().uuidString.lowercased(),
            rationale: canonicalRationale,
            attribution: MutationAttribution(kind: "humanUi", surface: surface)
        )
        pendingCreationIntent = intent
        return await submitCreation(intent)
    }

    func retryRootTagCreation() async -> RPCTag? {
        guard !isCreating, let pendingCreationIntent else { return nil }
        return await submitCreation(pendingCreationIntent)
    }

    /// Editing or cancelling a failed request deliberately discards its replay identity. The next
    /// activation builds a new immutable intent and UUID from the changed draft.
    func discardPendingRootTagCreation() {
        guard !isCreating else { return }
        pendingCreationIntent = nil
        creationErrorMessage = nil
    }

    private func submitCreation(_ intent: PendingSupertagIntent) async -> RPCTag? {
        isCreating = true
        creationErrorMessage = nil
        defer { isCreating = false }
        do {
            let tag = try await transport.createTag(intent: intent)
            confirmedCreatedTagsById[tag.id] = tag
            tags = Self.mergingConfirmedTags(Array(confirmedTagsById.values), into: tags)
            hasLoadedTags = true
            pendingCreationIntent = nil
            return tag
        } catch {
            creationErrorMessage = Self.creationFailureMessage(for: error)
            return nil
        }
    }

    static func creationFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that this Supertag was created. Your name and rationale are still here. Review the catalog before taking another action."
    }

    /// Keep the schema browser useful whenever a successful catalog contains tags. A valid user
    /// choice survives refreshes; a missing or stale choice falls back to the first sorted tag.
    static func resolveSelectedTagId(selectedTagId: String?, tags: [RPCTag]) -> String? {
        guard let selectedTagId, tags.contains(where: { $0.id == selectedTagId }) else {
            return tags.first?.id
        }
        return selectedTagId
    }

    /// A reference is authority-bearing: unlike ordinary catalog selection it must never fall
    /// through to an unrelated first tag when the target has disappeared.
    static func resolveDeepLinkedTagId(requestedTagId: String, tags: [RPCTag]) -> String? {
        tags.contains(where: { $0.id == requestedTagId }) ? requestedTagId : nil
    }

    func tag(withId id: String) -> RPCTag? {
        tags.first { $0.id == id }
    }

    func fields(for tagId: String) -> [RPCResolvedTagField]? {
        guard let snapshot = fieldsByTagId[tagId] else { return nil }
        return Self.mergingConfirmedFields(confirmedDefinedFieldsByTagId[tagId] ?? [:], into: snapshot)
    }

    func hasSuccessfulFieldSnapshot(for tagId: String) -> Bool {
        hasSuccessfulFieldSnapshotTagIds.contains(tagId)
    }

    static func mergingConfirmedFields(_ receipts: [String: RPCResolvedTagField], into snapshot: [RPCResolvedTagField]) -> [RPCResolvedTagField] {
        let receiptIDs = Set(receipts.keys)
        return snapshot.filter { !receiptIDs.contains($0.id) } + receipts.values.sorted { $0.field.sortOrder < $1.field.sortOrder }
    }

    static func nextDirectSortOrder(for fields: [RPCResolvedTagField]) -> Int {
        (fields.filter { !$0.inherited }.map(\.field.sortOrder).max() ?? -1) + 1
    }

    static func canDefineField(tag: RPCTag?, hasSuccessfulSnapshot: Bool, name: String, rationale: String) -> Bool {
        guard let tag, tag.parentIds.isEmpty, hasSuccessfulSnapshot else { return false }
        return !canonicalizedDraft(name).isEmpty && !canonicalizedDraft(rationale).isEmpty && canonicalizedDraft(rationale).utf16.count <= 500
    }

    /// This is deliberately the one retry policy shared by the model and the presentation: a
    /// pending request belongs to one selected, extant root tag. A selection change never turns a
    /// replay into a write against another tag.
    static func canRetryFieldDefinition(
        pendingIntent: PendingTagFieldIntent?,
        currentSelectedTagId: String?,
        currentTag: RPCTag?,
        isDefiningField: Bool
    ) -> Bool {
        guard !isDefiningField,
              let pendingIntent,
              currentSelectedTagId == pendingIntent.tagId,
              currentTag?.id == pendingIntent.tagId,
              currentTag?.parentIds.isEmpty == true else { return false }
        return true
    }

    func canRetryFieldDefinition(currentSelectedTagId: String?) -> Bool {
        Self.canRetryFieldDefinition(
            pendingIntent: pendingFieldDefinitionIntent,
            currentSelectedTagId: currentSelectedTagId,
            currentTag: currentSelectedTagId.flatMap(tag(withId:)),
            isDefiningField: isDefiningField
        )
    }

    func startFieldDefinition(tag: RPCTag?, name: String, valueKind: RPCTagFieldValueKind, rationale: String) async -> RPCTagFieldDefinition? {
        guard !isDefiningField, pendingFieldDefinitionIntent == nil,
              let selectedTagId = tag?.id,
              let selectedTag = self.tag(withId: selectedTagId),
              selectedTag.parentIds.isEmpty,
              hasSuccessfulFieldSnapshot(for: selectedTag.id) else { return nil }
        let canonicalName = Self.canonicalizedDraft(name)
        let canonicalRationale = Self.canonicalizedDraft(rationale)
        guard !canonicalName.isEmpty, !canonicalRationale.isEmpty, canonicalRationale.utf16.count <= 500 else { return nil }
        let intent = PendingTagFieldIntent(tagId: selectedTag.id, name: canonicalName, valueKind: valueKind, sortOrder: Self.nextDirectSortOrder(for: fields(for: selectedTag.id) ?? []), requestId: UUID().uuidString.lowercased(), rationale: canonicalRationale, attribution: MutationAttribution(kind: "humanUi", surface: "ios-supertags"))
        pendingFieldDefinitionIntent = intent
        return await submitFieldDefinition(intent)
    }

    func retryFieldDefinition(currentSelectedTagId: String?) async -> RPCTagFieldDefinition? {
        guard canRetryFieldDefinition(currentSelectedTagId: currentSelectedTagId),
              let intent = pendingFieldDefinitionIntent else { return nil }
        return await submitFieldDefinition(intent)
    }

    func discardPendingFieldDefinition() {
        guard !isDefiningField else { return }
        pendingFieldDefinitionIntent = nil
        fieldDefinitionErrorMessage = nil
    }

    private func submitFieldDefinition(_ intent: PendingTagFieldIntent) async -> RPCTagFieldDefinition? {
        isDefiningField = true
        fieldDefinitionErrorMessage = nil
        defer { isDefiningField = false }
        do {
            let receipt = try await transport.defineTagField(intent: intent)
            guard Self.matches(receipt: receipt, intent: intent) else {
                fieldDefinitionErrorMessage = Self.fieldDefinitionFailureMessage()
                return nil
            }
            confirmedDefinedFieldsByTagId[intent.tagId, default: [:]][receipt.id] = RPCResolvedTagField(field: receipt)
            pendingFieldDefinitionIntent = nil
            // A newer read supersedes any suspended read; its failure leaves the accepted receipt visible.
            await refreshFields(for: intent.tagId, force: true)
            return receipt
        } catch {
            fieldDefinitionErrorMessage = Self.fieldDefinitionFailureMessage()
            return nil
        }
    }

    static func fieldDefinitionFailureMessage() -> String {
        "We couldn’t confirm that this field was defined. Your field details are still here. Review the fields before taking another action."
    }

    /// The receipt is confirmation only if it is the exact immutable operation we sent. This
    /// intentionally rejects even a structurally valid field from a different operation.
    static func matches(receipt: RPCTagFieldDefinition, intent: PendingTagFieldIntent) -> Bool {
        receipt.tagId == intent.tagId &&
            receipt.name == intent.name &&
            receipt.valueKind == intent.valueKind &&
            receipt.sortOrder == intent.sortOrder &&
            !receipt.builtin
    }

    func isLoadingFields(for tagId: String) -> Bool {
        fieldsLoadingTagIds.contains(tagId)
    }

    func fieldError(for tagId: String) -> String? {
        fieldErrorsByTagId[tagId]
    }

    func parentNames(for tag: RPCTag) -> [String] {
        Self.parentNames(for: tag, in: tags)
    }

    func childNames(for tag: RPCTag) -> [String] {
        Self.childNames(for: tag, in: tags)
    }

    static func parentNames(for tag: RPCTag, in tags: [RPCTag]) -> [String] {
        tag.parentIds.compactMap { parentId in tags.first { $0.id == parentId }?.name }
    }

    static func childNames(for tag: RPCTag, in tags: [RPCTag]) -> [String] {
        tags.filter { $0.parentIds.contains(tag.id) }
            .map(\.name)
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    private static func isECMAScriptWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0,
             0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }
}

/// The catalog and its selected-field follow-up remain model-owned; this claim only rejects rapid
/// UI activations before the catalog loading publication can update the view.
enum SupertagsCatalogRefreshPresentation {
    static func canStartRefresh(isRefreshInFlight: Bool) -> Bool {
        !isRefreshInFlight
    }

    static func isLoading(isModelLoading: Bool, isRefreshInFlight: Bool) -> Bool {
        isModelLoading || isRefreshInFlight
    }
}

public struct SupertagsView: View {
    @StateObject private var model: SupertagsViewModel
    @State private var selectedTagId: String?
    @State private var initialSelectedTagId: String?
    @State private var initialSelectionUnavailable = false
    @State private var isCatalogRefreshInFlight = false
    @State private var newTagName = ""
    @State private var newTagRationale = ""
    @State private var newFieldName = ""
    @State private var newFieldRationale = ""
    @State private var newFieldValueKind: RPCTagFieldValueKind = .text
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private let onOpenToday: (() -> Void)?

    public init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        onOpenToday: (() -> Void)? = nil,
        initialSelectedTagId: EntityId? = nil
    ) {
        _model = StateObject(
            wrappedValue: SupertagsViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
        self.onOpenToday = onOpenToday
        _initialSelectedTagId = State(initialValue: initialSelectedTagId?.rawValue)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Type system")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("Supertags")
                        .font(.title2.bold())
                }
                Spacer()
                Button {
                    startCatalogRefresh()
                } label: {
                    Label(isLoadingCatalog ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(isLoadingCatalog)
            }

            Text("Typed tags give the entities in your second brain a shared vocabulary.")
                .font(.callout)
                .foregroundStyle(.secondary)

            creationForm

            if let error = model.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if initialSelectionUnavailable {
                Label("Referenced Supertag unavailable", systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Referenced Supertag unavailable")
            }

            if SupertagsViewModel.shouldShowCatalogLoading(
                hasLoadedTags: model.hasLoadedTags,
                isLoading: isLoadingCatalog,
                errorMessage: model.errorMessage
            ) {
                ProgressView("Loading Supertags…")
                    .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
            } else if SupertagsViewModel.shouldShowEmptyCatalog(
                isEmpty: model.tags.isEmpty,
                hasLoadedTags: model.hasLoadedTags,
                isLoading: isLoadingCatalog,
                errorMessage: model.errorMessage
            ) {
                SupertagsEmptyState(onOpenToday: onOpenToday)
            } else {
                if horizontalSizeClass == .compact {
                    VStack(alignment: .leading, spacing: 16) {
                        tagList
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Divider()
                        detail
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                } else {
                    HStack(alignment: .top, spacing: 20) {
                        tagList
                            .frame(minWidth: 220, maxWidth: 280, alignment: .leading)
                        Divider()
                        detail
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
            }
        }
        .padding()
        .task { await refreshCatalogOnAppear() }
        .task(id: selectedTagId) {
            guard let selectedTagId else { return }
            await model.refreshFields(for: selectedTagId)
        }
        .onChange(of: newTagName) { _ in
            model.discardPendingRootTagCreation()
        }
        .onChange(of: newTagRationale) { _ in
            model.discardPendingRootTagCreation()
        }
        .onChange(of: newFieldName) { _ in model.discardPendingFieldDefinition() }
        .onChange(of: newFieldRationale) { _ in model.discardPendingFieldDefinition() }
        .onChange(of: newFieldValueKind) { _ in model.discardPendingFieldDefinition() }
    }

    private var isLoadingCatalog: Bool {
        SupertagsCatalogRefreshPresentation.isLoading(
            isModelLoading: model.isLoading,
            isRefreshInFlight: isCatalogRefreshInFlight
        )
    }

    private func startCatalogRefresh() {
        guard beginCatalogRefresh() else { return }
        Task { @MainActor in
            await completeCatalogRefresh()
        }
    }

    private func refreshCatalogOnAppear() async {
        guard beginCatalogRefresh() else { return }
        await completeCatalogRefresh()
    }

    private func beginCatalogRefresh() -> Bool {
        guard SupertagsCatalogRefreshPresentation.canStartRefresh(
            isRefreshInFlight: isCatalogRefreshInFlight
        ) else {
            return false
        }
        isCatalogRefreshInFlight = true
        return true
    }

    private func completeCatalogRefresh() async {
        defer { isCatalogRefreshInFlight = false }
        await refreshCatalog()
    }

    private func refreshCatalog(preserving confirmedTag: RPCTag? = nil) async {
        await model.refresh(preserving: confirmedTag)

        guard model.errorMessage == nil else {
            if let selectedTagId {
                await model.refreshFields(for: selectedTagId)
            }
            return
        }

        if let requested = initialSelectedTagId {
            initialSelectedTagId = nil
            if let resolved = SupertagsViewModel.resolveDeepLinkedTagId(requestedTagId: requested, tags: model.tags) {
                selectedTagId = resolved
                initialSelectionUnavailable = false
            } else {
                selectedTagId = nil
                initialSelectionUnavailable = true
            }
            return
        }
        guard !initialSelectionUnavailable else { return }
        let selectedTagIdBeforeResolution = selectedTagId
        let resolvedTagId = SupertagsViewModel.resolveSelectedTagId(
            selectedTagId: selectedTagIdBeforeResolution,
            tags: model.tags
        )
        selectedTagId = resolvedTagId

        // A changed selection triggers the existing keyed task above. Retain the prior explicit
        // Refresh behavior only when the user remains on the same tag.
        if selectedTagIdBeforeResolution == resolvedTagId, let resolvedTagId {
            await model.refreshFields(for: resolvedTagId)
        }
    }

    private var creationForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Create a root Supertag")
                .font(.headline)
            TextField("Name", text: $newTagName)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Supertag name")
                .disabled(model.isCreating)
            TextField("Why does this belong in the shared vocabulary?", text: $newTagRationale, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...4)
                .accessibilityLabel("Creation rationale")
                .disabled(model.isCreating)

            if let creationErrorMessage = model.creationErrorMessage {
                Text(creationErrorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack {
                Button(model.isCreating ? "Creating…" : "Create Supertag") {
                    Task { await createRootTag() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    model.isCreating ||
                        model.pendingCreationIntent != nil ||
                        !SupertagsViewModel.canCreate(name: newTagName, rationale: newTagRationale)
                )

                if model.pendingCreationIntent != nil, !model.isCreating {
                    Button("Retry") {
                        Task { await retryRootTag() }
                    }
                    .buttonStyle(.bordered)
                    Button("Cancel") {
                        model.discardPendingRootTagCreation()
                    }
                    .buttonStyle(.borderless)
                }
            }

            Text("Root tags only. Select a root Supertag below to define its fields.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private func createRootTag() async {
        guard let created = await model.startRootTagCreation(
            name: newTagName,
            rationale: newTagRationale,
            surface: Self.mutationSurface
        ) else {
            return
        }
        newTagName = ""
        newTagRationale = ""
        selectedTagId = created.id
        await refreshCatalog(preserving: created)
    }

    private func retryRootTag() async {
        guard let created = await model.retryRootTagCreation() else { return }
        newTagName = ""
        newTagRationale = ""
        selectedTagId = created.id
        await refreshCatalog(preserving: created)
    }

    private static var mutationSurface: String {
        #if os(iOS)
        "ios-supertags"
        #else
        "macos"
        #endif
    }

    private var tagList: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Tags")
                .font(.headline)
            ForEach(model.tags, id: \.id) { tag in
                Button {
                    if selectedTagId != tag.id { model.cancelEditing() }
                    selectedTagId = tag.id
                    initialSelectionUnavailable = false
                } label: {
                    HStack(spacing: 8) {
                        if tag.builtin {
                            Image(systemName: "number.square.fill")
                                .foregroundStyle(.tint)
                        } else {
                            Image(systemName: "number.square")
                                .foregroundStyle(.secondary)
                        }
                        Text("#\(tag.name)")
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if tag.builtin {
                            Text("Base")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 5)
                    .padding(.horizontal, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(selectedTagId == tag.id ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 7))
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let selectedTagId, let tag = model.tag(withId: selectedTagId) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    Text("#\(tag.name)")
                        .font(.title3.bold())
                    if tag.builtin {
                        Text("Base tag")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                    }
                    Spacer()
                    if !tag.builtin, model.editDraft == nil {
                        Button(model.isLoadingEditBaseline ? "Loading…" : "Edit") {
                            Task { await model.beginEditing(tagId: tag.id) }
                        }
                        .buttonStyle(.bordered)
                        .disabled(model.isLoadingEditBaseline || model.isSavingEdit)
                    }
                }

                if let draft = model.editDraft {
                    supertagEditForm(tag: tag, draft: draft)
                } else if let error = model.editErrorMessage {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(error).font(.caption).foregroundStyle(.red)
                        Button("Retry load") { Task { await model.beginEditing(tagId: tag.id) } }
                            .buttonStyle(.bordered)
                            .disabled(model.isLoadingEditBaseline || model.isSavingEdit)
                    }
                }

                let parents = model.parentNames(for: tag)
                LabeledContent("Parents") {
                    Text(parents.isEmpty ? "— (root tag)" : parents.map { "#\($0)" }.joined(separator: ", "))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("Children") {
                    let children = model.childNames(for: tag)
                    Text(children.isEmpty ? "—" : children.map { "#\($0)" }.joined(separator: ", "))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                }

                fieldDefinitions(for: tag)
                fieldDefinitionForm(for: tag)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: "number.square")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text("Select a Supertag")
                    .font(.headline)
                Text("Inspect its place in the typed vocabulary.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private func supertagEditForm(tag: RPCTag, draft: SupertagEditDraft) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Edit Supertag").font(.headline)
            TextField("Name", text: Binding(get: { draft.name }, set: { model.updateEditDraft(name: $0) }))
                .textFieldStyle(.roundedBorder)
                .disabled(model.isSavingEdit || model.isLoadingEditBaseline)
            Text("Parents").font(.subheadline.weight(.medium))
            ForEach(model.tags.filter { $0.id != tag.id }, id: \.id) { candidate in
                Toggle("#\(candidate.name)", isOn: Binding(
                    get: { draft.selectedParentIds.contains(candidate.id) },
                    set: { _ in model.updateEditDraft(parentId: candidate.id) }
                ))
                .disabled(model.isSavingEdit || model.isLoadingEditBaseline)
            }
            HStack {
                Button(model.isSavingEdit ? "Saving…" : "Save") {
                    Task { _ = await model.saveEdit(tagId: tag.id, surface: Self.mutationSurface) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isSavingEdit || model.isLoadingEditBaseline || SupertagsViewModel.canonicalizedDraft(draft.name).isEmpty)
                Button("Cancel") { model.cancelEditing() }
                    .buttonStyle(.borderless)
                    .disabled(model.isLoadingEditBaseline)
            }
            if let error = model.editErrorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
                Button("Reload latest") { Task { await model.reloadEditBaselinePreservingDraft() } }
                    .buttonStyle(.bordered)
                    .disabled(model.isSavingEdit || model.isLoadingEditBaseline)
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func fieldDefinitions(for tag: RPCTag) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Fields")
                .font(.headline)

            if model.isLoadingFields(for: tag.id) {
                ProgressView("Loading fields…")
                    .controlSize(.small)
            }

            let fields = model.fields(for: tag.id)
            if SupertagsFieldDefinitionsPresentation.shouldRenderFields(fields) {
                let fields = fields ?? []
                if fields.isEmpty {
                    Text("No fields defined yet.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(fields) { resolved in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(resolved.field.name)
                                    .font(.body.weight(.medium))
                                Text(resolved.field.valueKind.rawValue)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                if resolved.inherited,
                                   let declaringTag = model.tag(withId: resolved.field.tagId) {
                                    Text("inherited from #\(declaringTag.name)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                if resolved.field.builtin {
                                    Text("built-in")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }

            if let error = model.fieldError(for: tag.id) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                    if SupertagsViewModel.canRetryFields(
                        tagId: tag.id,
                        isLoadingFields: model.isLoadingFields(for: tag.id)
                    ) {
                        Button("Retry fields") {
                            Task { await model.refreshFields(for: tag.id) }
                        }
                        .buttonStyle(.bordered)
                        .accessibilityHint("Retries loading fields for this Supertag.")
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func fieldDefinitionForm(for tag: RPCTag) -> some View {
        if tag.parentIds.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Define a field")
                    .font(.headline)
                if !model.hasSuccessfulFieldSnapshot(for: tag.id) {
                    Text("Load a successful field snapshot before defining a field.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                TextField("Field name", text: $newFieldName)
                    .textFieldStyle(.roundedBorder).disabled(model.isDefiningField)
                Picker("Value kind", selection: $newFieldValueKind) {
                    ForEach([RPCTagFieldValueKind.text, .number, .date, .checkbox, .entityRef], id: \.self) { kind in
                        Text(kind.rawValue).tag(kind)
                    }
                }
                TextField("Why does this field belong here?", text: $newFieldRationale, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(2...4).disabled(model.isDefiningField)
                if let error = model.fieldDefinitionErrorMessage {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
                HStack {
                    Button(model.isDefiningField ? "Defining…" : "Define field") {
                        Task { await defineField(for: tag) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isDefiningField || model.pendingFieldDefinitionIntent != nil || !SupertagsViewModel.canDefineField(tag: tag, hasSuccessfulSnapshot: model.hasSuccessfulFieldSnapshot(for: tag.id), name: newFieldName, rationale: newFieldRationale))
                    if model.canRetryFieldDefinition(currentSelectedTagId: selectedTagId) {
                        Button("Retry") { Task { await retryFieldDefinition() } }.buttonStyle(.bordered)
                        Button("Cancel") { model.discardPendingFieldDefinition() }.buttonStyle(.borderless)
                    } else if model.pendingFieldDefinitionIntent != nil, !model.isDefiningField {
                        Text("This pending field belongs to another root Supertag. Select that root to retry, or cancel this pending action.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Cancel") { model.discardPendingFieldDefinition() }.buttonStyle(.borderless)
                    }
                }
                Text("Only root Supertags can define fields in the native app.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(12)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        } else {
            Text("Native field definition is currently available only on root Supertags. This child tag can use inherited fields, but field editing remains unavailable here.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func defineField(for tag: RPCTag) async {
        guard await model.startFieldDefinition(tag: tag, name: newFieldName, valueKind: newFieldValueKind, rationale: newFieldRationale) != nil else { return }
        newFieldName = ""
        newFieldRationale = ""
    }

    private func retryFieldDefinition() async {
        guard await model.retryFieldDefinition(currentSelectedTagId: selectedTagId) != nil else { return }
        newFieldName = ""
        newFieldRationale = ""
    }
}

/// Receipt-backed fields and a reconciliation error are deliberately orthogonal: an accepted
/// receipt remains useful evidence while the user is offered a safe retry for the read.
enum SupertagsFieldDefinitionsPresentation {
    static func shouldRenderFields(_ fields: [RPCResolvedTagField]?) -> Bool {
        fields != nil
    }
}

enum SupertagsEmptyStatePresentation {
    static let title = "No Supertags yet"
    static let message = "Create root Supertags here. Define fields from a selected root Supertag."
    static let todayActionTitle = "Open today’s note"

    static func shouldShowTodayAction(onOpenToday: (() -> Void)?) -> Bool {
        onOpenToday != nil
    }
}

private struct SupertagsEmptyState: View {
    let onOpenToday: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "number")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(SupertagsEmptyStatePresentation.title)
                .font(.headline)
            Text(SupertagsEmptyStatePresentation.message)
                .font(.callout)
                .foregroundStyle(.secondary)
            if SupertagsEmptyStatePresentation.shouldShowTodayAction(onOpenToday: onOpenToday), let onOpenToday {
                Button(SupertagsEmptyStatePresentation.todayActionTitle, action: onOpenToday)
                    .buttonStyle(.borderedProminent)
                    .accessibilityHint("Returns to today’s daily note.")
            }
        }
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .topLeading)
    }
}
