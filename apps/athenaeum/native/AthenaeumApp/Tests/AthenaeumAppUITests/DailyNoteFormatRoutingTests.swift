import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumCore
import AthenaeumDomain
import AthenaeumRPC

@MainActor
final class DailyNoteFormatRoutingTests: XCTestCase {
    private let workspace = try! EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60")

    func testUnsupportedProjectionMarksAreNoninteractiveAndUseFixedAccessibleTreatment() {
        let presentation = LoroProjectionTextPresentation(marks: [.unsupported])
        XCTAssertFalse(presentation.allowsTextSelection)
        XCTAssertEqual(presentation.accessibilityLabel, "Text with unsupported formatting")
        XCTAssertEqual(presentation.visibleSuffix, " · unsupported formatting")

        let supported = LoroProjectionTextPresentation(marks: [.strong, .link])
        XCTAssertTrue(supported.allowsTextSelection)
        XCTAssertNil(supported.accessibilityLabel)
        XCTAssertNil(supported.visibleSuffix)
    }

    func testFailurePresentationSuppressesRawModelDiagnostics() {
        let privateMessage = "backend=https://internal.example/api?credential=private-token"
        let presentation = DailyNoteFailurePresentation.message(for: privateMessage)

        XCTAssertEqual(
            presentation,
            "We couldn’t resolve this daily note. Retry to continue loading this date safely."
        )
        XCTAssertFalse(presentation.contains(privateMessage))
        XCTAssertEqual(DailyNoteFailurePresentation.title, "Daily note is unavailable")
        XCTAssertEqual(DailyNoteFailurePresentation.retryLabel, "Retry loading this note")
        XCTAssertEqual(
            DailyNoteFailurePresentation.accessibilityLabel(for: privateMessage),
            "Daily note is unavailable. We couldn’t resolve this daily note. Retry to continue loading this date safely."
        )
    }

    func testPreparationAnnouncementUsesTheStableAccessibleMessage() {
        XCTAssertEqual(
            DailyNotePreparationAnnouncementPresentation.message,
            "Meeting prepared in this daily note."
        )
    }

    func testWritingPresentationKeepsTheEditorCompactAndMakesOnlyActiveOrProblemStatesPersistent() {
        XCTAssertEqual(DailyNoteWritingPresentation.minimumEditorHeight, 180)
        XCTAssertFalse(DailyNoteWritingPresentation.showsStatus(.idle))
        XCTAssertFalse(DailyNoteWritingPresentation.showsStatus(.loading))
        XCTAssertFalse(DailyNoteWritingPresentation.showsStatus(.synced))
        XCTAssertTrue(DailyNoteWritingPresentation.showsStatus(.syncing))
        XCTAssertTrue(DailyNoteWritingPresentation.showsStatus(.pending("private pending detail")))
        XCTAssertTrue(DailyNoteWritingPresentation.showsStatus(.conflict("private conflict detail")))
        XCTAssertTrue(DailyNoteWritingPresentation.showsStatus(.error("private token=secret")))
    }

    func testWritingPresentationUsesSafeAccessibilityAnnouncements() {
        XCTAssertEqual(DailyNoteWritingPresentation.accessibilityLabel(for: .syncing), "Syncing daily note.")
        XCTAssertEqual(DailyNoteWritingPresentation.accessibilityLabel(for: .pending("private detail")), "A local change is pending.")
        XCTAssertEqual(DailyNoteWritingPresentation.accessibilityLabel(for: .conflict("private detail")), "Local changes need resolution.")
        XCTAssertEqual(DailyNoteWritingPresentation.accessibilityLabel(for: .error("token=secret")), "Daily note sync needs attention.")
        XCTAssertNil(DailyNoteWritingPresentation.accessibilityLabel(for: .synced))
    }

    func testWritingSurfaceMakesNativeFocusVisuallyObservable() {
        XCTAssertGreaterThan(
            DailyNoteWritingPresentation.borderOpacity(isFocused: true),
            DailyNoteWritingPresentation.borderOpacity(isFocused: false)
        )
        XCTAssertGreaterThan(
            DailyNoteWritingPresentation.borderLineWidth(isFocused: true),
            DailyNoteWritingPresentation.borderLineWidth(isFocused: false)
        )
    }

    func testPreparationFocusIsLimitedToEditableLoroPresentations() {
        XCTAssertTrue(DailyNotePreparationAnnouncementPresentation.shouldFocus(pagePresentation: .loroPlainEditable))
        XCTAssertTrue(DailyNotePreparationAnnouncementPresentation.shouldFocus(pagePresentation: .loroRichEditable))
        XCTAssertFalse(
            DailyNotePreparationAnnouncementPresentation.shouldFocus(
                pagePresentation: .loroReadOnly(.init(format: .loroV1, schemaVersion: 1, isDirty: false))
            )
        )
        XCTAssertFalse(DailyNotePreparationAnnouncementPresentation.shouldFocus(pagePresentation: .unavailable))
        XCTAssertFalse(DailyNotePreparationAnnouncementPresentation.shouldFocus(pagePresentation: .automergeRichTextReadOnly))
    }

    func testPreparationAnnouncementUsesTheNativePoliteUpdateTrait() throws {
        let source = try appUISource(named: "DailyNoteView.swift")
        let noticeStart = try XCTUnwrap(source.range(of: "if let preparationNotice"))
        let noticeBody = String(source[noticeStart.lowerBound...].prefix(420))
        XCTAssertTrue(noticeBody.contains(".accessibilityAddTraits(.updatesFrequently)"))
        XCTAssertTrue(noticeBody.contains(".accessibilityLabel(preparationNotice)"))
    }

