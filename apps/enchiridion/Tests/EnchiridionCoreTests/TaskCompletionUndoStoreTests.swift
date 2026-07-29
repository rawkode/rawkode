import Foundation
import XCTest

@testable import EnchiridionCore

final class TaskCompletionUndoStoreTests: XCTestCase {
  @MainActor
  func testInAppRecurringCompletionOfferUsesAtomicUndoAndRemovesSuccessor() async throws {
    let fixture = try CompletionUndoRepositoryFixture()
    let store = fixture.makeStore()
    let createdTaskID = await store.createTask(
      TaskDraft(
        title: "Recurring review",
        data: TaskData(
          scheduledAt: Date(timeIntervalSince1970: 1_817_000_000),
          recurrence: .init(mode: .afterCompletion, unit: .day)
        )
      )
    )
    let taskID = try XCTUnwrap(createdTaskID)

    let completedTask = await store.completeTaskOfferingUndo(taskID)
    let completion = try XCTUnwrap(completedTask)
    let successorID = try XCTUnwrap(completion.successor?.id)
    let offer = try XCTUnwrap(store.latestTaskCompletionUndoOffer)
    XCTAssertEqual(offer.taskTitle, "Recurring review")
    XCTAssertEqual(offer.receipt, completion.undoReceipt)

    let undoneCompletion = await store.undoLatestTaskCompletion()
    let undo = try XCTUnwrap(undoneCompletion)

    XCTAssertEqual(undo.removedSuccessorID, successorID)
    XCTAssertNil(store.latestTaskCompletionUndoOffer)
    XCTAssertNil(store.taskCompletionUndoFailure)
    let reopened = try await fixture.repository.page(id: taskID)
    let removedSuccessor = try await fixture.repository.page(id: successorID)
    let successorPurgeMarker = try await fixture.repository.purgeMarker(pageID: successorID)
    XCTAssertEqual(reopened?.taskData?.state, .active)
    XCTAssertNil(removedSuccessor)
    XCTAssertNotNil(successorPurgeMarker)
  }

  @MainActor
  func testNewestInAppCompletionOfferReplacesPriorOfferAndDismissClearsIt() async throws {
    let fixture = try CompletionUndoRepositoryFixture()
    let store = fixture.makeStore()
    let createdFirstID = await store.createTask(TaskDraft(title: "First task"))
    let createdSecondID = await store.createTask(TaskDraft(title: "Second task"))
    let firstID = try XCTUnwrap(createdFirstID)
    let secondID = try XCTUnwrap(createdSecondID)

    _ = await store.completeTaskOfferingUndo(firstID)
    let firstOffer = try XCTUnwrap(store.latestTaskCompletionUndoOffer)
    _ = await store.completeTaskOfferingUndo(secondID)
    let secondOffer = try XCTUnwrap(store.latestTaskCompletionUndoOffer)

    XCTAssertEqual(firstOffer.taskTitle, "First task")
    XCTAssertEqual(secondOffer.taskTitle, "Second task")
    XCTAssertNotEqual(secondOffer.receipt, firstOffer.receipt)

    store.dismissLatestTaskCompletionUndo()

    XCTAssertNil(store.latestTaskCompletionUndoOffer)
    XCTAssertNil(store.taskCompletionUndoFailure)

    let createdBackgroundTaskID = await store.createTask(
      TaskDraft(title: "Background completion")
    )
    let backgroundTaskID = try XCTUnwrap(createdBackgroundTaskID)
    _ = await store.completeTask(backgroundTaskID)
    XCTAssertNil(store.latestTaskCompletionUndoOffer)
  }

  func testCompletionWithoutReceiptDoesNotProduceOffer() async throws {
    let fixture = try CompletionUndoRepositoryFixture()
    let created = try await fixture.repository.createTask(
      TaskDraft(title: "No receipt")
    )
    let completion = try await fixture.repository.completeTask(pageID: created.id)
    let unavailableCompletion = TaskCompletionResult(
      completed: completion.completed,
      successor: completion.successor,
      undoReceipt: nil
    )

    XCTAssertNil(TaskCompletionUndoOffer(completion: unavailableCompletion))
  }

