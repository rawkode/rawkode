import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskClarificationTests: XCTestCase {
  func testSeedIsReadOnlyAndContainsOnlyEligibleLocalAssociations() async throws {
    let fixture = try TaskClarificationFixture()
    let openProject = try await fixture.repository.createProject(title: "Launch")
    let closedProject = try await fixture.repository.createProject(
      title: "Archived",
      data: ProjectData(status: .completed)
    )
    let area = try await fixture.repository.createTaggedPage(
      title: "Work",
      supertagID: BuiltInSupertags.area
    )
    let parent = try await fixture.repository.createTask(TaskDraft(title: "Parent"))
    let person = try await fixture.repository.createTaggedPage(
      title: "Alex",
      supertagID: BuiltInSupertags.person
    )
    let otherPerson = try await fixture.repository.createTaggedPage(
      title: "Event Attendee",
      supertagID: BuiltInSupertags.person
    )
    _ = try await fixture.repository.movePersonToOther(pageID: otherPerson.id)
    let source = try await fixture.repository.createTask(
      TaskDraft(title: "Plan launch", notes: "Captured source notes")
    )

    let seed = try await fixture.repository.taskClarificationSeed(pageID: source.id)
    let loadedUnchanged = try await fixture.repository.page(id: source.id)
    let unchanged = try XCTUnwrap(loadedUnchanged)

    XCTAssertEqual(seed.expectedVersion, TaskPageVersion(source))
    XCTAssertEqual(seed.literalDraft.title, "Plan launch")
    XCTAssertEqual(seed.references.projects.map(\.id), [openProject.id])
    XCTAssertFalse(seed.references.projects.map(\.id).contains(closedProject.id))
    XCTAssertEqual(seed.references.areas.map(\.id), [area.id])
    XCTAssertEqual(seed.references.parentTasks.map(\.id), [parent.id])
    XCTAssertEqual(seed.references.people.map(\.id), [person.id])
    XCTAssertFalse(seed.references.people.map(\.id).contains(otherPerson.id))
    XCTAssertEqual(unchanged.heads, source.heads)
    XCTAssertEqual(unchanged.dirtyGeneration, source.dirtyGeneration)
    XCTAssertEqual(unchanged.plainText, "Captured source notes")
  }

  func testProposalResolvesOnlyOneExactLocalAssociationAndUnavailableIsFullyManual()
    throws
  {
    let taskID = PageID(rawValue: "task")
    let projectID = PageID(rawValue: "project")
    let version = TaskPageVersion(
      id: taskID,
      heads: AutomergeHeads([]),
      dirtyGeneration: 3
    )
    let seed = TaskClarificationSeed(
      taskID: taskID,
      expectedVersion: version,
      input: "Plan Launch tomorrow",
      literalDraft: TaskClarificationDraft(title: "Plan Launch tomorrow"),
      references: TaskClarificationReferenceCatalog(
        projects: [TaskClarificationNamedReference(id: projectID, title: "Launch")]
      )
    )
    let date = Date(timeIntervalSince1970: 1_817_000_000)
    let interpretation = TaskInterpretation(
      originalInput: seed.input,
      draft: TaskDraft(
        title: "Plan Launch",
        data: TaskData(scheduledAt: date, scheduleGranularity: .dateOnly)
      ),
      suggestions: [
        TaskInterpretationSuggestion(
          id: "schedule",
          field: .scheduledDate,
          value: date.formatted(.iso8601),
          sourceText: "tomorrow",
          state: .applied
        ),
        TaskInterpretationSuggestion(
          id: "project",
          field: .project,
          value: "launch",
          sourceText: "Launch",
          state: .unresolved
        ),
      ]
    )

    guard case .proposed(let proposal) = TaskClarificationProposalBuilder.result(
      seed: seed,
      response: .interpreted(interpretation)
    ) else { return XCTFail("Expected a proposal") }
    XCTAssertEqual(proposal.expectedVersion, version)
    XCTAssertEqual(proposal.draft.projectID, projectID)
    XCTAssertEqual(proposal.draft.scheduledAt, date)
    XCTAssertEqual(proposal.draft.scheduleGranularity, TaskScheduleGranularity.dateOnly)
    XCTAssertEqual(proposal.interpretation.suggestions.last?.state, .applied)

    guard case .unavailable(let fallback, let availability) =
      TaskClarificationProposalBuilder.result(
        seed: seed,
        response: .unavailable(.literal(seed.input), .modelNotReady)
      )
    else { return XCTFail("Expected complete manual fallback") }
    XCTAssertEqual(availability, AssistantAvailability.modelNotReady)
    XCTAssertEqual(fallback.taskID, taskID)
    XCTAssertEqual(fallback.expectedVersion, version)
    XCTAssertEqual(fallback.draft, seed.literalDraft)
  }

  func testApplyMovesToAnytimePreservesNotesAndUndoRestoresExactPriorState() async throws {
    let fixture = try TaskClarificationFixture()
    let deadline = Date(timeIntervalSince1970: 1_818_000_000)
    let reminder = deadline.addingTimeInterval(-3_600)
    let source = try await fixture.repository.createTask(
      TaskDraft(
        title: "Literal capture tomorrow",
        notes: "Never rewrite these notes",
        data: TaskData(priority: .low, tags: ["original"])
      )
    )
    let sourceData = try XCTUnwrap(source.taskData)
    var draft = try XCTUnwrap(TaskClarificationDraft(task: source))
    draft.title = "Literal capture"
    draft.deadline = deadline
    draft.reminder = reminder
    draft.priority = .urgent
    draft.tags.append("reviewed")

    let mutation = try await fixture.repository.applyTaskClarification(
      pageID: source.id,
      draft: draft,
      expectedVersion: TaskPageVersion(source)
    )

    XCTAssertEqual(mutation.task.title, "Literal capture")
    XCTAssertEqual(mutation.task.plainText, "Never rewrite these notes")
    XCTAssertEqual(mutation.task.taskData?.placement, .anytime)
    XCTAssertNil(mutation.task.taskData?.scheduledAt)
    XCTAssertEqual(mutation.task.taskData?.deadline, Calendar.current.startOfDay(for: deadline))
    XCTAssertEqual(mutation.task.taskData?.reminder, reminder)
    XCTAssertEqual(mutation.task.taskData?.tags, ["original", "reviewed"])

    let undone = try await fixture.repository.undoTaskClarification(mutation.undoReceipt)
    XCTAssertEqual(undone.restoredTask.title, source.title)
    XCTAssertEqual(undone.restoredTask.plainText, source.plainText)
    XCTAssertEqual(undone.restoredTask.taskData, sourceData)
  }

  func testStaleApplyChangesNothingAndConflictAlsoInvalidatesUndo() async throws {
    let fixture = try TaskClarificationFixture()
    let source = try await fixture.repository.createTask(TaskDraft(title: "Original"))
    let sourceData = try XCTUnwrap(source.taskData)
    let concurrent = try await fixture.repository.updateTask(
      pageID: source.id,
      data: sourceData,
      title: "Concurrent edit"
    )
    var draft = try XCTUnwrap(TaskClarificationDraft(task: source))
    draft.title = "Stale edit"

    do {
      _ = try await fixture.repository.applyTaskClarification(
        pageID: source.id,
        draft: draft,
        expectedVersion: TaskPageVersion(source)
      )
      XCTFail("Expected stale proposal rejection")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskClarificationStale)
    }
    let loadedAfterRejected = try await fixture.repository.page(id: source.id)
    let afterRejected = try XCTUnwrap(loadedAfterRejected)
    XCTAssertEqual(afterRejected.heads, concurrent.heads)
    XCTAssertEqual(afterRejected.dirtyGeneration, concurrent.dirtyGeneration)
    XCTAssertEqual(afterRejected.title, "Concurrent edit")

    let seed = try await fixture.repository.taskClarificationSeed(pageID: source.id)
    let applied = try await fixture.repository.applyTaskClarification(
      pageID: source.id,
      draft: seed.literalDraft,
      expectedVersion: seed.expectedVersion
    )
    let appliedData = try XCTUnwrap(applied.task.taskData)
    let postApplyEdit = try await fixture.repository.updateTask(
      pageID: source.id,
      data: appliedData,
      title: "Edited after apply"
    )
    do {
      _ = try await fixture.repository.undoTaskClarification(applied.undoReceipt)
      XCTFail("Expected conflict-safe undo rejection")
    } catch {
      XCTAssertEqual(error as? LibraryRepositoryError, .taskClarificationUndoUnavailable)
    }
    let loadedAfterUndoRejected = try await fixture.repository.page(id: source.id)
    let afterUndoRejected = try XCTUnwrap(loadedAfterUndoRejected)
    XCTAssertEqual(afterUndoRejected.heads, postApplyEdit.heads)
    XCTAssertEqual(afterUndoRejected.title, "Edited after apply")
  }

  func testMoveToSomedayClearsOnlySchedulingAndCanBeUndone() async throws {
    let fixture = try TaskClarificationFixture()
    let schedule = Date(timeIntervalSince1970: 1_817_000_000)
    let deadline = schedule.addingTimeInterval(86_400)
    let reminder = schedule.addingTimeInterval(-900)
    let source = try await fixture.repository.createTask(
      TaskDraft(
        title: "Maybe later",
        notes: "Keep me",
        data: TaskData(
          scheduledAt: schedule,
          scheduleGranularity: .dateTime,
          deadline: deadline,
          reminder: reminder
        )
      )
    )

    let moved = try await fixture.repository.moveClarificationTaskToSomeday(
      pageID: source.id,
      expectedVersion: TaskPageVersion(source)
    )
    XCTAssertEqual(moved.task.taskData?.placement, .someday)
    XCTAssertNil(moved.task.taskData?.scheduledAt)
    XCTAssertEqual(moved.task.taskData?.deadline, source.taskData?.deadline)
    XCTAssertEqual(moved.task.taskData?.reminder, source.taskData?.reminder)
    XCTAssertEqual(moved.task.plainText, "Keep me")

    let undo = try await fixture.repository.undoTaskClarification(moved.undoReceipt)
    XCTAssertEqual(undo.restoredTask.taskData, source.taskData)
    XCTAssertEqual(undo.restoredTask.title, source.title)
    XCTAssertEqual(undo.restoredTask.plainText, source.plainText)
  }

  @MainActor
  func testStoreQueueIsOldestFirstAndManualPathDoesNotInvokeInterpreter() async throws {
    let fixture = try TaskClarificationFixture()
    let base = Date(timeIntervalSince1970: 1_817_000_000)
    let first = try await fixture.repository.createTask(
      TaskDraft(title: "First"),
      now: base
    )
    let second = try await fixture.repository.createTask(
      TaskDraft(title: "Second"),
      now: base.addingTimeInterval(1)
    )
    _ = try await fixture.repository.createTask(
      TaskDraft(title: "Not Inbox", data: TaskData(placement: .anytime)),
      now: base.addingTimeInterval(2)
    )
    let interpreter = TaskClarificationInterpreterStub(
      response: .unavailable(.literal("Second"), .modelNotReady)
    )
    let store = LibraryStore(
      repository: fixture.repository,
      startImmediately: false,
      taskInterpreter: interpreter
    )
    _ = await store.reload(policy: .refreshOnly)

    XCTAssertEqual(store.clarificationInboxTasks.map(\.id), [first.id, second.id])
    let manual = await store.manualClarificationProposal(for: first.id)
    XCTAssertEqual(manual?.draft.title, "First")
    let callsAfterManual = await interpreter.calls()
    XCTAssertEqual(callsAfterManual, 0)

    guard case .unavailable(let fallback, let availability) =
      await store.clarificationProposal(for: second.id)
    else { return XCTFail("Expected model-unavailable manual fallback") }
    XCTAssertEqual(fallback.draft.title, "Second")
    XCTAssertEqual(availability, AssistantAvailability.modelNotReady)
    let callsAfterInterpretation = await interpreter.calls()
    XCTAssertEqual(callsAfterInterpretation, 1)
  }
}

private actor TaskClarificationInterpreterStub: TaskInputInterpreting {
  private let response: TaskInterpretationResponse
  private var callCount = 0

  init(response: TaskInterpretationResponse) {
    self.response = response
  }

  func interpret(
    _ input: String,
    context: TaskInterpretationContext,
    now: Date,
    calendar: Calendar,
    locale: Locale
  ) async -> TaskInterpretationResponse {
    callCount += 1
    return response
  }

  func calls() -> Int { callCount }
}

private final class TaskClarificationFixture {
  let repository: LibraryRepository
  private let directory: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "enchiridion-task-clarification-tests-\(UUID().uuidString)",
        isDirectory: true
      )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    repository = try LibraryRepository(
      path: directory.appendingPathComponent("library.sqlite").path
    )
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }
}
