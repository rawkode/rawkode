import XCTest
import AthenaeumDomain
import AthenaeumRPC
@testable import AthenaeumAppUI

private actor EmployeePublicationGate {
    private var continuation: CheckedContinuation<[StandupPublication], Never>?
    private(set) var waiting = false

    func wait() async -> [StandupPublication] {
        waiting = true
        return await withCheckedContinuation { continuation = $0 }
    }

    func resume(with publications: [StandupPublication]) {
        continuation?.resume(returning: publications)
        continuation = nil
    }
}

private actor EmployeePublicationCallCounter {
    private var count = 0

    func increment() { count += 1 }
    func value() -> Int { count }
}

private actor LedgerActivityGate {
    private var continuation: CheckedContinuation<[RPCLedgerActivityEntry], Never>?
    private(set) var windows: [DailyStandupDayWindow] = []
    private(set) var waiting = false

    func wait(window: DailyStandupDayWindow) async -> [RPCLedgerActivityEntry] {
        record(window)
        waiting = true
        return await withCheckedContinuation { continuation = $0 }
    }

    func record(_ window: DailyStandupDayWindow) { windows.append(window) }

    func resume(with entries: [RPCLedgerActivityEntry]) {
        continuation?.resume(returning: entries)
        continuation = nil
    }

    func recordedWindows() -> [DailyStandupDayWindow] { windows }
}

private actor InvocationCounter {
    private var count = 0

    func next() -> Int {
        count += 1
        return count
    }
}

private actor LifecycleSleepRecorder {
    private var dates: [Date] = []

    func record(_ date: Date) { dates.append(date) }
    func recordedDates() -> [Date] { dates }
}

@MainActor
final class DailyStandupViewTests: XCTestCase {
    func testEmployeeUpdatesPartitionOutcomesWithoutReorderingOrLabelingLegacyRows() throws {
        let publications = try [
            makePublication(id: "00000000-0000-4000-8000-000000000201", resultKind: .completed),
            makePublication(id: "00000000-0000-4000-8000-000000000202", resultKind: .blocked),
            makePublication(id: "00000000-0000-4000-8000-000000000203", resultKind: .failed),
            makePublication(id: "00000000-0000-4000-8000-000000000204", resultKind: .skipped),
            makePublication(id: "00000000-0000-4000-8000-000000000205")
        ]

        let partitions = EmployeeUpdatePresentation.partition(publications)

        XCTAssertEqual(
            partitions.needsAttention.map(\.id),
            [publications[1].id, publications[2].id]
        )
        XCTAssertEqual(
            partitions.updates.map(\.id),
            [publications[0].id, publications[3].id, publications[4].id]
        )
        XCTAssertEqual(EmployeeUpdatePresentation.outcome(for: .completed)?.label, "Completed")
        XCTAssertEqual(EmployeeUpdatePresentation.outcome(for: .blocked)?.label, "Blocked")
        XCTAssertEqual(EmployeeUpdatePresentation.outcome(for: .failed)?.label, "Failed")
        XCTAssertEqual(EmployeeUpdatePresentation.outcome(for: .skipped)?.label, "Skipped")
        XCTAssertNil(EmployeeUpdatePresentation.outcome(for: nil))
    }

    func testEmployeeUpdateOpenActionRequiresHealthyCompanionAndCallback() {
        let statuses: [StandupPublicationCompanionStatus] = [
            .verifiedOriginal, .modified, .missing, .unavailable
        ]

        for status in statuses {
            XCTAssertEqual(
                EmployeeUpdatePresentation.canOpenCompanion(status: status, hasOpenAction: true),
                status == .verifiedOriginal || status == .modified
            )
            XCTAssertFalse(
                EmployeeUpdatePresentation.canOpenCompanion(status: status, hasOpenAction: false)
            )
        }
    }