    func testLegacyProjectionRejectsAChangedFullWitness() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let first = legacy(node, version: 1, heads: "before")
        let second = legacy(node, version: 1, heads: "after")
        let fake = FakeOperations(descriptors: [first, second])
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        XCTAssertEqual(model.pagePresentation, .unavailable)
        guard case .error = model.status else { return XCTFail("expected full legacy witness mismatch to fail closed") }
        XCTAssertEqual(fake.automergeResolveCount, 1)
        XCTAssertEqual(fake.loroSyncCount, 0)
    }

    func testLegacyProjectionStopsBeforeRemoteReadWhenLocalAutomergeIsDirty() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let descriptor = legacy(node, version: 1, heads: "server")
        let fake = FakeOperations(descriptors: [descriptor], dirtyAutomerge: true)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        guard case .retainedLocalChangeConflict = model.pagePresentation else { return XCTFail("expected dirty legacy conflict") }
        XCTAssertEqual(fake.legacyProjectionCount, 0, "a remote projection must not hide an unsynced local Automerge edit")
        XCTAssertEqual(fake.automergeResolveCount, 0)
    }

    func testLegacyProductionProjectionIsReadOnlyAndDoesNotUseAutomergeSync() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let descriptor = legacy(node, version: 1, heads: "server")
        let fake = FakeOperations(
            descriptors: [descriptor],
            legacyProjection: .init(text: "server projection", descriptor: descriptor),
            legacyProjectionIsRichText: true
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        XCTAssertEqual(model.pagePresentation, .automergeRichTextReadOnly)
        XCTAssertEqual(model.text, "server projection")
        XCTAssertEqual(fake.legacyProjectionCount, 1)
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.automergeSyncCount, 0)
    }

    func testRichLegacyProjectionShowsMigrationStateWithoutLossyText() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let descriptor = legacy(node, version: 1, heads: "server")
        let fake = FakeOperations(
            descriptors: [descriptor],
            legacyProjection: .init(content: .richTextUnsupported, descriptor: descriptor)
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        XCTAssertEqual(model.pagePresentation, .legacyMigrationRequired(.richTextUnsupported))
        XCTAssertEqual(model.text, "")
        XCTAssertTrue(model.isRichTextReadOnly)
        XCTAssertEqual(fake.automergeRichTextCount, 0)
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.automergeSyncCount, 0)
    }

    func testOversizedLegacyProjectionShowsMigrationStateWithoutText() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let descriptor = legacy(node, version: 1, heads: "server")
        let fake = FakeOperations(
            descriptors: [descriptor],
            legacyProjection: .init(content: .tooLarge, descriptor: descriptor)
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        XCTAssertEqual(model.pagePresentation, .legacyMigrationRequired(.tooLarge))
        XCTAssertEqual(model.text, "")
        XCTAssertTrue(model.isRichTextReadOnly)
        XCTAssertEqual(fake.automergeRichTextCount, 0)
    }

    func testLegacyActivationRevisionChangeFailsClosed() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [legacy(node, version: 1, heads: "one"), legacy(node, version: 2, heads: "two")])
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        guard case .error = model.status else { return XCTFail("expected format activation race to fail closed") }
        XCTAssertEqual(model.pagePresentation, .unavailable)
    }

    func testMatchingMissingDescriptorCreatesLoroWithoutLegacyCreation() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(
            descriptorError: AthenaeumDomainError.pageNotFound(nodeId: node.rawValue),
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false)
        )
        var secondaryLifecycleCount = 0
        let model = try AthenaeumViewModel(
            workspaceId: workspace,
            pageOperations: fake,
            date: Date(timeIntervalSince1970: 0),
            secondaryLifecycleObserver: { secondaryLifecycleCount += 1 }
        )
        await model.start()
        XCTAssertEqual(fake.loroCreateCount, 1)
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.loroSyncCount, 1)
        XCTAssertEqual(secondaryLifecycleCount, 1, "successful Loro creation must continue into the shared backlinks/graph lifecycle")
    }

    func testLiveDailyNoteCreationUsesLoroAndKeepsLegacySplicesReadOnly() throws {
        let source = try liveDailyNoteOperationsSource()

        let loroCreation = try operationBody(
            in: source,
            startingAt: "func resolveOrCreateLoro(nodeId: EntityId, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor {",
            endingBefore: "func hasLocalLoroPage"
        )
        XCTAssertTrue(loroCreation.contains("readClient.getPageDocumentDescriptor"))
        XCTAssertTrue(loroCreation.contains("readClient.createLoroPage"))
        XCTAssertFalse(loroCreation.contains("readClient.createPage("))

        let legacyRichText = try operationBody(
            in: source,
            startingAt: "func isAutomergeRichText(nodeId: EntityId) async throws -> Bool {",
            endingBefore: "func applyAutomergeSplice"
        )
        XCTAssertTrue(legacyRichText.contains("{ true }"))

        let legacySplice = try operationBody(
            in: source,
            startingAt: "func applyAutomergeSplice(nodeId: EntityId, index: Int, deleteCount: Int, insertText: String) async throws {",
            endingBefore: "func syncLoroReadOnly"
        )
        XCTAssertTrue(legacySplice.contains("throw DailyNotePageOperationError.legacyPageReadOnly(nodeId)"))
    }

    func testWrongMissingDescriptorFailsClosedWithoutAutomergeCreation() async throws {
        let fake = FakeOperations(descriptorError: AthenaeumDomainError.pageNotFound(nodeId: "other"))
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        XCTAssertEqual(fake.automergeResolveCount, 0)
        guard case .error = model.status else { return XCTFail("expected error") }
    }

    func testMissingDescriptorRetriesLoroCreationWithTheSameIntent() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(
            descriptorError: AthenaeumDomainError.pageNotFound(nodeId: node.rawValue),
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false)
        )
        fake.loroCreateError = AthenaeumDomainError.unexpectedError(message: "transient create failure")
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()
        guard case .error = model.status else { return XCTFail("expected first Loro creation to fail") }
        model.retryCurrentNote()
        try await waitUntil { fake.loroCreateCount == 2 && model.pagePresentation != .unavailable }

        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.loroCreationIntents.count, 2)
        XCTAssertEqual(fake.loroCreationIntents[0], fake.loroCreationIntents[1])
    }

    func testMissingDescriptorWithLocalLoroBlocksRemoteLoroCreation() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptorError: AthenaeumDomainError.pageNotFound(nodeId: node.rawValue), hasLocalLoro: true)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        guard case .retainedLocalChangeConflict = model.pagePresentation else { return XCTFail("expected conflict") }
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.loroCreateCount, 0)
    }

    func testDescriptorNodeMismatchFailsClosedWithoutFormatCalls() async throws {
        let other = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let fake = FakeOperations(descriptors: [legacy(other, version: 1, heads: "h")])
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.loroSyncCount, 0)
    }

    func testMigratedLocalHeadsMismatchShowsConflictWithoutLoroOrAutomerge() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [migrated(node, heads: "server")], durableHeads: "local", loadedHeads: "local")
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        guard case .retainedLocalChangeConflict = model.pagePresentation else { return XCTFail("expected conflict") }
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.loroSyncCount, 0)
    }

    func testMigratedDirtyLegacyRowWithMatchingHeadsRequiresRecovery() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(
            descriptors: [migrated(node, heads: "same")],
            durableHeads: "same",
            loadedHeads: "same",
            dirtyAutomerge: true
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        guard case .retainedLocalChangeConflict = model.pagePresentation else {
            return XCTFail("a dirty legacy row must require recovery before migrated Loro admission")
        }
        XCTAssertEqual(fake.loroSyncCount, 0)
        XCTAssertEqual(fake.automergeResolveCount, 0)
    }

    func testNativeLoroWithLocalAutomergeShowsConflictWithoutFormatCalls() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)], durableHeads: "local")
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        guard case .retainedLocalChangeConflict = model.pagePresentation else { return XCTFail("expected conflict") }
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.loroSyncCount, 0)
    }

    func testLoroRoutesNeverRunAutomergeOperationsWhenOpaqueSyncFails() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)])
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        XCTAssertEqual(fake.loroSyncCount, 1)
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.automergeSyncCount, 0)
        XCTAssertEqual(fake.spliceCount, 0)
    }

    func testNativeLoroPublishesProjectedReadOnlyStateWithoutAutomerge() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        guard case .loroProjectedReadOnly = model.pagePresentation else { return XCTFail("expected projection") }
        XCTAssertEqual(model.text, "")
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.automergeSyncCount, 0)
        XCTAssertEqual(fake.spliceCount, 0)
    }

    func testMeetingPreparationUsesTheSharedLoroCustodyAndReloadsBeforeEditing() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let localDate = try LocalDate(validating: localDateStamp(startDate, calendar: .current))
        let occurrenceKey = String(repeating: "a", count: 64)
        let timeZone = try IanaTimeZone(validating: "UTC")
        let fake = FakeOperations(
            descriptors: [native(node), native(node), native(node), native(node), native(dailyNoteIdForDate(Calendar.current.date(byAdding: .day, value: 1, to: startDate)!, calendar: .current))],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false)
        )
        fake.eligibilityResult = .editable(state)
        fake.preparationResult = try PrepareMeetingInDailyNoteOutput(
            dailyNoteId: node,
            localDate: localDate,
            occurrenceKey: occurrenceKey,
            status: .created,
            resultSnapshotSha256: String(repeating: "e", count: 64)
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()
        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)

        let input = try PrepareMeetingInDailyNoteInput(
            workspaceId: workspace,
            dailyNoteId: node,
            localDate: localDate,
            timeZone: timeZone,
            occurrenceKey: occurrenceKey,
            intent: try LoroMutationIntentV1(
                requestId: "native-preparation",
                commitMessage: "Prepare meeting context in daily note.",
                attribution: .humanUi(surface: "macos")
            )
        )
        let output = try await model.prepareMeetingInDailyNote(input)

        XCTAssertEqual(output.dailyNoteId, node)
        XCTAssertEqual(fake.preparationCount, 1)
        XCTAssertEqual(fake.preparedInputs.first?.dailyNoteId, node)
        XCTAssertEqual(fake.preparedInputs.first?.localDate, localDate)
        XCTAssertEqual(fake.preparedInputs.first?.occurrenceKey, occurrenceKey)
        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertFalse(model.isEditorInputDisabled, "custody must be released only after the authoritative reload")
        XCTAssertEqual(model.consumePreparationCompletion(), output)
        XCTAssertNil(model.consumePreparationCompletion(), "completion is consumed before a view can announce or focus twice")

        let firstCompletionGeneration = model.preparationCompletionGeneration
        let replay = try await model.prepareMeetingInDailyNote(input)
        XCTAssertEqual(replay.occurrenceKey, occurrenceKey)
        XCTAssertEqual(model.preparationCompletionGeneration, firstCompletionGeneration + 1)
        XCTAssertNotNil(model.preparationCompletion)
        model.showDate(startDate)
        XCTAssertNotNil(model.preparationCompletion, "a no-op date request must not consume a delayed-mount completion")
        XCTAssertEqual(model.consumePreparationCompletion(), replay)

        _ = try await model.prepareMeetingInDailyNote(input)
        XCTAssertNotNil(model.preparationCompletion)

        let firstHumanEditGeneration = model.acceptedHumanEditGeneration
        model.handleLoroPlainTextChange("edited")
        XCTAssertEqual(model.acceptedHumanEditGeneration, firstHumanEditGeneration + 1)

        let nextDate = Calendar.current.date(byAdding: .day, value: 1, to: startDate)!
        model.showDate(nextDate)
        try await waitUntil { model.selectedDate == Calendar.current.startOfDay(for: nextDate) }
        XCTAssertNil(model.preparationCompletion, "an accepted day transition clears the old completion")
    }

    func testPreparationReceiptMismatchNeverPublishesCompletion() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let otherNode = dailyNoteIdForDate(Calendar.current.date(byAdding: .day, value: 1, to: startDate)!, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let localDate = try LocalDate(validating: localDateStamp(startDate, calendar: .current))
        let occurrenceKey = String(repeating: "a", count: 64)
        let fake = FakeOperations(descriptors: [native(node), native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.preparationResult = try PrepareMeetingInDailyNoteOutput(
            dailyNoteId: otherNode,
            localDate: localDate,
            occurrenceKey: occurrenceKey,
            status: .created,
            resultSnapshotSha256: String(repeating: "e", count: 64)
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()
        let input = try PrepareMeetingInDailyNoteInput(
            workspaceId: workspace,
            dailyNoteId: node,
            localDate: localDate,
            timeZone: try IanaTimeZone(validating: "UTC"),
            occurrenceKey: occurrenceKey,
            intent: try LoroMutationIntentV1(requestId: "mismatch", commitMessage: "Prepare meeting context in daily note.", attribution: .humanUi(surface: "macos"))
        )
        do {
            _ = try await model.prepareMeetingInDailyNote(input)
            XCTFail("a mismatched receipt must fail closed")
        } catch { }
        XCTAssertNil(model.preparationCompletion)
        XCTAssertEqual(model.preparationCompletionGeneration, 0)
    }

    func testReadOnlyPreparationConfirmsWithoutRequestingEditorFocus() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let localDate = try LocalDate(validating: localDateStamp(startDate, calendar: .current))
        let occurrenceKey = String(repeating: "a", count: 64)
        let fake = FakeOperations(
            descriptors: [native(node), native(node)],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false)
        )
        fake.preparationResult = try PrepareMeetingInDailyNoteOutput(
            dailyNoteId: node,
            localDate: localDate,
            occurrenceKey: occurrenceKey,
            status: .alreadyPrepared,
            resultSnapshotSha256: String(repeating: "e", count: 64)
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: false)
        await model.start()
        let input = try PrepareMeetingInDailyNoteInput(
            workspaceId: workspace,
            dailyNoteId: node,
            localDate: localDate,
            timeZone: try IanaTimeZone(validating: "UTC"),
            occurrenceKey: occurrenceKey,
            intent: try LoroMutationIntentV1(requestId: "readonly", commitMessage: "Prepare meeting context in daily note.", attribution: .humanUi(surface: "macos"))
        )
        _ = try await model.prepareMeetingInDailyNote(input)
        XCTAssertFalse(DailyNotePreparationAnnouncementPresentation.shouldFocus(pagePresentation: model.pagePresentation))
        XCTAssertNotNil(model.consumePreparationCompletion())
    }

    func testMigratedLoroPublishesProjectedReadOnlyStateWithoutAutomerge() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [migrated(node, heads: "same")], durableHeads: "same", loadedHeads: "same", loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        guard case .loroProjectedReadOnly = model.pagePresentation else { return XCTFail("expected projection") }
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.automergeSyncCount, 0)
    }

    func testLoroProjectionRouteWitnessMismatchFailsClosedWithoutAutomergeFallback() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let wrongRoute = LoroPageRouteWitness(
            nodeId: node,
            format: .loroV1,
            storageVersion: 99,
            schemaVersion: 1,
            snapshotSHA256: String(repeating: "z", count: 64)
        )
        let fake = FakeOperations(
            descriptors: [native(node)],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false),
            projectionRouteOverride: wrongRoute
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        XCTAssertEqual(model.pagePresentation, .unavailable)
        guard case .error = model.status else { return XCTFail("expected route mismatch error") }
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.automergeSyncCount, 0)
        XCTAssertEqual(fake.spliceCount, 0)
    }

    func testDirtyLoroProjectionReportsPendingWithoutAutomergeMutation() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(
            descriptors: [native(node)],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: true)
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        guard case .loroProjectedReadOnly(let state) = model.pagePresentation else { return XCTFail("expected projection") }
        XCTAssertTrue(state.projection.isDirty)
        XCTAssertEqual(model.status, .pending("Local Loro replica has not converged"))
        XCTAssertEqual(fake.automergeResolveCount, 0)
        XCTAssertEqual(fake.automergeSyncCount, 0)
        XCTAssertEqual(fake.spliceCount, 0)
    }

    func testStaleLoadCannotPublishAfterNavigationInvalidatesGeneration() async throws {
        let fake = FakeOperations(dynamicLegacy: true, resolveDelayNanoseconds: 100_000_000)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        let initialLoad = Task { await model.start() }
        try await Task.sleep(nanoseconds: 20_000_000)
        model.showNextDay()
        await initialLoad.value
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(model.pagePresentation, .automergeEditable)
        XCTAssertEqual(model.text, "legacy")
    }

    func testNavigationCancelsPendingAutomergeDebounceBeforeLoroRoute() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(
            descriptors: [legacy(node, version: 1, heads: "h"), legacy(node, version: 1, heads: "h")]
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()
        model.handleTextChange("edited")
        try await Task.sleep(nanoseconds: 30_000_000)
        model.showNextDay()
        try await Task.sleep(nanoseconds: 650_000_000)
        XCTAssertEqual(fake.spliceCount, 1)
        XCTAssertEqual(fake.automergeSyncCount, 0)
    }

    func testInFlightAutomergeSyncCannotPublishAfterSameNodeRetriesAsLoro() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(
            descriptors: [legacy(node, version: 1, heads: "h"), legacy(node, version: 1, heads: "h"), native(node)],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false),
            blocksAutomergeSync: true
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()

        model.handleTextChange("local edit")
        try await waitUntil { fake.automergeSyncEntered }
        model.retryCurrentNote()
        XCTAssertEqual(model.pagePresentation, .unavailable)

        // Retry queues behind the old node operation. Releasing it must not permit the stale
        // Automerge completion to publish while the new generation is waiting to load Loro.
        fake.releaseAutomergeSync()
        try await waitUntil {
            if case .loroProjectedReadOnly = model.pagePresentation { return true }; return false
        }

        guard case .loroProjectedReadOnly = model.pagePresentation else { return XCTFail("expected projection") }
        XCTAssertEqual(model.text, "")
        XCTAssertEqual(model.status, .synced)
        XCTAssertEqual(fake.automergeRichTextCount, 1, "the stale sync must not query/publish a post-sync Automerge state")
    }

    func testQueuedAutomergeSpliceCannotRunAfterSameNodeRetriesAsLoro() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(
            descriptors: [legacy(node, version: 1, heads: "h"), legacy(node, version: 1, heads: "h"), native(node)],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false)
        )
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))
        await model.start()

        // `enqueue` defers this operation to the main-actor task queue. Retrying before it is
        // allowed to execute invalidates its captured generation even though the node is unchanged.
        model.handleTextChange("queued local edit")
        model.retryCurrentNote()
        try await waitUntil {
            if case .loroProjectedReadOnly = model.pagePresentation { return true }; return false
        }
        try await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertEqual(fake.spliceCount, 0)
        XCTAssertEqual(fake.automergeSyncCount, 0)
    }

    func testRetainedLocalChangeConflictNeverClaimsSynced() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)], durableHeads: "retained")
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        guard case .retainedLocalChangeConflict = model.pagePresentation else { return XCTFail("expected conflict") }
        guard case .conflict = model.status else { return XCTFail("a retained-local-change conflict must not claim synced") }
    }

    func testLoroRecoveryRunsBeforeProjectionAndInFlightDoesNotSync() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.recoveryResult = .inFlight
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        XCTAssertEqual(fake.recoveryCount, 1)
        XCTAssertEqual(fake.loroSyncCount, 0)
        XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)
        XCTAssertEqual(fake.automergeResolveCount + fake.automergeSyncCount + fake.spliceCount, 0)
    }

    func testCommittedRecoveryRechecksDescriptorWithoutLoroSync() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [native(node), native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.recoveryResult = .committed
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)

        await model.start()

        XCTAssertEqual(fake.loroSyncCount, 0)
        XCTAssertEqual(fake.eligibilityCount, 1)
        XCTAssertEqual(model.loroRecoveryAction, .recoverSavedRichEditableVersion)
    }

    func testCommittedRecoveryUsesFreshDescriptorWitnessRatherThanStaleRoute() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let old = native(node, version: 1, snapshot: "b")
        let fresh = native(node, version: 2, snapshot: "e")
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 2, schemaVersion: 1, snapshotSHA256: String(repeating: "e", count: 64))
        let state = LoroNativePlainEditorState(text: "fresh", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [old, fresh], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.recoveryResult = .committed
        fake.eligibilityResult = .editable(state)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)

        await model.start()

        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(model.loroPlainDraft, "fresh")
        XCTAssertEqual(fake.loroSyncCount, 0)
    }

    func testCommittedRecoveryMismatchedFreshEditorWitnessFailsClosed() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fresh = native(node, version: 2, snapshot: "e")
        let wrongRoute = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let wrong = LoroNativePlainEditorState(text: "wrong", scalarCount: 5, route: wrongRoute, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node), fresh], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.recoveryResult = .committed
        fake.eligibilityResult = .editable(wrong)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)

        await model.start()

        guard case .error = model.status else { return XCTFail("expected closed witness mismatch") }
        XCTAssertEqual(fake.loroSyncCount, 0)
    }

    func testAcceptedLiteralRecoveryIsExplicitAndDisabledNativePolicyStaysProjectionOnly() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: false)

        await model.start()

        XCTAssertEqual(fake.acceptedLiteralRecoveryCount, 0)
        XCTAssertEqual(fake.eligibilityCount, 0)
        guard case .loroProjectedReadOnly = model.pagePresentation else { return XCTFail("expected projection-only iOS policy") }
    }

    func testSubmittedNeedsReloadExposesOnlyExplicitAcceptedLiteralRecovery() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "recovered", scalarCount: 9, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .submittedNeedsReload
        fake.acceptedLiteralRecoveryResult = .editable(state)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()

        model.handleLoroPlainTextChange("changed")
        try await waitUntil { fake.nativeSubmitCount == 1 }
        XCTAssertEqual(model.loroRecoveryAction, .recoverSavedEditableVersion)
        XCTAssertEqual(fake.acceptedLiteralRecoveryCount, 0)
        let syncBeforeAction = fake.loroSyncCount

        model.performLoroRecoveryAction()
        try await waitUntil { model.pagePresentation == .loroPlainEditable && model.loroPlainDraft == "recovered" }
        XCTAssertEqual(fake.acceptedLiteralRecoveryCount, 1)
        XCTAssertEqual(fake.loroSyncCount, syncBeforeAction, "explicit recovery must not run an implicit Loro sync")
    }

    func testSubmittedEditAdmitsOnlyStateMatchingFreshDescriptor() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let oldRoute = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let freshRoute = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 2, schemaVersion: 1, snapshotSHA256: String(repeating: "e", count: 64))
        let initial = LoroNativePlainEditorState(text: "before", scalarCount: 6, route: oldRoute, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fresh = LoroNativePlainEditorState(text: "after", scalarCount: 5, route: freshRoute, replica: .init(snapshotSHA256: String(repeating: "f", count: 64), versionVectorSHA256: String(repeating: "g", count: 64)))
        let fake = FakeOperations(descriptors: [native(node), native(node, version: 2, snapshot: "e")], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false), projectionRouteOverride: oldRoute)
        fake.eligibilityResults = [.editable(initial), .editable(fresh)]
        fake.nativeSubmitResult = .submitted
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()

        model.handleLoroPlainTextChange("changed")
        try await waitUntil { model.loroPlainDraft == "after" }
        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(fake.loroSyncCount, 1, "post-submit admission must refetch the descriptor, not sync Loro")
    }

    func testMacPolicyAdmitsOnlyCoreEditableState() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)

        await model.start()

        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(model.loroPlainDraft, "plain")
        XCTAssertEqual(fake.automergeResolveCount + fake.automergeSyncCount + fake.spliceCount, 0)
    }

    func testRapidNativeEditsCoalesceToOneLatestSubmissionAndNewlinesNeverSubmit() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .submitted
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()

        model.handleLoroPlainTextChange("p")
        model.handleLoroPlainTextChange("pl")
        model.handleLoroPlainTextChange("plane")
        try await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertEqual(fake.nativeSubmitCount, 1)

        model.handleLoroPlainTextChange("bad\ntext")
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(fake.nativeSubmitCount, 1)
    }

    func testEnteredNativeSubmissionFreezesVisibleDraftAndBlocksFreshInputAndNavigation() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .submittedNeedsReload
        fake.blocksNativeSubmit = true
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()
        let selectedBeforeNavigation = model.selectedDate

        model.handleLoroPlainTextChange("A")
        try await waitUntil { fake.nativeSubmitEntered }
        XCTAssertTrue(model.isEditorInputDisabled)
        XCTAssertEqual(model.loroPlainDraft, "A")

        model.handleLoroPlainTextChange("B")
        model.showNextDay()
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(model.loroPlainDraft, "A", "entered A remains the visible retained draft")
        XCTAssertEqual(model.selectedDate, selectedBeforeNavigation, "navigation must not publish B before A has a durable disposition")
        XCTAssertEqual(fake.nativeSubmitCount, 1)

        fake.releaseNativeSubmit()
        try await waitUntil { model.selectedDate != selectedBeforeNavigation }
    }

    func testPreCustodyNavigationFailurePreservesVisibleNativeDraftAndSelection() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .unauthenticated
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()
        let before = model.selectedDate

        model.handleLoroPlainTextChange("A")
        model.showNextDay()
        try await waitUntil { fake.nativeSubmitCount == 1 && !model.isNavigating }

        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(model.loroPlainDraft, "A")
        XCTAssertEqual(model.selectedDate, before)
        XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)
        // `.pending` follows DailyNoteView's normal page-presentation path, so this retained A
        // remains inline with its recovery action instead of selecting the generic error retry.
        XCTAssertEqual(model.status, .pending("Sign in before navigating away from this saved draft."))

        model.showNextDay()
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(fake.nativeSubmitCount, 1, "a blocked draft must not be silently replayed during navigation")
        XCTAssertEqual(model.selectedDate, before)

        fake.descriptors = [legacy(node, version: 1, heads: "h"), legacy(node, version: 1, heads: "h")]
        model.retryCurrentNote()
        try await waitUntil { model.pagePresentation == .automergeEditable }
        XCTAssertFalse(model.isEditorInputDisabled, "a real route reset clears a prior Loro draft block")
    }

    func testNoChangeSubmissionCompletesPendingNavigation() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .noChange
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()
        let before = model.selectedDate

        model.handleLoroPlainTextChange("A")
        model.showNextDay()
        try await waitUntil { model.selectedDate != before }
        XCTAssertEqual(fake.nativeSubmitCount, 1)
    }

    func testEnteredPreCustodyFailureKeepsADraftVisibleAfterNavigationRequest() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .unauthenticated
        fake.blocksNativeSubmit = true
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()
        let before = model.selectedDate

        model.handleLoroPlainTextChange("A")
        try await waitUntil { fake.nativeSubmitEntered }
        model.showNextDay()
        fake.releaseNativeSubmit()
        try await waitUntil { !model.isNavigating }

        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(model.loroPlainDraft, "A")
        XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)
        XCTAssertEqual(model.selectedDate, before)
        XCTAssertEqual(fake.nativeSubmitCount, 1)
    }

    func testFailedRecoveryActionKeepsPreservedDraftWithoutResubmission() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .unauthenticated
        fake.recoveryResult = .none
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()
        let before = model.selectedDate

        model.handleLoroPlainTextChange("A")
        model.showNextDay()
        try await waitUntil { fake.nativeSubmitCount == 1 && !model.isNavigating }
        model.performLoroRecoveryAction()
        try await waitUntil { fake.recoveryCount == 1 }

        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(model.loroPlainDraft, "A")
        XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)
        XCTAssertEqual(model.selectedDate, before)
        XCTAssertEqual(fake.nativeSubmitCount, 1)
    }

    func testCommittedRecoveryReAdmissionRetainsBlockedDraftForEveryNonAdmissibleResult() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .unauthenticated
        fake.recoveryResult = .committed
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()

        model.handleLoroPlainTextChange("A")
        model.showNextDay()
        try await waitUntil { fake.nativeSubmitCount == 1 && !model.isNavigating }
        let syncCountBeforeRecovery = fake.loroSyncCount

        for eligibility in [
            LoroNativePlainEditorEligibility.ineligible,
            .checkpointResolutionRequired(.retainedRetry),
            .unauthenticated
        ] {
            fake.eligibilityResult = eligibility
            let expectedRecoveryCount = fake.recoveryCount + 1
            model.performLoroRecoveryAction()
            try await waitUntil { fake.recoveryCount == expectedRecoveryCount && !model.isLoroRecoveryInProgress }

            XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
            XCTAssertEqual(model.loroPlainDraft, "A")
            XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)
            XCTAssertTrue(model.isEditorInputDisabled)
        }

        XCTAssertEqual(fake.loroSyncCount, syncCountBeforeRecovery, "committed recovery re-admission must not synchronize Loro")
        XCTAssertEqual(fake.nativeSubmitCount, 1)
    }

    func testBlockedRecoveryRejectsGenericRetryAndDuplicateRecoveryAction() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .unauthenticated
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()

        model.handleLoroPlainTextChange("A")
        model.showNextDay()
        try await waitUntil { fake.nativeSubmitCount == 1 && !model.isNavigating }

        fake.blocksRecovery = true
        fake.recoveryResult = .committed
        let recoveryCountBeforeAction = fake.recoveryCount
        let loadCountBeforeAction = fake.resolveNodeCount
        model.performLoroRecoveryAction()
        model.performLoroRecoveryAction()
        try await waitUntil { fake.recoveryEntered }
        XCTAssertTrue(model.isLoroRecoveryInProgress)
        XCTAssertEqual(fake.recoveryCount, recoveryCountBeforeAction + 1, "two taps must enter only one Core recovery")

        model.retryCurrentNote()
        await model.start()
        let selectedDateBeforeNavigation = model.selectedDate
        model.showNextDay()
        XCTAssertTrue(model.isLoroRecoveryInProgress)
        XCTAssertEqual(fake.recoveryCount, recoveryCountBeforeAction + 1, "generic retry must not enter a second Core recovery")
        XCTAssertEqual(fake.resolveNodeCount, loadCountBeforeAction, "retry or lifecycle reload must not start another page route")
        XCTAssertEqual(model.selectedDate, selectedDateBeforeNavigation, "date navigation must not reset an active recovery")

        fake.releaseRecovery()
        try await waitUntil { fake.blockedRecoveryCompleted }
        try await waitUntil { model.pagePresentation == .loroPlainEditable }
        XCTAssertFalse(model.isLoroRecoveryInProgress)
        XCTAssertEqual(fake.recoveryCount, recoveryCountBeforeAction + 1)
        XCTAssertEqual(fake.nativeSubmitCount, 1)
    }

    func testBlockedAutomaticLoroRecoveryRejectsLifecycleStartWithoutSecondCoreRoute() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let fake = FakeOperations(
            descriptors: [native(node)],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false)
        )
        fake.blocksRecovery = true
        fake.recoveryResult = .none
        let model = try AthenaeumViewModel(
            workspaceId: workspace,
            pageOperations: fake,
            date: startDate,
            nativeLoroEditingEnabled: true
        )

        let initialStart = Task { await model.start() }
        try await waitUntil { fake.recoveryEntered }
        XCTAssertTrue(model.isLoroRecoveryInProgress)
        XCTAssertEqual(fake.recoveryCount, 1)
        XCTAssertEqual(fake.resolveNodeCount, 1)

        await model.start()
        XCTAssertTrue(model.isLoroRecoveryInProgress)
        XCTAssertEqual(fake.recoveryCount, 1, "a duplicate lifecycle start must not enter Core recovery again")
        XCTAssertEqual(fake.resolveNodeCount, 1, "a duplicate lifecycle start must not route the page again")

        fake.releaseRecovery()
        await initialStart.value
        try await waitUntil {
            if case .loroProjectedReadOnly = model.pagePresentation { return true }
            return false
        }
        XCTAssertFalse(model.isLoroRecoveryInProgress)
        XCTAssertEqual(fake.recoveryCount, 1)
        XCTAssertEqual(fake.resolveNodeCount, 1)
    }

    func testBlockedRecoveryStaleCompletionCannotPublishAfterGenerationInvalidation() async throws {
        let startDate = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(startDate, calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.recoveryResult = .inFlight
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: startDate, nativeLoroEditingEnabled: true)
        await model.start()
        XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)

        fake.blocksRecovery = true
        let recoveryCountBeforeAction = fake.recoveryCount
        model.performLoroRecoveryAction()
        try await waitUntil { fake.recoveryEntered }

        model.invalidatePageRouteForTesting()
        XCTAssertTrue(model.isLoroRecoveryInProgress, "a stale route invalidation must not release entered Core recovery ownership")

        fake.releaseRecovery()
        try await waitUntil { fake.blockedRecoveryCompleted }
        XCTAssertEqual(model.pagePresentation, .unavailable)
        XCTAssertFalse(model.isLoroRecoveryInProgress)
        XCTAssertEqual(fake.recoveryCount, recoveryCountBeforeAction + 1)
    }

    func testDirectCheckpointSubmissionResultPreservesUnacceptedDraft() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .checkpointResolutionRequired(.inFlight)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()

        model.handleLoroPlainTextChange("A")
        try await waitUntil { fake.nativeSubmitCount == 1 && !model.isNavigating }
        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(model.loroPlainDraft, "A")
        XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)
    }

    func testRecoveryIneligibleUnauthenticatedAndThrownErrorsRetainBlockedDraft() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .ineligible
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        model.handleLoroPlainTextChange("A")
        try await waitUntil { fake.nativeSubmitCount == 1 && !model.isNavigating }

        fake.acceptedLiteralRecoveryResult = .ineligible
        model.performLoroRecoveryAction()
        try await waitUntil { fake.acceptedLiteralRecoveryCount == 1 }
        XCTAssertEqual(model.loroPlainDraft, "A")
        XCTAssertEqual(model.loroRecoveryAction, .reloadEditor)

        fake.acceptedLiteralRecoveryResult = .unauthenticated
        model.performLoroRecoveryAction()
        try await waitUntil { fake.acceptedLiteralRecoveryCount == 2 }
        XCTAssertEqual(model.loroPlainDraft, "A")
        XCTAssertEqual(model.loroRecoveryAction, .reloadEditor)

        fake.acceptedLiteralRecoveryError = AthenaeumDomainError.unexpectedError(message: "injected")
        model.performLoroRecoveryAction()
        try await waitUntil { fake.acceptedLiteralRecoveryCount == 3 }
        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(model.loroPlainDraft, "A")
        XCTAssertEqual(model.loroRecoveryAction, .reloadEditor)
        XCTAssertEqual(fake.nativeSubmitCount, 1)
    }

    func testPostSubmittedEligibilityCheckpointUsesCoreClosedState() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResults = [.editable(state), .checkpointResolutionRequired(.retainedRetry)]
        fake.nativeSubmitResult = .submitted
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        model.handleLoroPlainTextChange("A")
        try await waitUntil { if case .retainedLocalChangeConflict = model.pagePresentation { return true }; return false }
        XCTAssertEqual(model.loroPlainDraft, "", "accepted A is represented by Core's retained checkpoint state, not an unaccepted draft")
        XCTAssertEqual(model.loroRecoveryAction, .retrySavedChange)
    }

    func testPostSubmittedIneligibilityKeepsAcceptedDraftInClosedCoreState() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResults = [.editable(state), .ineligible]
        fake.nativeSubmitResult = .submitted
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()

        model.handleLoroPlainTextChange("A")
        try await waitUntil {
            if case .retainedLocalChangeConflict = model.pagePresentation { return true }
            return false
        }

        XCTAssertEqual(model.loroPlainDraft, "", "A was accepted by Core and must not be re-labelled as an unaccepted draft")
        XCTAssertEqual(model.loroRecoveryAction, .reloadEditor)
    }

    func testExplicitLiteralRecoveryRejectsMismatchedDescriptorNode() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let other = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let state = LoroNativePlainEditorState(text: "saved", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(state)
        fake.nativeSubmitResult = .submittedNeedsReload
        fake.acceptedLiteralRecoveryResult = .editable(state)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        model.handleLoroPlainTextChange("changed")
        try await waitUntil { model.loroRecoveryAction == .recoverSavedEditableVersion && fake.nativeSubmitCount == 1 }
        XCTAssertEqual(model.loroRecoveryAction, .recoverSavedEditableVersion)
        try await Task.sleep(nanoseconds: 20_000_000)
        fake.descriptors = [native(other)]

        model.performLoroRecoveryAction()
        try await waitUntil { if case .retainedLocalChangeConflict = model.pagePresentation { return true }; return false }
        XCTAssertEqual(model.loroPlainDraft, "")
        XCTAssertEqual(fake.acceptedRichLiteralRecoveryCount, 0)
    }

    func testPlainIneligibleAdmitsRichWithoutAutomerge() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let rich = richState(node, text: "rich")
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible
        fake.richEligibilityResult = .editable(rich)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        XCTAssertEqual(model.pagePresentation, .loroRichEditable)
        XCTAssertEqual(model.loroRichEditorState, rich)
        XCTAssertEqual(fake.automergeResolveCount, 0)
    }

    func testPlainEditableWinsWithoutRichEligibility() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let route = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        let plain = LoroNativePlainEditorState(text: "plain", scalarCount: 5, route: route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .editable(plain)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        XCTAssertEqual(model.pagePresentation, .loroPlainEditable)
        XCTAssertEqual(fake.richEligibilityCount, 0)
    }

    func testBothIneligibleRemainProjectionWithRichRecoveryAction() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResult = .ineligible
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        guard case .loroProjectedReadOnly = model.pagePresentation else { return XCTFail("expected safe projection") }
        XCTAssertEqual(model.loroRecoveryAction, .recoverSavedRichEditableVersion)
        XCTAssertEqual(fake.automergeResolveCount + fake.automergeSyncCount + fake.spliceCount, 0)
    }

    func testPlainTerminalAdmissionNeverFallsThroughToRich() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        for result in [LoroNativePlainEditorEligibility.unauthenticated, .checkpointResolutionRequired(.retainedRetry)] {
            let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
            fake.eligibilityResult = result
            let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
            await model.start()
            XCTAssertEqual(fake.richEligibilityCount, 0)
            XCTAssertNotEqual(model.pagePresentation, .loroRichEditable)
        }
    }

    func testRichRecoveryUsesOnlyRichAcceptedEvidenceAPI() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let rich = richState(node, text: "saved")
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResult = .ineligible
        fake.acceptedRichLiteralRecoveryResult = .editable(rich)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start(); model.performLoroRecoveryAction()
        try await waitUntil { model.pagePresentation == .loroRichEditable }
        XCTAssertEqual(fake.acceptedRichLiteralRecoveryCount, 1)
        XCTAssertEqual(fake.acceptedLiteralRecoveryCount, 0)
    }

    func testRichSubmissionUsesExactDocumentAndMessage() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let rich = richState(node, text: "before")
        let proposed = richDocument("after")
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResults = [.ineligible]
        fake.richEligibilityResults = [.editable(rich)]
        fake.richSubmitResult = .invalidCommitMessage
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        model.handleLoroRichDocumentChange(proposed)
        try await waitUntil { fake.nativeRichSubmitCount == 1 }
        XCTAssertEqual(fake.nativeRichSubmitDocuments, [proposed])
        XCTAssertEqual(fake.nativeRichSubmitMessages, ["Update daily note content"])
        XCTAssertEqual(model.loroRichDraft, proposed)
        XCTAssertTrue(model.isEditorInputDisabled)
    }

    func testRichNoChangeRestoresCleanEditableSession() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let rich = richState(node, text: "before")
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResult = .editable(rich); fake.richSubmitResult = .noChange
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        model.handleLoroRichDocumentChange(richDocument("changed"))
        try await waitUntil { fake.nativeRichSubmitCount == 1 && !model.isEditorInputDisabled }
        XCTAssertEqual(model.loroRichDraft, rich.document)
    }

    func testAcceptedRichReloadUsesEvidenceRecoveryWhileUnacceptedDraftUsesDiscard() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let rich = richState(node, text: "before")
        let accepted = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        accepted.eligibilityResult = .ineligible; accepted.richEligibilityResult = .editable(rich); accepted.richSubmitResult = .submittedNeedsReload
        let acceptedModel = try AthenaeumViewModel(workspaceId: workspace, pageOperations: accepted, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await acceptedModel.start(); acceptedModel.handleLoroRichDocumentChange(richDocument("A"))
        try await waitUntil { acceptedModel.loroRecoveryAction == .recoverSavedRichEditableVersion }
        XCTAssertNil(acceptedModel.loroRichDraft)

        let retained = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        retained.eligibilityResult = .ineligible; retained.richEligibilityResult = .editable(rich); retained.richSubmitResult = .invalidCommitMessage
        let retainedModel = try AthenaeumViewModel(workspaceId: workspace, pageOperations: retained, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await retainedModel.start(); retainedModel.handleLoroRichDocumentChange(richDocument("A"))
        try await waitUntil { retainedModel.loroRecoveryAction == .discardRichDraftAndReload }
        XCTAssertEqual(retainedModel.loroRichDraft, richDocument("A"))
    }

    func testRichRouteMismatchFailsClosedWithoutPublicationOrAutomerge() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let wrongRoute = LoroPageRouteWitness(nodeId: node, format: .loroV1, storageVersion: 2, schemaVersion: 1, snapshotSHA256: String(repeating: "e", count: 64))
        let wrong = LoroNativeRichEditorState(document: richDocument("wrong"), route: wrongRoute, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResult = .editable(wrong)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        XCTAssertEqual(model.pagePresentation, .unavailable)
        XCTAssertNil(model.loroRichEditorState)
        XCTAssertEqual(fake.nativeRichSubmitCount, 0)
        XCTAssertEqual(fake.automergeResolveCount + fake.automergeSyncCount + fake.spliceCount, 0)
    }

    func testSubmittedRichReadmissionRequiresFreshEligibilityAndDescriptorWitness() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let initial = richState(node, text: "before")
        let stale = richState(node, text: "stale")
        let oldRoute = initial.route
        let fake = FakeOperations(descriptors: [native(node), native(node, version: 2, snapshot: "e")], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false), projectionRouteOverride: oldRoute)
        fake.eligibilityResult = .ineligible
        fake.richEligibilityResults = [.editable(initial), .editable(stale)]
        fake.richSubmitResult = .submitted
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start(); model.handleLoroRichDocumentChange(richDocument("A"))
        try await waitUntil { model.loroRecoveryAction == .recoverSavedRichEditableVersion }
        XCTAssertEqual(fake.nativeRichSubmitCount, 1)
        XCTAssertEqual(fake.richEligibilityCount, 2)
        XCTAssertNil(model.loroRichDraft)
        XCTAssertEqual(fake.automergeResolveCount + fake.automergeSyncCount + fake.spliceCount, 0)
    }

    func testExternalMutationRejectsDirtyAndBlockedRichDrafts() async throws {
        let date = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(date, calendar: .current)
        let rich = richState(node, text: "before")
        let localDate = try LocalDate(validating: localDateStamp(date, calendar: .current))
        let input = try PrepareMeetingInDailyNoteInput(
            workspaceId: workspace, dailyNoteId: node, localDate: localDate,
            timeZone: try IanaTimeZone(validating: "UTC"), occurrenceKey: String(repeating: "a", count: 64),
            intent: try LoroMutationIntentV1(requestId: "rich-external", commitMessage: "Prepare meeting context in daily note.", attribution: .humanUi(surface: "macos"))
        )
        let fake = FakeOperations(descriptors: [native(node), native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResults = [.editable(rich), .editable(rich)]
        fake.richSubmitResult = .invalidCommitMessage
        fake.preparationResult = try PrepareMeetingInDailyNoteOutput(dailyNoteId: node, localDate: localDate, occurrenceKey: input.occurrenceKey, status: .created, resultSnapshotSha256: String(repeating: "e", count: 64))
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: date, nativeLoroEditingEnabled: true)
        await model.start()
        let acceptedEditGeneration = model.acceptedHumanEditGeneration
        model.handleLoroRichDocumentChange(richDocument("dirty"))
        XCTAssertEqual(model.acceptedHumanEditGeneration, acceptedEditGeneration + 1)
        var dirtyRejected = false
        do { _ = try await model.prepareMeetingInDailyNote(input) } catch { dirtyRejected = true }
        XCTAssertTrue(dirtyRejected, "dirty rich draft must reject external mutation")
        try await waitUntil { model.loroRecoveryAction == .discardRichDraftAndReload || fake.nativeRichSubmitCount == 1 }
        var blockedRejected = false
        do { _ = try await model.prepareMeetingInDailyNote(input) } catch { blockedRejected = true }
        XCTAssertTrue(blockedRejected, "blocked rich draft must reject external mutation")

        XCTAssertEqual(fake.automergeResolveCount + fake.automergeSyncCount + fake.spliceCount, 0)
    }

    func testRetainedRetryCommittedRichRecoveryPreservesAWithoutResubmission() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let draft = richDocument("A")
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResult = .editable(richState(node, text: "before"))
        fake.richSubmitResult = .checkpointResolutionRequired(.retainedRetry); fake.retryResult = .committed
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start(); model.handleLoroRichDocumentChange(draft)
        try await waitUntil { model.loroRecoveryAction == .retrySavedChange }
        model.performLoroRecoveryAction()
        try await waitUntil { model.loroRecoveryAction == .discardRichDraftAndReload && !model.isLoroRecoveryInProgress }
        XCTAssertEqual(model.loroRichDraft, draft)
        XCTAssertEqual(fake.retryCount, 1)
        XCTAssertEqual(fake.nativeRichSubmitCount, 1)
    }

    func testCommittedRichRecoveryPreservesAUntilExplicitDiscardAndFreshWitness() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let initial = richState(node, text: "before")
        let fresh = richState(node, text: "authority")
        let draft = richDocument("A")
        let fake = FakeOperations(descriptors: [native(node), native(node), native(node), native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResult = .editable(initial)
        fake.richSubmitResult = .checkpointResolutionRequired(.inFlight)
        fake.recoveryResult = .committed
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start(); model.handleLoroRichDocumentChange(draft)
        try await waitUntil { model.loroRecoveryAction == .continueRecovery }
        try await Task.sleep(nanoseconds: 20_000_000)
        model.performLoroRecoveryAction()
        try await waitUntil { model.loroRecoveryAction == .discardRichDraftAndReload && !model.isLoroRecoveryInProgress }
        XCTAssertEqual(model.loroRichDraft, draft)
        XCTAssertEqual(fake.nativeRichSubmitCount, 1)

        fake.richEligibilityResult = .ineligible
        model.performLoroRecoveryAction()
        try await waitUntil { model.loroNotice == "Reload did not establish an editable rich-text page." && !model.isLoroRecoveryInProgress }
        XCTAssertEqual(model.loroRichDraft, draft)

        fake.richEligibilityResult = .editable(fresh)
        try await Task.sleep(nanoseconds: 20_000_000)
        model.performLoroRecoveryAction()
        try await waitUntil { model.loroRichEditorState == fresh }
        XCTAssertEqual(model.loroRichDraft, fresh.document)
        XCTAssertEqual(fake.nativeRichSubmitCount, 1)
        XCTAssertEqual(fake.automergeResolveCount + fake.automergeSyncCount + fake.spliceCount, 0)
    }

    func testGenericRichRecoveryPreservesAForEveryNonAdmittingResolution() async throws {
        let date = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(date, calendar: .current)
        let draft = richDocument("A")
        let cases: [(LoroSemanticCheckpointResolution, String?)] = [
            (.inFlight, "continue"),
            (.deniedAuthorizationOrSession, "continue"),
            (.retainedRetry, "retry"),
            (.retainedConflict, nil),
            (.retainedRequestIdentity, nil),
            (.none, "discard")
        ]

        for (resolution, expectedAction) in cases {
            let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
            fake.eligibilityResult = .ineligible
            fake.richEligibilityResult = .editable(richState(node, text: "before"))
            fake.richSubmitResult = .checkpointResolutionRequired(.inFlight)
            let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: date, nativeLoroEditingEnabled: true)
            await model.start()
            fake.recoveryResult = resolution
            model.handleLoroRichDocumentChange(draft)
            try await waitUntil { model.loroRecoveryAction == .continueRecovery }

            let recoveryCountBeforeAction = fake.recoveryCount
            model.performLoroRecoveryAction()
            try await waitUntil { fake.recoveryCount == recoveryCountBeforeAction + 1 && !model.isLoroRecoveryInProgress }

            XCTAssertEqual(model.pagePresentation, .loroRichEditable, "\(resolution) must retain rich presentation")
            XCTAssertEqual(model.loroRichDraft, draft, "\(resolution) must retain Draft A")
            XCTAssertEqual(model.selectedDate, Calendar.current.startOfDay(for: date))
            switch expectedAction {
            case "continue": XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)
            case "retry": XCTAssertEqual(model.loroRecoveryAction, .retrySavedChange)
            case "discard": XCTAssertEqual(model.loroRecoveryAction, .discardRichDraftAndReload)
            case nil: XCTAssertNil(model.loroRecoveryAction)
            default: XCTFail("unexpected action fixture")
            }
            XCTAssertEqual(fake.nativeRichSubmitCount, 1, "generic recovery must not resubmit Draft A")
            XCTAssertEqual(fake.acceptedLiteralRecoveryCount, 0, "rich recovery must not enter the plain lane")
            XCTAssertEqual(fake.acceptedRichLiteralRecoveryCount, 0, "generic checkpoint recovery must not replace Draft A with accepted evidence")
        }
    }

    func testDebouncedRichSubmissionPreservesDraftWithResolutionSpecificAction() async throws {
        let date = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(date, calendar: .current)
        let draft = richDocument("A")
        let cases: [(LoroSemanticCheckpointResolution, AthenaeumViewModel.LoroRecoveryAction?)] = [
            (.inFlight, .continueRecovery),
            (.deniedAuthorizationOrSession, .continueRecovery),
            (.retainedRetry, .retrySavedChange),
            (.retainedConflict, nil),
            (.retainedRequestIdentity, nil),
            (.none, .discardRichDraftAndReload)
        ]

        for (resolution, expectedAction) in cases {
            let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
            fake.eligibilityResult = .ineligible
            let base = richState(node, text: "before")
            fake.richEligibilityResult = .editable(base)
            fake.richSubmitResult = .checkpointResolutionRequired(resolution)
            let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: date, nativeLoroEditingEnabled: true)
            await model.start()
            let recoveryCountBeforeSubmission = fake.recoveryCount

            model.handleLoroRichDocumentChange(draft)
            try await waitUntil { fake.nativeRichSubmitCount == 1 && model.loroRecoveryAction == expectedAction }
            try await Task.sleep(nanoseconds: 50_000_000)

            XCTAssertEqual(model.pagePresentation, .loroRichEditable)
            XCTAssertEqual(model.loroRichDraft, draft)
            XCTAssertEqual(model.selectedDate, Calendar.current.startOfDay(for: date))
            XCTAssertTrue(model.isEditorInputDisabled, "a retained Draft A must remain under explicit recovery custody")
            XCTAssertEqual(model.loroRecoveryAction, expectedAction)
            XCTAssertEqual(fake.nativeRichSubmitCount, 1)
            XCTAssertEqual(fake.recoveryCount, recoveryCountBeforeSubmission, "resolution must not recover until its explicit action is invoked")
            XCTAssertEqual(fake.acceptedLiteralRecoveryCount, 0)
            XCTAssertEqual(fake.acceptedRichLiteralRecoveryCount, 0)
            XCTAssertEqual(fake.automergeResolveCount + fake.automergeSyncCount + fake.spliceCount, 0)
        }
    }

    func testRichNavigationFlushPreservesAWithResolutionSpecificRecoveryAction() async throws {
        let start = Date(timeIntervalSince1970: 0)
        let target = Calendar.current.date(byAdding: .day, value: 1, to: start)!
        let node = dailyNoteIdForDate(start, calendar: .current)
        let cases: [(LoroNativeRichDocumentSubmissionDisposition, String?)] = [
            (.checkpointResolutionRequired(.inFlight), "continue"),
            (.checkpointResolutionRequired(.deniedAuthorizationOrSession), "continue"),
            (.checkpointResolutionRequired(.retainedRetry), "retry"),
            (.checkpointResolutionRequired(.retainedConflict), nil),
            (.checkpointResolutionRequired(.retainedRequestIdentity), nil),
            (.unauthenticated, "continue")
        ]

        for (result, expectedAction) in cases {
            let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
            fake.eligibilityResult = .ineligible
            fake.richEligibilityResult = .editable(richState(node, text: "before"))
            fake.richSubmitResult = result
            let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: start, nativeLoroEditingEnabled: true)
            await model.start()
            model.handleLoroRichDocumentChange(richDocument("A"))
            model.showDate(target)
            try await waitUntil { fake.nativeRichSubmitCount == 1 && !model.isNavigating }

            XCTAssertEqual(model.pagePresentation, .loroRichEditable)
            XCTAssertEqual(model.loroRichDraft, richDocument("A"))
            XCTAssertEqual(model.selectedDate, Calendar.current.startOfDay(for: start))
            switch expectedAction {
            case "continue": XCTAssertEqual(model.loroRecoveryAction, .continueRecovery)
            case "retry": XCTAssertEqual(model.loroRecoveryAction, .retrySavedChange)
            case nil: XCTAssertNil(model.loroRecoveryAction)
            default: XCTFail("unexpected action fixture")
            }

            model.showDate(target)
            try await Task.sleep(nanoseconds: 30_000_000)
            XCTAssertEqual(fake.nativeRichSubmitCount, 1, "blocked rich Draft A must not be replayed during navigation")
        }
    }

    func testRichNavigationOnlyAdvancesForAcceptedSubmissionOutcomes() async throws {
        let start = Date(timeIntervalSince1970: 0)
        let target = Calendar.current.date(byAdding: .day, value: 1, to: start)!
        let node = dailyNoteIdForDate(start, calendar: .current)
        let targetNode = dailyNoteIdForDate(target, calendar: .current)
        for result in [LoroNativeRichDocumentSubmissionDisposition.submitted, .submittedNeedsReload, .noChange] {
            let current = richState(node, text: "before")
            let next = richState(targetNode, text: "next")
            let fake = FakeOperations(descriptors: [native(node), native(targetNode)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
            fake.eligibilityResults = [.ineligible, .ineligible]
            fake.richEligibilityResults = [.editable(current), .editable(next)]
            fake.richSubmitResult = result
            let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: start, nativeLoroEditingEnabled: true)
            await model.start(); model.handleLoroRichDocumentChange(richDocument("A")); model.showDate(target)
            try await waitUntil { model.selectedDate == Calendar.current.startOfDay(for: target) }
            XCTAssertEqual(fake.nativeRichSubmitCount, 1)
        }
    }

    func testBlockedRichDraftRetainsDateAndAInsteadOfNavigatingOrResubmitting() async throws {
        let start = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(start, calendar: .current)
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResult = .editable(richState(node, text: "before")); fake.richSubmitResult = .invalidCommitMessage
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: start, nativeLoroEditingEnabled: true)
        await model.start(); model.handleLoroRichDocumentChange(richDocument("A"))
        try await waitUntil { model.loroRecoveryAction == .discardRichDraftAndReload }
        model.showDate(Calendar.current.date(byAdding: .day, value: 1, to: start)!)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(model.selectedDate, Calendar.current.startOfDay(for: start))
        XCTAssertEqual(model.loroRichDraft, richDocument("A"))
        XCTAssertEqual(fake.nativeRichSubmitCount, 1)
    }

    func testRichSelectionAndRejectionAreEphemeralAndDoNotSubmit() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let rich = richState(node, text: "before")
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible; fake.richEligibilityResult = .editable(rich)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0), nativeLoroEditingEnabled: true)
        await model.start()
        model.handleLoroRichSelectionChange(.init(location: 1, length: 0))
        model.handleLoroRichRejectedInput(.invalidEdit)
        try await Task.sleep(nanoseconds: 600_000_000)
        XCTAssertEqual(model.loroRichDraft, rich.document)
        XCTAssertEqual(fake.nativeRichSubmitCount, 0)
    }

    func testDefaultNativePolicyAdmitsRichEditingForEveryNativeClient() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let rich = richState(node, text: "iOS admission")
        let fake = FakeOperations(descriptors: [native(node)], loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false))
        fake.eligibilityResult = .ineligible
        fake.richEligibilityResult = .editable(rich)
        let model = try AthenaeumViewModel(workspaceId: workspace, pageOperations: fake, date: Date(timeIntervalSince1970: 0))

        await model.start()

        XCTAssertEqual(model.pagePresentation, .loroRichEditable)
        XCTAssertEqual(model.loroRichEditorState, rich)
    }

    func testIosRichAdmissionUsesUIKitWithoutMacOnlyReadOnlyFallback() throws {
        let dailyNoteView = try appUISource(named: "DailyNoteView.swift")
        let viewModel = try appUISource(named: "AthenaeumViewModel.swift")

        XCTAssertTrue(dailyNoteView.contains("#elseif os(iOS)"))
        XCTAssertTrue(dailyNoteView.contains("LoroNativeRichTextEditorUIKit("))
        XCTAssertFalse(dailyNoteView.contains("Native rich-text editing is available on macOS"))
        XCTAssertTrue(viewModel.contains("self.nativeLoroEditingEnabled = true"))
        XCTAssertFalse(viewModel.contains("self.nativeLoroEditingEnabled = nativeLoroEditingEnabled ?? false"))
    }

    func testDailyNoteKeepsContextualProjectionMountedBetweenEditorAndResolvedSecondaries() throws {
        let source = try appUISource(named: "DailyNoteView.swift")
        let body = try operationBody(
            in: source,
            startingAt: "public var body: some View {",
            endingBefore: "private var hasResolvedDailyNote"
        )

        XCTAssertEqual(body.components(separatedBy: "if let contextualView").count - 1, 1)
        let statusIndex = try XCTUnwrap(body.range(of: "switch model.status")?.lowerBound)
        let contextIndex = try XCTUnwrap(body.range(of: "if let contextualView")?.lowerBound)
        let standupIndex = try XCTUnwrap(body.range(of: "DailyStandupView(")?.lowerBound)
        let backlinksIndex = try XCTUnwrap(body.range(of: "BacklinksView(model: model)")?.lowerBound)

        XCTAssertLessThan(statusIndex, contextIndex)
        XCTAssertLessThan(contextIndex, standupIndex)
        XCTAssertLessThan(standupIndex, backlinksIndex)
    }

    func testDailyNoteSupertagPreexistingMembershipIsDisplayedAndNeverReapplied() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let tagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let tag = try XCTUnwrap(Self.supertag(id: tagID, name: "Person"))
        let client = FakeDailyNoteSupertagClient(
            tags: [tag],
            membershipRows: [Self.membershipRow(node: node, tag: tagID)]
        )
        let model = try makeSupertagModel(client: client)

        await model.start()

        guard case .loaded(let tags, let applied) = model.dailyNoteSupertagAssignmentState else {
            return XCTFail("expected an authoritative loaded Supertag snapshot")
        }
        XCTAssertEqual(tags.map(\.id), [tagID.rawValue])
        XCTAssertEqual(applied, [tagID.rawValue])
        await model.applyDailyNoteSupertag(tagId: tagID.rawValue)
        XCTAssertEqual(client.applyCount, 0, "an already-applied tag must be a read-only disabled action")
    }

    func testDailyNoteSupertagUnknownMembershipFailsClosed() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let tagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let unknownTagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62")
        let tag = try XCTUnwrap(Self.supertag(id: tagID, name: "Person"))
        let client = FakeDailyNoteSupertagClient(
            tags: [tag],
            membershipRows: [Self.membershipRow(node: node, tag: unknownTagID)]
        )
        let model = try makeSupertagModel(client: client)

        await model.start()

        XCTAssertEqual(model.dailyNoteSupertagAssignmentState, .failed)
        await model.applyDailyNoteSupertag(tagId: tagID.rawValue)
        XCTAssertEqual(client.applyCount, 0, "catalog/membership disagreement must not expose a mutation")
    }

    func testDailyNoteSupertagResponseLossRetainsRequestIdentityUntilAuthoritativeReconciliation() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let tagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let tag = try XCTUnwrap(Self.supertag(id: tagID, name: "Person"))
        let client = FakeDailyNoteSupertagClient(
            tags: [tag],
            membershipRowsByApplyCount: [
                [], [], [Self.membershipRow(node: node, tag: tagID)]
            ]
        )
        client.applyResults = [
            .failure(DailyNoteSupertagTestError.responseLost),
            .success(ApplySupertagOutput(nodeId: node, tagId: tagID, facts: []))
        ]
        let model = try makeSupertagModel(client: client)
        await model.start()

        await model.applyDailyNoteSupertag(tagId: tagID.rawValue)

        XCTAssertEqual(client.applyCount, 1)
        XCTAssertTrue(model.isDailyNoteSupertagRetryAvailable, "an unconfirmed response must leave the exact request retryable")
        let firstRequestID = try XCTUnwrap(client.appliedInputs.first?.requestId)
        await model.retryDailyNoteSupertagAssignment()

        XCTAssertEqual(client.applyCount, 2)
        XCTAssertEqual(client.appliedInputs.map(\.requestId), [firstRequestID, firstRequestID])
        guard case .loaded(_, let applied) = model.dailyNoteSupertagAssignmentState else {
            return XCTFail("expected the post-retry membership read to be loaded")
        }
        XCTAssertEqual(applied, [tagID.rawValue])
        XCTAssertFalse(model.isDailyNoteSupertagRetryAvailable, "confirmed membership clears the retained intent")
    }

    func testDailyNoteSupertagConcurrentPressesCreateOneMutation() async throws {
        let node = dailyNoteIdForDate(Date(timeIntervalSince1970: 0), calendar: .current)
        let tagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let tag = try XCTUnwrap(Self.supertag(id: tagID, name: "Person"))
        let client = FakeDailyNoteSupertagClient(
            tags: [tag],
            membershipRowsByApplyCount: [[], [Self.membershipRow(node: node, tag: tagID)]]
        )
        client.applyDelayNanoseconds = 100_000_000
        let model = try makeSupertagModel(client: client)
        await model.start()

        let first = Task { await model.applyDailyNoteSupertag(tagId: tagID.rawValue) }
        try await Task.sleep(nanoseconds: 10_000_000)
        let second = Task { await model.applyDailyNoteSupertag(tagId: tagID.rawValue) }
        await first.value
        await second.value

        XCTAssertEqual(client.applyCount, 1, "the synchronous pending-intent claim must fence a second press")
    }

    func testDailyNoteSupertagStaleMutationCompletionCannotReleaseNewerClaim() {
        var gate = DailyNoteSupertagMutationGate()
        guard let first = gate.claim() else { return XCTFail("expected the first mutation claim") }
        XCTAssertTrue(gate.release(first))
        guard let newer = gate.claim() else { return XCTFail("expected the newer mutation claim") }

        XCTAssertFalse(gate.release(first), "a delayed first completion cannot release the newer claim")
        XCTAssertEqual(gate.activeToken, newer)
        XCTAssertTrue(gate.release(newer))
        XCTAssertNil(gate.activeToken)
    }

    func testDailyNoteSupertagMutationPinsTheExactDailyNoteUntilItsReceiptReconciles() async throws {
        let date = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(date, calendar: .current)
        let tagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let tag = try XCTUnwrap(Self.supertag(id: tagID, name: "Person"))
        let client = FakeDailyNoteSupertagClient(
            tags: [tag],
            membershipRowsByApplyCount: [[], [Self.membershipRow(node: node, tag: tagID)]]
        )
        client.applyDelayNanoseconds = 150_000_000
        let model = try makeSupertagModel(client: client)
        await model.start()
        let pinnedDate = model.selectedDate

        let mutation = Task { await model.applyDailyNoteSupertag(tagId: tagID.rawValue) }
        try await Task.sleep(nanoseconds: 20_000_000)
        model.showDate(date.addingTimeInterval(86_400))

        XCTAssertEqual(model.selectedDate, pinnedDate, "navigation must not discard a claimed note-level semantic operation")
        await mutation.value
        XCTAssertEqual(model.dailyNoteId, node, "the accepted receipt belongs only to the pinned note")
        XCTAssertEqual(client.appliedInputs.map(\.nodeId), [node.rawValue])
    }

    func testDailyNoteSupertagLateCatalogSnapshotCannotOverwriteNewerSameNoteGeneration() async throws {
        let tagAID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let tagBID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62")
        let client = FakeDailyNoteSupertagClient(tags: [try XCTUnwrap(Self.supertag(id: tagAID, name: "Old"))])
        let model = try makeSupertagModel(client: client)
        await model.start()

        client.blockNextCatalogRead = true
        let staleRefresh = Task { await model.refreshDailyNoteSupertags() }
        try await waitUntil { client.catalogReadBlocked }
        client.tags = [try XCTUnwrap(Self.supertag(id: tagBID, name: "Current"))]
        await model.refreshDailyNoteSupertags()
        client.releaseCatalogRead()
        await staleRefresh.value

        guard case .loaded(let tags, _) = model.dailyNoteSupertagAssignmentState else { return XCTFail("expected latest snapshot") }
        XCTAssertEqual(tags.map(\.id), [tagBID.rawValue])
        XCTAssertEqual(client.listTagsCount, 3, "only the explicitly requested stale/current generations may run")
    }

    func testDailyNoteSupertagLateSnapshotCannotPublishAfterDateChanges() async throws {
        let dateA = Date(timeIntervalSince1970: 0)
        let dateB = dateA.addingTimeInterval(86_400)
        let nodeA = dailyNoteIdForDate(dateA, calendar: .current)
        let nodeB = dailyNoteIdForDate(dateB, calendar: .current)
        let tagAID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let tagBID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62")
        let tagA = try XCTUnwrap(Self.supertag(id: tagAID, name: "A"))
        let tagB = try XCTUnwrap(Self.supertag(id: tagBID, name: "B"))
        let operations = FakeOperations(
            descriptors: [native(nodeA, snapshot: "a"), native(nodeB, snapshot: "b")],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false)
        )
        operations.eligibilityResults = [
            .editable(Self.plainEditorState(node: nodeA, text: "A", snapshot: "a")),
            .editable(Self.plainEditorState(node: nodeB, text: "B", snapshot: "b"))
        ]
        let client = FakeDailyNoteSupertagClient(tags: [tagA])
        let model = try makeSupertagModel(client: client, operations: operations)
        await model.start()
        try await waitUntil {
            model.dailyNoteId == nodeA && model.loroPlainDraft == "A" &&
                model.dailyNoteSupertagAssignmentState != .idle
        }

        client.blockNextCatalogRead = true
        let staleRefresh = Task { await model.refreshDailyNoteSupertags() }
        try await waitUntil { client.catalogReadBlocked }

        client.tags = [tagB]
        model.showDate(dateB)
        try await waitUntil {
            model.dailyNoteId == nodeB && model.loroPlainDraft == "B" &&
                model.dailyNoteSupertagAssignmentState != .idle
        }

        client.releaseCatalogRead()
        await staleRefresh.value
        try await waitUntil {
            guard case .loaded(let tags, _) = model.dailyNoteSupertagAssignmentState else { return false }
            return tags.map(\.id) == [tagBID.rawValue]
        }

        guard case .loaded(let tags, _) = model.dailyNoteSupertagAssignmentState else {
            return XCTFail("expected the current date's authoritative snapshot")
        }
        XCTAssertEqual(tags.map(\.id), [tagBID.rawValue], "a stale A snapshot must not publish over date B")
        XCTAssertTrue(client.appliedInputs.isEmpty, "a stale read must never authorize a mutation on the new date")
    }

    func testDailyNoteSupertagDescriptorABARejectsLateReadFromTheFirstRoute() async throws {
        let date = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(date, calendar: .current)
        let oldTagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let currentTagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62")
        let finalTagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e63")
        let oldTag = try XCTUnwrap(Self.supertag(id: oldTagID, name: "Old"))
        _ = try XCTUnwrap(Self.supertag(id: currentTagID, name: "Current"))
        let finalTag = try XCTUnwrap(Self.supertag(id: finalTagID, name: "Final"))
        let operations = FakeOperations(
            descriptors: [native(node, snapshot: "a"), native(node, snapshot: "b"), native(node, snapshot: "a")],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: false)
        )
        operations.eligibilityResults = [
            .editable(Self.plainEditorState(node: node, text: "A", snapshot: "a")),
            .editable(Self.plainEditorState(node: node, text: "B", snapshot: "b")),
            .editable(Self.plainEditorState(node: node, text: "A", snapshot: "a"))
        ]
        let client = FakeDailyNoteSupertagClient(tags: [oldTag])
        let model = try makeSupertagModel(client: client, operations: operations)
        await model.start()
        try await waitUntil { model.loroPlainDraft == "A" && model.dailyNoteSupertagAssignmentState != .idle }

        client.blockNextMembershipRead = true
        let staleRefresh = Task { await model.refreshDailyNoteSupertags() }
        try await waitUntil { client.membershipReadBlocked }

        model.invalidatePageRouteForTesting()
        model.retryCurrentNote()
        try await waitUntil { model.loroPlainDraft == "B" }
        client.tags = [finalTag]
        model.retryCurrentNote()
        try await waitUntil { model.loroPlainDraft == "A" && operations.currentDescriptor == self.native(node, snapshot: "a") }
        client.releaseMembershipRead()
        await staleRefresh.value
        try await waitUntil {
            guard case .loaded(let tags, _) = model.dailyNoteSupertagAssignmentState else { return false }
            return tags.map(\.id) == [finalTagID.rawValue]
        }

        guard case .loaded(let tags, _) = model.dailyNoteSupertagAssignmentState else { return XCTFail("expected the final A route snapshot") }
        XCTAssertEqual(tags.map(\.id), [finalTagID.rawValue], "the stale first-route read must not publish over the final A route")
        XCTAssertEqual(operations.currentDescriptor, native(node, snapshot: "a"))
    }

    func testDailyNoteSupertagDirtyProjectionNeverMutates() async throws {
        let tagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let tag = try XCTUnwrap(Self.supertag(id: tagID, name: "Person"))
        let client = FakeDailyNoteSupertagClient(tags: [tag])
        let model = try makeSupertagModel(client: client, loroIsDirty: true, plainEligibility: false)
        await model.start()

        await model.applyDailyNoteSupertag(tagId: tagID.rawValue)

        XCTAssertEqual(client.applyCount, 0, "dirty Loro projection has no safe external-mutation boundary")
    }

    func testDailyNoteSupertagCleanReadOnlyRouteIsIneligible() {
        let projection = DailyNoteLoroReadOnlyState(format: .loroV1, schemaVersion: 1, isDirty: false)
        XCTAssertFalse(AthenaeumViewModel.isDailyNoteSupertagPresentationEligible(.loroReadOnly(projection)))
    }

    func testDailyNoteSupertagCleanProjectedRouteMakesNoCatalogMembershipOrApplyRPC() async throws {
        let tagID = try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61")
        let client = FakeDailyNoteSupertagClient(tags: [try XCTUnwrap(Self.supertag(id: tagID, name: "Person"))])
        let model = try makeSupertagModel(client: client, plainEligibility: false)

        await model.start()
        await model.applyDailyNoteSupertag(tagId: tagID.rawValue)

        guard case .loroProjectedReadOnly = model.pagePresentation else { return XCTFail("expected clean projected Loro route") }
        XCTAssertEqual(model.dailyNoteSupertagAssignmentState, .idle)
        XCTAssertEqual(client.listTagsCount, 0)
        XCTAssertEqual(client.membershipReadCount, 0)
        XCTAssertEqual(client.applyCount, 0)
    }

    private func makeSupertagModel(
        client: FakeDailyNoteSupertagClient,
        loroIsDirty: Bool = false,
        nativeLoroEditingEnabled: Bool = true,
        plainEligibility: Bool = true,
        operations: FakeOperations? = nil
    ) throws -> AthenaeumViewModel {
        let date = Date(timeIntervalSince1970: 0)
        let node = dailyNoteIdForDate(date, calendar: .current)
        let fake = operations ?? FakeOperations(
            descriptors: [native(node)],
            loroResult: .init(format: .loroV1, schemaVersion: 1, isDirty: loroIsDirty)
        )
        if operations == nil {
            fake.loroResult = .init(format: .loroV1, schemaVersion: 1, isDirty: loroIsDirty)
        }
        if operations == nil && nativeLoroEditingEnabled && plainEligibility {
            let route = LoroPageRouteWitness(
                nodeId: node,
                format: .loroV1,
                storageVersion: 1,
                schemaVersion: 1,
                snapshotSHA256: String(repeating: "b", count: 64)
            )
            fake.eligibilityResult = .editable(.init(
                text: "",
                scalarCount: 0,
                route: route,
                replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64))
            ))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EmptyWorkspaceRPCURLProtocol.self]
        let readClient = WorkspaceRPCClient(
            baseURL: URL(string: "http://daily-note-supertags.invalid")!,
            workspaceId: workspace.rawValue,
            urlSession: URLSession(configuration: configuration)
        )
        return try AthenaeumViewModel(
            workspaceId: workspace,
            pageOperations: fake,
            date: date,
            readClient: readClient,
            dailyNoteSupertagClient: client,
            nativeLoroEditingEnabled: nativeLoroEditingEnabled
        )
    }

    private static func supertag(id: EntityId, name: String) -> RPCTag? {
        RPCTag(id: id.rawValue, name: name, builtin: false)
    }

    private static func plainEditorState(node: EntityId, text: String, snapshot: Character) -> LoroNativePlainEditorState {
        .init(
            text: text,
            scalarCount: text.count,
            route: .init(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: snapshot, count: 64)),
            replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64))
        )
    }

    private static func membershipRow(node: EntityId, tag: EntityId) -> CapnWebValue {
        .object(["nodeId": .string(node.rawValue), "tagId": .string(tag.rawValue)])
    }

    private func liveDailyNoteOperationsSource() throws -> String {
        let package = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // AthenaeumAppUITests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // AthenaeumApp
        return try String(
            contentsOf: package.appendingPathComponent("Sources/AthenaeumAppUI/DailyNotePageOperations.swift"),
            encoding: .utf8
        )
    }

    private func appUISource(named name: String) throws -> String {
        let package = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(contentsOf: package.appendingPathComponent("Sources/AthenaeumAppUI/\(name)"), encoding: .utf8)
    }

    private func operationBody(
        in source: String,
        startingAt signature: String,
        endingBefore nextSignature: String
    ) throws -> String {
        let start = try XCTUnwrap(source.range(of: signature), "missing operation: \(signature)")
        let end = try XCTUnwrap(
            source.range(of: nextSignature, range: start.upperBound..<source.endIndex),
            "missing operation boundary: \(nextSignature)"
        )
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func waitUntil(
        _ predicate: @escaping @MainActor () -> Bool,
        timeoutNanoseconds: UInt64 = 2_000_000_000
    ) async throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
        while !predicate() {
            guard DispatchTime.now().uptimeNanoseconds < deadline else {
                return XCTFail("timed out waiting for asynchronous operation")
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func legacy(_ node: EntityId, version: Int, heads: String) -> PageDocumentDescriptor {
        .legacy(nodeId: node, storageVersion: version, automerge: .init(docId: node.rawValue, headsHash: heads, bytesSha256: String(repeating: "a", count: 64)))
    }
    private func migrated(_ node: EntityId, heads: String) -> PageDocumentDescriptor {
        .migratedLoro(nodeId: node, storageVersion: 2, automerge: .init(docId: node.rawValue, headsHash: heads, bytesSha256: String(repeating: "a", count: 64)), loro: .init(schemaVersion: 1, snapshotSha256: String(repeating: "b", count: 64)))
    }
    private func native(_ node: EntityId, version: Int = 1, snapshot: Character = "b") -> PageDocumentDescriptor {
        .nativeLoro(nodeId: node, storageVersion: version, loro: .init(schemaVersion: 1, snapshotSha256: String(repeating: snapshot, count: 64)))
    }
    private func richDocument(_ text: String) -> LoroNativeRichDocumentV1 {
        .init(semantic: .init(blocks: [.paragraph([.init(text: text)])]))
    }
    private func richState(_ node: EntityId, text: String) -> LoroNativeRichEditorState {
        .init(document: richDocument(text), route: .init(nodeId: node, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64)), replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)))
    }
}

