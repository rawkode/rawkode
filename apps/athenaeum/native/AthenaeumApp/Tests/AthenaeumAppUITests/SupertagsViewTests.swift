import XCTest
@testable import AthenaeumRPC
@testable import AthenaeumAppUI

@MainActor
final class SupertagsViewTests: XCTestCase {
    private struct PrivateTransportError: Error, CustomStringConvertible {
        let description = "backend=https://internal.example/api?credential=private-token"
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
            "Create and define Supertags from the web type-system view."
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

    private func tag(id: String, name: String, parentIds: [String], builtin: Bool) throws -> RPCTag {
        try RPCTag(.object([
            "id": .string(id),
            "name": .string(name),
            "parentIds": .array(parentIds.map(CapnWebValue.string)),
            "builtin": .bool(builtin)
        ]))
    }
}
