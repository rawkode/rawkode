import Foundation
import XCTest
@testable import EnchiridionCore

final class TaskManagementTests: XCTestCase {
  func testCompatibilityQuickCapturePreservesLiteralInput() {
    let input = "Prepare board pack tomorrow #work #Finance !high every weekday"
    let result = QuickTaskParser.parse(input)

    XCTAssertEqual(result.draft.title, input)
    XCTAssertEqual(result.draft.data, TaskData())
    XCTAssertEqual(result.recognizedTokens, [])
  }

  func testTaskDataRoundTripsThroughAutomergeAndRepositoryProjection() async throws {
    let fixture = try TaskRepositoryFixture()
    let deadline = Date(timeIntervalSince1970: 1_817_000_000)
    let scheduled = Date(timeIntervalSince1970: 1_816_900_000)
    let seriesID = TaskRecurrenceSeriesID(rawValue: "task_series_round_trip")
    let data = TaskData(
      placement: .anytime,
      scheduledAt: scheduled,
      scheduleGranularity: .dateOnly,
      deadline: deadline,
      priority: .urgent,
      tags: ["Launch", "launch", "Deep Work"],
      recurrence: .init(mode: .fixedSchedule, unit: .week),
      recurrenceSeriesID: seriesID,
      recurrenceSequence: 12,
      estimatedMinutes: 45
    )

    let created = try await fixture.repository.createTask(
      TaskDraft(title: "Ship task system", notes: "Keep the editor calm.", data: data)
    )
    let reopened = try await fixture.repository.page(id: created.id)

    XCTAssertEqual(reopened?.title, "Ship task system")
    XCTAssertEqual(reopened?.plainText, "Keep the editor calm.")
    XCTAssertEqual(reopened?.taskData?.placement, .anytime)
    XCTAssertEqual(reopened?.taskData?.scheduledAt, scheduled)
    XCTAssertEqual(reopened?.taskData?.scheduleGranularity, .dateOnly)
    XCTAssertEqual(reopened?.taskData?.deadline, deadline)
    XCTAssertEqual(reopened?.taskData?.priority, .urgent)
    XCTAssertEqual(reopened?.taskData?.tags, ["deep work", "launch"])
    XCTAssertEqual(reopened?.taskData?.recurrenceSeriesID, seriesID)
    XCTAssertEqual(reopened?.taskData?.recurrenceSequence, 12)
    XCTAssertEqual(reopened?.taskData?.estimatedMinutes, 45)
  }

  func testLegacyScheduleWithoutGranularityDefaultsToDateTime() throws {
    let scheduled = Date(timeIntervalSince1970: 1_817_000_000)
    let legacy = try taskPage(
      title: "Legacy timed task",
      data: TaskData(scheduledAt: scheduled),
      omitting: [TaskFields.scheduleGranularity]
    )

    XCTAssertEqual(legacy.taskData?.scheduledAt, scheduled)
    XCTAssertEqual(legacy.taskData?.scheduleGranularity, .dateTime)

    let encoded = try JSONEncoder.enchiridion.encode(TaskData(scheduledAt: scheduled))
    var legacyObject = try XCTUnwrap(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    legacyObject.removeValue(forKey: "scheduleGranularity")
    let legacyData = try JSONSerialization.data(withJSONObject: legacyObject)
    let decoded = try JSONDecoder.enchiridion.decode(TaskData.self, from: legacyData)
    XCTAssertEqual(decoded.scheduledAt, scheduled)
    XCTAssertEqual(decoded.scheduleGranularity, .dateTime)
  }

  func testLegacyRecurringTaskLazilyAcquiresStableIdentity() async throws {
    let fixture = try TaskRepositoryFixture()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let scheduled = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 9))!
    let legacy = try await fixture.repository.createTaggedPage(
      title: "Legacy recurring task",
      supertagID: BuiltInSupertags.task,
      now: scheduled
    )
    let recurrence = TaskRecurrenceRule(mode: .fixedSchedule, unit: .day)
    let encodedRecurrence = try JSONEncoder.enchiridion.encode(recurrence)
    try await fixture.repository.setProperty(
      pageID: legacy.id,
      key: TaskFields.recurrence,
      values: [.text(String(decoding: encodedRecurrence, as: UTF8.self))],
      now: scheduled
    )

    let beforeUpgrade = try await fixture.repository.page(id: legacy.id)
    XCTAssertNil(beforeUpgrade?.taskData?.recurrenceSeriesID)
    XCTAssertNil(beforeUpgrade?.taskData?.recurrenceSequence)

    let result = try await fixture.repository.completeTask(
      pageID: legacy.id,
      now: scheduled.addingTimeInterval(3_600),
      calendar: calendar
    )
    let expectedSeriesID = TaskRecurrenceSeriesID.derived(from: legacy.id)
    let expectedSuccessorID = PageID.taskOccurrence(seriesID: expectedSeriesID, sequence: 1)