@MainActor
private final class FakeOperations: DailyNotePageOperations {
    var descriptors: [PageDocumentDescriptor]
    private(set) var currentDescriptor: PageDocumentDescriptor?
    var descriptorError: Error?
    var durableHeads: String?
    var loadedHeads: String?
    var dirtyAutomerge: Bool
    var hasLocalLoro: Bool
    var loroResult: DailyNoteLoroReadOnlyState?
    var legacyProjectionOverride: DailyNoteLegacyReadOnlyState?
    var legacyProjectionIsRichText: Bool
    var dynamicLegacy: Bool
    var resolveDelayNanoseconds: UInt64
    var blocksAutomergeSync: Bool
    var projectionRouteOverride: LoroPageRouteWitness?
    var recoveryResult: LoroSemanticCheckpointResolution = .none
    var recoveryError: Error?
    var blocksRecovery = false
    var recoveryEntered = false
    var blockedRecoveryCompleted = false
    var retryResult: LoroSemanticCheckpointResolution = .none
    var eligibilityResult: LoroNativePlainEditorEligibility = .ineligible
    var eligibilityResults: [LoroNativePlainEditorEligibility] = []
    var acceptedLiteralRecoveryResult: LoroNativePlainEditorEligibility = .ineligible
    var acceptedLiteralRecoveryError: Error?
    /// Rich lifecycle values are deliberately kept distinct from the legacy plain-test seam.
    /// P3 can queue closed Core outcomes without manufacturing CRDT bytes or request identities.
    var richEligibilityResult: LoroNativeRichEditorEligibility = .ineligible
    var richEligibilityResults: [LoroNativeRichEditorEligibility] = []
    var acceptedRichLiteralRecoveryResult: LoroNativeRichEditorEligibility = .ineligible
    var acceptedRichLiteralRecoveryResults: [LoroNativeRichEditorEligibility] = []
    var richSubmitResult: LoroNativeRichDocumentSubmissionDisposition = .noChange
    var richSubmitResults: [LoroNativeRichDocumentSubmissionDisposition] = []
    var resolveNodeCount = 0
    var automergeResolveCount = 0
    var legacyProjectionCount = 0
    var automergeSyncCount = 0
    var automergeSyncEntered = false
    var automergeRichTextCount = 0
    var loroSyncCount = 0
    var loroCreateCount = 0
    var loroCreationIntents: [CreationIntent] = []
    var loroCreateError: Error?
    var spliceCount = 0
    var recoveryCount = 0
    var retryCount = 0
    var eligibilityCount = 0
    var acceptedLiteralRecoveryCount = 0
    var nativeSubmitCount = 0
    var richEligibilityCount = 0
    var acceptedRichLiteralRecoveryCount = 0
    var nativeRichSubmitCount = 0
    var nativeRichSubmitMessages: [String] = []
    var nativeRichSubmitDocuments: [LoroNativeRichDocumentV1] = []
    var nativeSubmitResult: LoroNativePlainTextSubmissionDisposition = .noChange
    var blocksNativeSubmit = false
    var nativeSubmitEntered = false
    var preparationCount = 0
    var preparedInputs: [PrepareMeetingInDailyNoteInput] = []
    var preparationResult: PrepareMeetingInDailyNoteOutput?

