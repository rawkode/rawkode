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
        private(set) var createIntents: [PendingSupertagIntent] = []
        var shouldSuspendCatalogReads = false
        private(set) var suspendedCatalogReadCount = 0
        private var catalogContinuation: CheckedContinuation<[RPCTag], Error>?

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

        func listTagFields(tagId _: String) async throws -> [RPCResolvedTagField] {
            []
        }

        func createTag(intent: PendingSupertagIntent) async throws -> RPCTag {
            createIntents.append(intent)
            guard !createResults.isEmpty else { throw PrivateTransportError() }
            return try createResults.removeFirst().get()
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
            "Create root Supertags here. Add or change field definitions from the web type-system view."
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

    private func tag(id: String, name: String, parentIds: [String], builtin: Bool) throws -> RPCTag {
        try RPCTag(.object([
            "id": .string(id),
            "name": .string(name),
            "parentIds": .array(parentIds.map(CapnWebValue.string)),
            "builtin": .bool(builtin)
        ]))
    }
}
