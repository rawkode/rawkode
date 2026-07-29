import Foundation
import XCTest

@testable import EnchiridionCore

final class ProjectPlanningTests: XCTestCase {
  func testBuiltInProjectSchemaIncludesPlanningFields() async throws {
    let fixture = try ProjectPlanningFixture()
    let schemas = try await fixture.repository.supertags()
    let project = try XCTUnwrap(schemas.first { $0.id == BuiltInSupertags.project })
    let status = try XCTUnwrap(project.fields.first { $0.id == ProjectFields.status.fieldID })

    XCTAssertTrue(project.fields.contains { $0.id == ProjectFields.outcome.fieldID })
    XCTAssertTrue(project.fields.contains { $0.id == ProjectFields.lastReviewedAt.fieldID })
    XCTAssertEqual(Set(status.options.map(\.id)), Set(ProjectStatus.allCases.map(\.rawValue)))
  }

  func testProjectPlanRoundTripsThroughRepositoryProjection() async throws {
    let fixture = try ProjectPlanningFixture()
    let start = Date(timeIntervalSince1970: 1_817_000_000)
    let due = start.addingTimeInterval(604_800)
    let reviewed = start.addingTimeInterval(60)
    let area = try await fixture.repository.createTaggedPage(
      title: "Product",
      supertagID: BuiltInSupertags.area
    )

    let project = try await fixture.repository.createProject(
      title: "Ship planning",
      data: ProjectData(
        status: .planned,
        outcome: "A trusted weekly planning loop",
        areaID: area.id,
        startDate: start,
        dueDate: due,
        lastReviewedAt: reviewed
      )
    )
    let loaded = try await fixture.repository.page(id: project.id)
    let reopened = try XCTUnwrap(loaded)

    XCTAssertEqual(reopened.projectData?.status, .planned)
    XCTAssertEqual(reopened.projectData?.outcome, "A trusted weekly planning loop")
    XCTAssertEqual(reopened.projectData?.areaID, area.id)
    XCTAssertEqual(reopened.projectData?.startDate, start)
    XCTAssertEqual(reopened.projectData?.dueDate, due)
    XCTAssertEqual(reopened.projectData?.lastReviewedAt, reviewed)
  }

  func testTaskHierarchyProducesStableArbitraryDepthAndRetainsOrphans() async throws {
    let fixture = try ProjectPlanningFixture()
    let parent = try await fixture.repository.createTask(TaskDraft(title: "Plan launch"))
    let child = try await fixture.repository.createTask(
      TaskDraft(title: "Draft brief", data: TaskData(parentTaskID: parent.id))
    )
    let grandchild = try await fixture.repository.createTask(
      TaskDraft(title: "Confirm audience", data: TaskData(parentTaskID: child.id))
    )
    let orphan = try taskItem(title: "Retained orphan", parentTaskID: .free())
    let items = [grandchild, parent, orphan.page, child].compactMap(TaskItem.init(page:))

    let rows = TaskHierarchy.rows(from: items)

    XCTAssertEqual(rows.map(\.id), [parent.id, child.id, grandchild.id, orphan.id])
    XCTAssertEqual(rows.map(\.depth), [0, 1, 2, 0])
    XCTAssertEqual(rows.map(\.directSubtaskCount), [1, 1, 0, 0])
  }

  func testTaskHierarchyBreaksParentCyclesWithoutDroppingTasks() async throws {
    let firstID = PageID.free()
    let secondID = PageID.free()
    let first = try taskItem(id: firstID, title: "First", parentTaskID: secondID)
    let second = try taskItem(id: secondID, title: "Second", parentTaskID: firstID)

    let rows = TaskHierarchy.rows(from: [first, second])

    XCTAssertEqual(Set(rows.map(\.id)), [firstID, secondID])
    XCTAssertEqual(rows.count, 2)
    XCTAssertEqual(rows.first?.depth, 0)
  }

  func testRepositoryRejectsAParentCycle() async throws {
    let fixture = try ProjectPlanningFixture()
    let first = try await fixture.repository.createTask(TaskDraft(title: "First"))
    let second = try await fixture.repository.createTask(
      TaskDraft(title: "Second", data: TaskData(parentTaskID: first.id))
    )
    var firstData = try XCTUnwrap(first.taskData)
    firstData.parentTaskID = second.id

    do {
      _ = try await fixture.repository.updateTask(pageID: first.id, data: firstData)
      XCTFail("Expected the parent cycle to be rejected")
    } catch {
      guard let repositoryError = error as? LibraryRepositoryError else {
        return XCTFail("Unexpected error: \(error)")
      }
      guard case .invalidRecord = repositoryError else {
        return XCTFail("Unexpected repository error: \(repositoryError)")
      }
    }
  }

  func testWeeklyReviewPrioritizesStaleOrUnhealthyProjects() async throws {
    let fixture = try ProjectPlanningFixture()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 12))!
    let stale = try XCTUnwrap(calendar.date(byAdding: .day, value: -8, to: now))
    let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: now))

    let attention = try await fixture.repository.createProject(
      title: "Needs attention",
      data: ProjectData(status: .active, lastReviewedAt: stale),
      now: now
    )
    let healthy = try await fixture.repository.createProject(
      title: "On track",
      data: ProjectData(
        status: .active,
        outcome: "Customers can finish setup",
        lastReviewedAt: now
      ),
      now: now
    )
    _ = try await fixture.repository.createProject(
      title: "Already done",
      data: ProjectData(status: .completed),
      now: now
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Overdue action",
        data: TaskData(placement: .anytime, deadline: yesterday, projectID: attention.id)
      ),
      now: now
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Next action",
        data: TaskData(placement: .anytime, projectID: healthy.id)
      ),
      now: now
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(title: "Clarify me", data: TaskData(placement: .inbox)),
      now: now
    )
    let pages = try await fixture.repository.pages(in: .allPages)

    let review = WeeklyReviewSnapshot.make(pages: pages, now: now, calendar: calendar)

    XCTAssertEqual(review.inboxTaskCount, 1)
    XCTAssertEqual(review.overdueTaskCount, 1)
    XCTAssertEqual(review.projects.map(\.id), [attention.id, healthy.id])
    XCTAssertTrue(review.projects[0].needsReview)
    XCTAssertEqual(review.projects[0].overdueTaskCount, 1)
    XCTAssertFalse(review.projects[1].needsReview)
  }

  private func taskItem(
    id: PageID = .free(),
    title: String,
    parentTaskID: PageID?
  ) throws -> TaskItem {
    let now = Date(timeIntervalSince1970: 1_817_000_000)
    let page = try PageDocument.create(id: id, kind: .free, title: title, createdAt: now)
    let task = try PageDocument.setProperties(
      TaskFields.properties(for: TaskData(parentTaskID: parentTaskID)),
      ensuring: BuiltInSupertags.task,
      message: "Test task hierarchy",
      in: page.document
    )
    let snapshot = PageSnapshot(
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
    return try XCTUnwrap(TaskItem(page: snapshot))
  }
}

private final class ProjectPlanningFixture {
  let repository: LibraryRepository
  private let directory: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "enchiridion-project-planning-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    repository = try LibraryRepository(
      path: directory.appendingPathComponent("library.sqlite").path)
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }
}