    private var automergeSyncContinuation: CheckedContinuation<Void, Never>?
    private var nativeSubmitContinuation: CheckedContinuation<Void, Never>?
    private var recoveryContinuation: CheckedContinuation<Void, Never>?

    init(descriptors: [PageDocumentDescriptor] = [], descriptorError: Error? = nil, durableHeads: String? = nil, loadedHeads: String? = nil, dirtyAutomerge: Bool = false, hasLocalLoro: Bool = false, loroResult: DailyNoteLoroReadOnlyState? = nil, legacyProjection: DailyNoteLegacyReadOnlyState? = nil, legacyProjectionIsRichText: Bool = false, dynamicLegacy: Bool = false, resolveDelayNanoseconds: UInt64 = 0, blocksAutomergeSync: Bool = false, projectionRouteOverride: LoroPageRouteWitness? = nil) {
        self.descriptors = descriptors; self.descriptorError = descriptorError; self.durableHeads = durableHeads; self.loadedHeads = loadedHeads; self.dirtyAutomerge = dirtyAutomerge; self.hasLocalLoro = hasLocalLoro; self.loroResult = loroResult; self.legacyProjectionOverride = legacyProjection; self.legacyProjectionIsRichText = legacyProjectionIsRichText; self.dynamicLegacy = dynamicLegacy; self.resolveDelayNanoseconds = resolveDelayNanoseconds; self.blocksAutomergeSync = blocksAutomergeSync; self.projectionRouteOverride = projectionRouteOverride
    }
    func resolveNode(id: EntityId, title: String) async throws { resolveNodeCount += 1; if resolveDelayNanoseconds > 0 { try await Task.sleep(nanoseconds: resolveDelayNanoseconds) } }
    func descriptor(nodeId: EntityId) async throws -> PageDocumentDescriptor {
        if let descriptorError { throw descriptorError }
        if dynamicLegacy {
            let descriptor = PageDocumentDescriptor.legacy(nodeId: nodeId, storageVersion: 1, automerge: .init(docId: nodeId.rawValue, headsHash: "h", bytesSha256: String(repeating: "a", count: 64)))
            currentDescriptor = descriptor
            return descriptor
        }
        guard !descriptors.isEmpty else { throw AthenaeumDomainError.unexpectedError(message: "no descriptor") }
        let descriptor = descriptors.count == 1 ? descriptors[0] : descriptors.removeFirst()
        currentDescriptor = descriptor
        return descriptor
    }
    func resolveOrCreateLoro(nodeId: EntityId, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor {
        loroCreateCount += 1
        loroCreationIntents.append(creationIntent)
        if let loroCreateError {
            self.loroCreateError = nil
            throw loroCreateError
        }
        return .nativeLoro(
            nodeId: nodeId,
            storageVersion: 1,
            loro: .init(schemaVersion: 1, snapshotSha256: String(repeating: "b", count: 64))
        )
    }
    func hasLocalLoroPage(nodeId: EntityId) async throws -> Bool { hasLocalLoro }
    func hasDirtyLocalAutomerge(nodeId: EntityId) async throws -> Bool { dirtyAutomerge }
    func localAutomergeHeads(nodeId: EntityId) async throws -> String? { durableHeads }
    func loadedAutomergeHeads(nodeId: EntityId) async throws -> String? { loadedHeads }
    func legacyPageProjection(nodeId: EntityId, descriptor: PageDocumentDescriptor, session: SyncSessionHandle) async throws -> DailyNoteLegacyReadOnlyState {
        legacyProjectionCount += 1
        if let legacyProjectionOverride { return legacyProjectionOverride }
        let text = try await resolveOrCreateAutomerge(nodeId: nodeId, session: session)
        guard case .legacy = descriptor else { throw DailyNotePageOperationError.invalidLegacyProjection(nodeId) }
        return DailyNoteLegacyReadOnlyState(text: text, descriptor: descriptor)
    }
    func resolveOrCreateAutomerge(nodeId: EntityId, session: SyncSessionHandle) async throws -> String { automergeResolveCount += 1; return "legacy" }
    func syncAutomerge(nodeId: EntityId, session: SyncSessionHandle) async throws -> String {
        automergeSyncCount += 1
        guard blocksAutomergeSync else { return "legacy" }
        automergeSyncEntered = true
        await withCheckedContinuation { automergeSyncContinuation = $0 }
        return "stale sync text"
    }
    func releaseAutomergeSync() {
        automergeSyncContinuation?.resume()
        automergeSyncContinuation = nil
    }
    func isAutomergeRichText(nodeId: EntityId) async throws -> Bool { automergeRichTextCount += 1; return legacyProjectionIsRichText }
    func applyAutomergeSplice(nodeId: EntityId, index: Int, deleteCount: Int, insertText: String) async throws { spliceCount += 1 }
    func syncLoroReadOnly(nodeId: EntityId) async throws -> DailyNoteLoroReadOnlyState {
        loroSyncCount += 1
        if let loroResult { return loroResult }
        throw AthenaeumDomainError.unexpectedError(message: "injected Loro failure")
    }
    func syncLoroProjection(nodeId: EntityId) async throws -> DailyNoteLoroProjectionState {
        loroSyncCount += 1
        guard let result = loroResult else { throw AthenaeumDomainError.unexpectedError(message: "injected Loro failure") }
        let descriptor = currentDescriptor ?? descriptors.first ?? .nativeLoro(nodeId: nodeId, storageVersion: 1, loro: .init(schemaVersion: 1, snapshotSha256: String(repeating: "b", count: 64)))
        let route: LoroPageRouteWitness
        switch descriptor {
        case .migratedLoro(_, let version, _, let loro), .nativeLoro(_, let version, let loro):
            route = .init(nodeId: nodeId, format: .loroV1, storageVersion: version, schemaVersion: loro.schemaVersion, snapshotSHA256: loro.snapshotSha256)
        case .legacy:
            route = .init(nodeId: nodeId, format: .loroV1, storageVersion: 1, schemaVersion: 1, snapshotSHA256: String(repeating: "b", count: 64))
        }
        return .init(.init(root: .document([.paragraph([.text("fixture", marks: [])])]), route: projectionRouteOverride ?? route, replica: .init(snapshotSHA256: String(repeating: "c", count: 64), versionVectorSHA256: String(repeating: "d", count: 64)), schemaVersion: result.schemaVersion, isDirty: result.isDirty))
    }
    func recoverInFlightLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution {
        recoveryCount += 1
        if blocksRecovery {
            recoveryEntered = true
            await withCheckedContinuation { recoveryContinuation = $0 }
            blockedRecoveryCompleted = true
        }
        if let recoveryError { throw recoveryError }
        return recoveryResult
    }
    func releaseRecovery() { recoveryContinuation?.resume(); recoveryContinuation = nil }
    func retryRetainedLoroSemanticCheckpoint(nodeId: EntityId) async throws -> LoroSemanticCheckpointResolution { retryCount += 1; return retryResult }
    func loroNativePlainEditorEligibility(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility {
        eligibilityCount += 1
        return eligibilityResults.isEmpty ? eligibilityResult : eligibilityResults.removeFirst()
    }
    func recoverAcceptedLoroLiteralForEditing(nodeId: EntityId) async throws -> LoroNativePlainEditorEligibility {
        acceptedLiteralRecoveryCount += 1
        if let acceptedLiteralRecoveryError { throw acceptedLiteralRecoveryError }
        return acceptedLiteralRecoveryResult
    }
    func submitNativePlainText(nodeId: EntityId, base: LoroNativePlainEditorState, proposedText: String) async throws -> LoroNativePlainTextSubmissionDisposition {
        nativeSubmitCount += 1
        guard blocksNativeSubmit else { return nativeSubmitResult }
        nativeSubmitEntered = true
        await withCheckedContinuation { nativeSubmitContinuation = $0 }
        return nativeSubmitResult
    }
    func loroNativeRichEditorEligibility(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility {
        richEligibilityCount += 1
        return richEligibilityResults.isEmpty ? richEligibilityResult : richEligibilityResults.removeFirst()
    }
    func recoverAcceptedLoroRichLiteralForEditing(nodeId: EntityId) async throws -> LoroNativeRichEditorEligibility {
        acceptedRichLiteralRecoveryCount += 1
        return acceptedRichLiteralRecoveryResults.isEmpty ? acceptedRichLiteralRecoveryResult : acceptedRichLiteralRecoveryResults.removeFirst()
    }
    func submitNativeRichDocumentV1(nodeId: EntityId, base: LoroNativeRichEditorState, proposed: LoroNativeRichDocumentV1, commitMessage: String) async throws -> LoroNativeRichDocumentSubmissionDisposition {
        nativeRichSubmitCount += 1
        nativeRichSubmitMessages.append(commitMessage)
        nativeRichSubmitDocuments.append(proposed)
        return richSubmitResults.isEmpty ? richSubmitResult : richSubmitResults.removeFirst()
    }
    func releaseNativeSubmit() { nativeSubmitContinuation?.resume(); nativeSubmitContinuation = nil }
    func prepareMeetingInDailyNote(_ input: PrepareMeetingInDailyNoteInput) async throws -> PrepareMeetingInDailyNoteOutput {
        preparationCount += 1
        preparedInputs.append(input)
        if let preparationResult { return preparationResult }
        throw DailyNotePageOperationError.externalMutationUnavailable(input.dailyNoteId)
    }
}

private enum DailyNoteSupertagTestError: Error {
    case responseLost
}

@MainActor
private final class FakeDailyNoteSupertagClient: DailyNoteSupertagClient {
    struct AppliedInput {
        let nodeId: String
        let tagId: String
        let requestId: String
        let commitMessage: String
        let attribution: MutationAttribution
    }

    var tags: [RPCTag]
    let initialMembershipRows: [CapnWebValue]
    let membershipRowsByApplyCount: [[CapnWebValue]]
    var applyResults: [Result<ApplySupertagOutput, Error>] = []
    var applyDelayNanoseconds: UInt64 = 0
    var listTagsCount = 0
    var membershipReadCount = 0
    var blockNextCatalogRead = false
    var catalogReadBlocked = false
    private var catalogReadContinuation: CheckedContinuation<Void, Never>?
    var blockNextMembershipRead = false
    var membershipReadBlocked = false
    private var membershipReadContinuation: CheckedContinuation<Void, Never>?
    var applyCount = 0
    var appliedInputs: [AppliedInput] = []

    init(
        tags: [RPCTag],
        membershipRows: [CapnWebValue] = [],
        membershipRowsByApplyCount: [[CapnWebValue]] = []
    ) {
        self.tags = tags
        self.initialMembershipRows = membershipRows
        self.membershipRowsByApplyCount = membershipRowsByApplyCount
    }

    func listTags() async throws -> [RPCTag] {
        listTagsCount += 1
        let snapshot = tags
        if blockNextCatalogRead {
            blockNextCatalogRead = false
            catalogReadBlocked = true
            await withCheckedContinuation { catalogReadContinuation = $0 }
            catalogReadBlocked = false
        }
        return snapshot
    }

    func releaseCatalogRead() {
        catalogReadContinuation?.resume()
        catalogReadContinuation = nil
    }

    func runView(viewName: String, viewSpec _: CapnWebValue) async throws -> [CapnWebValue] {
        membershipReadCount += 1
        guard viewName == "graph_node_tags" else { return [] }
        let snapshot: [CapnWebValue]
        if !membershipRowsByApplyCount.isEmpty {
            let index = min(applyCount, membershipRowsByApplyCount.count - 1)
            snapshot = membershipRowsByApplyCount[index]
        } else {
            snapshot = initialMembershipRows
        }
        if blockNextMembershipRead {
            blockNextMembershipRead = false
            membershipReadBlocked = true
            await withCheckedContinuation { membershipReadContinuation = $0 }
            membershipReadBlocked = false
        }
        return snapshot
    }

    func releaseMembershipRead() {
        membershipReadContinuation?.resume()
        membershipReadContinuation = nil
    }

    func applySupertag(
        nodeId: String,
        tagId: String,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution,
        fieldValues _: [ApplySupertagFieldValue]?
    ) async throws -> ApplySupertagOutput {
        applyCount += 1
        appliedInputs.append(.init(nodeId: nodeId, tagId: tagId, requestId: requestId, commitMessage: commitMessage, attribution: attribution))
        if applyDelayNanoseconds > 0 {
            try await Task.sleep(nanoseconds: applyDelayNanoseconds)
        }
        let result = applyResults.isEmpty
            ? Result.success(
                ApplySupertagOutput(
                    nodeId: try EntityId(validating: nodeId),
                    tagId: try EntityId(validating: tagId),
                    facts: []
                )
            )
            : applyResults.removeFirst()
        return try result.get()
    }
}

private final class EmptyWorkspaceRPCURLProtocol: URLProtocol {
    override class func canInit(with _: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = "[\"resolve\",1,{\"edges\":[],\"rows\":[],\"tags\":[]}]\n"
        let httpResponse = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