    XCTAssertEqual(result.completed.taskData?.recurrenceSeriesID, expectedSeriesID)
    XCTAssertEqual(result.completed.taskData?.recurrenceSequence, 0)
    XCTAssertEqual(result.successor?.id, expectedSuccessorID)
    XCTAssertEqual(result.successor?.taskData?.recurrenceSeriesID, expectedSeriesID)
    XCTAssertEqual(result.successor?.taskData?.recurrenceSequence, 1)
  }

  func testCompletingFixedRecurringTaskCreatesNextOccurrenceAndKeepsHistory() async throws {
    let fixture = try TaskRepositoryFixture()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let scheduled = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 9))!
    let reminder = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 8))!
    let completedAt = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 11))!
    let task = try await fixture.repository.createTask(
      TaskDraft(
        title: "Daily review",
        notes: "Review inbox and priorities.",
        data: TaskData(
          placement: .anytime,
          scheduledAt: scheduled,
          reminder: reminder,
          recurrence: .init(mode: .fixedSchedule, unit: .day)
        )
      ),
      now: scheduled
    )

    let result = try await fixture.repository.completeTask(
      pageID: task.id,
      now: completedAt,
      calendar: calendar
    )

    XCTAssertEqual(result.completed.taskData?.state, .completed)
    XCTAssertEqual(result.completed.taskData?.completedAt, completedAt)
    XCTAssertEqual(result.successor?.taskData?.state, .active)
    XCTAssertEqual(
      result.successor?.taskData?.scheduledAt,
      calendar.date(from: DateComponents(year: 2026, month: 7, day: 30, hour: 9))
    )
    XCTAssertEqual(
      result.successor?.taskData?.reminder,
      calendar.date(from: DateComponents(year: 2026, month: 7, day: 30, hour: 8))
    )
    XCTAssertEqual(result.successor?.plainText, task.plainText)
    XCTAssertNotEqual(result.successor?.id, result.completed.id)

    let seriesID = try XCTUnwrap(result.completed.taskData?.recurrenceSeriesID)
    XCTAssertEqual(result.completed.taskData?.recurrenceSequence, 0)
    XCTAssertEqual(result.successor?.taskData?.recurrenceSequence, 1)
    XCTAssertEqual(
      result.successor?.id,
      PageID.taskOccurrence(seriesID: seriesID, sequence: 1)
    )

    let repeated = try await fixture.repository.completeTask(
      pageID: task.id,
      now: completedAt.addingTimeInterval(60),
      calendar: calendar
    )
    XCTAssertEqual(repeated.successor?.id, result.successor?.id)
    let seriesPages = try await fixture.repository.pages(in: .allPages).filter {
      $0.taskData?.recurrenceSeriesID == seriesID
    }
    XCTAssertEqual(seriesPages.count, 2)

    let nextOccurrence = try XCTUnwrap(result.successor)
    let nextCompletion = try await fixture.repository.completeTask(
      pageID: nextOccurrence.id,
      now: completedAt.addingTimeInterval(86_400),
      calendar: calendar
    )
    XCTAssertEqual(nextCompletion.completed.taskData?.recurrenceSequence, 1)
    XCTAssertEqual(nextCompletion.successor?.taskData?.recurrenceSequence, 2)
    XCTAssertEqual(
      nextCompletion.successor?.id,
      PageID.taskOccurrence(seriesID: seriesID, sequence: 2)
    )
  }

  func testTwoReplicasConvergeOnOneRecurringSuccessorWithoutDuplicatingContent() async throws {
    let first = try TaskRepositoryFixture()
    let second = try TaskRepositoryFixture()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let scheduled = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 9))!
    let task = try await first.repository.createTask(
      TaskDraft(
        title: "Shared daily review",
        notes: "Keep this body exactly once.",
        data: TaskData(
          placement: .anytime,
          scheduledAt: scheduled,
          recurrence: .init(mode: .fixedSchedule, unit: .day)
        )
      ),
      now: scheduled
    )
    _ = try await second.repository.mergeCloudPage(
      pageID: task.id,
      kind: task.kind,
      remoteDocument: task.document,
      systemFields: Data([1]),
      now: scheduled
    )

    let firstCompletion = try await first.repository.completeTask(
      pageID: task.id,
      now: scheduled.addingTimeInterval(3_600),
      calendar: calendar
    )
    let secondCompletion = try await second.repository.completeTask(
      pageID: task.id,
      now: scheduled.addingTimeInterval(7_200),
      calendar: calendar
    )
    let firstSuccessor = try XCTUnwrap(firstCompletion.successor)
    let secondSuccessor = try XCTUnwrap(secondCompletion.successor)

    XCTAssertEqual(firstSuccessor.id, secondSuccessor.id)
    XCTAssertEqual(firstSuccessor.taskData?.recurrenceSequence, 1)
    XCTAssertEqual(secondSuccessor.taskData?.recurrenceSequence, 1)

    let merge = try await first.repository.mergeCloudPage(
      pageID: secondSuccessor.id,
      kind: secondSuccessor.kind,
      remoteDocument: secondSuccessor.document,
      systemFields: Data([2]),
      now: scheduled.addingTimeInterval(10_800)
    )
    XCTAssertEqual(merge.page?.title, "Shared daily review")
    XCTAssertEqual(merge.page?.plainText, "Keep this body exactly once.")
    let successorCount = try await first.repository.pages(in: .allPages)
      .filter { $0.id == firstSuccessor.id }
      .count
    XCTAssertEqual(successorCount, 1)
  }

  func testSmartListsKeepStartDatesDeadlinesAndSomedayDistinct() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 12))!
    let today = try taskPage(
      title: "Started today",
      data: TaskData(placement: .anytime, scheduledAt: now)
    )
    let overdue = try taskPage(
      title: "Overdue deadline",
      data: TaskData(
        placement: .anytime,
        deadline: calendar.date(byAdding: .day, value: -1, to: now)
      )
    )
    let future = try taskPage(
      title: "Future",
      data: TaskData(
        placement: .anytime,
        scheduledAt: calendar.date(byAdding: .day, value: 2, to: now)
      )
    )
    let someday = try taskPage(
      title: "Maybe",
      data: TaskData(placement: .someday)
    )

    let pages = [future, someday, overdue, today]
    XCTAssertEqual(
      Set(TaskQuery.items(from: pages, selection: .smart(.today), now: now, calendar: calendar).map(\.id)),
      [today.id, overdue.id]
    )
    XCTAssertEqual(
      TaskQuery.items(from: pages, selection: .smart(.upcoming), now: now, calendar: calendar).map(\.id),
      [future.id]
    )
    XCTAssertEqual(
      TaskQuery.items(from: pages, selection: .smart(.someday), now: now, calendar: calendar).map(\.id),
      [someday.id]
    )
  }

  func testDailyTaskContextIncludesADeadlineOnTheSelectedDay() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let selectedDay = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29))!
    let dueToday = try taskPage(
      title: "Submit expenses",
      data: TaskData(
        placement: .anytime,
        deadline: calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 18))
      )
    )
    let dueTomorrow = try taskPage(
      title: "Renew certificate",
      data: TaskData(
        placement: .anytime,
        deadline: calendar.date(from: DateComponents(year: 2026, month: 7, day: 30, hour: 9))
      )
    )

    let result = TaskQuery.items(
      from: [dueTomorrow, dueToday],
      on: selectedDay,
      includingOverdue: false,
      calendar: calendar
    )

    XCTAssertEqual(result.map(\.id), [dueToday.id])
  }

  func testDailyTaskContextTreatsDateOnlySchedulingAsTheExactCalendarDay() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let scheduledDay = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29))!
    let task = try taskPage(
      title: "Plan August",
      data: TaskData(
        placement: .anytime,
        scheduledAt: scheduledDay,
        scheduleGranularity: .dateOnly
      )
    )
    let previousDay = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: scheduledDay))
    let nextDay = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: scheduledDay))

    XCTAssertEqual(
      TaskQuery.items(
        from: [task],
        on: scheduledDay,
        includingOverdue: false,
        calendar: calendar
      ).map(\.id),
      [task.id]
    )
    XCTAssertTrue(
      TaskQuery.items(
        from: [task],
        on: previousDay,
        includingOverdue: false,
        calendar: calendar
      ).isEmpty
    )
    XCTAssertTrue(
      TaskQuery.items(
        from: [task],
        on: nextDay,
        includingOverdue: false,
        calendar: calendar
      ).isEmpty
    )
  }

  private func taskPage(
    title: String,
    data: TaskData,
    omitting omittedKeys: Set<SupertagPropertyKey> = []
  ) throws -> PageSnapshot {
    let id = PageID.free()
    let now = Date(timeIntervalSince1970: 1_817_000_000)
    let base = try PageDocument.create(id: id, kind: .free, title: title, createdAt: now)
    let properties = TaskFields.properties(for: data).filter { !omittedKeys.contains($0.key) }
    let task = try PageDocument.setProperties(
      properties,
      ensuring: BuiltInSupertags.task,
      message: "Test task",
      in: base.document
    )
    return PageSnapshot(
      id: id,
      kind: .free,
      title: title,
      plainText: "",
      document: task.document,
      heads: task.heads,
      createdAt: now,
      modifiedAt: now,
      objectMetadata: task.projection.objectMetadata
    )
  }
}

private final class TaskRepositoryFixture {
  let repository: LibraryRepository
  private let directory: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-task-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    repository = try LibraryRepository(path: directory.appendingPathComponent("library.sqlite").path)
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }
}