    func testAttentionStripCapsCountsRemainderAndKeepsOnlySafeReviewLabels() throws {
        let publications = try (0..<4).map { index in
            try makePublication(
                id: String(format: "00000000-0000-4000-8000-%012d", 300 + index),
                resultKind: .blocked
            )
        }
        let snapshot = WorkforceAttentionPresentation.snapshot(publications)
        XCTAssertEqual(snapshot.totalAttention, 4)
        XCTAssertEqual(snapshot.displayed.count, 3)
        XCTAssertEqual(snapshot.remainder, 1)
        XCTAssertEqual(snapshot.displayed.map(\.outcome), [.blocked, .blocked, .blocked])
        XCTAssertEqual(snapshot.displayed.map(\.employee), ["Executive", "Executive", "Executive"])
        XCTAssertEqual(snapshot.displayed.map(\.job), ["Daily standup", "Daily standup", "Daily standup"])
        XCTAssertEqual(WorkforceAttentionPresentation.summary(totalAttention: 4), "4 workforce updates need attention")
        XCTAssertEqual(WorkforceAttentionPresentation.remainderTitle(1), "and 1 more")
    }

    func testAttentionStripTreatsRoutinePublicationsAsClear() throws {
        let publication = try makePublication(id: "00000000-0000-4000-8000-000000000310", resultKind: .completed)
        let snapshot = WorkforceAttentionPresentation.snapshot([publication])
        XCTAssertTrue(snapshot.isClear)
        XCTAssertEqual(snapshot.routineCount, 1)
        XCTAssertEqual(
            WorkforceAttentionPresentation.summary(
                totalAttention: snapshot.totalAttention,
                routineCount: snapshot.routineCount
            ),
            "1 employee update · no exceptions"
        )
    }

    func testAttentionStripOnlyExposesReviewForVerifiedOrModifiedCompanions() throws {
        let verified = try makePublication(id: "00000000-0000-4000-8000-000000000320", resultKind: .blocked)
        let missing = try makePublication(id: "00000000-0000-4000-8000-000000000321", resultKind: .blocked, companionStatus: .missing)
        let unavailable = try makePublication(id: "00000000-0000-4000-8000-000000000322", resultKind: .blocked, companionStatus: .unavailable)

        let snapshot = WorkforceAttentionPresentation.snapshot([verified, missing, unavailable])

        XCTAssertEqual(snapshot.displayed.map(\.outcome), [.blocked, .blocked, .blocked])
        XCTAssertEqual(snapshot.displayed.map(\.isReviewAvailable), [true, false, false])
        XCTAssertEqual(snapshot.displayed.map(\.employee), ["Executive", "Executive", "Executive"])
        XCTAssertEqual(snapshot.displayed.map(\.job), ["Daily standup", "Daily standup", "Daily standup"])
    }

    func testAttentionStripUsesStackedLayoutForAccessibilityTypeAndKeepsReviewSpokenLabelSafe() throws {
        let publication = try makePublication(
            id: "00000000-0000-4000-8000-000000000330",
            resultKind: .blocked
        )
        let disclosure = try XCTUnwrap(WorkforceAttentionPresentation.snapshot([publication]).displayed.first)

        XCTAssertEqual(WorkforceAttentionLayout.mode(isAccessibilitySize: false), .inline)
        XCTAssertEqual(WorkforceAttentionLayout.mode(isAccessibilitySize: true), .stacked)
        XCTAssertTrue(WorkforceAttentionLayout.requiresStackedFallback(availableWidth: 320, intrinsicInlineWidth: 321))
        XCTAssertFalse(WorkforceAttentionLayout.requiresStackedFallback(availableWidth: 500, intrinsicInlineWidth: 321))
        XCTAssertEqual(
            WorkforceAttentionLayout.reviewAccessibilityLabel(for: disclosure),
            "Review Blocked update from Executive for Daily standup"
        )
    }

    func testRefreshPresentationPreventsRapidDuplicateActionsAndRestoresControls() {
        var isRefreshInFlight = false

        XCTAssertTrue(DailyStandupRefreshPresentation.canStartRefresh(isRefreshInFlight: isRefreshInFlight))
        XCTAssertEqual(DailyStandupRefreshPresentation.actionTitle(isRefreshing: false), "Refresh")
        XCTAssertEqual(DailyStandupRefreshPresentation.retryTitle(isRefreshing: false), "Retry")
        XCTAssertEqual(DailyStandupRefreshPresentation.progressTitle(isRefreshing: false), "Loading standup…")

        isRefreshInFlight = true
        XCTAssertFalse(DailyStandupRefreshPresentation.canStartRefresh(isRefreshInFlight: isRefreshInFlight))
        XCTAssertEqual(DailyStandupRefreshPresentation.actionTitle(isRefreshing: true), "Refreshing…")
        XCTAssertEqual(DailyStandupRefreshPresentation.retryTitle(isRefreshing: true), "Retrying…")
        XCTAssertEqual(DailyStandupRefreshPresentation.progressTitle(isRefreshing: true), "Refreshing recorded work…")

        isRefreshInFlight = false
        XCTAssertTrue(DailyStandupRefreshPresentation.canStartRefresh(isRefreshInFlight: isRefreshInFlight))
    }

