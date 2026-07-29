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

  func testProjectReviewReadinessRequiresOutcomeNextActionAndOverdueDecision() async throws {
    let fixture = try ProjectPlanningFixture()
    let project = try await fixture.repository.createProject(
      title: "Prepare launch",
      data: ProjectData(status: .active)
    )
    let incomplete = ProjectReviewItem(
      project: project,
      data: try XCTUnwrap(project.projectData),
      activeTaskCount: 0,
      overdueTaskCount: 0,
      needsReview: true
    )

    XCTAssertEqual(
      WeeklyReviewPolicy.readiness(for: incomplete, acceptsOverdueWork: false).blockers,
      [.missingOutcome, .missingNextAction]
    )

    let overdue = ProjectReviewItem(
      project: project,
      data: ProjectData(status: .active, outcome: "Launch is ready for customers"),
      activeTaskCount: 1,
      overdueTaskCount: 1,
      needsReview: true
    )
    let unresolved = WeeklyReviewPolicy.readiness(for: overdue, acceptsOverdueWork: false)
    let accepted = WeeklyReviewPolicy.readiness(for: overdue, acceptsOverdueWork: true)

    XCTAssertEqual(unresolved.blockers, [.unresolvedOverdue(count: 1)])
    XCTAssertFalse(unresolved.canMarkReviewed)
    XCTAssertTrue(accepted.blockers.isEmpty)
    XCTAssertTrue(accepted.canMarkReviewed)
  }

  func testWeeklyReviewOverdueQueueMatchesSnapshotAndExcludesTodayFutureAndCompletedTasks()
    async throws
  {
    let fixture = try ProjectPlanningFixture()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let now = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 7, day: 29, hour: 12))
    )
    let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: now))
    let today = calendar.startOfDay(for: now)
    let tomorrow = try XCTUnwrap(calendar.date(byAdding: .day, value: 1, to: now))

    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Scheduled yesterday",
        data: TaskData(placement: .anytime, scheduledAt: yesterday)
      ),
      now: now,
      calendar: calendar
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Due yesterday",
        data: TaskData(placement: .anytime, deadline: yesterday)
      ),
      now: now,
      calendar: calendar
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(title: "Due today", data: TaskData(placement: .anytime, deadline: today)),
      now: now,
      calendar: calendar
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(
        title: "Scheduled tomorrow",
        data: TaskData(placement: .anytime, scheduledAt: tomorrow)
      ),
      now: now,
      calendar: calendar
    )
    let completedOverdue = try await fixture.repository.createTask(
      TaskDraft(
        title: "Completed overdue",
        data: TaskData(placement: .anytime, deadline: yesterday)
      ),
      now: now,
      calendar: calendar
    )
    _ = try await fixture.repository.completeTask(
      pageID: completedOverdue.id,
      now: now,
      calendar: calendar
    )
    let pages = try await fixture.repository.pages(in: .allPages)

    let overdueTasks = WeeklyReviewPolicy.overdueTasks(
      in: pages,
      now: now,
      calendar: calendar
    )
    let snapshot = WeeklyReviewSnapshot.make(pages: pages, now: now, calendar: calendar)

    XCTAssertEqual(
      Set(overdueTasks.map(\.page.displayTitle)),
      ["Scheduled yesterday", "Due yesterday"]
    )
    XCTAssertEqual(snapshot.overdueTaskCount, overdueTasks.count)
  }

  func testCloseProjectBlocksAtomicallyWhileActiveTasksRemain() async throws {
    let fixture = try ProjectPlanningFixture()
    let now = Date(timeIntervalSince1970: 1_817_000_000)
    let project = try await fixture.repository.createProject(
      title: "Ship safely",
      data: ProjectData(outcome: "The release is available"),
      now: now
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(title: "Active one", data: TaskData(projectID: project.id)),
      now: now
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(title: "Active two", data: TaskData(projectID: project.id)),
      now: now
    )
    let completed = try await fixture.repository.createTask(
      TaskDraft(title: "Already done", data: TaskData(projectID: project.id)),
      now: now
    )
    _ = try await fixture.repository.completeTask(pageID: completed.id, now: now)
    let loadedBefore = try await fixture.repository.page(id: project.id)
    let before = try XCTUnwrap(loadedBefore)

    let result = try await fixture.repository.closeProject(
      pageID: project.id,
      now: now.addingTimeInterval(60)
    )
    let loadedAfter = try await fixture.repository.page(id: project.id)
    let after = try XCTUnwrap(loadedAfter)

    guard case .blocked(let activeTaskCount) = result else {
      return XCTFail("Expected active tasks to block project closure, got \(result)")
    }
    XCTAssertEqual(activeTaskCount, 2)
    XCTAssertEqual(after, before)
    XCTAssertEqual(after.projectData?.status, .active)
  }

  func testCloseAndReopenProjectAreSafeAndIdempotent() async throws {
    let fixture = try ProjectPlanningFixture()
    let now = Date(timeIntervalSince1970: 1_817_000_000)
    let project = try await fixture.repository.createProject(title: "Ship safely", now: now)
    let completedTask = try await fixture.repository.createTask(
      TaskDraft(title: "Done", data: TaskData(projectID: project.id)),
      now: now
    )
    _ = try await fixture.repository.completeTask(pageID: completedTask.id, now: now)

    let firstResult = try await fixture.repository.closeProject(
      pageID: project.id,
      now: now.addingTimeInterval(60)
    )
    guard case .closed(let firstClosed) = firstResult else {
      return XCTFail("Expected project closure, got \(firstResult)")
    }
    XCTAssertEqual(firstClosed.projectData?.status, .completed)
    XCTAssertEqual(firstClosed.dirtyGeneration, project.dirtyGeneration + 1)

    let secondResult = try await fixture.repository.closeProject(
      pageID: project.id,
      now: now.addingTimeInterval(120)
    )
    guard case .closed(let secondClosed) = secondResult else {
      return XCTFail("Expected idempotent project closure, got \(secondResult)")
    }
    XCTAssertEqual(secondClosed, firstClosed)

    let reopened = try await fixture.repository.reopenProject(
      pageID: project.id,
      now: now.addingTimeInterval(180)
    )
    XCTAssertEqual(reopened.projectData?.status, .active)
    XCTAssertEqual(reopened.dirtyGeneration, firstClosed.dirtyGeneration + 1)

    let reopenedAgain = try await fixture.repository.reopenProject(
      pageID: project.id,
      now: now.addingTimeInterval(240)
    )
    XCTAssertEqual(reopenedAgain, reopened)
  }

  func testProjectUpdateCannotBypassActiveTaskCloseGuard() async throws {
    let fixture = try ProjectPlanningFixture()
    let project = try await fixture.repository.createProject(
      title: "Guarded project",
      data: ProjectData(outcome: "Original outcome")
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(title: "Still active", data: TaskData(projectID: project.id))
    )
    var data = try XCTUnwrap(project.projectData)
    data.status = .cancelled
    data.outcome = "This must not be partially saved"

    do {
      _ = try await fixture.repository.updateProject(pageID: project.id, data: data)
      XCTFail("Expected project closure through updateProject to be rejected")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .projectHasActiveTasks(count: 1))
    }

    let loadedProject = try await fixture.repository.page(id: project.id)
    let unchanged = try XCTUnwrap(loadedProject)
    XCTAssertEqual(unchanged.projectData?.status, .active)
    XCTAssertEqual(unchanged.projectData?.outcome, "Original outcome")
    XCTAssertEqual(unchanged.dirtyGeneration, project.dirtyGeneration)
  }

  func testProjectStatusPropertyCannotBypassActiveTaskCloseGuard() async throws {
    let fixture = try ProjectPlanningFixture()
    let project = try await fixture.repository.createProject(title: "Guarded property")
    _ = try await fixture.repository.createTask(
      TaskDraft(title: "Still active", data: TaskData(projectID: project.id))
    )

    do {
      try await fixture.repository.setProperty(
        pageID: project.id,
        key: ProjectFields.status,
        values: [.select(ProjectStatus.completed.rawValue)]
      )
      XCTFail("Expected direct status property closure to be rejected")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .projectHasActiveTasks(count: 1))
    }

    let loadedProject = try await fixture.repository.page(id: project.id)
    let unchanged = try XCTUnwrap(loadedProject)
    XCTAssertEqual(unchanged.projectData?.status, .active)
    XCTAssertEqual(unchanged.dirtyGeneration, project.dirtyGeneration)
  }

  func testActiveTaskCannotBeCreatedForAClosedProjectButHistoricalTaskIsPreserved()
    async throws
  {
    let fixture = try ProjectPlanningFixture()
    let project = try await fixture.repository.createProject(title: "Closed project")
    _ = try await fixture.repository.closeProject(pageID: project.id)

    do {
      _ = try await fixture.repository.createTask(
        TaskDraft(title: "Invalid active task", data: TaskData(projectID: project.id))
      )
      XCTFail("Expected active task creation for a closed project to be rejected")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskProjectClosed(projectID: project.id))
    }

    let historical = try await fixture.repository.createTask(
      TaskDraft(
        title: "Historical completed task",
        data: TaskData(state: .completed, projectID: project.id)
      )
    )
    XCTAssertEqual(historical.taskData?.projectID, project.id)
    XCTAssertEqual(historical.taskData?.state, .completed)

    _ = try await fixture.repository.reopenProject(pageID: project.id)
    let active = try await fixture.repository.createTask(
      TaskDraft(title: "Valid active task", data: TaskData(projectID: project.id))
    )
    XCTAssertEqual(active.taskData?.projectID, project.id)
    XCTAssertEqual(active.taskData?.state, .active)
  }

  func testActiveTaskCannotBeReassignedOrReopenedIntoAClosedProject() async throws {
    let fixture = try ProjectPlanningFixture()
    let sourceProject = try await fixture.repository.createProject(title: "Open project")
    let closedProject = try await fixture.repository.createProject(title: "Closed project")
    _ = try await fixture.repository.closeProject(pageID: closedProject.id)
    let active = try await fixture.repository.createTask(
      TaskDraft(title: "Active task", data: TaskData(projectID: sourceProject.id))
    )
    var reassignedData = try XCTUnwrap(active.taskData)
    reassignedData.projectID = closedProject.id

    do {
      _ = try await fixture.repository.updateTask(pageID: active.id, data: reassignedData)
      XCTFail("Expected reassignment into a closed project to be rejected")
    } catch {
      XCTAssertEqual(
        error as? LibraryRepositoryError,
        .taskProjectClosed(projectID: closedProject.id)
      )
    }
    let loadedTask = try await fixture.repository.page(id: active.id)
    let unchanged = try XCTUnwrap(loadedTask)
    XCTAssertEqual(unchanged.taskData?.projectID, sourceProject.id)

    let historical = try await fixture.repository.createTask(
      TaskDraft(
        title: "Closed historical task",
        data: TaskData(state: .completed, projectID: closedProject.id)
      )
    )
    do {
      _ = try await fixture.repository.reopenTask(pageID: historical.id)
      XCTFail("Expected task reopening in a closed project to be rejected")
    } catch {
      XCTAssertEqual(
        error as? LibraryRepositoryError,
        .taskProjectClosed(projectID: closedProject.id)
      )
    }

    _ = try await fixture.repository.reopenProject(pageID: closedProject.id)
    let reopenedTask = try await fixture.repository.reopenTask(pageID: historical.id)
    XCTAssertEqual(reopenedTask.taskData?.state, .active)
    XCTAssertEqual(reopenedTask.taskData?.projectID, closedProject.id)
  }

  @MainActor
  func testStoreCloseProjectReturnsBlockedThenRefreshesSuccessfulClosure() async throws {
    let fixture = try ProjectPlanningFixture()
    let project = try await fixture.repository.createProject(title: "Store project")
    let task = try await fixture.repository.createTask(
      TaskDraft(title: "Resolve me", data: TaskData(projectID: project.id))
    )
    let store = LibraryStore(repository: fixture.repository, startImmediately: false)
    _ = await store.reload(policy: .refreshOnly)

    let blocked = await store.closeProject(pageID: project.id)
    guard case .blocked(let activeTaskCount) = blocked else {
      return XCTFail("Expected the store to surface the blocked result, got \(blocked)")
    }
    XCTAssertEqual(activeTaskCount, 1)

    _ = try await fixture.repository.completeTask(pageID: task.id)
    let closed = await store.closeProject(pageID: project.id)
    guard case .closed = closed else {
      return XCTFail("Expected the store to close the project, got \(closed)")
    }
    XCTAssertEqual(store.page(id: project.id)?.projectData?.status, .completed)
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
