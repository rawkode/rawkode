import Foundation
import XCTest
@testable import EnchiridionCore

final class TaskManagementTests: XCTestCase {
  func testQuickCaptureExtractsPortableTaskSyntax() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 10))!

    let result = QuickTaskParser.parse(
      "Prepare board pack tomorrow #work #Finance !high every weekday",
      now: now,
      calendar: calendar
    )

    XCTAssertEqual(result.draft.title, "Prepare board pack")
    XCTAssertEqual(result.draft.data.placement, .anytime)
    XCTAssertEqual(result.draft.data.priority, .high)
    XCTAssertEqual(result.draft.data.tags, ["finance", "work"])
    XCTAssertEqual(
      result.draft.data.scheduledAt,
      calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))
    )
    XCTAssertEqual(
      result.draft.data.recurrence?.weekdays,
      [.monday, .tuesday, .wednesday, .thursday, .friday]
    )
  }

  func testTaskDataRoundTripsThroughAutomergeAndRepositoryProjection() async throws {
    let fixture = try TaskRepositoryFixture()
    let deadline = Date(timeIntervalSince1970: 1_817_000_000)
    let data = TaskData(
      placement: .anytime,
      deadline: deadline,
      priority: .urgent,
      tags: ["Launch", "launch", "Deep Work"],
      estimatedMinutes: 45
    )

    let created = try await fixture.repository.createTask(
      TaskDraft(title: "Ship task system", notes: "Keep the editor calm.", data: data)
    )
    let reopened = try await fixture.repository.page(id: created.id)

    XCTAssertEqual(reopened?.title, "Ship task system")
    XCTAssertEqual(reopened?.plainText, "Keep the editor calm.")
    XCTAssertEqual(reopened?.taskData?.placement, .anytime)
    XCTAssertEqual(reopened?.taskData?.deadline, deadline)
    XCTAssertEqual(reopened?.taskData?.priority, .urgent)
    XCTAssertEqual(reopened?.taskData?.tags, ["deep work", "launch"])
    XCTAssertEqual(reopened?.taskData?.estimatedMinutes, 45)
  }

  func testCompletingFixedRecurringTaskCreatesNextOccurrenceAndKeepsHistory() async throws {
    let fixture = try TaskRepositoryFixture()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let scheduled = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 9))!
    let completedAt = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 11))!
    let task = try await fixture.repository.createTask(
      TaskDraft(
        title: "Daily review",
        notes: "Review inbox and priorities.",
        data: TaskData(
          placement: .anytime,
          scheduledAt: scheduled,
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
    XCTAssertEqual(result.successor?.plainText, task.plainText)
    XCTAssertNotEqual(result.successor?.id, result.completed.id)
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

  private func taskPage(title: String, data: TaskData) throws -> PageSnapshot {
    let id = PageID.free()
    let now = Date(timeIntervalSince1970: 1_817_000_000)
    let base = try PageDocument.create(id: id, kind: .free, title: title, createdAt: now)
    let task = try PageDocument.setProperties(
      TaskFields.properties(for: data),
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