    func testRecentActivityUsesTheSupportedWindowAndCalmDisclosureDefault() throws {
        XCTAssertEqual(DailyStandupPresentation.fetchLimit, 20)
        XCTAssertEqual(DailyStandupPresentation.initialVisibleEntryCount, 8)

        let timestamp = try IsoDateTimeString(validating: "2026-08-27T09:30:00.000Z")
        let entries = (0..<9).map { index in
            RPCLedgerActivityEntry(
                occurredAt: timestamp,
                type: .createNodeWithIntent,
                actor: .workspaceMember,
                message: "Recorded change \(index + 1)"
            )
        }

        XCTAssertEqual(DailyStandupPresentation.visibleEntries(entries, isExpanded: false).count, 8)
        XCTAssertEqual(DailyStandupPresentation.visibleEntries(entries, isExpanded: true).count, 9)
        XCTAssertEqual(DailyStandupPresentation.additionalEntryCount(entries), 1)
        XCTAssertEqual(
            DailyStandupPresentation.disclosureTitle(isExpanded: false, additionalEntryCount: 1),
            "Show 1 more recorded change"
        )
        XCTAssertEqual(
            DailyStandupPresentation.disclosureTitle(isExpanded: true, additionalEntryCount: 1),
            "Show fewer recorded changes"
        )
    }

    func testRecentActivityDoesNotNeedDisclosureWhenItFitsTheCalmDefault() throws {
        let timestamp = try IsoDateTimeString(validating: "2026-08-27T09:30:00.000Z")
        let entries = (0..<8).map { index in
            RPCLedgerActivityEntry(
                occurredAt: timestamp,
                type: .createNodeWithIntent,
                actor: .workspaceMember,
                message: "Recorded change \(index + 1)"
            )
        }

        XCTAssertEqual(DailyStandupPresentation.visibleEntries(entries, isExpanded: false).count, 8)
        XCTAssertEqual(DailyStandupPresentation.additionalEntryCount(entries), 0)
    }

    func testSummaryAccessibilityStillNamesEachActorBucket() throws {
        let summary = DailyStandupSummary(
            entries: [
                RPCLedgerActivityEntry(
                    occurredAt: try IsoDateTimeString(validating: "2026-08-27T09:30:00.000Z"),
                    type: .createNodeWithIntent,
                    actor: .you,
                    message: "Captured a priority."
                ),
                RPCLedgerActivityEntry(
                    occurredAt: try IsoDateTimeString(validating: "2026-08-27T09:31:00.000Z"),
                    type: .commitLoroPageContent,
                    actor: .workspaceMember,
                    message: "Recorded a meeting outcome."
                )
            ]
        )

        XCTAssertEqual(summary.total, 2)
        XCTAssertEqual(summary.byYou, 1)
        XCTAssertEqual(summary.byWorkspaceMembers, 1)
        XCTAssertTrue(summary.accessibilityLabel.contains("2 changes"))
        XCTAssertTrue(summary.accessibilityLabel.contains("1 by you"))
        XCTAssertTrue(summary.accessibilityLabel.contains("1 by workspace members"))
    }

    func testRefreshLoadsRecordedWork() async throws {
        let entry = RPCLedgerActivityEntry(
            occurredAt: try IsoDateTimeString(validating: "2026-08-26T09:30:00.000Z"),
            type: .applySupertag,
            actor: .you,
            message: "Applied Supertag to a workspace node."
        )
        let model = DailyStandupViewModel(loader: { _ in [entry] })

        await model.refresh()

        XCTAssertEqual(model.state, .loaded([entry]))
    }