  @MainActor
  func testConflictedInAppCompletionUndoReportsFailureWithoutPartialInverse() async throws {
    let fixture = try CompletionUndoRepositoryFixture()
    let store = fixture.makeStore()
    let createdTaskID = await store.createTask(
      TaskDraft(
        title: "Protected recurring task",
        data: TaskData(
          scheduledAt: Date(timeIntervalSince1970: 1_817_000_000),
          recurrence: .init(mode: .fixedSchedule, unit: .day)
        )
      )
    )
    let taskID = try XCTUnwrap(createdTaskID)
    let completedTask = await store.completeTaskOfferingUndo(taskID)
    let completion = try XCTUnwrap(completedTask)
    let successor = try XCTUnwrap(completion.successor)
    var changedData = try XCTUnwrap(successor.taskData)
    changedData.priority = .urgent
    _ = try await fixture.repository.updateTask(pageID: successor.id, data: changedData)

    let undo = await store.undoLatestTaskCompletion()

    XCTAssertNil(undo)
    XCTAssertEqual(
      store.taskCompletionUndoFailure,
      "The task or its recurring successor changed after completion, so the completion was not undone."
    )
    XCTAssertEqual(store.latestTaskCompletionUndoOffer?.receipt, completion.undoReceipt)
    let sourceAfterFailure = try await fixture.repository.page(id: taskID)
    let successorAfterFailure = try await fixture.repository.page(id: successor.id)
    let successorPurgeMarker = try await fixture.repository.purgeMarker(pageID: successor.id)
    XCTAssertEqual(sourceAfterFailure?.taskData?.state, .completed)
    XCTAssertEqual(successorAfterFailure?.taskData?.priority, .urgent)
    XCTAssertNil(successorPurgeMarker)
  }

  @MainActor
  func testSideEffectWarningActionsDoNotClearInAppCompletionOffer() async throws {
    let fixture = try CompletionUndoRepositoryFixture()
    let store = fixture.makeStore { effect in
      switch effect {
      case .cancelReminder:
        .failed("The reminder could not be canceled: Service offline")
      case .removeSpotlight:
        .failed("The task could not be removed from Spotlight: Search offline")
      case .reloadLibrary, .sync, .syncPurge, .scheduleReminder, .indexSpotlight,
        .reloadWidgets:
        .applied
      }
    }
    let createdTaskID = await store.createTask(TaskDraft(title: "Warn and undo"))
    let taskID = try XCTUnwrap(createdTaskID)

    _ = await store.completeTaskOfferingUndo(taskID)

    let offeredReceipt = try XCTUnwrap(store.latestTaskCompletionUndoOffer?.receipt)
    let presentation = try XCTUnwrap(
      TaskMutationWarningPresentation.make(warnings: store.taskMutationWarnings)
    )
    XCTAssertEqual(presentation.title, "Task Change Saved, but Reminder Failed")

    store.acknowledgeTaskMutationWarnings()
    XCTAssertEqual(store.latestTaskCompletionUndoOffer?.receipt, offeredReceipt)

    let retrySucceeded = await store.retryPendingTaskEffects()
    XCTAssertFalse(retrySucceeded)
    XCTAssertEqual(store.latestTaskCompletionUndoOffer?.receipt, offeredReceipt)

    store.acknowledgeTaskMutationWarnings()
    XCTAssertEqual(store.latestTaskCompletionUndoOffer?.receipt, offeredReceipt)
  }
}

private final class CompletionUndoRepositoryFixture {
  let repository: LibraryRepository

  private let directory: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-completion-undo-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    repository = try LibraryRepository(
      path: directory.appendingPathComponent("library.sqlite").path
    )
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }

  @MainActor
  func makeStore(
    effects: @escaping @Sendable (TaskMutationEffect) async -> TaskMutationEffectDisposition = {
      _ in .applied
    }
  ) -> LibraryStore {
    LibraryStore(
      repository: repository,
      startImmediately: false,
      taskMutationEffects: TaskMutationEffectExecutor(handler: effects)
    )
  }
}
