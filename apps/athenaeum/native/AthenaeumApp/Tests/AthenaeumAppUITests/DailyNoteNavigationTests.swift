import Foundation
import XCTest
@testable import AthenaeumAppUI

@MainActor
final class DailyNoteNavigationTests: XCTestCase {
    private var utcCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int) -> Date {
        utcCalendar.date(from: DateComponents(year: year, month: month, day: day))!
    }

    func testAdjacentDaysUseDeterministicIdsAndTitles() {
        var navigator = DailyNoteNavigator(date: date(2026, 8, 26), calendar: utcCalendar)

        let current = navigator.currentSelection()
        let previous = navigator.request(date: date(2026, 8, 25))

        XCTAssertNotEqual(current.nodeId, previous.nodeId)
        XCTAssertEqual(previous.title, "Daily Note — 2026-08-25")
        XCTAssertEqual(previous.date, date(2026, 8, 25))
    }

    func testStandupPresentationOnlyShowsForTodayWhenConfigured() {
        XCTAssertEqual(DailyNoteStandupPresentation.anchorID, "athenaeum.daily-note.standup")
        XCTAssertTrue(DailyNoteStandupPresentation.shouldShow(isToday: true, hasConfiguration: true))
        XCTAssertFalse(DailyNoteStandupPresentation.shouldShow(isToday: false, hasConfiguration: true))
        XCTAssertFalse(DailyNoteStandupPresentation.shouldShow(isToday: true, hasConfiguration: false))
        XCTAssertFalse(DailyNoteStandupPresentation.shouldShow(isToday: false, hasConfiguration: false))
    }

    func testNavigationProgressExplainsExistingCustodyWithoutChangingIdleStatus() {
        XCTAssertNil(
            DailyNoteNavigationProgressPresentation.message(
                isNavigating: false,
                status: .syncing
            )
        )
        XCTAssertEqual(
            DailyNoteNavigationProgressPresentation.message(
                isNavigating: true,
                status: .syncing
            ),
            "Saving this note before changing days…"
        )
        XCTAssertEqual(
            DailyNoteNavigationProgressPresentation.message(
                isNavigating: true,
                status: .pending("Queued local change")
            ),
            "Saving this note before changing days…"
        )
        XCTAssertEqual(
            DailyNoteNavigationProgressPresentation.message(
                isNavigating: true,
                status: .synced
            ),
            "Opening the selected daily note…"
        )
    }

    func testReturningToADayReusesItsSessionHandle() {
        var navigator = DailyNoteNavigator(date: date(2026, 8, 26), calendar: utcCalendar)

        let first = navigator.currentSelection()
        _ = navigator.request(date: date(2026, 8, 27))
        let returned = navigator.request(date: date(2026, 8, 26))

        XCTAssertTrue(first.session === returned.session)
        XCTAssertFalse(first.session === navigator.request(date: date(2026, 8, 27)).session)
    }

    func testCivilDayNormalizationHandlesMonthBoundary() {
        var navigator = DailyNoteNavigator(
            date: date(2026, 1, 31).addingTimeInterval(23 * 60 * 60),
            calendar: utcCalendar
        )

        let next = navigator.request(date: date(2026, 2, 1).addingTimeInterval(12 * 60 * 60))

        XCTAssertEqual(next.title, "Daily Note — 2026-02-01")
        XCTAssertEqual(next.date, date(2026, 2, 1))
    }

    func testCommitQueueReportsFailureAtTheNavigationBoundary() async {
        var queue = DailyNoteCommitQueue()
        let first = queue.enqueue { false }
        let second = queue.enqueue { true }

        let firstResult = await first.value
        let secondResult = await second.value
        let pendingResult = await queue.pending?.value ?? false
        XCTAssertFalse(firstResult)
        XCTAssertFalse(secondResult)
        XCTAssertFalse(pendingResult)
    }

    func testCommitQueueSerializesACommitBeforeTheNextOne() async {
        var queue = DailyNoteCommitQueue()
        let events = EventRecorder()
        let first = queue.enqueue {
            await events.append("first-start")
            try? await Task.sleep(nanoseconds: 10_000_000)
            await events.append("first-end")
            return true
        }
        let second = queue.enqueue {
            await events.append("second")
            return true
        }

        let firstResult = await first.value
        let secondResult = await second.value
        let recorded = await events.values
        XCTAssertTrue(firstResult)
        XCTAssertTrue(secondResult)
        XCTAssertEqual(recorded, ["first-start", "first-end", "second"])
    }

    func testDepartingNodeSyncRemainsSuppressedAfterBlockedCommitReleases() async {
        var intent = DailyNoteNavigationIntent()
        intent.begin(departingNodeId: "A")
        var queue = DailyNoteCommitQueue()
        let gate = CommitGate()
        let syncCallbacks = EventRecorder()
        let commit = queue.enqueue {
            await gate.wait()
            return true
        }

        await gate.waitUntilWaiting()
        await gate.release()
        let committed = await commit.value
        let callbacksBeforeNavigation = await syncCallbacks.values
        XCTAssertTrue(committed)
        if !intent.suppressesSync(for: "A") {
            await syncCallbacks.append("A-sync")
        }

        XCTAssertEqual(callbacksBeforeNavigation, [])
        let callbacksAfterNavigationBoundary = await syncCallbacks.values
        XCTAssertEqual(callbacksAfterNavigationBoundary, [])
        intent.cancel()
        XCTAssertFalse(intent.suppressesSync(for: "A"))
    }

    private actor CommitGate {
        private var released = false
        private var waitingCount = 0
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var startedWaiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            if released { return }
            waitingCount += 1
            let started = startedWaiters
            startedWaiters.removeAll()
            for continuation in started {
                continuation.resume()
            }
            await withCheckedContinuation { continuation in
                waiters.append(continuation)
            }
        }

        func waitUntilWaiting() async {
            if waitingCount > 0 { return }
            await withCheckedContinuation { continuation in
                startedWaiters.append(continuation)
            }
        }

        func release() {
            released = true
            let pending = waiters
            waiters.removeAll()
            for continuation in pending {
                continuation.resume()
            }
        }
    }

    private actor EventRecorder {
        private(set) var values: [String] = []

        func append(_ value: String) {
            values.append(value)
        }
    }
}
