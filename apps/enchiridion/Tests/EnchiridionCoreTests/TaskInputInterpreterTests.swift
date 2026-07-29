import Foundation
import XCTest
@testable import EnchiridionCore

final class TaskInputInterpreterTests: XCTestCase {
  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
  }

  func testDeterministicFallbackIsMinimalAndLiteral() {
    let input = "  Prepare #board tomorrow !high every weekday  "

    let first = QuickTaskParser.parse(input)
    let second = QuickTaskParser.parse(input, now: .distantFuture, calendar: calendar)

    XCTAssertEqual(first, second)
    XCTAssertEqual(first.draft.title, "Prepare #board tomorrow !high every weekday")
    XCTAssertEqual(first.draft.data, TaskData())
    XCTAssertTrue(first.recognizedTokens.isEmpty)
  }

  func testNormalizerPreservesWordsTheModelDidNotCiteAsMetadata() throws {
    let input = "Prepare the board pack tomorrow"
    let tomorrow = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))
    )
    let output = TaskModelOutput(
      title: "Prepare",
      scheduledAtISO8601: tomorrow.formatted(.iso8601),
      scheduleSourceText: "tomorrow",
      scheduleIncludesTime: false
    )

    let result = TaskInterpretationNormalizer.normalize(
      output,
      input: input,
      now: tomorrow,
      calendar: calendar
    )

    XCTAssertEqual(result.draft.title, "Prepare the board pack")
    XCTAssertEqual(result.draft.data.scheduledAt, tomorrow)
    XCTAssertEqual(result.draft.data.scheduleGranularity, .dateOnly)
    XCTAssertEqual(result.recognizedTokens, ["tomorrow"])
    XCTAssertTrue(result.suggestions.contains { $0.field == .title && $0.state == .invalid })
  }

  func testInvalidModelOutputIsNotPersistedOrRemovedFromTitle() {
    let input = "Plan launch next blursday at impossible priority with a huge estimate"
    let output = TaskModelOutput(
      title: "Plan launch",
      scheduledAtISO8601: "not-a-date",
      scheduleSourceText: "next blursday",
      deadlineISO8601: "also-not-a-date",
      deadlineSourceText: "at impossible",
      recurrenceUnit: "fortnight",
      recurrenceInterval: -2,
      recurrenceMode: "sometimes",
      recurrenceSourceText: "next blursday",
      tags: [""],
      tagSourceTexts: ["launch"],
      priority: "critical",
      prioritySourceText: "impossible priority",
      estimatedMinutes: 100_000,
      estimatedDurationSourceText: "huge estimate"
    )

    let result = TaskInterpretationNormalizer.normalize(
      output,
      input: input,
      now: Date(timeIntervalSince1970: 0),
      calendar: calendar
    )

    XCTAssertEqual(result.draft.title, input)
    XCTAssertNil(result.draft.data.scheduledAt)
    XCTAssertNil(result.draft.data.deadline)
    XCTAssertNil(result.draft.data.recurrence)
    XCTAssertNil(result.draft.data.estimatedMinutes)
    XCTAssertEqual(result.draft.data.priority, .none)
    XCTAssertTrue(result.draft.data.tags.isEmpty)
    XCTAssertTrue(result.suggestions.filter { $0.field != .title }.allSatisfy { $0.state == .invalid })
    XCTAssertEqual(result.confirmation, .unresolvedHints)
  }

  func testConfirmationDistinguishesAppliedFieldsUnresolvedHintsAndLiteralCapture() {
    let applied = TaskInterpretationNormalizer.normalize(
      TaskModelOutput(
        title: "Review brief",
        tags: ["work"],
        tagSourceTexts: ["#work"]
      ),
      input: "Review brief #work",
      now: Date(),
      calendar: calendar
    )
    let unresolved = TaskInterpretationNormalizer.normalize(
      TaskModelOutput(
        title: "Call",
        personName: "Alice",
        personSourceText: "Alice"
      ),
      input: "Call Alice",
      now: Date(),
      calendar: calendar
    )
    let literal = TaskInterpretation.literal("Call Alice")

    XCTAssertEqual(applied.confirmation, .extractedFields)
    XCTAssertTrue(applied.requiresConfirmation)
    XCTAssertEqual(unresolved.confirmation, .unresolvedHints)
    XCTAssertTrue(unresolved.requiresConfirmation)
    XCTAssertEqual(unresolved.draft.title, "Call Alice")
    XCTAssertEqual(literal.confirmation, .literal)
    XCTAssertFalse(literal.requiresConfirmation)
  }

  func testScheduleGranularityTracksWhetherInputHadAnExplicitTime() throws {
    let date = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 7, day: 30, hour: 15))
    )
    let dateOnly = TaskInterpretationNormalizer.normalize(
      TaskModelOutput(
        title: "Review notes",
        scheduledAtISO8601: date.formatted(.iso8601),
        scheduleSourceText: "tomorrow",
        scheduleIncludesTime: false
      ),
      input: "Review notes tomorrow",
      now: date,
      calendar: calendar
    )
    let dateTime = TaskInterpretationNormalizer.normalize(
      TaskModelOutput(
        title: "Review notes",
        scheduledAtISO8601: date.formatted(.iso8601),
        scheduleSourceText: "tomorrow at 3 PM",
        scheduleIncludesTime: true
      ),
      input: "Review notes tomorrow at 3 PM",
      now: date,
      calendar: calendar
    )

    XCTAssertEqual(dateOnly.draft.data.scheduledAt, calendar.startOfDay(for: date))
    XCTAssertEqual(dateOnly.draft.data.scheduleGranularity, .dateOnly)
    XCTAssertEqual(dateTime.draft.data.scheduledAt, date)
    XCTAssertEqual(dateTime.draft.data.scheduleGranularity, .dateTime)
  }
}