    func testRefreshSurfacesSafeFailure() async {
        let model = DailyStandupViewModel(loader: { _ in throw TestFailure.load })

        await model.refresh()

        XCTAssertEqual(model.state, .failed("Unable to load the daily standup. Please try again."))
    }

    func testHistoricalRefreshSkipsLedgerAndLoadsEmployeeUpdates() async throws {
        let employeeCalls = EmployeePublicationCallCounter()
        let noteId = try EntityId(validating: "00000000-0000-4000-8000-000000000101")
        let publication = try makePublication(id: "00000000-0000-4000-8000-000000000102")
        let model = DailyStandupViewModel(
            ledgerLoader: nil,
            employeeLoaderFactory: { requestedNoteId in
                XCTAssertEqual(requestedNoteId, noteId)
                await employeeCalls.increment()
                return [publication]
            },
            dailyNoteId: noteId
        )

        // A historical note has no ledger loader at all. This makes the Today-only rule a
        // runtime property rather than a visual `if` around a still-running request.
        await model.refresh()

        let callCount = await employeeCalls.value()
        XCTAssertEqual(callCount, 1)
        XCTAssertEqual(model.state, .idle)
        XCTAssertEqual(model.employeeState, .loaded([publication]))
    }

    func testChangingDailyNoteIgnoresAnInFlightOlderEmployeeResponse() async throws {
        let firstNoteId = try EntityId(validating: "00000000-0000-4000-8000-000000000111")
        let secondNoteId = try EntityId(validating: "00000000-0000-4000-8000-000000000112")
        let firstPublication = try makePublication(id: "00000000-0000-4000-8000-000000000113")
        let secondPublication = try makePublication(id: "00000000-0000-4000-8000-000000000114")
        let gate = EmployeePublicationGate()
        let model = DailyStandupViewModel(
            ledgerLoader: nil,
            employeeLoaderFactory: { requestedNoteId in
                if requestedNoteId == firstNoteId { return await gate.wait() }
                return [secondPublication]
            },
            dailyNoteId: firstNoteId
        )

        let firstRefresh = Task { await model.refresh() }
        for _ in 0..<20 where !(await gate.waiting) { await Task.yield() }
        model.updateDailyNoteId(secondNoteId)
        await model.refresh()
        await gate.resume(with: [firstPublication])
        await firstRefresh.value

        XCTAssertEqual(model.employeeState, .loaded([secondPublication]))
    }

    func testLocalizedFailureSuppressesUnderlyingTransportDetails() async {
        let error = PrivateLocalizedFailure()
        let model = DailyStandupViewModel(loader: { _ in throw error })

        await model.refresh()

        XCTAssertEqual(model.state, .failed("Unable to load the daily standup. Please try again."))
        if case .failed(let message) = model.state {
            XCTAssertFalse(message.contains(error.errorDescription ?? ""))
        } else {
            XCTFail("Expected failed state")
        }
    }

    func testAddFactActivityMatchesThePublicLedgerVocabulary() {
        let type = RPCLedgerActivityType(rawValue: "addFact")

        XCTAssertEqual(type, .addFact)
        XCTAssertEqual(type?.displayName, "Updated a workspace fact")
        XCTAssertEqual(type?.systemImage, "list.bullet.rectangle")
    }

    func testCreateEdgeActivityMatchesThePublicLedgerVocabulary() {
        let type = RPCLedgerActivityType(rawValue: "createEdge")

        XCTAssertEqual(type, .createEdge)
        XCTAssertEqual(type?.displayName, "Created a relationship")
        XCTAssertEqual(type?.systemImage, "link")
    }

    func testCreateTagActivityMatchesThePublicLedgerVocabulary() {
        let type = RPCLedgerActivityType(rawValue: "createTag")

        XCTAssertEqual(type, .createTag)
        XCTAssertEqual(type?.displayName, "Created a Supertag definition")
        XCTAssertEqual(type?.systemImage, "tag")
    }

    func testCreateNodeWithIntentActivityMatchesThePublicLedgerVocabulary() {
        let type = RPCLedgerActivityType(rawValue: "createNodeWithIntent")

        XCTAssertEqual(type, .createNodeWithIntent)
        XCTAssertEqual(type?.displayName, "Created a node with provenance")
        XCTAssertEqual(type?.systemImage, "checkmark.seal")
    }

