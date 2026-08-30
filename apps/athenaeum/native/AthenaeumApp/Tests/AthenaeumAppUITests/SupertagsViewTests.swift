import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumAppUI

@MainActor
final class SupertagsViewTests: XCTestCase {
    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
    }

    private final class RecordingTransport: SupertagsCatalogTransport {
        var catalog: [RPCTag] = []
        var listTagsError: Error?
        var createResults: [Result<RPCTag, Error>] = []
        var defineFieldResults: [Result<RPCTagFieldDefinition, Error>] = []
        private(set) var defineFieldIntents: [PendingTagFieldIntent] = []
        var fieldsByTagId: [String: [RPCResolvedTagField]] = [:]
        var fieldReadErrorsByTagId: [String: Error] = [:]
        private(set) var fieldReadCallCounts: [String: Int] = [:]
        var suspendedFieldReadTagIds: Set<String> = []
        private(set) var suspendedFieldReadCounts: [String: Int] = [:]
        private var fieldReadContinuations: [String: [CheckedContinuation<[RPCResolvedTagField], Error>]] = [:]
        private(set) var createIntents: [PendingSupertagIntent] = []
        var shouldSuspendCatalogReads = false
        private(set) var suspendedCatalogReadCount = 0
        private var catalogContinuation: CheckedContinuation<[RPCTag], Error>?
        var shouldSuspendCreates = false
        private var createContinuation: CheckedContinuation<RPCTag, Error>?

        func listTags() async throws -> [RPCTag] {
            if shouldSuspendCatalogReads {
                suspendedCatalogReadCount += 1
                return try await withCheckedThrowingContinuation { continuation in
                    catalogContinuation = continuation
                }
            }
            if let listTagsError { throw listTagsError }
            return catalog
        }

        func completeSuspendedCatalogRead(with result: Result<[RPCTag], Error>) {
            let continuation = catalogContinuation
            catalogContinuation = nil
            continuation?.resume(with: result)
        }

        func listTagFields(tagId: String) async throws -> [RPCResolvedTagField] {
            fieldReadCallCounts[tagId, default: 0] += 1
            if suspendedFieldReadTagIds.contains(tagId) {
                suspendedFieldReadCounts[tagId, default: 0] += 1
                return try await withCheckedThrowingContinuation { continuation in
                    fieldReadContinuations[tagId, default: []].append(continuation)
                }
            }
            if let error = fieldReadErrorsByTagId[tagId] { throw error }
            return fieldsByTagId[tagId] ?? []
        }

        func completeSuspendedFieldRead(tagId: String, with result: Result<[RPCResolvedTagField], Error>) {
            guard !fieldReadContinuations[tagId, default: []].isEmpty else { return }
            let continuation = fieldReadContinuations[tagId]!.removeFirst()
            continuation.resume(with: result)
        }

        func createTag(intent: PendingSupertagIntent) async throws -> RPCTag {
            createIntents.append(intent)
            if shouldSuspendCreates {
                return try await withCheckedThrowingContinuation { continuation in
                    createContinuation = continuation
                }
            }
            guard !createResults.isEmpty else { throw PrivateTransportError() }
            return try createResults.removeFirst().get()
        }

        func defineTagField(intent: PendingTagFieldIntent) async throws -> RPCTagFieldDefinition {
            defineFieldIntents.append(intent)
            guard !defineFieldResults.isEmpty else { throw PrivateTransportError() }
            return try defineFieldResults.removeFirst().get()
        }

        func completeSuspendedCreate(with result: Result<RPCTag, Error>) {
            let continuation = createContinuation
            createContinuation = nil
            continuation?.resume(with: result)
        }
    }

    func testSortsBaseTagsBeforeCustomTagsThenByName() throws {
        let tags = [
            try tag(id: "custom-b", name: "zebra", parentIds: [], builtin: false),
            try tag(id: "base-b", name: "Task", parentIds: [], builtin: true),
            try tag(id: "custom-a", name: "alpha", parentIds: [], builtin: false),
            try tag(id: "base-a", name: "Person", parentIds: [], builtin: true)
        ]

        XCTAssertEqual(SupertagsViewModel.sortedTags(tags).map(\.name), ["Person", "Task", "alpha", "zebra"])
    }

    func testResolvedSelectionPreservesAValidExplicitTag() throws {
        let tags = [
            try tag(id: "person", name: "Person", parentIds: [], builtin: true),
            try tag(id: "project", name: "Project", parentIds: [], builtin: false)
        ]

        XCTAssertEqual(
            SupertagsViewModel.resolveSelectedTagId(selectedTagId: "project", tags: tags),
            "project"
        )
    }

    func testResolvedSelectionDefaultsMissingOrStaleChoiceToFirstSortedTag() throws {
        let tags = SupertagsViewModel.sortedTags([
            try tag(id: "task", name: "Task", parentIds: [], builtin: true),
            try tag(id: "person", name: "Person", parentIds: [], builtin: true)
        ])

        XCTAssertEqual(
            SupertagsViewModel.resolveSelectedTagId(selectedTagId: nil, tags: tags),
            "person"
        )
        XCTAssertEqual(
            SupertagsViewModel.resolveSelectedTagId(selectedTagId: "removed", tags: tags),
            "person"
        )
    }

    func testResolvedSelectionClearsForAnEmptyCatalog() {
        XCTAssertNil(
            SupertagsViewModel.resolveSelectedTagId(selectedTagId: "stale", tags: [])
        )
    }

    func testDeepLinkedSelectionOnlySelectsTheExactExistingTag() throws {
        let tags = [
            try tag(id: "person", name: "Person", parentIds: [], builtin: true),
            try tag(id: "project", name: "Project", parentIds: [], builtin: false)
        ]
        XCTAssertEqual(SupertagsViewModel.resolveDeepLinkedTagId(requestedTagId: "project", tags: tags), "project")
        XCTAssertNil(SupertagsViewModel.resolveDeepLinkedTagId(requestedTagId: "removed", tags: tags))
        XCTAssertNil(SupertagsViewModel.resolveDeepLinkedTagId(requestedTagId: "project", tags: []))
    }

    func testParentAndChildNamesResolveAgainstLoadedTags() throws {
        let parent = try tag(id: "parent", name: "Project", parentIds: [], builtin: true)
        let child = try tag(id: "child", name: "Launch", parentIds: ["parent"], builtin: false)
        let unrelated = try tag(id: "other", name: "Person", parentIds: [], builtin: true)
        let tags = [parent, child, unrelated]

        XCTAssertEqual(SupertagsViewModel.parentNames(for: child, in: tags), ["Project"])
        XCTAssertEqual(SupertagsViewModel.childNames(for: parent, in: tags), ["Launch"])
        XCTAssertEqual(SupertagsViewModel.childNames(for: unrelated, in: tags), [String]())
    }

    func testDecodesEffectiveFieldWithInheritanceMetadata() throws {
        let field = CapnWebValue.object([
            "id": .string("field-id"),
            "tagId": .string("parent"),
            "name": .string("email"),
            "valueKind": .string("text"),
            "sortOrder": .int(1),
            "builtin": .bool(true)
        ])
        let resolved = try RPCResolvedTagField(.object([
            "field": field,
            "inherited": .bool(true)
        ]))

        XCTAssertEqual(resolved.id, "field-id")
        XCTAssertEqual(resolved.field.name, "email")
        XCTAssertEqual(resolved.field.valueKind, .text)
        XCTAssertEqual(resolved.field.sortOrder, 1)
        XCTAssertTrue(resolved.field.builtin)
        XCTAssertTrue(resolved.inherited)
    }

    func testCatalogLoadFailureMessageSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = SupertagsViewModel.catalogLoadFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "Supertags couldn’t be loaded. Nothing has been changed. Refresh to check the catalog again."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testFieldLoadFailureMessageSuppressesUnderlyingTransportDetails() {
        let error = PrivateTransportError()
        let message = SupertagsViewModel.fieldLoadFailureMessage(for: error)

        XCTAssertEqual(
            message,
            "Fields couldn’t be loaded. Nothing has been changed. Retry these fields or refresh the catalog."
        )
        XCTAssertFalse(message.contains(error.description))
    }

    func testFieldRetryRequiresTagAndNoActiveFieldRead() {
        XCTAssertTrue(
            SupertagsViewModel.canRetryFields(tagId: "tag-1", isLoadingFields: false)
        )
        XCTAssertFalse(
            SupertagsViewModel.canRetryFields(tagId: nil, isLoadingFields: false)
        )
        XCTAssertFalse(
            SupertagsViewModel.canRetryFields(tagId: "tag-1", isLoadingFields: true)
        )
    }

    func testCatalogRefreshPresentationRejectsRapidDuplicateActionsAndRestoresLoadingState() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            SupertagsCatalogRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            SupertagsCatalogRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            SupertagsCatalogRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            SupertagsCatalogRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )

        isRefreshInFlight = false
        XCTAssertTrue(
            SupertagsCatalogRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertFalse(
            SupertagsCatalogRefreshPresentation.isLoading(
                isModelLoading: false,
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertTrue(
            SupertagsCatalogRefreshPresentation.isLoading(
                isModelLoading: true,
                isRefreshInFlight: isRefreshInFlight
            )
        )
    }

    func testCatalogPresentationWaitsForAConfirmedSuccessfulRead() {
        XCTAssertTrue(
            SupertagsViewModel.shouldShowCatalogLoading(
                hasLoadedTags: false,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            SupertagsViewModel.shouldShowCatalogLoading(
                hasLoadedTags: false,
                isLoading: true,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            SupertagsViewModel.shouldShowCatalogLoading(
                hasLoadedTags: false,
                isLoading: true,
                errorMessage: "Supertags couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            SupertagsViewModel.shouldShowCatalogLoading(
                hasLoadedTags: false,
                isLoading: false,
                errorMessage: "Supertags couldn’t be loaded."
            )
        )
        XCTAssertFalse(
            SupertagsViewModel.shouldShowCatalogLoading(
                hasLoadedTags: true,
                isLoading: true,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            SupertagsViewModel.shouldShowCatalogLoading(
                hasLoadedTags: true,
                isLoading: false,
                errorMessage: "Supertags couldn’t be loaded."
            )
        )

        XCTAssertFalse(
            SupertagsViewModel.shouldShowEmptyCatalog(
                isEmpty: true,
                hasLoadedTags: false,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertTrue(
            SupertagsViewModel.shouldShowEmptyCatalog(
                isEmpty: true,
                hasLoadedTags: true,
                isLoading: false,
                errorMessage: nil
            )
        )
        XCTAssertFalse(
            SupertagsViewModel.shouldShowEmptyCatalog(
                isEmpty: true,
                hasLoadedTags: true,
                isLoading: false,
                errorMessage: "Supertags couldn’t be loaded."
            )
        )
    }

    func testEmptyStateUsesProductCopyAndOnlyShowsTodayActionWhenNavigationIsWired() {
        XCTAssertEqual(SupertagsEmptyStatePresentation.title, "No Supertags yet")
        XCTAssertEqual(
            SupertagsEmptyStatePresentation.message,
            "Create root Supertags here. Define fields from a selected root Supertag."
        )
        XCTAssertEqual(
            SupertagsEmptyStatePresentation.todayActionTitle,
            "Open today’s note"
        )
        XCTAssertFalse(
            SupertagsEmptyStatePresentation.shouldShowTodayAction(onOpenToday: nil)
        )
        XCTAssertTrue(
            SupertagsEmptyStatePresentation.shouldShowTodayAction(onOpenToday: {})
        )
    }

    func testCreationCanonicalizesNameAndRationaleAndUsesRootOnlyIntent() async throws {
        let created = try tag(id: "created", name: "Project Plan", parentIds: [], builtin: false)
        let transport = RecordingTransport()
        transport.createResults = [.success(created)]
        let model = SupertagsViewModel(transport: transport)

        let result = await model.startRootTagCreation(
            name: "\u{FEFF}  Project\n\tPlan  ",
            rationale: "  Keep\u{00A0}related\nwork\u{0009}together  ",
            surface: "ios-supertags"
        )

        XCTAssertEqual(result?.id, "created")
        XCTAssertEqual(transport.createIntents.count, 1)
        let intent = try XCTUnwrap(transport.createIntents.first)
        XCTAssertEqual(intent.name, "Project Plan")
        XCTAssertEqual(intent.rationale, "Keep related work together")
        XCTAssertEqual(intent.parentIds, [])
        XCTAssertEqual(intent.attribution.kind, "humanUi")
        XCTAssertEqual(intent.attribution.surface, "ios-supertags")
    }

    func testCreationRequiresNonblankNameAndRationaleAndBoundsRationaleByUTF16() {
        XCTAssertFalse(SupertagsViewModel.canCreate(name: "  ", rationale: "reason"))
        XCTAssertFalse(SupertagsViewModel.canCreate(name: "Tag", rationale: "\u{FEFF}\n"))
        XCTAssertTrue(SupertagsViewModel.canCreate(name: "Tag", rationale: String(repeating: "a", count: 500)))
        XCTAssertFalse(SupertagsViewModel.canCreate(name: "Tag", rationale: String(repeating: "😀", count: 251)))
    }

    func testCreationRetryReusesExactlyTheFrozenIntent() async throws {
        let created = try tag(id: "created", name: "Project", parentIds: [], builtin: false)
        let transport = RecordingTransport()
        transport.createResults = [.failure(PrivateTransportError()), .success(created)]
        let model = SupertagsViewModel(transport: transport)

        let firstResult = await model.startRootTagCreation(name: " Project ", rationale: " Make projects visible ", surface: "ios-supertags")
        XCTAssertNil(firstResult)
        let frozen = try XCTUnwrap(model.pendingCreationIntent)
        XCTAssertEqual(
            model.creationErrorMessage,
            "We couldn’t confirm that this Supertag was created. Your name and rationale are still here. Review the catalog before taking another action."
        )

        let retryResult = await model.retryRootTagCreation()
        XCTAssertEqual(retryResult?.id, "created")
        XCTAssertEqual(transport.createIntents, [frozen, frozen])
        XCTAssertNil(model.pendingCreationIntent)
    }

    func testCreationRejectsRapidDoubleActivationWhileTheFirstRequestIsInFlight() async throws {
        let created = try tag(id: "created", name: "Project", parentIds: [], builtin: false)
        let transport = RecordingTransport()
        transport.shouldSuspendCreates = true
        let model = SupertagsViewModel(transport: transport)

        let firstTask = Task {
            await model.startRootTagCreation(
                name: "Project",
                rationale: "Shared project vocabulary",
                surface: "ios-supertags"
            )
        }
        while transport.createIntents.isEmpty {
            await Task.yield()
        }

        let secondResult = await model.startRootTagCreation(
            name: "Project",
            rationale: "Shared project vocabulary",
            surface: "ios-supertags"
        )
        XCTAssertNil(secondResult)
        XCTAssertTrue(model.isCreating)
        XCTAssertEqual(transport.createIntents.count, 1)

        transport.completeSuspendedCreate(with: .success(created))
        let firstResult = await firstTask.value
        XCTAssertEqual(firstResult?.id, created.id)
        XCTAssertFalse(model.isCreating)
        XCTAssertEqual(transport.createIntents.count, 1)
    }

    func testEditingOrCancellingFailedCreationDiscardsReplayIdentity() async throws {
        let transport = RecordingTransport()
        transport.createResults = [.failure(PrivateTransportError()), .failure(PrivateTransportError())]
        let model = SupertagsViewModel(transport: transport)

        let firstResult = await model.startRootTagCreation(name: "Project", rationale: "First reason", surface: "ios-supertags")
        XCTAssertNil(firstResult)
        let first = try XCTUnwrap(model.pendingCreationIntent)
        model.discardPendingRootTagCreation()
        XCTAssertNil(model.pendingCreationIntent)

        let secondResult = await model.startRootTagCreation(name: "Project", rationale: "Edited reason", surface: "ios-supertags")
        XCTAssertNil(secondResult)
        let second = try XCTUnwrap(model.pendingCreationIntent)
        XCTAssertNotEqual(first.requestId, second.requestId)
        XCTAssertNotEqual(first.rationale, second.rationale)
    }

    func testConfirmedCreateRemainsSelectedCandidateWhenReconciliationFailsOrOmitsIt() async throws {
        let created = try tag(id: "created", name: "Project", parentIds: [], builtin: false)
        let other = try tag(id: "other", name: "Task", parentIds: [], builtin: true)
        let transport = RecordingTransport()
        transport.createResults = [.success(created)]
        transport.catalog = [other]
        let model = SupertagsViewModel(transport: transport)

        let result = await model.startRootTagCreation(name: "Project", rationale: "Shared project vocabulary", surface: "ios-supertags")
        XCTAssertEqual(result?.id, created.id)
        await model.refresh(preserving: result)

        XCTAssertEqual(model.tags.map(\.id), [other.id, created.id])
        XCTAssertEqual(
            SupertagsViewModel.resolveSelectedTagId(selectedTagId: created.id, tags: model.tags),
            created.id
        )

        transport.listTagsError = PrivateTransportError()
        await model.refresh(preserving: result)
        XCTAssertNotNil(model.tag(withId: created.id))
        XCTAssertEqual(
            model.errorMessage,
            "Supertag was created, but the catalog couldn’t be refreshed. Refresh later to check the catalog."
        )
        XCTAssertEqual(
            SupertagsViewModel.resolveSelectedTagId(selectedTagId: created.id, tags: model.tags),
            created.id
        )

        transport.catalog = []
        await model.refresh()
        XCTAssertNotNil(model.tag(withId: created.id))
        XCTAssertEqual(
            SupertagsViewModel.resolveSelectedTagId(selectedTagId: created.id, tags: model.tags),
            created.id
        )
    }

    func testInFlightStaleCatalogRefreshCannotEraseConfirmedCreate() async throws {
        let created = try tag(id: "created", name: "Project", parentIds: [], builtin: false)
        let transport = RecordingTransport()
        transport.createResults = [.success(created)]
        transport.shouldSuspendCatalogReads = true
        let model = SupertagsViewModel(transport: transport)

        let refreshTask = Task { await model.refresh() }
        while transport.suspendedCatalogReadCount == 0 {
            await Task.yield()
        }

        let createResult = await model.startRootTagCreation(
            name: "Project",
            rationale: "Shared project vocabulary",
            surface: "ios-supertags"
        )
        XCTAssertEqual(createResult?.id, created.id)

        transport.completeSuspendedCatalogRead(with: .success([]))
        await refreshTask.value

        XCTAssertNotNil(model.tag(withId: created.id))
        XCTAssertEqual(
            SupertagsViewModel.resolveSelectedTagId(selectedTagId: created.id, tags: model.tags),
            created.id
        )
    }

    func testFieldDefinitionIsRootOnlyRequiresSnapshotAndExcludesInheritedSortOrder() throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let child = try tag(id: "child", name: "Milestone", parentIds: ["root"], builtin: false)
        XCTAssertFalse(SupertagsViewModel.canDefineField(tag: root, hasSuccessfulSnapshot: false, name: "status", rationale: "shared"))
        XCTAssertFalse(SupertagsViewModel.canDefineField(tag: child, hasSuccessfulSnapshot: true, name: "status", rationale: "shared"))
        XCTAssertTrue(SupertagsViewModel.canDefineField(tag: root, hasSuccessfulSnapshot: true, name: " status ", rationale: " shared "))
        let direct = try resolvedField(id: "direct", tagId: "root", name: "name", kind: "text", order: 2, inherited: false)
        let inherited = try resolvedField(id: "inherited", tagId: "parent", name: "owner", kind: "text", order: 99, inherited: true)
        XCTAssertEqual(SupertagsViewModel.nextDirectSortOrder(for: [direct, inherited]), 3)
    }

    func testFieldDefinitionRetryKeepsFrozenIntentUntilSameRootSelection() async throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let child = try tag(id: "child", name: "Milestone", parentIds: ["root"], builtin: false)
        let receipt = try field(id: "field", tagId: "root", name: "status", kind: "text", order: 0)
        let transport = RecordingTransport()
        transport.catalog = [root]
        transport.defineFieldResults = [.failure(PrivateTransportError()), .success(receipt)]
        let model = SupertagsViewModel(transport: transport)
        await model.refresh()
        await model.refreshFields(for: root.id)
        let first = await model.startFieldDefinition(tag: root, name: " status ", valueKind: .text, rationale: " shared ")
        XCTAssertNil(first)
        let frozen = try XCTUnwrap(model.pendingFieldDefinitionIntent)
        XCTAssertEqual(frozen.name, "status")
        XCTAssertEqual(frozen.rationale, "shared")
        XCTAssertEqual(frozen.attribution.kind, "humanUi")
        XCTAssertEqual(frozen.attribution.surface, "ios-supertags")
        XCTAssertTrue(SupertagsViewModel.canRetryFieldDefinition(pendingIntent: frozen, currentSelectedTagId: root.id, currentTag: root, isDefiningField: false))
        XCTAssertFalse(SupertagsViewModel.canRetryFieldDefinition(pendingIntent: frozen, currentSelectedTagId: child.id, currentTag: child, isDefiningField: false))
        XCTAssertFalse(SupertagsViewModel.canRetryFieldDefinition(pendingIntent: frozen, currentSelectedTagId: "missing", currentTag: nil, isDefiningField: false))
        XCTAssertFalse(SupertagsViewModel.canRetryFieldDefinition(pendingIntent: frozen, currentSelectedTagId: root.id, currentTag: root, isDefiningField: true))
        let mismatch = await model.retryFieldDefinition(currentSelectedTagId: "other")
        XCTAssertNil(mismatch)
        XCTAssertEqual(transport.defineFieldIntents, [frozen])
        let retry = await model.retryFieldDefinition(currentSelectedTagId: root.id)
        XCTAssertEqual(retry?.id, receipt.id)
        XCTAssertEqual(transport.defineFieldIntents, [frozen, frozen])
    }

    func testDiscardingFrozenFieldIntentMakesTheNextActivationUseANewRequestID() async throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let transport = RecordingTransport()
        transport.catalog = [root]
        transport.defineFieldResults = [.failure(PrivateTransportError()), .failure(PrivateTransportError())]
        let model = SupertagsViewModel(transport: transport)
        await model.refresh(); await model.refreshFields(for: root.id)
        _ = await model.startFieldDefinition(tag: root, name: "Status", valueKind: .text, rationale: "First rationale")
        let first = try XCTUnwrap(model.pendingFieldDefinitionIntent)
        model.discardPendingFieldDefinition()
        _ = await model.startFieldDefinition(tag: root, name: "Status", valueKind: .text, rationale: "Second rationale")
        let second = try XCTUnwrap(model.pendingFieldDefinitionIntent)
        XCTAssertNotEqual(first.requestId, second.requestId)
        XCTAssertNotEqual(first.rationale, second.rationale)
    }

    func testStaleFieldReadSuccessAndFailureDoNotOwnLatestLoadingOrError() async throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let old = try resolvedField(id: "old", tagId: root.id, name: "Old", kind: "text", order: 0, inherited: false)
        let latest = try resolvedField(id: "latest", tagId: root.id, name: "Latest", kind: "text", order: 1, inherited: false)
        let transport = RecordingTransport(); transport.catalog = [root]; transport.suspendedFieldReadTagIds = [root.id]
        let model = SupertagsViewModel(transport: transport); await model.refresh()
        let oldTask = Task { await model.refreshFields(for: root.id) }
        while transport.suspendedFieldReadCounts[root.id, default: 0] < 1 { await Task.yield() }
        let latestTask = Task { await model.refreshFields(for: root.id, force: true) }
        while transport.suspendedFieldReadCounts[root.id, default: 0] < 2 { await Task.yield() }
        transport.completeSuspendedFieldRead(tagId: root.id, with: .success([old]))
        await oldTask.value
        XCTAssertTrue(model.isLoadingFields(for: root.id))
        XCTAssertNil(model.fieldError(for: root.id))
        XCTAssertNil(model.fields(for: root.id))
        transport.completeSuspendedFieldRead(tagId: root.id, with: .success([latest]))
        await latestTask.value
        XCTAssertEqual(model.fields(for: root.id)?.map(\.id), [latest.id])
        XCTAssertFalse(model.isLoadingFields(for: root.id))

        let staleFailure = Task { await model.refreshFields(for: root.id, force: true) }
        while transport.suspendedFieldReadCounts[root.id, default: 0] < 3 { await Task.yield() }
        let newerSuccess = Task { await model.refreshFields(for: root.id, force: true) }
        while transport.suspendedFieldReadCounts[root.id, default: 0] < 4 { await Task.yield() }
        transport.completeSuspendedFieldRead(tagId: root.id, with: .failure(PrivateTransportError()))
        await staleFailure.value
        XCTAssertTrue(model.isLoadingFields(for: root.id))
        XCTAssertNil(model.fieldError(for: root.id))
        transport.completeSuspendedFieldRead(tagId: root.id, with: .success([latest]))
        await newerSuccess.value
        XCTAssertFalse(model.isLoadingFields(for: root.id))
        XCTAssertNil(model.fieldError(for: root.id))
    }

    func testSuccessfulDefinitionReservesNewerReconciliationAndRetainsReceiptAfterOldRead() async throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let receipt = try field(id: "receipt", tagId: root.id, name: "Status", kind: "checkbox", order: 0)
        let transport = RecordingTransport(); transport.catalog = [root]
        let model = SupertagsViewModel(transport: transport); await model.refresh(); await model.refreshFields(for: root.id)
        XCTAssertTrue(model.hasSuccessfulFieldSnapshot(for: root.id))
        transport.suspendedFieldReadTagIds = [root.id]
        let oldRead = Task { await model.refreshFields(for: root.id, force: true) }
        while transport.suspendedFieldReadCounts[root.id, default: 0] < 1 { await Task.yield() }
        transport.defineFieldResults = [.success(receipt)]
        let define = Task { await model.startFieldDefinition(tag: root, name: "Status", valueKind: .checkbox, rationale: "Track state") }
        while transport.suspendedFieldReadCounts[root.id, default: 0] < 2 { await Task.yield() }
        transport.completeSuspendedFieldRead(tagId: root.id, with: .success([]))
        await oldRead.value
        XCTAssertTrue(model.isLoadingFields(for: root.id))
        XCTAssertTrue(model.fields(for: root.id)?.contains(where: { $0.id == receipt.id }) == true)
        transport.completeSuspendedFieldRead(tagId: root.id, with: .success([]))
        let defined = await define.value
        XCTAssertEqual(defined?.id, receipt.id)
        XCTAssertFalse(model.isLoadingFields(for: root.id))
        XCTAssertTrue(model.fields(for: root.id)?.contains(where: { $0.id == receipt.id }) == true)
    }

    func testFieldGenerationsAreCrossTagIsolated() async throws {
        let first = try tag(id: "first", name: "First", parentIds: [], builtin: false)
        let second = try tag(id: "second", name: "Second", parentIds: [], builtin: false)
        let firstField = try resolvedField(id: "one", tagId: first.id, name: "One", kind: "text", order: 0, inherited: false)
        let secondField = try resolvedField(id: "two", tagId: second.id, name: "Two", kind: "text", order: 0, inherited: false)
        let transport = RecordingTransport(); transport.catalog = [first, second]; transport.suspendedFieldReadTagIds = [first.id, second.id]
        let model = SupertagsViewModel(transport: transport); await model.refresh()
        let firstTask = Task { await model.refreshFields(for: first.id) }
        let secondTask = Task { await model.refreshFields(for: second.id) }
        while transport.suspendedFieldReadCounts[first.id, default: 0] < 1 || transport.suspendedFieldReadCounts[second.id, default: 0] < 1 { await Task.yield() }
        transport.completeSuspendedFieldRead(tagId: second.id, with: .success([secondField]))
        await secondTask.value
        XCTAssertTrue(model.isLoadingFields(for: first.id))
        XCTAssertFalse(model.isLoadingFields(for: second.id))
        XCTAssertEqual(model.fields(for: second.id)?.map(\.id), [secondField.id])
        transport.completeSuspendedFieldRead(tagId: first.id, with: .success([firstField]))
        await firstTask.value
        XCTAssertEqual(model.fields(for: first.id)?.map(\.id), [firstField.id])
    }

    func testMismatchedFieldReceiptRetainsPendingIntentWithoutCaching() async throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let otherReceipt = try field(id: "field", tagId: "other", name: "status", kind: "text", order: 0)
        let transport = RecordingTransport()
        transport.catalog = [root]
        transport.defineFieldResults = [.success(otherReceipt)]
        let model = SupertagsViewModel(transport: transport)
        await model.refresh(); await model.refreshFields(for: root.id)
        let result = await model.startFieldDefinition(tag: root, name: "status", valueKind: .text, rationale: "shared")
        XCTAssertNil(result)
        XCTAssertNotNil(model.pendingFieldDefinitionIntent)
        XCTAssertEqual(model.fields(for: root.id), [])
    }

    func testFieldDefinitionRejectsRemovedAndFabricatedSelectionEvidenceBeforeTransport() async throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let fabricated = try tag(id: "fabricated", name: "Fabricated", parentIds: [], builtin: false)
        let transport = RecordingTransport(); transport.catalog = [root]
        let model = SupertagsViewModel(transport: transport)
        await model.refresh(); await model.refreshFields(for: root.id)
        XCTAssertTrue(model.hasSuccessfulFieldSnapshot(for: root.id))

        transport.catalog = []
        await model.refresh()
        let removedResult = await model.startFieldDefinition(tag: root, name: "Status", valueKind: .text, rationale: "Track state")
        let fabricatedResult = await model.startFieldDefinition(tag: fabricated, name: "Status", valueKind: .text, rationale: "Track state")

        XCTAssertNil(removedResult)
        XCTAssertNil(fabricatedResult)
        XCTAssertTrue(transport.defineFieldIntents.isEmpty)
        XCTAssertNil(model.pendingFieldDefinitionIntent)
    }

    func testReceiptMustMatchEveryFrozenFieldSemanticBeforeCachingOrRefreshing() async throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let mismatches: [(String, RPCTagFieldDefinition)] = [
            ("tag", try field(id: "field", tagId: "other", name: "Status", kind: "text", order: 0)),
            ("name", try field(id: "field", tagId: root.id, name: "Other", kind: "text", order: 0)),
            ("kind", try field(id: "field", tagId: root.id, name: "Status", kind: "number", order: 0)),
            ("order", try field(id: "field", tagId: root.id, name: "Status", kind: "text", order: 1)),
            ("builtin", try field(id: "field", tagId: root.id, name: "Status", kind: "text", order: 0, builtin: true))
        ]

        for (kind, mismatchedReceipt) in mismatches {
            let transport = RecordingTransport(); transport.catalog = [root]
            transport.defineFieldResults = [.success(mismatchedReceipt)]
            let model = SupertagsViewModel(transport: transport)
            await model.refresh(); await model.refreshFields(for: root.id)

            let result = await model.startFieldDefinition(tag: root, name: " Status ", valueKind: .text, rationale: " Track state ")
            XCTAssertNil(result, kind)
            let pending = try XCTUnwrap(model.pendingFieldDefinitionIntent, kind)
            XCTAssertEqual(pending.name, "Status", kind)
            XCTAssertEqual(pending.valueKind, .text, kind)
            XCTAssertEqual(pending.sortOrder, 0, kind)
            XCTAssertEqual(transport.defineFieldIntents, [pending], kind)
            XCTAssertEqual(transport.fieldReadCallCounts[root.id], 1, kind)
            XCTAssertEqual(model.fields(for: root.id), [], kind)
            XCTAssertEqual(model.fieldDefinitionErrorMessage, SupertagsViewModel.fieldDefinitionFailureMessage(), kind)
        }
    }

    func testAcceptedReceiptRemainsRenderableWhenForcedReconciliationFails() async throws {
        let root = try tag(id: "root", name: "Project", parentIds: [], builtin: false)
        let receipt = try field(id: "field", tagId: root.id, name: "Status", kind: "checkbox", order: 0)
        let transport = RecordingTransport(); transport.catalog = [root]
        let model = SupertagsViewModel(transport: transport)
        await model.refresh(); await model.refreshFields(for: root.id)
        transport.defineFieldResults = [.success(receipt)]
        transport.fieldReadErrorsByTagId[root.id] = PrivateTransportError()

        let result = await model.startFieldDefinition(tag: root, name: "Status", valueKind: .checkbox, rationale: "Track state")
        XCTAssertEqual(result?.id, receipt.id)
        let visible = model.fields(for: root.id)
        XCTAssertTrue(visible?.contains(where: { $0.id == receipt.id }) == true)
        XCTAssertTrue(SupertagsFieldDefinitionsPresentation.shouldRenderFields(visible))
        XCTAssertNotNil(model.fieldError(for: root.id))
        XCTAssertTrue(SupertagsViewModel.canRetryFields(tagId: root.id, isLoadingFields: model.isLoadingFields(for: root.id)))
    }

    private func field(id: String, tagId: String, name: String, kind: String, order: Int, builtin: Bool = false) throws -> RPCTagFieldDefinition {
        try RPCTagFieldDefinition(.object(["id": .string(id), "tagId": .string(tagId), "name": .string(name), "valueKind": .string(kind), "sortOrder": .int(order), "builtin": .bool(builtin)]))
    }

    private func resolvedField(id: String, tagId: String, name: String, kind: String, order: Int, inherited: Bool) throws -> RPCResolvedTagField {
        try RPCResolvedTagField(.object(["field": .object(["id": .string(id), "tagId": .string(tagId), "name": .string(name), "valueKind": .string(kind), "sortOrder": .int(order), "builtin": .bool(false)]), "inherited": .bool(inherited)]))
    }

    private func tag(id: String, name: String, parentIds: [String], builtin: Bool) throws -> RPCTag {
        try RPCTag(.object([
            "id": .string(id),
            "name": .string(name),
            "parentIds": .array(parentIds.map(CapnWebValue.string)),
            "builtin": .bool(builtin)
        ]))
    }
}
