import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class TaskMutationCoordinatorTests: XCTestCase {
  func testEveryMutationUsesTheSameTypedOrderedEffectContract() async throws {
    let fixture = try TaskMutationFixture()
    let recorder = TaskMutationEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in
        await recorder.apply(effect)
      }
    )
    let reminder = Date(timeIntervalSince1970: 1_900_000_000)

    let created = try success(
      await coordinator.create(
        TaskDraft(
          title: "Shared mutation path",
          data: TaskData(reminder: reminder)
        )
      )
    )
    try await assertEffects(
      of: created,
      equal: [
        .reloadLibrary,
        .scheduleReminder(created.value, requestingAuthorization: true),
        .indexSpotlight(created.value),
        .sync(created.value.id),
        .reloadWidgets,
      ],
      recorder: recorder
    )

    var updatedData = try XCTUnwrap(created.value.taskData)
    updatedData.priority = .high
    let updated = try success(
      await coordinator.update(pageID: created.value.id, data: updatedData)
    )
    try await assertEffects(
      of: updated,
      equal: [
        .reloadLibrary,
        .scheduleReminder(updated.value, requestingAuthorization: true),
        .indexSpotlight(updated.value),
        .sync(updated.value.id),
        .reloadWidgets,
      ],
      recorder: recorder
    )

    let completed = try success(await coordinator.complete(created.value.id))
    try await assertEffects(
      of: completed,
      equal: [
        .reloadLibrary,
        .cancelReminder(completed.value.completed.id),
        .removeSpotlight(completed.value.completed.id),
        .sync(completed.value.completed.id),
        .reloadWidgets,
      ],
      recorder: recorder
    )

    let reopened = try success(await coordinator.reopen(created.value.id))
    try await assertEffects(
      of: reopened,
      equal: [
        .reloadLibrary,
        .scheduleReminder(reopened.value, requestingAuthorization: false),
        .indexSpotlight(reopened.value),
        .sync(reopened.value.id),
        .reloadWidgets,
      ],
      recorder: recorder
    )

    let canceled = try success(await coordinator.cancel(created.value.id))
    try await assertEffects(
      of: canceled,
      equal: [
        .reloadLibrary,
        .cancelReminder(canceled.value.id),
        .removeSpotlight(canceled.value.id),
        .sync(canceled.value.id),
        .reloadWidgets,
      ],
      recorder: recorder
    )
  }

  func testRepeatedCompletionFailsWithoutCreatingAnotherSuccessorOrEffects() async throws {
    let fixture = try TaskMutationFixture()
    let recorder = TaskMutationEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in
        await recorder.apply(effect)
      }
    )
    let created = try success(
      await coordinator.create(
        TaskDraft(
          title: "Repeat safely",
          data: TaskData(
            scheduledAt: Date(timeIntervalSince1970: 1_800_000_000),
            recurrence: .init(mode: .fixedSchedule, unit: .day)
          )
        )
      )
    )
    _ = await recorder.take()

    let first = try success(
      await coordinator.complete(
        created.value.id,
        now: Date(timeIntervalSince1970: 1_800_086_400)
      )
    )
    let firstEffects = await recorder.take()
    let second = await coordinator.complete(
      created.value.id,
      now: Date(timeIntervalSince1970: 1_800_172_800)
    )
    let secondEffects = await recorder.take()

    let successorID = try XCTUnwrap(first.value.successor?.id)
    XCTAssertEqual(first.changedPageIDs, [created.value.id, successorID])
    XCTAssertFalse(firstEffects.isEmpty)
    XCTAssertEqual(
      second,
      .failure(
        TaskMutationFailure(operation: .complete, reason: .taskNotActive)
      )
    )
    XCTAssertTrue(secondEffects.isEmpty)

    let tasks = try await fixture.repository.pages(with: BuiltInSupertags.task)
    XCTAssertEqual(tasks.filter { $0.id == successorID }.count, 1)
  }

  func testCompletionUndoReopensSourcePurgesSuccessorAndRunsOrderedEffects() async throws {
    let fixture = try TaskMutationFixture()
    let recorder = TaskMutationEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in await recorder.apply(effect) }
    )
    let created = try success(
      await coordinator.create(
        TaskDraft(
          title: "Undo recurring completion",
          data: TaskData(
            scheduledAt: Date(timeIntervalSince1970: 1_800_000_000),
            recurrence: .init(mode: .fixedSchedule, unit: .day)
          )
        )
      )
    )
    _ = await recorder.take()
    let completed = try success(
      await coordinator.complete(
        created.value.id,
        now: Date(timeIntervalSince1970: 1_800_086_400)
      )
    )
    _ = await recorder.take()
    let successorID = try XCTUnwrap(completed.value.successor?.id)
    let receipt = try XCTUnwrap(completed.value.undoReceipt)

    let undone = try success(
      await coordinator.undoCompletion(
        receipt,
        now: Date(timeIntervalSince1970: 1_800_129_600)
      )
    )

    try await assertEffects(
      of: undone,
      equal: [
        .reloadLibrary,
        .scheduleReminder(undone.value.reopened, requestingAuthorization: false),
        .indexSpotlight(undone.value.reopened),
        .cancelReminder(successorID),
        .removeSpotlight(successorID),
        .sync(created.value.id),
        .syncPurge(successorID),
        .reloadWidgets,
      ],
      recorder: recorder
    )
    XCTAssertEqual(undone.value.reopened.taskData?.state, .active)
    let removedSuccessor = try await fixture.repository.page(id: successorID)
    XCTAssertNil(removedSuccessor)
  }

  func testCompletionUndoConflictIsTypedAndDoesNotRunEffects() async throws {
    let fixture = try TaskMutationFixture()
    let recorder = TaskMutationEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in await recorder.apply(effect) }
    )
    let created = try success(
      await coordinator.create(
        TaskDraft(
          title: "Protect changed recurrence",
          data: TaskData(
            scheduledAt: Date(timeIntervalSince1970: 1_800_000_000),
            recurrence: .init(mode: .fixedSchedule, unit: .day)
          )
        )
      )
    )
    _ = await recorder.take()
    let completed = try success(
      await coordinator.complete(
        created.value.id,
        now: Date(timeIntervalSince1970: 1_800_086_400)
      )
    )
    _ = await recorder.take()
    let successor = try XCTUnwrap(completed.value.successor)
    var changedData = try XCTUnwrap(successor.taskData)
    changedData.priority = .urgent
    _ = try await fixture.repository.updateTask(pageID: successor.id, data: changedData)
    let receipt = try XCTUnwrap(completed.value.undoReceipt)

    let result = await coordinator.undoCompletion(receipt)

    XCTAssertEqual(
      result,
      .failure(
        TaskMutationFailure(
          operation: .undoCompletion,
          reason: .completionUndoUnavailable
        )
      )
    )
    let effects = await recorder.take()
    XCTAssertTrue(effects.isEmpty)
  }

  func testRepositoryFailureIsTypedAndDoesNotRunSideEffects() async throws {
    let fixture = try TaskMutationFixture()
    let recorder = TaskMutationEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in
        await recorder.apply(effect)
      }
    )

    let result = await coordinator.cancel(PageID(rawValue: "missing"))

    XCTAssertEqual(
      result,
      .failure(
        TaskMutationFailure(operation: .cancel, reason: .invalidRecord)
      )
    )
    let effects = await recorder.take()
    XCTAssertTrue(effects.isEmpty)
  }

  func testSideEffectFailureDoesNotMisreportAPersistedCreateAsWriteFailure() async throws {
    let fixture = try TaskMutationFixture()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in
        if case .sync = effect { return .failed("Sync is offline") }
        return .applied
      }
    )

    let success = try success(
      await coordinator.create(TaskDraft(title: "Persist exactly once"))
    )

    XCTAssertTrue(
      success.sideEffects.contains {
        if case .sync = $0.effect { return $0.disposition == .failed("Sync is offline") }
        return false
      }
    )
    let tasks = try await fixture.repository.pages(with: BuiltInSupertags.task)
    XCTAssertEqual(tasks.map(\.id), [success.value.id])
  }

  func testLiveAdaptersTranslateTypedReminderAndSpotlightFailures() async throws {
    let fixture = try TaskMutationFixture()
    let page = try await fixture.repository.createTask(TaskDraft(title: "Typed adapters"))

    let authorizationExecutor = TaskMutationEffectExecutor.live(
      surface: .application,
      systemEffects: systemEffectAdapters(
        schedule: .authorizationRequestFailed("Prompt unavailable")
      )
    )
    let authorizationDisposition = await authorizationExecutor.apply(
      .scheduleReminder(page, requestingAuthorization: true)
    )
    XCTAssertEqual(
      authorizationDisposition,
      .failed("Reminder authorization could not be requested: Prompt unavailable")
    )
    let deniedExecutor = TaskMutationEffectExecutor.live(
      surface: .application,
      systemEffects: systemEffectAdapters(
        schedule: .authorizationRequired(.denied)
      )
    )
    let deniedDisposition = await deniedExecutor.apply(
      .scheduleReminder(page, requestingAuthorization: true)
    )
    XCTAssertEqual(deniedDisposition, .failed("Reminder authorization is denied."))

    let operationExecutor = TaskMutationEffectExecutor.live(
      surface: .application,
      systemEffects: systemEffectAdapters(
        schedule: .schedulingFailed("Notification service offline"),
        index: .indexingFailed("Search service offline"),
        remove: .removalFailed("Search removal offline")
      )
    )
    let schedulingDisposition = await operationExecutor.apply(
      .scheduleReminder(page, requestingAuthorization: false)
    )
    let indexingDisposition = await operationExecutor.apply(.indexSpotlight(page))
    let removalDisposition = await operationExecutor.apply(.removeSpotlight(page.id))
    XCTAssertEqual(
      schedulingDisposition,
      .failed("The reminder could not be scheduled: Notification service offline")
    )
    XCTAssertEqual(
      indexingDisposition,
      .failed("The task could not be indexed in Spotlight: Search service offline")
    )
    XCTAssertEqual(
      removalDisposition,
      .failed("The task could not be removed from Spotlight: Search removal offline")
    )
  }

  func testLiveSystemFailuresRemainDurableWarningsAfterPersistedCreate() async throws {
    let fixture = try TaskMutationFixture()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: .live(
        surface: .application,
        systemEffects: systemEffectAdapters(
          schedule: .schedulingFailed("Notification service offline"),
          index: .indexingFailed("Search service offline")
        ),
        reload: { .applied },
        sync: { _ in .applied },
        purgeSync: { _ in .applied }
      )
    )

    let created = try success(
      await coordinator.create(
        TaskDraft(
          title: "Saved with warnings",
          data: TaskData(reminder: Date(timeIntervalSince1970: 1_900_000_000))
        )
      )
    )

    XCTAssertEqual(
      created.warnings.map(\.message),
      [
        "The reminder could not be scheduled: Notification service offline",
        "The task could not be indexed in Spotlight: Search service offline",
      ]
    )
    let pendingCount = try await fixture.repository.pendingTaskEffectOutboxCount()
    let persistedPage = try await fixture.repository.page(id: created.value.id)
    XCTAssertEqual(pendingCount, 2)
    XCTAssertEqual(persistedPage?.id, created.value.id)

    let retry = TaskMutationCoordinator(
      repository: try LibraryRepository(path: fixture.path),
      effects: .live(
        surface: .application,
        systemEffects: systemEffectAdapters(),
        reload: { .applied },
        sync: { _ in .applied },
        purgeSync: { _ in .applied }
      )
    )
    let retried = await retry.drainPendingEffects()

    let remainingCount = try await fixture.repository.pendingTaskEffectOutboxCount()
    XCTAssertEqual(retried.map(\.disposition), [.applied, .applied])
    XCTAssertEqual(remainingCount, 0)
  }

  func testWidgetExtensionDefersReminderOwnershipToHostApplication() async throws {
    let fixture = try TaskMutationFixture()
    let page = try await fixture.repository.createTask(TaskDraft(title: "Widget task"))
    let executor = TaskMutationEffectExecutor.live(surface: .widgetExtension)

    let schedule = await executor.apply(
      .scheduleReminder(page, requestingAuthorization: false)
    )
    let cancel = await executor.apply(.cancelReminder(page.id))

    XCTAssertEqual(schedule, .deferred(.hostApplicationRequired))
    XCTAssertEqual(cancel, .deferred(.hostApplicationRequired))
  }

  func testDurableEffectsSurviveFailedProcessAndDrainExactlyOnceAfterRestart() async throws {
    let fixture = try TaskMutationFixture()
    let page = try await fixture.repository.createTask(
      TaskDraft(
        title: "Retry after extension exit",
        data: TaskData(reminder: Date(timeIntervalSince1970: 1_900_000_000))
      )
    )
    let interrupted = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { _ in .failed("Process terminated") }
    )

    let failed = await interrupted.drainPendingEffects()
    let failedPendingCount = try await fixture.repository.pendingTaskEffectOutboxCount()

    XCTAssertEqual(failed.count, 2)
    XCTAssertTrue(failed.allSatisfy { $0.disposition == .failed("Process terminated") })
    XCTAssertEqual(failedPendingCount, 2)

    let reopenedRepository = try LibraryRepository(path: fixture.path)
    let recorder = TaskMutationEffectRecorder()
    let restarted = TaskMutationCoordinator(
      repository: reopenedRepository,
      effects: TaskMutationEffectExecutor { effect in
        await recorder.apply(effect)
      }
    )

    let retried = await restarted.drainPendingEffects()
    let secondDrain = await restarted.drainPendingEffects()
    let applied = await recorder.take()
    let remainingCount = try await reopenedRepository.pendingTaskEffectOutboxCount()

    XCTAssertEqual(retried.count, 2)
    XCTAssertTrue(retried.allSatisfy { $0.disposition == .applied })
    XCTAssertTrue(secondDrain.isEmpty)
    XCTAssertEqual(
      applied.map(\.stableIdentity),
      [
        TaskMutationEffect.scheduleReminder(page, requestingAuthorization: true).stableIdentity,
        TaskMutationEffect.indexSpotlight(page).stableIdentity,
      ]
    )
    XCTAssertEqual(remainingCount, 0)
  }

  func testTwoRepositoryProcessesClaimEachDurableEffectOnlyOnce() async throws {
    let fixture = try TaskMutationFixture()
    let page = try await fixture.repository.createTask(TaskDraft(title: "One durable claim"))
    let secondRepository = try LibraryRepository(path: fixture.path)
    let recorder = TaskMutationEffectRecorder()
    let first = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in await recorder.apply(effect) }
    )
    let second = TaskMutationCoordinator(
      repository: secondRepository,
      effects: TaskMutationEffectExecutor { effect in await recorder.apply(effect) }
    )

    async let firstDrain = first.drainPendingEffects()
    async let secondDrain = second.drainPendingEffects()
    _ = await (firstDrain, secondDrain)

    let applied = await recorder.take()
    let remainingCount = try await fixture.repository.pendingTaskEffectOutboxCount()
    XCTAssertEqual(
      applied.map(\.stableIdentity).sorted(),
      [
        TaskMutationEffect.scheduleReminder(page, requestingAuthorization: false).stableIdentity,
        TaskMutationEffect.indexSpotlight(page).stableIdentity,
      ].sorted()
    )
    XCTAssertEqual(remainingCount, 0)
  }

  func testOlderReentrantMutationCannotApplyAfterNewerDurableEffects() async throws {
    let fixture = try TaskMutationFixture()
    let gate = ReentrantTaskMutationEffectGate()
    let first = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in await gate.apply(effect) }
    )
    let created = try success(
      await first.create(TaskDraft(title: "Initial state"))
    ).value
    _ = await gate.take()
    let secondRepository = try LibraryRepository(path: fixture.path)
    let second = TaskMutationCoordinator(
      repository: secondRepository,
      effects: TaskMutationEffectExecutor { effect in await gate.apply(effect) }
    )
    let data = try XCTUnwrap(created.taskData)

    let olderMutation = Task {
      await first.update(pageID: created.id, data: data, title: "Earlier")
    }
    await gate.waitUntilEarlierReminderIsBlocked()
    _ = try success(
      await second.update(pageID: created.id, data: data, title: "Newer")
    )
    await gate.releaseEarlierReminder()
    _ = try success(await olderMutation.value)

    let effects = await gate.take()
    let remainingCount = try await fixture.repository.pendingTaskEffectOutboxCount()
    let reminderTitles = effects.compactMap { effect -> String? in
      guard case .scheduleReminder(let page, _) = effect else { return nil }
      return page.title
    }
    let spotlightTitles = effects.compactMap { effect -> String? in
      guard case .indexSpotlight(let page) = effect else { return nil }
      return page.title
    }
    XCTAssertEqual(reminderTitles, ["Earlier", "Newer"])
    XCTAssertEqual(spotlightTitles, ["Newer"])
    XCTAssertEqual(remainingCount, 0)
  }

  func testTaskTrashRestoreAndPurgeUseTheCompleteEffectBoundary() async throws {
    let fixture = try TaskMutationFixture()
    let recorder = TaskMutationEffectRecorder()
    let coordinator = TaskMutationCoordinator(
      repository: fixture.repository,
      effects: TaskMutationEffectExecutor { effect in await recorder.apply(effect) }
    )
    let created = try success(await coordinator.create(TaskDraft(title: "Lifecycle task")))
    _ = await recorder.take()

    let trashed = try success(await coordinator.moveToTrash(created.value.id))
    try await assertEffects(
      of: trashed,
      equal: [
        .reloadLibrary,
        .cancelReminder(created.value.id),
        .removeSpotlight(created.value.id),
        .sync(created.value.id),
        .reloadWidgets,
      ],
      recorder: recorder
    )

    let restored = try success(await coordinator.restore(created.value.id))
    try await assertEffects(
      of: restored,
      equal: [
        .reloadLibrary,
        .scheduleReminder(restored.value, requestingAuthorization: false),
        .indexSpotlight(restored.value),
        .sync(restored.value.id),
        .reloadWidgets,
      ],
      recorder: recorder
    )

    _ = try success(await coordinator.moveToTrash(created.value.id))
    _ = await recorder.take()
    let purged = try success(await coordinator.purge(created.value.id))
    try await assertEffects(
      of: purged,
      equal: [
        .reloadLibrary,
        .cancelReminder(created.value.id),
        .removeSpotlight(created.value.id),
        .syncPurge(created.value.id),
        .reloadWidgets,
      ],
      recorder: recorder
    )
    let purgedPage = try await fixture.repository.page(id: created.value.id)
    let purgeMarker = try await fixture.repository.purgeMarker(pageID: created.value.id)
    XCTAssertNil(purgedPage)
    XCTAssertNotNil(purgeMarker)
  }

  private func success<Value: Sendable>(
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

  private func assertEffects<Value: Sendable>(
    of success: TaskMutationSuccess<Value>,
    equal expected: [TaskMutationEffect],
    recorder: TaskMutationEffectRecorder,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async throws {
    XCTAssertEqual(
      success.sideEffects.map(\.effect).map(\.stableIdentity),
      expected.map(\.stableIdentity),
      file: file,
      line: line
    )
    XCTAssertEqual(
      success.sideEffects.map(\.disposition),
      Array(repeating: .applied, count: expected.count),
      file: file,
      line: line
    )
    let recorded = await recorder.take()
    XCTAssertEqual(
      recorded.map(\.stableIdentity),
      expected.map(\.stableIdentity),
      file: file,
      line: line
    )
  }
}

private func systemEffectAdapters(
  schedule: TaskReminderEffectOutcome = .applied,
  cancel: TaskReminderEffectOutcome = .applied,
  index: TaskSpotlightEffectOutcome = .applied,
  remove: TaskSpotlightEffectOutcome = .applied
) -> TaskSystemEffectAdapters {
  TaskSystemEffectAdapters(
    scheduleReminder: { _, _ in schedule },
    cancelReminder: { _ in cancel },
    indexSpotlight: { _ in index },
    removeSpotlight: { _ in remove }
  )
}

private actor TaskMutationEffectRecorder {
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

private actor ReentrantTaskMutationEffectGate {
  private var effects: [TaskMutationEffect] = []
  private var earlierReminderIsBlocked = false
  private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseContinuation: CheckedContinuation<Void, Never>?

  func apply(_ effect: TaskMutationEffect) async -> TaskMutationEffectDisposition {
    if case .scheduleReminder(let page, _) = effect, page.title == "Earlier" {
      earlierReminderIsBlocked = true
      let waiters = blockedWaiters
      blockedWaiters.removeAll()
      for waiter in waiters { waiter.resume() }
      await withCheckedContinuation { continuation in
        releaseContinuation = continuation
      }
    }
    effects.append(effect)
    return .applied
  }

  func waitUntilEarlierReminderIsBlocked() async {
    guard !earlierReminderIsBlocked else { return }
    await withCheckedContinuation { continuation in
      blockedWaiters.append(continuation)
    }
  }

  func releaseEarlierReminder() {
    releaseContinuation?.resume()
    releaseContinuation = nil
  }

  func take() -> [TaskMutationEffect] {
    defer { effects.removeAll() }
    return effects
  }
}

extension TaskMutationEffect {
  fileprivate var stableIdentity: String {
    switch self {
    case .reloadLibrary: "reload"
    case .sync(let pageID): "sync:\(pageID.rawValue)"
    case .syncPurge(let pageID): "sync-purge:\(pageID.rawValue)"
    case .scheduleReminder(let page, let requestingAuthorization):
      "schedule:\(page.id.rawValue):\(requestingAuthorization)"
    case .cancelReminder(let pageID): "cancel-reminder:\(pageID.rawValue)"
    case .indexSpotlight(let page): "index:\(page.id.rawValue)"
    case .removeSpotlight(let pageID): "remove-index:\(pageID.rawValue)"
    case .reloadWidgets: "widgets"
    }
  }
}

private final class TaskMutationFixture {
  let repository: LibraryRepository
  let path: String
  private let directory: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("enchiridion-mutation-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    path = directory.appendingPathComponent("library.sqlite").path
    repository = try LibraryRepository(path: path)
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }
}