    func testSummaryKeepsActorAttributionVisible() throws {
        let timestamp = try IsoDateTimeString(validating: "2026-08-27T09:30:00.000Z")
        let entries = [
            RPCLedgerActivityEntry(occurredAt: timestamp, type: .createNodeWithIntent, actor: .you, message: "Create the person entity."),
            RPCLedgerActivityEntry(occurredAt: timestamp, type: .createEdge, actor: .anonymous, message: "Link the attendee to the event."),
            RPCLedgerActivityEntry(occurredAt: timestamp, type: .createTag, actor: .workspaceMember, message: "Create the Person Supertag.")
        ]

        let summary = DailyStandupSummary(entries: entries)

        XCTAssertEqual(summary.total, 3)
        XCTAssertEqual(summary.byYou, 1)
        XCTAssertEqual(summary.byWorkspaceMembers, 1)
        XCTAssertEqual(summary.byAutomatedActors, 1)
    }

    func testSummaryUsesNamedActorDetailWhenPresent() throws {
        let timestamp = try IsoDateTimeString(validating: "2026-08-27T09:30:00.000Z")
        let entries = [
            RPCLedgerActivityEntry(occurredAt: timestamp, type: .createNodeWithIntent, actor: .workspaceMember, message: "Enrich the person.", actorDetail: .init(kind: .employee, label: "Enrichment employee")),
            RPCLedgerActivityEntry(occurredAt: timestamp, type: .createNodeWithIntent, actor: .workspaceMember, message: "Create the person.", actorDetail: .init(kind: .user, label: "You"))
        ]

        let summary = DailyStandupSummary(entries: entries)

        XCTAssertEqual(summary.total, 2)
        XCTAssertEqual(summary.byYou, 1)
        XCTAssertEqual(summary.byWorkspaceMembers, 1)
        XCTAssertEqual(summary.byAutomatedActors, 0)
    }

