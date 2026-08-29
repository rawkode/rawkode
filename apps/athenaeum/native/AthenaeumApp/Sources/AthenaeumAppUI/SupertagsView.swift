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

@MainActor
protocol SupertagsCatalogTransport {
    func listTags() async throws -> [RPCTag]
    func listTagFields(tagId: String) async throws -> [RPCResolvedTagField]
    func createTag(intent: PendingSupertagIntent) async throws -> RPCTag
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
}

/// Native type-system browser and root-tag creator. Field definition remains web-only while its
/// ledgered write path matures for cross-client parity.
@MainActor
final class SupertagsViewModel: ObservableObject {
    @Published private(set) var tags: [RPCTag] = []
    @Published private(set) var hasLoadedTags = false
    @Published private(set) var fieldsByTagId: [String: [RPCResolvedTagField]] = [:]
    @Published private(set) var fieldsLoadingTagIds: Set<String> = []
    @Published private(set) var fieldErrorsByTagId: [String: String] = [:]
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?
    @Published private(set) var isCreating = false
    @Published private(set) var creationErrorMessage: String?
    @Published private(set) var pendingCreationIntent: PendingSupertagIntent?

    private let transport: any SupertagsCatalogTransport

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
        isLoading = true
        defer { isLoading = false }
        do {
            tags = Self.mergingConfirmedTag(confirmedTag, into: try await transport.listTags())
            hasLoadedTags = true
            errorMessage = nil
        } catch {
            errorMessage = confirmedTag == nil
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
        "Supertag was created, but the catalog couldn’t be refreshed. Refresh later to check the catalog."
    }

    func refreshFields(for tagId: String) async {
        guard !fieldsLoadingTagIds.contains(tagId) else { return }
        fieldsLoadingTagIds.insert(tagId)
        fieldErrorsByTagId[tagId] = nil
        defer { fieldsLoadingTagIds.remove(tagId) }

        do {
            fieldsByTagId[tagId] = try await transport.listTagFields(tagId: tagId)
        } catch {
            fieldsByTagId[tagId] = nil
            fieldErrorsByTagId[tagId] = Self.fieldLoadFailureMessage(for: error)
        }
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
    static func mergingConfirmedTag(_ confirmedTag: RPCTag?, into catalog: [RPCTag]) -> [RPCTag] {
        guard let confirmedTag else { return sortedTags(catalog) }
        return sortedTags([confirmedTag] + catalog.filter { $0.id != confirmedTag.id })
    }

    static func canonicalizedDraft(_ raw: String) -> String {
        let trimmed = trimECMAScriptWhitespace(raw)
        var words: [String] = []
        var word = ""
        for scalar in trimmed.unicodeScalars {
            if isECMAScriptWhitespace(scalar) {
                if !word.isEmpty {
                    words.append(word)
                    word = ""
                }
            } else {
                word.unicodeScalars.append(scalar)
            }
        }
        if !word.isEmpty { words.append(word) }
        return words.joined(separator: " ")
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
            tags = Self.mergingConfirmedTag(tag, into: tags)
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

    func tag(withId id: String) -> RPCTag? {
        tags.first { $0.id == id }
    }

    func fields(for tagId: String) -> [RPCResolvedTagField]? {
        fieldsByTagId[tagId]
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
    @State private var isCatalogRefreshInFlight = false
    @State private var newTagName = ""
    @State private var newTagRationale = ""
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private let onOpenToday: (() -> Void)?

    public init(
        backendURL: URL,
        workspaceId: EntityId,
        bearerCredential: String?,
        onOpenToday: (() -> Void)? = nil
    ) {
        _model = StateObject(
            wrappedValue: SupertagsViewModel(backendURL: backendURL, workspaceId: workspaceId, bearerCredential: bearerCredential)
        )
        self.onOpenToday = onOpenToday
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

            Text("Root tags only. Add field definitions from the web type-system view.")
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
                    selectedTagId = tag.id
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

                Text("Field definitions are mirrored here. Use the web type-system view to add or change them for now.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
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
    private func fieldDefinitions(for tag: RPCTag) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Fields")
                .font(.headline)

            if model.isLoadingFields(for: tag.id) {
                ProgressView("Loading fields…")
                    .controlSize(.small)
            } else if let error = model.fieldError(for: tag.id) {
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
            } else if let fields = model.fields(for: tag.id) {
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
        }
        .padding(.top, 4)
    }
}

enum SupertagsEmptyStatePresentation {
    static let title = "No Supertags yet"
    static let message = "Create and define Supertags from the web type-system view."
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
