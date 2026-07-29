import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskBatchMutationTests: XCTestCase {
  func testEmptyCollectionOperationsAreEmptyAfterOperandNormalization() {
    XCTAssertTrue(TaskMetadataPatch(tagPatch: .add([])).isEmpty)
    XCTAssertTrue(TaskMetadataPatch(tagPatch: .add(["", "  ", "#"])).isEmpty)
    XCTAssertTrue(TaskMetadataPatch(tagPatch: .remove(["", "\n", " # "])).isEmpty)
    XCTAssertTrue(TaskMetadataPatch(assigneePatch: .add([])).isEmpty)
    XCTAssertTrue(TaskMetadataPatch(assigneePatch: .remove([])).isEmpty)

    XCTAssertFalse(TaskMetadataPatch(tagPatch: .add(["work"])).isEmpty)
    XCTAssertFalse(TaskMetadataPatch(tagPatch: .remove(["work"])).isEmpty)
    XCTAssertFalse(
      TaskMetadataPatch(assigneePatch: .add([PageID(rawValue: "person-alex")])).isEmpty
    )
    XCTAssertFalse(
      TaskMetadataPatch(assigneePatch: .remove([PageID(rawValue: "person-alex")])).isEmpty
    )

    // Empty replacement collections intentionally clear existing metadata.
    XCTAssertFalse(TaskMetadataPatch(tags: []).isEmpty)
    XCTAssertFalse(TaskMetadataPatch(assigneeIDs: []).isEmpty)
  }

  func testNormalizedCollectionOperationsPreserveUnmentionedMetadata() {
    let alex = PageID(rawValue: "person-alex")
    let blair = PageID(rawValue: "person-blair")
    let original = TaskData(
      assigneeIDs: [alex],
      tags: ["alpha", "shared"]
    )

    let added = TaskMetadataPatch(
      tagPatch: .add([" ALPHA ", "#Beta", "", " beta "]),
      assigneePatch: .add([alex, blair, blair])
    ).applying(to: original)

    XCTAssertEqual(added.tags, ["alpha", "beta", "shared"])
    XCTAssertEqual(added.assigneeIDs, [alex, blair])

    let removed = TaskMetadataPatch(
      tagPatch: .remove([" SHARED ", "#missing", ""]),
      assigneePatch: .remove([blair, blair])
    ).applying(to: original)

    XCTAssertEqual(removed.tags, ["alpha"])
    XCTAssertEqual(removed.assigneeIDs, [alex])
  }

  func testRepositoryRejectsEmptyNormalizedCollectionOperationsWithoutVersionChurn()
    async throws
  {
    let fixture = try TaskBatchFixture()
    let existingPerson = try await fixture.repository.createTaggedPage(
      title: "Existing person",
      supertagID: BuiltInSupertags.person
    )
    let task = try await fixture.repository.createTask(
      TaskDraft(
        title: "Keep metadata untouched",
        data: TaskData(
          assigneeIDs: [existingPerson.id],
          tags: ["existing"]
        )
      )
    )

    for patch in [
      TaskMetadataPatch(tagPatch: .add(["", " # "])),
      TaskMetadataPatch(tagPatch: .remove([" ", "#"])),
      TaskMetadataPatch(assigneePatch: .add([])),
      TaskMetadataPatch(assigneePatch: .remove([])),
    ] {
      do {
        _ = try await fixture.repository.patchTasks([task.id], patch: patch)
        XCTFail("Expected an empty collection operation to be rejected")
      } catch {
        XCTAssertEqual(error as? LibraryRepositoryError, .invalidRecord)
      }
    }

    let loaded = try await fixture.repository.page(id: task.id)
    let unchanged = try XCTUnwrap(loaded)
    XCTAssertEqual(unchanged.heads, task.heads)
    XCTAssertEqual(unchanged.dirtyGeneration, task.dirtyGeneration)
    XCTAssertEqual(unchanged.taskData, task.taskData)
  }

  func testRejectsDuplicateAndOverMaximumBatchesBeforeChangingAnything() async throws {
    let fixture = try TaskBatchFixture()
    let task = try await fixture.repository.createTask(TaskDraft(title: "Leave untouched"))

    for invalidIDs in [
      [task.id, task.id],
      (0...LibraryRepository.maximumTaskBatchSize).map {
        PageID(rawValue: "oversized-task-\($0)")
      },
    ] {
      do {
        _ = try await fixture.repository.patchTasks(
          invalidIDs,
          patch: TaskMetadataPatch(priority: .urgent)
        )
        XCTFail("Expected invalid batch membership to be rejected")
      } catch {
        XCTAssertEqual(error as? LibraryRepositoryError, .invalidRecord)
      }
    }

    let loaded = try await fixture.repository.page(id: task.id)
    let current = try XCTUnwrap(loaded)
    XCTAssertEqual(current.heads, task.heads)
    XCTAssertEqual(current.dirtyGeneration, task.dirtyGeneration)
    XCTAssertEqual(current.taskData, task.taskData)
  }

  func testPatchesFiftyTasksAndUndoRestoresEveryExactTaskDataValue() async throws {
    let fixture = try TaskBatchFixture()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let schedule = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 14, hour: 17))
    )
    let deadline = try XCTUnwrap(
      calendar.date(from: DateComponents(year: 2026, month: 8, day: 20, hour: 9))
    )
    let area = try await fixture.repository.createTaggedPage(
      title: "Work",
      supertagID: BuiltInSupertags.area
    )
    let project = try await fixture.repository.createProject(
      title: "Launch",
      data: ProjectData(areaID: area.id)
    )
    let person = try await fixture.repository.createTaggedPage(
      title: "Alex",
      supertagID: BuiltInSupertags.person
    )
    var tasks: [PageSnapshot] = []
    for index in 0..<50 {
      tasks.append(
        try await fixture.repository.createTask(
          TaskDraft(
            title: "Workbench task \(index)",
            data: TaskData(
              placement: index.isMultiple(of: 2) ? .inbox : .someday,
              priority: index.isMultiple(of: 3) ? .low : .none,
              tags: ["original-\(index)"]
            )
          )
        )
      )
    }
    let originalData = Dictionary(
      uniqueKeysWithValues: try tasks.map { ($0.id, try XCTUnwrap($0.taskData)) }
    )

    let patched = try await fixture.repository.patchTasks(
      tasks.map(\.id),
      patch: TaskMetadataPatch(
        schedule: .dateOnly(schedule),
        deadline: .set(deadline),
        priority: .urgent,
        placement: .anytime,
        project: .set(project.id),
        area: .set(area.id),
        tags: ["Deep Work", "launch", "deep work"],
        assigneeIDs: [person.id, person.id]
      ),
      calendar: calendar
    )

    XCTAssertEqual(patched.tasks.count, 50)
    XCTAssertTrue(patched.createdSuccessors.isEmpty)
    XCTAssertEqual(patched.undoReceipt.entries.count, 50)
    for task in patched.tasks {
      let data = try XCTUnwrap(task.taskData)
      XCTAssertEqual(data.scheduledAt, calendar.startOfDay(for: schedule))
      XCTAssertEqual(data.scheduleGranularity, .dateOnly)
      XCTAssertEqual(data.deadline, calendar.startOfDay(for: deadline))
      XCTAssertEqual(data.priority, .urgent)
      XCTAssertEqual(data.placement, .anytime)
      XCTAssertEqual(data.projectID, project.id)
      XCTAssertEqual(data.areaID, area.id)
      XCTAssertEqual(data.tags, ["deep work", "launch"])
      XCTAssertEqual(data.assigneeIDs, [person.id])
    }

    let undone = try await fixture.repository.undoTaskBatch(patched.undoReceipt)

    XCTAssertEqual(undone.restoredTasks.count, 50)
    XCTAssertTrue(undone.removedSuccessorIDs.isEmpty)
    for task in undone.restoredTasks {
      XCTAssertEqual(task.taskData, originalData[task.id])
    }
  }

  func testPatchSupportsTimedSchedulesAndExplicitMetadataClears() async throws {
    let fixture = try TaskBatchFixture()
    let scheduled = Date(timeIntervalSince1970: 1_900_123_456)
    let area = try await fixture.repository.createTaggedPage(
      title: "Personal",
      supertagID: BuiltInSupertags.area
    )
    let project = try await fixture.repository.createProject(title: "Move house")
    let person = try await fixture.repository.createTaggedPage(
      title: "Sam",
      supertagID: BuiltInSupertags.person
    )
    let task = try await fixture.repository.createTask(
      TaskDraft(
        title: "Book movers",
        data: TaskData(
          deadline: scheduled,
          projectID: project.id,
          areaID: area.id,
          assigneeIDs: [person.id],
          tags: ["moving"]
        )
      )
    )

    let result = try await fixture.repository.patchTasks(
      [task.id],
      patch: TaskMetadataPatch(
        schedule: .dateTime(scheduled),
        deadline: .clear,
        project: .clear,
        area: .clear,
        tags: [],
        assigneeIDs: []
      )
    )
    let data = try XCTUnwrap(result.tasks.first?.taskData)

    XCTAssertEqual(data.scheduledAt, scheduled)
    XCTAssertEqual(data.scheduleGranularity, .dateTime)
    XCTAssertNil(data.deadline)
    XCTAssertNil(data.projectID)
    XCTAssertNil(data.areaID)
    XCTAssertEqual(data.tags, [])
    XCTAssertEqual(data.assigneeIDs, [])
  }

  func testCompletionPreflightFailureRollsBackEarlierTaskAndPreparedRecurrence() async throws {
    let fixture = try TaskBatchFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let recurring = try await fixture.repository.createTask(
      TaskDraft(
        title: "Still active",
        data: TaskData(
          scheduledAt: now,
          recurrence: TaskRecurrenceRule(mode: .fixedSchedule, unit: .day)
        )
      )
    )
    let alreadyClosed = try await fixture.repository.createTask(
      TaskDraft(title: "Already closed")
    )
    _ = try await fixture.repository.completeTask(pageID: alreadyClosed.id, now: now)
    let loadedRecurringBefore = try await fixture.repository.page(id: recurring.id)
    let recurringBefore = try XCTUnwrap(loadedRecurringBefore)
    let taskIDsBefore = Set(
      try await fixture.repository.pages(with: BuiltInSupertags.task).map(\.id)
    )

    do {
      _ = try await fixture.repository.completeTasks(
        [recurring.id, alreadyClosed.id],
        now: now.addingTimeInterval(86_400)
      )
      XCTFail("Expected the closed task to fail batch preflight")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskNotActive)
    }

    let loadedRecurringAfter = try await fixture.repository.page(id: recurring.id)
    let recurringAfter = try XCTUnwrap(loadedRecurringAfter)
    XCTAssertEqual(recurringAfter.heads, recurringBefore.heads)
    XCTAssertEqual(recurringAfter.dirtyGeneration, recurringBefore.dirtyGeneration)
    XCTAssertEqual(recurringAfter.taskData, recurringBefore.taskData)
    let taskIDsAfter = Set(
      try await fixture.repository.pages(with: BuiltInSupertags.task).map(\.id)
    )
    XCTAssertEqual(taskIDsAfter, taskIDsBefore)
  }

  func testProjectAreaInvariantFailureRollsBackTheWholePatch() async throws {
    let fixture = try TaskBatchFixture()
    let projectArea = try await fixture.repository.createTaggedPage(
      title: "Work",
      supertagID: BuiltInSupertags.area
    )
    let conflictingArea = try await fixture.repository.createTaggedPage(
      title: "Personal",
      supertagID: BuiltInSupertags.area
    )
    let project = try await fixture.repository.createProject(
      title: "Quarterly plan",
      data: ProjectData(areaID: projectArea.id)
    )
    let first = try await fixture.repository.createTask(TaskDraft(title: "First"))
    let second = try await fixture.repository.createTask(TaskDraft(title: "Second"))

    do {
      _ = try await fixture.repository.patchTasks(
        [first.id, second.id],
        patch: TaskMetadataPatch(
          priority: .high,
          project: .set(project.id),
          area: .set(conflictingArea.id)
        )
      )
      XCTFail("Expected a project/area mismatch to fail preflight")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .invalidRecord)
    }

    for original in [first, second] {
      let loaded = try await fixture.repository.page(id: original.id)
      let current = try XCTUnwrap(loaded)
      XCTAssertEqual(current.heads, original.heads)
      XCTAssertEqual(current.dirtyGeneration, original.dirtyGeneration)
      XCTAssertEqual(current.taskData, original.taskData)
    }
  }

  func testMissingTargetAndInvalidAssigneeEachRollBackTheWholePatch() async throws {
    let fixture = try TaskBatchFixture()
    let first = try await fixture.repository.createTask(TaskDraft(title: "First"))
    let second = try await fixture.repository.createTask(TaskDraft(title: "Second"))
    let originals = [first, second]

    do {
      _ = try await fixture.repository.patchTasks(
        [first.id, PageID(rawValue: "missing-task")],
        patch: TaskMetadataPatch(priority: .urgent)
      )
      XCTFail("Expected a missing task to fail preflight")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .invalidRecord)
    }

    do {
      _ = try await fixture.repository.patchTasks(
        originals.map(\.id),
        patch: TaskMetadataPatch(
          priority: .high,
          assigneeIDs: [PageID(rawValue: "missing-person")]
        )
      )
      XCTFail("Expected an invalid assignee to fail preflight")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .invalidRecord)
    }

    for original in originals {
      let loaded = try await fixture.repository.page(id: original.id)
      let current = try XCTUnwrap(loaded)
      XCTAssertEqual(current.heads, original.heads)
      XCTAssertEqual(current.dirtyGeneration, original.dirtyGeneration)
      XCTAssertEqual(current.taskData, original.taskData)
    }
  }

  func testUndoPreflightsHierarchyAndChangesNothingForForgedCycle() async throws {
    let fixture = try TaskBatchFixture()
    let parent = try await fixture.repository.createTask(TaskDraft(title: "Parent"))
    let child = try await fixture.repository.createTask(
      TaskDraft(title: "Child", data: TaskData(parentTaskID: parent.id))
    )
    var impossiblePriorData = try XCTUnwrap(parent.taskData)
    impossiblePriorData.parentTaskID = child.id
    let forged = TaskBatchUndoReceipt(
      entries: [
        TaskBatchUndoEntry(
          operation: .patch,
          sourceAfterMutation: TaskPageVersion(parent),
          sourceBeforeTaskData: impossiblePriorData
        )
      ]
    )

    do {
      _ = try await fixture.repository.undoTaskBatch(forged)
      XCTFail("Expected the forged parent cycle to fail undo preflight")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .invalidRecord)
    }

    let loadedParent = try await fixture.repository.page(id: parent.id)
    let loadedChild = try await fixture.repository.page(id: child.id)
    let currentParent = try XCTUnwrap(loadedParent)
    let currentChild = try XCTUnwrap(loadedChild)
    XCTAssertEqual(currentParent.heads, parent.heads)
    XCTAssertEqual(currentParent.taskData, parent.taskData)
    XCTAssertEqual(currentChild.heads, child.heads)
    XCTAssertEqual(currentChild.taskData, child.taskData)
  }

  func testRecurringBatchCompletionCreatesSuccessorsAndUndoRestoresAtomically() async throws {
    let fixture = try TaskBatchFixture()
    let scheduled = Date(timeIntervalSince1970: 1_900_000_000)
    let completedAt = scheduled.addingTimeInterval(86_400)
    let first = try await fixture.repository.createTask(
      TaskDraft(
        title: "Daily one",
        data: TaskData(
          scheduledAt: scheduled,
          recurrence: TaskRecurrenceRule(mode: .fixedSchedule, unit: .day)
        )
      )
    )
    let second = try await fixture.repository.createTask(
      TaskDraft(
        title: "Daily two",
        data: TaskData(
          scheduledAt: scheduled,
          recurrence: TaskRecurrenceRule(mode: .afterCompletion, unit: .day)
        )
      )
    )
    let originalData = [
      first.id: try XCTUnwrap(first.taskData),
      second.id: try XCTUnwrap(second.taskData),
    ]

    let completed = try await fixture.repository.completeTasks(
      [first.id, second.id],
      now: completedAt
    )

    XCTAssertEqual(completed.tasks.map(\.taskData?.state), [.completed, .completed])
    XCTAssertEqual(completed.createdSuccessors.count, 2)
    XCTAssertEqual(completed.undoReceipt.entries.count, 2)
    XCTAssertTrue(completed.undoReceipt.entries.allSatisfy { $0.createdSuccessor != nil })
    let successorIDs = Set(completed.createdSuccessors.map(\.id))

    let undone = try await fixture.repository.undoTaskBatch(
      completed.undoReceipt,
      now: completedAt.addingTimeInterval(60)
    )

    XCTAssertEqual(Set(undone.removedSuccessorIDs), successorIDs)
    XCTAssertEqual(undone.restoredTasks.count, 2)
    for task in undone.restoredTasks {
      XCTAssertEqual(task.taskData, originalData[task.id])
    }
    for successorID in successorIDs {
      let successor = try await fixture.repository.page(id: successorID)
      let marker = try await fixture.repository.purgeMarker(pageID: successorID)
      XCTAssertNil(successor)
      XCTAssertNotNil(marker)
    }
  }

  func testUndoSuccessorConflictRollsBackEverySourceAndSuccessor() async throws {
    let fixture = try TaskBatchFixture()
    let scheduled = Date(timeIntervalSince1970: 1_900_000_000)
    var originals: [PageSnapshot] = []
    for title in ["First recurring", "Second recurring"] {
      originals.append(
        try await fixture.repository.createTask(
          TaskDraft(
            title: title,
            data: TaskData(
              scheduledAt: scheduled,
              recurrence: TaskRecurrenceRule(mode: .fixedSchedule, unit: .day)
            )
          )
        )
      )
    }
    let completed = try await fixture.repository.completeTasks(
      originals.map(\.id),
      now: scheduled.addingTimeInterval(86_400)
    )
    let changedSuccessor = try XCTUnwrap(completed.createdSuccessors.last)
    var changedData = try XCTUnwrap(changedSuccessor.taskData)
    changedData.priority = .urgent
    _ = try await fixture.repository.updateTask(
      pageID: changedSuccessor.id,
      data: changedData
    )

    do {
      _ = try await fixture.repository.undoTaskBatch(completed.undoReceipt)
      XCTFail("Expected a changed successor to make the entire undo unavailable")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskCompletionUndoUnavailable)
    }

    for source in completed.tasks {
      let loaded = try await fixture.repository.page(id: source.id)
      let current = try XCTUnwrap(loaded)
      XCTAssertEqual(current.heads, source.heads)
      XCTAssertEqual(current.dirtyGeneration, source.dirtyGeneration)
      XCTAssertEqual(current.taskData?.state, .completed)
    }
    for successor in completed.createdSuccessors {
      let loaded = try await fixture.repository.page(id: successor.id)
      let marker = try await fixture.repository.purgeMarker(pageID: successor.id)
      XCTAssertNotNil(loaded)
      XCTAssertNil(marker)
    }
  }

  func testUndoSourceConflictRollsBackEverySourceAndSuccessor() async throws {
    let fixture = try TaskBatchFixture()
    let scheduled = Date(timeIntervalSince1970: 1_900_000_000)
    var originals: [PageSnapshot] = []
    for title in ["First source", "Second source"] {
      originals.append(
        try await fixture.repository.createTask(
          TaskDraft(
            title: title,
            data: TaskData(
              scheduledAt: scheduled,
              recurrence: TaskRecurrenceRule(mode: .fixedSchedule, unit: .day)
            )
          )
        )
      )
    }
    let completed = try await fixture.repository.completeTasks(
      originals.map(\.id),
      now: scheduled.addingTimeInterval(86_400)
    )
    var divergentData = try XCTUnwrap(completed.tasks.first?.taskData)
    divergentData.priority = .urgent
    _ = try await fixture.repository.updateTask(
      pageID: completed.tasks[0].id,
      data: divergentData
    )

    do {
      _ = try await fixture.repository.undoTaskBatch(completed.undoReceipt)
      XCTFail("Expected a changed source to make the entire undo unavailable")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskCompletionUndoUnavailable)
    }

    for source in completed.tasks {
      let loaded = try await fixture.repository.page(id: source.id)
      let current = try XCTUnwrap(loaded)
      XCTAssertEqual(current.taskData?.state, .completed)
    }
    for successor in completed.createdSuccessors {
      let loaded = try await fixture.repository.page(id: successor.id)
      let marker = try await fixture.repository.purgeMarker(pageID: successor.id)
      XCTAssertNotNil(loaded)
      XCTAssertNil(marker)
    }
  }

  func testAddAndRemoveCollectionPatchesPreserveUnseenValuesAndUndoExactly() async throws {
    let fixture = try TaskBatchFixture()
    let firstPerson = try await fixture.repository.createTaggedPage(
      title: "First person",
      supertagID: BuiltInSupertags.person
    )
    let secondPerson = try await fixture.repository.createTaggedPage(
      title: "Second person",
      supertagID: BuiltInSupertags.person
    )
    let sharedPerson = try await fixture.repository.createTaggedPage(
      title: "Shared person",
      supertagID: BuiltInSupertags.person
    )
    let first = try await fixture.repository.createTask(
      TaskDraft(
        title: "First mixed task",
        data: TaskData(assigneeIDs: [firstPerson.id], tags: ["alpha", "shared"])
      )
    )
    let second = try await fixture.repository.createTask(
      TaskDraft(
        title: "Second mixed task",
        data: TaskData(assigneeIDs: [secondPerson.id], tags: ["beta", "shared"])
      )
    )
    let originals = [
      first.id: try XCTUnwrap(first.taskData),
      second.id: try XCTUnwrap(second.taskData),
    ]

    let added = try await fixture.repository.patchTasks(
      [first.id, second.id],
      patch: TaskMetadataPatch(
        tagPatch: .add(["Common", "ALPHA"]),
        assigneePatch: .add([sharedPerson.id, sharedPerson.id])
      )
    )

    XCTAssertEqual(added.tasks[0].taskData?.tags, ["alpha", "common", "shared"])
    XCTAssertEqual(added.tasks[1].taskData?.tags, ["alpha", "beta", "common", "shared"])
    XCTAssertEqual(
      added.tasks[0].taskData?.assigneeIDs,
      TaskData.normalizedPageIDs([firstPerson.id, sharedPerson.id])
    )
    XCTAssertEqual(
      added.tasks[1].taskData?.assigneeIDs,
      TaskData.normalizedPageIDs([secondPerson.id, sharedPerson.id])
    )

    let addUndo = try await fixture.repository.undoTaskBatch(added.undoReceipt)
    for task in addUndo.restoredTasks {
      XCTAssertEqual(task.taskData, originals[task.id])
    }

    let removed = try await fixture.repository.patchTasks(
      [first.id, second.id],
      patch: TaskMetadataPatch(
        tagPatch: .remove(["SHARED", "not-present"]),
        assigneePatch: .remove([firstPerson.id])
      )
    )

    XCTAssertEqual(removed.tasks[0].taskData?.tags, ["alpha"])
    XCTAssertEqual(removed.tasks[1].taskData?.tags, ["beta"])
    XCTAssertEqual(removed.tasks[0].taskData?.assigneeIDs, [])
    XCTAssertEqual(removed.tasks[1].taskData?.assigneeIDs, [secondPerson.id])

    let removeUndo = try await fixture.repository.undoTaskBatch(removed.undoReceipt)
    for task in removeUndo.restoredTasks {
      XCTAssertEqual(task.taskData, originals[task.id])
    }
  }

  func testCancelAndReopenBatchUndoRestoreExactPriorStates() async throws {
    let fixture = try TaskBatchFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let first = try await fixture.repository.createTask(
      TaskDraft(
        title: "First lifecycle task",
        data: TaskData(priority: .high, tags: ["first"])
      )
    )
    let second = try await fixture.repository.createTask(
      TaskDraft(
        title: "Second lifecycle task",
        data: TaskData(placement: .someday, tags: ["second"])
      )
    )
    let activeData = [
      first.id: try XCTUnwrap(first.taskData),
      second.id: try XCTUnwrap(second.taskData),
    ]

    let canceled = try await fixture.repository.cancelTasks(
      [first.id, second.id],
      now: now
    )
    XCTAssertEqual(canceled.tasks.map(\.taskData?.state), [.canceled, .canceled])

    let cancelUndo = try await fixture.repository.undoTaskBatch(
      canceled.undoReceipt,
      now: now.addingTimeInterval(1)
    )
    for task in cancelUndo.restoredTasks {
      XCTAssertEqual(task.taskData, activeData[task.id])
    }

    _ = try await fixture.repository.completeTask(pageID: first.id, now: now)
    _ = try await fixture.repository.cancelTask(pageID: second.id, now: now)
    let loadedFirstClosed = try await fixture.repository.page(id: first.id)
    let loadedSecondClosed = try await fixture.repository.page(id: second.id)
    let firstClosed = try XCTUnwrap(loadedFirstClosed)
    let secondClosed = try XCTUnwrap(loadedSecondClosed)
    let closedData = [
      first.id: try XCTUnwrap(firstClosed.taskData),
      second.id: try XCTUnwrap(secondClosed.taskData),
    ]

    let reopened = try await fixture.repository.reopenTasks(
      [first.id, second.id],
      now: now.addingTimeInterval(2)
    )
    XCTAssertEqual(reopened.tasks.map(\.taskData?.state), [.active, .active])

    let reopenUndo = try await fixture.repository.undoTaskBatch(
      reopened.undoReceipt,
      now: now.addingTimeInterval(3)
    )
    for task in reopenUndo.restoredTasks {
      XCTAssertEqual(task.taskData, closedData[task.id])
    }
  }

  func testTrashBatchRestoresMixedLifecycleParentChildAndRecurringTasksExactly() async throws {
    let fixture = try TaskBatchFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let parent = try await fixture.repository.createTask(
      TaskDraft(title: "Parent", data: TaskData(priority: .high, tags: ["family"]))
    )
    let child = try await fixture.repository.createTask(
      TaskDraft(
        title: "Child",
        data: TaskData(parentTaskID: parent.id, tags: ["errand"])
      )
    )
    let recurring = try await fixture.repository.createTask(
      TaskDraft(
        title: "Recurring",
        data: TaskData(
          scheduledAt: now,
          recurrence: TaskRecurrenceRule(mode: .fixedSchedule, unit: .day)
        )
      )
    )
    let canceled = try await fixture.repository.createTask(TaskDraft(title: "Canceled"))
    _ = try await fixture.repository.cancelTask(pageID: canceled.id, now: now)
    let loadedCanceledBefore = try await fixture.repository.page(id: canceled.id)
    let canceledBefore = try XCTUnwrap(loadedCanceledBefore)
    let originals = Dictionary(
      uniqueKeysWithValues: try [parent, child, recurring, canceledBefore].map {
        ($0.id, try XCTUnwrap($0.taskData))
      }
    )
    let pageIDs = [parent.id, child.id, recurring.id, canceled.id]

    let trashed = try await fixture.repository.trashTasks(pageIDs, now: now.addingTimeInterval(1))

    XCTAssertEqual(trashed.tasks.map(\.id), pageIDs)
    XCTAssertTrue(trashed.tasks.allSatisfy { $0.deletedAt != nil })
    XCTAssertTrue(trashed.createdSuccessors.isEmpty)
    XCTAssertTrue(trashed.undoReceipt.entries.allSatisfy { $0.operation == .trash })
    for task in trashed.tasks {
      XCTAssertEqual(task.taskData, originals[task.id])
    }

    let recurringData = try XCTUnwrap(recurring.taskData)
    let seriesID = try XCTUnwrap(recurringData.recurrenceSeriesID)
    let sequence = try XCTUnwrap(recurringData.recurrenceSequence)
    let successorID = PageID.taskOccurrence(seriesID: seriesID, sequence: sequence + 1)
    let absentSuccessor = try await fixture.repository.page(id: successorID)
    XCTAssertNil(absentSuccessor)

    let undone = try await fixture.repository.undoTaskBatch(
      trashed.undoReceipt,
      now: now.addingTimeInterval(2)
    )
    XCTAssertEqual(undone.restoredTasks.map(\.id), pageIDs)
    XCTAssertTrue(undone.removedSuccessorIDs.isEmpty)
    for task in undone.restoredTasks {
      XCTAssertNil(task.deletedAt)
      XCTAssertEqual(task.taskData, originals[task.id])
    }
  }

  func testTrashUndoConflictLeavesEveryOtherTaskUntouched() async throws {
    let fixture = try TaskBatchFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let first = try await fixture.repository.createTask(TaskDraft(title: "First"))
    let second = try await fixture.repository.createTask(TaskDraft(title: "Second"))
    let trashed = try await fixture.repository.trashTasks(
      [first.id, second.id],
      now: now
    )
    let firstTrashed = try XCTUnwrap(trashed.tasks.first { $0.id == first.id })
    _ = try await fixture.repository.restoreTask(
      pageID: second.id,
      now: now.addingTimeInterval(1)
    )

    do {
      _ = try await fixture.repository.undoTaskBatch(
        trashed.undoReceipt,
        now: now.addingTimeInterval(2)
      )
      XCTFail("Expected a changed trash receipt to reject the whole undo")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskCompletionUndoUnavailable)
    }

    let loadedFirstAfter = try await fixture.repository.page(id: first.id)
    let loadedSecondAfter = try await fixture.repository.page(id: second.id)
    let firstAfter = try XCTUnwrap(loadedFirstAfter)
    let secondAfter = try XCTUnwrap(loadedSecondAfter)
    XCTAssertEqual(firstAfter.heads, firstTrashed.heads)
    XCTAssertEqual(firstAfter.dirtyGeneration, firstTrashed.dirtyGeneration)
    XCTAssertNotNil(firstAfter.deletedAt)
    XCTAssertNil(secondAfter.deletedAt)
  }

  func testTrashBatchRejectsAlreadyTrashedMemberWithoutChangingLiveTask() async throws {
    let fixture = try TaskBatchFixture()
    let live = try await fixture.repository.createTask(TaskDraft(title: "Keep live"))
    let alreadyTrashed = try await fixture.repository.createTask(TaskDraft(title: "Already gone"))
    _ = try await fixture.repository.moveTaskToTrash(pageID: alreadyTrashed.id)

    do {
      _ = try await fixture.repository.trashTasks([live.id, alreadyTrashed.id])
      XCTFail("Expected the whole batch to reject an already-trashed task")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .invalidRecord)
    }

    let loadedLiveAfter = try await fixture.repository.page(id: live.id)
    let loadedTrashedAfter = try await fixture.repository.page(id: alreadyTrashed.id)
    let liveAfter = try XCTUnwrap(loadedLiveAfter)
    let trashedAfter = try XCTUnwrap(loadedTrashedAfter)
    XCTAssertEqual(liveAfter.heads, live.heads)
    XCTAssertEqual(liveAfter.dirtyGeneration, live.dirtyGeneration)
    XCTAssertNil(liveAfter.deletedAt)
    XCTAssertNotNil(trashedAfter.deletedAt)
  }

  func testTrashingCompletedRecurringSourceDoesNotChangeExistingSuccessor() async throws {
    let fixture = try TaskBatchFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let source = try await fixture.repository.createTask(
      TaskDraft(
        title: "Recurring source",
        data: TaskData(
          scheduledAt: now,
          recurrence: TaskRecurrenceRule(mode: .fixedSchedule, unit: .day)
        )
      )
    )
    let completion = try await fixture.repository.completeTask(
      pageID: source.id,
      now: now.addingTimeInterval(60)
    )
    let successor = try XCTUnwrap(completion.successor)

    let trashed = try await fixture.repository.trashTasks(
      [source.id],
      now: now.addingTimeInterval(120)
    )
    _ = try await fixture.repository.undoTaskBatch(
      trashed.undoReceipt,
      now: now.addingTimeInterval(180)
    )

    let loadedSuccessorAfter = try await fixture.repository.page(id: successor.id)
    let successorAfter = try XCTUnwrap(loadedSuccessorAfter)
    XCTAssertEqual(successorAfter.heads, successor.heads)
    XCTAssertEqual(successorAfter.dirtyGeneration, successor.dirtyGeneration)
    XCTAssertEqual(successorAfter.taskData, successor.taskData)
    XCTAssertNil(successorAfter.deletedAt)
  }

  func testCoordinatorTrashAndUndoRunStateCorrectEffects() async throws {
    let fixture = try TaskBatchFixture()
    let recorder = TaskBatchEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in await recorder.apply(effect) }
    )
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let active = try await fixture.repository.createTask(TaskDraft(title: "Active"))
    let closed = try await fixture.repository.createTask(TaskDraft(title: "Closed"))
    _ = try await fixture.repository.cancelTask(pageID: closed.id, now: now)
    let pageIDs = [active.id, closed.id]

    let trashed = try taskMutationSuccess(
      await coordinator.trashTasks(pageIDs, now: now.addingTimeInterval(1))
    )
    XCTAssertEqual(trashed.operation, .trashTasks)
    let trashEffects = await recorder.take()
    XCTAssertEqual(
      trashEffects,
      closedEffects(for: trashed.value.tasks) + syncTail(for: pageIDs)
    )

    let restored = try taskMutationSuccess(
      await coordinator.undoTaskBatch(
        trashed.value.undoReceipt,
        now: now.addingTimeInterval(2)
      )
    )
    let restoredActive = restored.value.restoredTasks.filter { $0.id == active.id }
    let restoredClosed = restored.value.restoredTasks.filter { $0.id == closed.id }
    let restoreEffects = await recorder.take()
    XCTAssertEqual(
      restoreEffects,
      activeEffects(for: restoredActive)
        + restoredClosed.flatMap {
          [TaskMutationEffect.cancelReminder($0.id), .removeSpotlight($0.id)]
        }
        + syncTail(for: pageIDs)
    )
  }

  func testCancelAndReopenLifecycleFailuresRollBackEarlierPreparedTasks() async throws {
    let fixture = try TaskBatchFixture()
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let active = try await fixture.repository.createTask(TaskDraft(title: "Active"))
    let closed = try await fixture.repository.createTask(TaskDraft(title: "Closed"))
    _ = try await fixture.repository.completeTask(pageID: closed.id, now: now)
    let loadedClosed = try await fixture.repository.page(id: closed.id)
    let closedBefore = try XCTUnwrap(loadedClosed)

    do {
      _ = try await fixture.repository.cancelTasks([active.id, closed.id], now: now)
      XCTFail("Expected cancellation of a closed task to fail the whole batch")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskNotActive)
    }
    let loadedActiveAfterCancel = try await fixture.repository.page(id: active.id)
    let loadedClosedAfterCancel = try await fixture.repository.page(id: closed.id)
    let activeAfterCancel = try XCTUnwrap(loadedActiveAfterCancel)
    let closedAfterCancel = try XCTUnwrap(loadedClosedAfterCancel)
    XCTAssertEqual(activeAfterCancel.heads, active.heads)
    XCTAssertEqual(activeAfterCancel.taskData, active.taskData)
    XCTAssertEqual(closedAfterCancel.heads, closedBefore.heads)
    XCTAssertEqual(closedAfterCancel.taskData, closedBefore.taskData)

    do {
      _ = try await fixture.repository.reopenTasks([closed.id, active.id], now: now)
      XCTFail("Expected reopening an active task to fail the whole batch")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskNotClosed)
    }
    let loadedActiveAfterReopen = try await fixture.repository.page(id: active.id)
    let loadedClosedAfterReopen = try await fixture.repository.page(id: closed.id)
    let activeAfterReopen = try XCTUnwrap(loadedActiveAfterReopen)
    let closedAfterReopen = try XCTUnwrap(loadedClosedAfterReopen)
    XCTAssertEqual(activeAfterReopen.heads, active.heads)
    XCTAssertEqual(activeAfterReopen.taskData, active.taskData)
    XCTAssertEqual(closedAfterReopen.heads, closedBefore.heads)
    XCTAssertEqual(closedAfterReopen.taskData, closedBefore.taskData)
  }

  func testCoordinatorCancelReopenAndUndoRunStateCorrectEffects() async throws {
    let fixture = try TaskBatchFixture()
    let recorder = TaskBatchEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in await recorder.apply(effect) }
    )
    let now = Date(timeIntervalSince1970: 1_900_000_000)
    let first = try await fixture.repository.createTask(TaskDraft(title: "First"))
    let second = try await fixture.repository.createTask(TaskDraft(title: "Second"))
    let pageIDs = [first.id, second.id]

    let canceled = try taskMutationSuccess(
      await coordinator.cancelTasks(pageIDs, now: now)
    )
    XCTAssertEqual(canceled.operation, .cancelTasks)
    let cancelEffects = await recorder.take()
    XCTAssertEqual(
      cancelEffects,
      closedEffects(for: canceled.value.tasks) + syncTail(for: pageIDs)
    )

    let cancelUndo = try taskMutationSuccess(
      await coordinator.undoTaskBatch(canceled.value.undoReceipt, now: now.addingTimeInterval(1))
    )
    XCTAssertEqual(cancelUndo.operation, .undoTaskBatch)
    let cancelUndoEffects = await recorder.take()
    XCTAssertEqual(
      cancelUndoEffects,
      activeEffects(for: cancelUndo.value.restoredTasks) + syncTail(for: pageIDs)
    )

    _ = try await fixture.repository.completeTask(pageID: first.id, now: now)
    _ = try await fixture.repository.cancelTask(pageID: second.id, now: now)
    let reopened = try taskMutationSuccess(
      await coordinator.reopenTasks(pageIDs, now: now.addingTimeInterval(2))
    )
    XCTAssertEqual(reopened.operation, .reopenTasks)
    let reopenEffects = await recorder.take()
    XCTAssertEqual(
      reopenEffects,
      activeEffects(for: reopened.value.tasks) + syncTail(for: pageIDs)
    )

    let reopenUndo = try taskMutationSuccess(
      await coordinator.undoTaskBatch(reopened.value.undoReceipt, now: now.addingTimeInterval(3))
    )
    XCTAssertEqual(reopenUndo.operation, .undoTaskBatch)
    let reopenUndoEffects = await recorder.take()
    XCTAssertEqual(
      reopenUndoEffects,
      closedEffects(for: reopenUndo.value.restoredTasks) + syncTail(for: pageIDs)
    )
  }

  func testCoordinatorBatchCompletionDrainsOutboxAndRunsOrderedEffects() async throws {
    let fixture = try TaskBatchFixture()
    let recorder = TaskBatchEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in
        await recorder.apply(effect)
      }
    )
    let scheduled = Date(timeIntervalSince1970: 1_900_000_000)
    let plain = try await fixture.repository.createTask(TaskDraft(title: "Plain"))
    let recurring = try await fixture.repository.createTask(
      TaskDraft(
        title: "Recurring",
        data: TaskData(
          scheduledAt: scheduled,
          recurrence: TaskRecurrenceRule(mode: .fixedSchedule, unit: .day)
        )
      )
    )

    let mutation = await coordinator.completeTasks(
      [plain.id, recurring.id],
      now: scheduled.addingTimeInterval(86_400)
    )
    guard case .success(let success) = mutation else {
      return XCTFail("Expected batch completion to succeed: \(mutation)")
    }
    let successor = try XCTUnwrap(success.value.createdSuccessors.first)
    let effects = await recorder.take()

    XCTAssertEqual(success.operation, .completeTasks)
    XCTAssertEqual(success.changedPageIDs, [plain.id, recurring.id, successor.id])
    XCTAssertEqual(
      effects,
      [
        .reloadLibrary,
        .cancelReminder(plain.id),
        .removeSpotlight(plain.id),
        .cancelReminder(recurring.id),
        .removeSpotlight(recurring.id),
        .scheduleReminder(successor, requestingAuthorization: false),
        .indexSpotlight(successor),
        .sync(plain.id),
        .sync(recurring.id),
        .sync(successor.id),
        .reloadWidgets,
      ]
    )
    let pendingEffects = try await fixture.repository.pendingTaskEffectOutboxIdentities()
    XCTAssertTrue(pendingEffects.isEmpty)
  }
}