    func testStandupWindowUsesTheLocalCalendarDay() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 3_600)!
        let window = DailyStandupDayWindow(
            now: Date(timeIntervalSince1970: 1_756_297_800), // 2025-08-27 12:30:00 +01:00
            calendar: calendar
        )

        XCTAssertEqual(window.from, "2025-08-26T23:00:00.000Z")
        XCTAssertEqual(window.to, "2025-08-27T23:00:00.000Z")
    }

    func testLifecycleSchedulesTheNextLocalMidnight() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = Date(timeIntervalSince1970: 1_782_000_000)
        let next = DailyStandupLifecyclePresentation.nextLocalMidnight(after: now, calendar: calendar)
        XCTAssertEqual(calendar.startOfDay(for: next), next)
        XCTAssertGreaterThan(next, now)
    }

    func testLifecycleDriverIsInjectableWithoutWallClockOrRealSleep() async throws {
        let now = Date(timeIntervalSince1970: 1_782_000_000)
        let recorder = LifecycleSleepRecorder()
        let driver = DailyStandupLifecycleDriver(
            now: { now },
            sleepUntil: { date in await recorder.record(date) }
        )
        let midnight = DailyStandupLifecyclePresentation.nextLocalMidnight(after: driver.now())

        try await driver.sleepUntil(midnight)

        let recordedDates = await recorder.recordedDates()
        XCTAssertEqual(recordedDates, [midnight])
    }

    func testLedgerLaneCanCompleteWhileEmployeeLaneIsStillLoading() async throws {
        let entry = RPCLedgerActivityEntry(
            occurredAt: try IsoDateTimeString(validating: "2026-06-28T09:30:00.000Z"), type: .addFact, actor: .you, message: "Ledger"
        )
        let publication = try makePublication(id: "00000000-0000-4000-8000-000000000420")
        let gate = EmployeePublicationGate()
        let model = DailyStandupViewModel(loader: { _ in [entry] }, employeeLoader: { await gate.wait() })

        let refresh = Task { await model.refresh() }
        for _ in 0..<20 where !(await gate.waiting) { await Task.yield() }
        for _ in 0..<20 {
            if case .loaded = model.state { break }
            await Task.yield()
        }

        XCTAssertEqual(model.state, .loaded([entry]))
        XCTAssertEqual(model.employeeState, .loading)
        await gate.resume(with: [publication])
        await refresh.value
        XCTAssertEqual(model.employeeState, .loaded([publication]))
    }

    func testLedgerRefreshUsesTheExactCapturedWindowAndRejectsOlderSameNoteResponse() async throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let windowA = DailyStandupDayWindow(now: Date(timeIntervalSince1970: 1_782_000_000), calendar: calendar)
        let windowB = DailyStandupDayWindow(now: Date(timeIntervalSince1970: 1_782_086_400), calendar: calendar)
        let old = RPCLedgerActivityEntry(
            occurredAt: try IsoDateTimeString(validating: "2026-06-27T09:30:00.000Z"), type: .addFact, actor: .you, message: "Old"
        )
        let current = RPCLedgerActivityEntry(
            occurredAt: try IsoDateTimeString(validating: "2026-06-28T09:30:00.000Z"), type: .addFact, actor: .you, message: "Current"
        )
        let gate = LedgerActivityGate()
        let calls = InvocationCounter()
        let model = DailyStandupViewModel(loader: { window in
            if await calls.next() == 1 { return await gate.wait(window: window) }
            await gate.record(window)
            return [current]
        })

        let first = Task { await model.refresh(window: windowA) }
        for _ in 0..<20 where !(await gate.waiting) { await Task.yield() }
        await model.refresh(window: windowB)
        await gate.resume(with: [old])
        await first.value

        let recordedWindows = await gate.recordedWindows()
        XCTAssertEqual(recordedWindows, [windowA, windowB])
        XCTAssertEqual(model.state, .loaded([current]))
    }

    func testSameNoteNewerEmployeeRefreshWinsOverOlderResponse() async throws {
        let noteId = try EntityId(validating: "00000000-0000-4000-8000-000000000401")
        let old = try makePublication(id: "00000000-0000-4000-8000-000000000402")
        let current = try makePublication(id: "00000000-0000-4000-8000-000000000403", resultKind: .completed)
        let gate = EmployeePublicationGate()
        let calls = InvocationCounter()
        let model = DailyStandupViewModel(
            ledgerLoader: nil,
            employeeLoaderFactory: { _ in
                if await calls.next() == 1 { return await gate.wait() }
                return [current]
            },
            dailyNoteId: noteId
        )

        let first = Task { await model.refresh() }
        for _ in 0..<20 where !(await gate.waiting) { await Task.yield() }
        await model.refresh()
        await gate.resume(with: [old])
        await first.value

        XCTAssertEqual(model.employeeState, .loaded([current]))
    }

    private enum TestFailure: Error {
        case load
    }

    private struct PrivateLocalizedFailure: LocalizedError {
        var errorDescription: String? {
            "backend=https://internal.example/api?credential=private-token"
        }
    }

    private func makePublication(
        id: String,
        resultKind: StandupPublicationResultKind? = nil,
        companionStatus: StandupPublicationCompanionStatus = .verifiedOriginal
    ) throws -> StandupPublication {
        let reference = StandupPublicationReference(kind: "job", id: "daily-standup", version: "v1")
        return StandupPublication(
            id: try EntityId(validating: id),
            civilDate: "2026-08-30",
            microEmployeeLabel: "Executive",
            jobLabel: "Daily standup",
            workflowLabel: "Morning review",
            scheduleLabel: "Weekdays",
            microEmployee: StandupPublicationReference(kind: "microEmployee", id: "executive", version: "v1"),
            job: reference,
            workflow: StandupPublicationReference(kind: "workflow", id: "morning", version: "v1"),
            schedule: StandupPublicationReference(kind: "schedule", id: "weekdays", version: "v1"),
            councilRefs: [],
            originalText: "Prepared the daily brief.",
            publishedAt: try IsoDateTimeString(validating: "2026-08-30T08:00:00.000Z"),
            childNodeId: try EntityId(validating: "00000000-0000-4000-8000-000000000115"),
            companionStatus: companionStatus,
            resultKind: resultKind
        )
    }
}
