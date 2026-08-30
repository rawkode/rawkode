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

@MainActor
final class DailyStandupViewTests: XCTestCase {
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

    func testRefreshLoadsRecordedWork() async throws {
        let entry = RPCLedgerActivityEntry(
            occurredAt: try IsoDateTimeString(validating: "2026-08-26T09:30:00.000Z"),
            type: .applySupertag,
            actor: .you,
            message: "Applied Supertag to a workspace node."
        )
        let model = DailyStandupViewModel(loader: { [entry] })

        await model.refresh()

        XCTAssertEqual(model.state, .loaded([entry]))
    }

    func testRefreshSurfacesSafeFailure() async {
        let model = DailyStandupViewModel(loader: { throw TestFailure.load })

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
        let model = DailyStandupViewModel(loader: { throw error })

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

    private enum TestFailure: Error {
        case load
    }

    private struct PrivateLocalizedFailure: LocalizedError {
        var errorDescription: String? {
            "backend=https://internal.example/api?credential=private-token"
        }
    }

    private func makePublication(id: String) throws -> StandupPublication {
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
            companionStatus: .verifiedOriginal
        )
    }
}
