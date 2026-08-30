import XCTest
import Foundation
import AthenaeumDomain
@testable import AthenaeumRPC
@testable import AthenaeumAppUI

@MainActor
final class TodayBriefViewTests: XCTestCase {
    func testLocalDateUsesCalendarComponentsWithoutClientSortingOrJoining() {
        XCTAssertEqual(
            TodayBriefViewModel.localDate(from: DateComponents(year: 2026, month: 8, day: 24)),
            "2026-08-24"
        )
    }

    func testLocalDateRejectsIncompleteComponents() {
        XCTAssertNil(TodayBriefViewModel.localDate(from: DateComponents(year: 2026, month: 8)))
    }

    func testRequestedLocalDatePinsHistoricalBriefToTheSelectedNote() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London")!
        let now = date("2026-08-30T23:30:00Z")
        let selectedDate = date("2026-08-26T00:00:00Z")

        XCTAssertEqual(
            TodayBriefViewModel.requestedLocalDate(
                referenceDate: selectedDate,
                now: now,
                calendar: calendar
            ),
            "2026-08-26"
        )
        XCTAssertEqual(
            TodayBriefViewModel.requestedLocalDate(
                referenceDate: nil,
                now: now,
                calendar: calendar
            ),
            "2026-08-31"
        )
    }

    func testLoadFailureMessageCannotEchoProviderData() {
        let privateWireValue = "alice@example.test/provider-private-id"
        XCTAssertEqual(TodayBriefViewModel.safeErrorMessage, "Unable to load today’s brief. Please try again.")
        XCTAssertFalse(TodayBriefViewModel.safeErrorMessage.contains(privateWireValue))
    }

    func testFailurePresentationUsesSafeContextualCopyAndRetryContract() {
        let privateWireValue = "backend=https://internal.example/api?credential=private-token"

        XCTAssertEqual(TodayBriefFailurePresentation.title(isToday: true), "Today’s brief is unavailable")
        XCTAssertEqual(
            TodayBriefFailurePresentation.message(isToday: true),
            "We couldn’t resolve today’s calendar context. Retry to load it safely."
        )
        XCTAssertEqual(TodayBriefFailurePresentation.retryLabel(isToday: true), "Retry today’s brief")
        XCTAssertEqual(TodayBriefFailurePresentation.retryingLabel(isToday: true), "Retrying today’s brief…")
        XCTAssertEqual(
            TodayBriefFailurePresentation.retryHint(isToday: true),
            "Retries loading today’s calendar context."
        )
        XCTAssertEqual(
            TodayBriefFailurePresentation.accessibilityLabel(isToday: true),
            "Today’s brief is unavailable. We couldn’t resolve today’s calendar context. Retry to load it safely."
        )

        XCTAssertEqual(TodayBriefFailurePresentation.title(isToday: false), "Daily brief is unavailable")
        XCTAssertEqual(TodayBriefFailurePresentation.retryLabel(isToday: false), "Retry daily brief")
        XCTAssertFalse(TodayBriefFailurePresentation.message(isToday: true).contains(privateWireValue))
        XCTAssertFalse(TodayBriefFailurePresentation.accessibilityLabel(isToday: false).contains(privateWireValue))
    }

    func testRefreshPresentationPreventsRapidDuplicateActionsAndRestoresTheControl() {
        var isRefreshInFlight = false

        XCTAssertTrue(
            TodayBriefRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertEqual(TodayBriefRefreshPresentation.actionTitle(isRefreshing: false), "Refresh")
        XCTAssertEqual(
            TodayBriefRefreshPresentation.progressTitle(isRefreshInFlight: false),
            "Loading today’s brief…"
        )
        XCTAssertEqual(
            TodayBriefRefreshPresentation.progressTitle(isRefreshInFlight: false, isToday: false),
            "Loading daily brief…"
        )

        isRefreshInFlight = true
        XCTAssertFalse(
            TodayBriefRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
        XCTAssertEqual(TodayBriefRefreshPresentation.actionTitle(isRefreshing: true), "Refreshing…")
        XCTAssertEqual(
            TodayBriefRefreshPresentation.progressTitle(isRefreshInFlight: true),
            "Refreshing today’s brief…"
        )

        isRefreshInFlight = false
        XCTAssertTrue(
            TodayBriefRefreshPresentation.canStartRefresh(
                isRefreshInFlight: isRefreshInFlight
            )
        )
    }

    func testPreparationStatePreventsRapidDuplicatesAndLocksOnlyTheSuccessfulOccurrence() {
        var state = TodayBriefPreparationState()
        let firstOccurrence = "first-occurrence"
        let secondOccurrence = "second-occurrence"

        XCTAssertTrue(state.begin(for: firstOccurrence))
        XCTAssertTrue(state.isPreparing)
        XCTAssertFalse(state.begin(for: firstOccurrence))

        state.complete(for: secondOccurrence, succeeded: true)
        XCTAssertTrue(state.isPreparing)
        XCTAssertFalse(state.isPrepared(for: secondOccurrence))

        state.complete(for: firstOccurrence, succeeded: false)
        XCTAssertFalse(state.isPreparing)
        XCTAssertFalse(state.isPrepared(for: firstOccurrence))
        XCTAssertTrue(state.begin(for: firstOccurrence))

        state.complete(for: firstOccurrence, succeeded: true)
        XCTAssertTrue(state.isPrepared(for: firstOccurrence))
        XCTAssertFalse(state.begin(for: firstOccurrence))
        XCTAssertTrue(state.begin(for: secondOccurrence))
    }

    func testPreparationPresentationKeepsEligibleWorkVisibleWhenTheDailyNoteRouteIsUnavailable() {
        XCTAssertNil(
            TodayBriefPreparationPresentation.action(
                offersPreparation: false,
                isReady: false,
                isPreparing: false,
                isPrepared: false
            )
        )

        XCTAssertEqual(
            TodayBriefPreparationPresentation.action(
                offersPreparation: true,
                isReady: true,
                isPreparing: false,
                isPrepared: false
            ),
            .init(
                title: "Prepare in daily note",
                isDisabled: false,
                readinessMessage: nil,
                accessibilityHint: "Prepares this meeting in its daily note"
            )
        )
        XCTAssertEqual(
            TodayBriefPreparationPresentation.action(
                offersPreparation: true,
                isReady: false,
                isPreparing: false,
                isPrepared: false
            ),
            .init(
                title: "Daily note not ready",
                isDisabled: true,
                readinessMessage: "This daily note is not ready for meeting preparation.",
                accessibilityHint: "This daily note is not ready for meeting preparation."
            )
        )
        XCTAssertEqual(
            TodayBriefPreparationPresentation.action(
                offersPreparation: true,
                isReady: true,
                isPreparing: true,
                isPrepared: false
            ),
            .init(
                title: "Preparing…",
                isDisabled: true,
                readinessMessage: nil,
                accessibilityHint: "Prepares this meeting in its daily note"
            )
        )
        XCTAssertEqual(
            TodayBriefPreparationPresentation.action(
                offersPreparation: true,
                isReady: true,
                isPreparing: false,
                isPrepared: true
            ),
            .init(
                title: "Prepared in daily note",
                isDisabled: true,
                readinessMessage: "This meeting is already prepared in its daily note.",
                accessibilityHint: "This meeting is already prepared in its daily note."
            )
        )
        XCTAssertFalse(
            TodayBriefPreparationPresentation.canStartPreparation(
                isPreparing: false,
                isPrepared: true
            )
        )
    }

    func testPersonNavigationPresentationPreservesSourceOrderAndAccessibleActions() throws {
        let aliceId = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let idOnly = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440001")
        let items = TodayBriefPersonNavigationPresentation.items(
            people: [
                RPCTodayBriefPerson(displayName: "Alice", personNodeId: aliceId),
                RPCTodayBriefPerson(displayName: "Guest"),
                RPCTodayBriefPerson(personNodeId: idOnly),
                RPCTodayBriefPerson()
            ],
            canOpenPerson: true
        )

        XCTAssertEqual(items.map(\.title), ["Alice", "Guest", "Person"])
        XCTAssertEqual(items[0].destination, .person(aliceId))
        XCTAssertEqual(items[1].destination, .staticText)
        XCTAssertEqual(items[2].destination, .person(idOnly))
        XCTAssertEqual(items[0].accessibilityLabel, "Open Alice")
        XCTAssertEqual(items[2].accessibilityLabel, "Open Person")
        XCTAssertEqual(items[0].accessibilityHint, "Opens this person in the workspace.")
        XCTAssertFalse(items.compactMap(\.accessibilityLabel).joined(separator: " ").contains(aliceId.rawValue))
        XCTAssertFalse(items.compactMap(\.accessibilityLabel).joined(separator: " ").contains(idOnly.rawValue))

        XCTAssertEqual(
            TodayBriefPersonNavigationPresentation.items(
                people: [
                    RPCTodayBriefPerson(displayName: "Alice", personNodeId: aliceId),
                    RPCTodayBriefPerson(displayName: "Guest"),
                    RPCTodayBriefPerson(personNodeId: idOnly),
                    RPCTodayBriefPerson()
                ],
                canOpenPerson: false
            ),
            [
                .init(title: "Alice", destination: .staticText),
                .init(title: "Guest", destination: .staticText)
            ]
        )
    }

    func testScheduleClassifiesHalfOpenIntervalsAndPreservesSourceOrder() throws {
        let result = TodayBriefSchedule.project([
            try event("active", start: "2026-08-26T09:00:00Z", end: "2026-08-26T10:00:00Z"),
            try event("now-active", start: "2026-08-26T10:00:00Z", end: "2026-08-26T11:00:00Z"),
            try event("later", start: "2026-08-26T11:00:00Z", end: "2026-08-26T12:00:00Z"),
            try event("past", start: "2026-08-26T08:00:00Z", end: "2026-08-26T09:00:00Z")
        ], now: date("2026-08-26T10:00:00Z"))

        XCTAssertEqual(result.active.map(\.title), ["now-active"])
        XCTAssertEqual(result.past.map(\.title), ["active", "past"])
        XCTAssertEqual(result.upcoming.map(\.title), ["later"])
        XCTAssertEqual(result.next.map(\.title), ["later"])
    }

    func testScheduleKeepsInvalidEventsAndAllMinimumStartTies() throws {
        let result = TodayBriefSchedule.project([
            try event("invalid-past", start: "2026-08-26T08:00:00Z", end: "2026-08-26T07:00:00Z"),
            try event("invalid-upcoming", start: "2026-08-26T12:00:00Z", end: "2026-08-26T11:00:00Z"),
            try event("tie-a", start: "2026-08-26T12:00:00Z", end: "2026-08-26T13:00:00Z"),
            try event("tie-b", start: "2026-08-26T12:00:00Z", end: "2026-08-26T13:00:00Z")
        ], now: date("2026-08-26T10:00:00Z"))

        XCTAssertEqual(result.past.map(\.title), ["invalid-past"])
        XCTAssertEqual(result.upcoming.map(\.title), ["invalid-upcoming", "tie-a", "tie-b"])
        XCTAssertEqual(result.next.map(\.title), ["invalid-upcoming", "tie-a", "tie-b"])
        XCTAssertEqual(result.later, [])
        XCTAssertEqual((result.active + result.past + result.upcoming).map(\.title), [
            "invalid-past", "invalid-upcoming", "tie-a", "tie-b"
        ])
    }

    func testSchedulePlacesUnparseableStartInPastAndPartitionsDuplicateIdsBySourceIndex() throws {
        let duplicateId = try EntityId(validating: "550e8400-e29b-41d4-a716-446655440000")
        let result = TodayBriefSchedule.project([
            try event("unparseable-start", start: "2026-08-26", end: "2026-08-26T12:00:00Z"),
            try event("tie-a", id: duplicateId, start: "2026-08-26T11:00:00Z", end: "2026-08-26T12:00:00Z"),
            try event("tie-b", id: duplicateId, start: "2026-08-26T11:00:00Z", end: "2026-08-26T12:00:00Z"),
            try event("later", id: duplicateId, start: "2026-08-26T13:00:00Z", end: "2026-08-26T14:00:00Z")
        ], now: date("2026-08-26T10:00:00Z"))

        XCTAssertEqual(result.past.map(\.title), ["unparseable-start"])
        XCTAssertEqual(result.next.map(\.title), ["tie-a", "tie-b"])
        XCTAssertEqual(result.later.map(\.title), ["later"])
        XCTAssertTrue(result.membershipSignature(in: [
            try event("unparseable-start", start: "2026-08-26", end: "2026-08-26T12:00:00Z"),
            try event("tie-a", id: duplicateId, start: "2026-08-26T11:00:00Z", end: "2026-08-26T12:00:00Z"),
            try event("tie-b", id: duplicateId, start: "2026-08-26T11:00:00Z", end: "2026-08-26T12:00:00Z"),
            try event("later", id: duplicateId, start: "2026-08-26T13:00:00Z", end: "2026-08-26T14:00:00Z")
        ]).contains("next:1,2"))
    }

    func testSectionPresentationKeepsCurrentAttentionOpenAndDefersOnlySecondaryBuckets() throws {
        let events = [
            try event("past", start: "2026-08-26T08:00:00Z", end: "2026-08-26T09:00:00Z"),
            try event("active", start: "2026-08-26T09:30:00Z", end: "2026-08-26T10:30:00Z"),
            try event("next", start: "2026-08-26T11:00:00Z", end: "2026-08-26T12:00:00Z"),
            try event("later", start: "2026-08-26T13:00:00Z", end: "2026-08-26T14:00:00Z")
        ]
        let schedule = TodayBriefSchedule.project(events, now: date("2026-08-26T10:00:00Z"))
        let sections = TodayBriefSectionPresentation.sections(isToday: true, events: events, schedule: schedule)

        XCTAssertEqual(sections.map(\.kind), [.active, .next, .later, .earlier])
        XCTAssertEqual(sections.map(\.label), ["Active", "Up next", "Later", "Earlier today"])
        XCTAssertEqual(sections.map(\.count), [1, 1, 1, 1])
        XCTAssertEqual(sections.map(\.deferred), [false, false, true, true])
        XCTAssertEqual(sections.map(\.offersPreparation), [true, true, true, false])
    }

    func testSectionPresentationOmitsEmptyTodayBucketsAndKeepsHistoryAsOneSchedule() throws {
        let currentEvents = [try event("active", start: "2026-08-26T09:30:00Z", end: "2026-08-26T10:30:00Z")]
        let currentSchedule = TodayBriefSchedule.project(currentEvents, now: date("2026-08-26T10:00:00Z"))
        XCTAssertEqual(
            TodayBriefSectionPresentation.sections(isToday: true, events: currentEvents, schedule: currentSchedule).map(\.kind),
            [.active]
        )

        let historical = [try event("historical", start: "2026-08-25T09:00:00Z", end: "2026-08-25T10:00:00Z")]
        XCTAssertEqual(
            TodayBriefSectionPresentation.sections(isToday: false, events: historical, schedule: nil),
            [.init(kind: .schedule, label: "Schedule", count: 1, deferred: false, offersPreparation: false)]
        )
    }

    func testRefreshCanRetryAfterFailure() async {
        let attempts = RetryAttempts()
        let model = TodayBriefViewModel(loader: {
            await attempts.record()
            throw TestFailure.load
        })

        await model.refresh()
        XCTAssertEqual(model.state, .failed(TodayBriefViewModel.safeErrorMessage))
        await model.refresh()
        XCTAssertEqual(model.state, .failed(TodayBriefViewModel.safeErrorMessage))
        let count = await attempts.value
        XCTAssertEqual(count, 2)
    }

    func testPreparationUsesTheServerResolvedDailyNoteAndOccurrence() async throws {
        let brief = try makeBrief(
            localDate: "2026-08-26",
            timeZone: "Europe/London",
            events: [try event("Planning", start: "2026-08-26T10:00:00Z", end: "2026-08-26T10:30:00Z")]
        )
        let event = try XCTUnwrap(brief.events.first)
        let model = TodayBriefViewModel(
            loader: { brief },
            preparer: { receivedBrief, receivedEvent in
                XCTAssertEqual(receivedBrief, brief)
                XCTAssertEqual(receivedEvent, event)
                return try PrepareMeetingInDailyNoteOutput(
                    dailyNoteId: dailyNoteIdForLocalDate(brief.localDate),
                    localDate: brief.localDate,
                    occurrenceKey: event.occurrenceKey,
                    status: .created,
                    resultSnapshotSha256: String(repeating: "a", count: 64)
                )
            }
        )

        let prepared = await model.prepare(event, in: brief)
        XCTAssertTrue(prepared)
        XCTAssertNil(model.preparationError)
    }

    func testPreparationRejectsMismatchedServerReceiptWithoutNavigating() async throws {
        let brief = try makeBrief(
            localDate: "2026-08-26",
            timeZone: "Europe/London",
            events: [try event("Planning", start: "2026-08-26T10:00:00Z", end: "2026-08-26T10:30:00Z")]
        )
        let event = try XCTUnwrap(brief.events.first)
        let model = TodayBriefViewModel(
            loader: { brief },
            preparer: { _, _ in
                return try PrepareMeetingInDailyNoteOutput(
                    dailyNoteId: dailyNoteIdForLocalDate(brief.localDate),
                    localDate: brief.localDate,
                    occurrenceKey: String(repeating: "b", count: 64),
                    status: .created,
                    resultSnapshotSha256: String(repeating: "a", count: 64)
                )
            }
        )

        let prepared = await model.prepare(event, in: brief)
        XCTAssertFalse(prepared)
        XCTAssertEqual(model.preparationError, "Unable to prepare this meeting. Please try again.")
    }

    func testHistoryLabelsDescribeEachRetainedHistoryState() {
        XCTAssertEqual(TodayBriefHistoryLabel.text(for: .found), "Calendar history available")
        XCTAssertEqual(TodayBriefHistoryLabel.text(for: .noneInRetainedData), "No calendar history retained for this day")
        XCTAssertEqual(TodayBriefHistoryLabel.text(for: .unavailable), "Calendar history unavailable")
    }

    func testFreshnessUsesBriefTimezoneMidnightAndEarliestEventBoundary() throws {
        let brief = try makeBrief(
            localDate: "2026-08-26",
            timeZone: "Europe/London",
            events: [try event("soon", start: "2026-08-26T10:30:00Z", end: "2026-08-26T11:00:00Z")]
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = date("2026-08-26T10:00:00Z")
        XCTAssertTrue(TodayBriefViewModel.isCurrent(brief, now: now))
        XCTAssertEqual(TodayBriefViewModel.nextBoundary(brief, now: now, calendar: calendar), date("2026-08-26T10:30:00Z"))
        XCTAssertFalse(TodayBriefViewModel.isCurrent(brief, now: date("2026-08-26T23:00:00Z")))
        XCTAssertNil(TodayBriefViewModel.nextBoundary(brief, now: date("2026-08-26T23:00:00Z"), calendar: calendar))
    }

    private func event(
        _ title: String,
        id: EntityId = try! EntityId(validating: "550e8400-e29b-41d4-a716-446655440000"),
        start: String,
        end: String
    ) throws -> RPCTodayBriefEvent {
        RPCTodayBriefEvent(
            id: id,
            occurrenceKey: String(repeating: "a", count: 64),
            title: title,
            start: try IsoDateTimeString(validating: start),
            end: try IsoDateTimeString(validating: end),
            people: []
        )
    }

    private func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }

    private func makeBrief(localDate: String, timeZone: String, events: [RPCTodayBriefEvent]) throws -> RPCTodayBrief {
        try RPCTodayBrief(.object([
            "localDate": .string(localDate),
            "timeZone": .string(timeZone),
            "from": .string("2026-08-25T23:00:00Z"),
            "to": .string("2026-08-26T23:00:00Z"),
            "calendarHistory": .object(["status": .string("found")]),
            "events": .array(events.map { event in .object([
                "id": .string(event.id.rawValue), "occurrenceKey": .string(event.occurrenceKey), "title": .string(event.title),
                "start": .string(event.start.rawValue), "end": .string(event.end.rawValue), "people": .array([])
            ]) })
        ]))
    }

    private enum TestFailure: Error { case load }

    private actor RetryAttempts {
        private var count = 0

        func record() { count += 1 }
        var value: Int { count }
    }
}