private func taskMutationSuccess<Value: Sendable>(
  _ result: TaskMutationResult<Value>,
  file: StaticString = #filePath,
  line: UInt = #line
) throws -> TaskMutationSuccess<Value> {
  switch result {
  case .success(let success):
    return success
  case .failure(let failure):
    XCTFail("Unexpected mutation failure: \(failure)", file: file, line: line)
    throw failure
  }
}

private func activeEffects(for tasks: [PageSnapshot]) -> [TaskMutationEffect] {
  [.reloadLibrary]
    + tasks.flatMap {
      [
        TaskMutationEffect.scheduleReminder($0, requestingAuthorization: false),
        .indexSpotlight($0),
      ]
    }
}

private func closedEffects(for tasks: [PageSnapshot]) -> [TaskMutationEffect] {
  [.reloadLibrary]
    + tasks.flatMap {
      [TaskMutationEffect.cancelReminder($0.id), .removeSpotlight($0.id)]
    }
}

private func syncTail(for pageIDs: [PageID]) -> [TaskMutationEffect] {
  pageIDs.map(TaskMutationEffect.sync) + [.reloadWidgets]
}

private actor TaskBatchEffectRecorder {
  private var effects: [TaskMutationEffect] = []

  func apply(_ effect: TaskMutationEffect) -> TaskMutationEffectDisposition {
    effects.append(effect)
    return .applied
  }

  func take() -> [TaskMutationEffect] {
    defer { effects.removeAll() }
    return effects
  }
}

private final class TaskBatchFixture {
  let repository: LibraryRepository
  private let directory: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "enchiridion-task-batch-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    repository = try LibraryRepository(
      path: directory.appendingPathComponent("library.sqlite").path
    )
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }
}
