import Foundation

#if canImport(WidgetKit)
  import WidgetKit
#endif

public enum TaskMutationOperation: String, Equatable, Sendable {
  case create
  case update
  case complete
  case undoCompletion
  case reopen
  case cancel
  case completeTasks
  case reopenTasks
  case cancelTasks
  case patchTasks
  case trashTasks
  case undoTaskBatch
  case moveToTrash
  case restore
  case purge
}

public enum TaskMutationFailureReason: Equatable, Sendable {
  case pageNotFound
  case pagePurged
  case invalidRecord
  case taskNotActive
  case taskNotClosed
  case completionUndoUnavailable
  case databaseUnavailable(String)
  case unexpected(String)
}

public struct TaskMutationFailure: Error, Equatable, LocalizedError, Sendable {
  public let operation: TaskMutationOperation
  public let reason: TaskMutationFailureReason

  public init(operation: TaskMutationOperation, reason: TaskMutationFailureReason) {
    self.operation = operation
    self.reason = reason
  }

  public var errorDescription: String? {
    switch reason {
    case .pageNotFound:
      "The task is no longer available."
    case .pagePurged:
      "The task was permanently removed."
    case .invalidRecord:
      "The task record is invalid."
    case .taskNotActive:
      operation == .cancelTasks
        ? "Only active tasks can be canceled."
        : "Only active tasks can be completed."
    case .taskNotClosed:
      "Only completed or canceled tasks can be reopened."
    case .completionUndoUnavailable:
      operation == .undoTaskBatch
        ? "One or more tasks changed after the batch action, so it was not undone."
        : "The task or its recurring successor changed after completion, so the completion was not undone."
    case .databaseUnavailable(let message):
      "The local library could not be opened: \(message)"
    case .unexpected(let message):
      "The task could not be \(operation.pastTense): \(message)"
    }
  }
}

extension TaskMutationOperation {
  fileprivate var pastTense: String {
    switch self {
    case .create: "created"
    case .update: "updated"
    case .complete: "completed"
    case .undoCompletion: "restored"
    case .reopen: "reopened"
    case .cancel: "canceled"
    case .completeTasks: "completed"
    case .reopenTasks: "reopened"
    case .cancelTasks: "canceled"
    case .patchTasks: "updated"
    case .trashTasks: "moved to the trash"
    case .undoTaskBatch: "restored"
    case .moveToTrash: "moved to the trash"
    case .restore: "restored"
    case .purge: "permanently deleted"
    }
  }
}

public enum TaskMutationDeferralReason: Equatable, Sendable {
  /// The extension persisted the write, but only the containing app owns this side effect.
  case hostApplicationRequired
  case unsupportedPlatform
  /// Another process owns the durable effect lease. The queued state remains retryable.
  case durableRetryScheduled
}

public enum TaskMutationEffectDisposition: Equatable, Sendable {
  case applied
  case notNeeded
  case deferred(TaskMutationDeferralReason)
  case failed(String)

  var acknowledgesDurableEffect: Bool {
    self == .applied || self == .notNeeded
  }
}

public enum TaskMutationEffect: Equatable, Sendable {
  case reloadLibrary
  case sync(PageID)
  case syncPurge(PageID)
  case scheduleReminder(PageSnapshot, requestingAuthorization: Bool)
  case cancelReminder(PageID)
  case indexSpotlight(PageSnapshot)
  case removeSpotlight(PageID)
  case reloadWidgets
}

enum TaskEffectOutboxKind: String, CaseIterable, Sendable {
  case reminder
  case spotlight
}

struct TaskEffectOutboxIdentity: Hashable, Sendable {
  let pageID: PageID
  let kind: TaskEffectOutboxKind

  var fallbackEffect: TaskMutationEffect {
    switch kind {
    case .reminder: .cancelReminder(pageID)
    case .spotlight: .removeSpotlight(pageID)
    }
  }
}

struct TaskEffectOutboxClaim: Sendable {
  let identity: TaskEffectOutboxIdentity
  let generation: Int64
  let leaseID: String
  let effect: TaskMutationEffect
}

enum TaskEffectOutboxClaimResult: Sendable {
  case noPendingEffect
  case busy
  case claimed(TaskEffectOutboxClaim)
}

enum TaskEffectOutboxCompletion: Sendable {
  case completed
  case superseded
}

extension TaskMutationEffect {
  fileprivate var outboxIdentity: TaskEffectOutboxIdentity? {
    switch self {
    case .scheduleReminder(let page, _):
      TaskEffectOutboxIdentity(pageID: page.id, kind: .reminder)
    case .cancelReminder(let pageID):
      TaskEffectOutboxIdentity(pageID: pageID, kind: .reminder)
    case .indexSpotlight(let page):
      TaskEffectOutboxIdentity(pageID: page.id, kind: .spotlight)
    case .removeSpotlight(let pageID):
      TaskEffectOutboxIdentity(pageID: pageID, kind: .spotlight)
    case .reloadLibrary, .sync, .syncPurge, .reloadWidgets:
      nil
    }
  }
}

public struct TaskMutationEffectOutcome: Equatable, Sendable {
  public let effect: TaskMutationEffect
  public let disposition: TaskMutationEffectDisposition

  public init(effect: TaskMutationEffect, disposition: TaskMutationEffectDisposition) {
    self.effect = effect
    self.disposition = disposition
  }

  public var warning: TaskMutationWarning? {
    let message: String
    switch disposition {
    case .applied, .notNeeded:
      return nil
    case .failed(let failure):
      message = failure
    case .deferred(.hostApplicationRequired):
      message = "A task system update is queued until Enchiridion next opens."
    case .deferred(.unsupportedPlatform):
      message = "A task system update is unavailable on this platform."
    case .deferred(.durableRetryScheduled):
      message = "A task system update is queued and will retry."
    }
    return TaskMutationWarning(effect: effect, message: message)
  }
}

public struct TaskMutationWarning: Equatable, Sendable {
  public let effect: TaskMutationEffect
  public let message: String

  public init(effect: TaskMutationEffect, message: String) {
    self.effect = effect
    self.message = message
  }
}

public struct TaskMutationSuccess<Value: Sendable>: Sendable {
  public let operation: TaskMutationOperation
  public let value: Value
  public let changedPageIDs: [PageID]
  public let sideEffects: [TaskMutationEffectOutcome]

  public init(
    operation: TaskMutationOperation,
    value: Value,
    changedPageIDs: [PageID],
    sideEffects: [TaskMutationEffectOutcome]
  ) {
    self.operation = operation
    self.value = value
    self.changedPageIDs = changedPageIDs
    self.sideEffects = sideEffects
  }

  public var warnings: [TaskMutationWarning] {
    sideEffects.compactMap(\.warning)
  }
}

extension TaskMutationSuccess: Equatable where Value: Equatable {}

public enum TaskMutationResult<Value: Sendable>: Sendable {
  case success(TaskMutationSuccess<Value>)
  case failure(TaskMutationFailure)
}

extension TaskMutationResult: Equatable where Value: Equatable {}

public enum TaskMutationSurface: Equatable, Sendable {
  case application
  case appIntent
  case widgetExtension
  case shareExtension

  fileprivate var canManageAppNotifications: Bool {
    switch self {
    case .application, .appIntent: true
    case .widgetExtension, .shareExtension: false
    }
  }
}

public enum TaskWidgetIdentifiers {
  public static let todayTasks = "EnchiridionTodayTasksWidget"
}

struct TaskSystemEffectAdapters: Sendable {
  typealias ScheduleReminder =
    @Sendable (PageSnapshot, Bool) async -> TaskReminderEffectOutcome
  typealias CancelReminder = @Sendable (PageID) async -> TaskReminderEffectOutcome
  typealias IndexSpotlight = @Sendable (PageSnapshot) async -> TaskSpotlightEffectOutcome
  typealias RemoveSpotlight = @Sendable (PageID) async -> TaskSpotlightEffectOutcome

  let scheduleReminder: ScheduleReminder
  let cancelReminder: CancelReminder
  let indexSpotlight: IndexSpotlight
  let removeSpotlight: RemoveSpotlight

  init(
    scheduleReminder: @escaping ScheduleReminder,
    cancelReminder: @escaping CancelReminder,
    indexSpotlight: @escaping IndexSpotlight,
    removeSpotlight: @escaping RemoveSpotlight
  ) {
    self.scheduleReminder = scheduleReminder
    self.cancelReminder = cancelReminder
    self.indexSpotlight = indexSpotlight
    self.removeSpotlight = removeSpotlight
  }

  static let live = Self(
    scheduleReminder: { page, requestingAuthorization in
      await TaskReminderScheduler.shared.schedule(
        page,
        requestingAuthorization: requestingAuthorization
      )
    },
    cancelReminder: { pageID in
      await TaskReminderScheduler.shared.cancel(pageID)
    },
    indexSpotlight: { page in
      await TaskSystemSpotlight.index(page)
    },
    removeSpotlight: { pageID in
      await TaskSystemSpotlight.remove(pageID)
    }
  )
}

public struct TaskMutationEffectExecutor: Sendable {
  public typealias Handler =
    @Sendable (TaskMutationEffect) async -> TaskMutationEffectDisposition

  private let handler: Handler

  public init(handler: @escaping Handler) {
    self.handler = handler
  }

  public func apply(_ effect: TaskMutationEffect) async -> TaskMutationEffectDisposition {
    await handler(effect)
  }

  public static func live(
    surface: TaskMutationSurface,
    reload: (@MainActor @Sendable () async -> TaskMutationEffectDisposition)? = nil,
    sync: (@MainActor @Sendable (PageID) async -> TaskMutationEffectDisposition)? = nil,
    purgeSync: (@MainActor @Sendable (PageID) async -> TaskMutationEffectDisposition)? = nil
  ) -> Self {
    live(
      surface: surface,
      systemEffects: .live,
      reload: reload,
      sync: sync,
      purgeSync: purgeSync
    )
  }

  static func live(
    surface: TaskMutationSurface,
    systemEffects: TaskSystemEffectAdapters,
    reload: (@MainActor @Sendable () async -> TaskMutationEffectDisposition)? = nil,
    sync: (@MainActor @Sendable (PageID) async -> TaskMutationEffectDisposition)? = nil,
    purgeSync: (@MainActor @Sendable (PageID) async -> TaskMutationEffectDisposition)? = nil
  ) -> Self {
    Self { effect in
      switch effect {
      case .reloadLibrary:
        guard let reload else { return .deferred(.hostApplicationRequired) }
        return await reload()
      case .sync(let pageID):
        guard let sync else { return .deferred(.hostApplicationRequired) }
        return await sync(pageID)
      case .syncPurge(let pageID):
        guard let purgeSync else { return .deferred(.hostApplicationRequired) }
        return await purgeSync(pageID)
      case .scheduleReminder(let page, let requestingAuthorization):
        guard surface.canManageAppNotifications else {
          return .deferred(.hostApplicationRequired)
        }
        return await systemEffects.scheduleReminder(page, requestingAuthorization).disposition
      case .cancelReminder(let pageID):
        guard surface.canManageAppNotifications else {
          return .deferred(.hostApplicationRequired)
        }
        return await systemEffects.cancelReminder(pageID).disposition
      case .indexSpotlight(let page):
        return await systemEffects.indexSpotlight(page).disposition
      case .removeSpotlight(let pageID):
        return await systemEffects.removeSpotlight(pageID).disposition
      case .reloadWidgets:
        #if canImport(WidgetKit)
          WidgetCenter.shared.reloadTimelines(ofKind: TaskWidgetIdentifiers.todayTasks)
          return .applied
        #else
          return .deferred(.unsupportedPlatform)
        #endif
      }
    }
  }
}

extension TaskReminderEffectOutcome {
  fileprivate var disposition: TaskMutationEffectDisposition {
    switch self {
    case .applied:
      .applied
    case .unavailable:
      .deferred(.unsupportedPlatform)
    case .authorizationRequired(let status):
      .failed("Reminder authorization is \(status.warningDescription).")
    case .authorizationRequestFailed(let message):
      .failed("Reminder authorization could not be requested: \(message)")
    case .schedulingFailed(let message):
      .failed("The reminder could not be scheduled: \(message)")
    }
  }
}

extension TaskReminderAuthorizationStatus {
  fileprivate var warningDescription: String {
    switch self {
    case .unavailable: "unavailable"
    case .notDetermined: "still required"
    case .denied: "denied"
    case .authorized: "authorized"
    case .provisional: "provisional"
    case .ephemeral: "ephemeral"
    }
  }
}

extension TaskSpotlightEffectOutcome {
  fileprivate var disposition: TaskMutationEffectDisposition {
    switch self {
    case .applied:
      .applied
    case .unavailable:
      .deferred(.unsupportedPlatform)
    case .indexingFailed(let message):
      .failed("The task could not be indexed in Spotlight: \(message)")
    case .removalFailed(let message):
      .failed("The task could not be removed from Spotlight: \(message)")
    }
  }
}

/// The only task-write boundary used by app and system surfaces. Repository writes
/// are serialized, and every successful mutation emits the same ordered, stable-ID
/// side effects. Extension-only limitations are returned as explicit deferrals.
public actor TaskMutationCoordinator {
  private let repository: LibraryRepository
  private let calendar: Calendar
  private let effects: TaskMutationEffectExecutor
  private let outboxLeaseDuration: TimeInterval

  public init(
    repository: LibraryRepository,
    calendar: Calendar = .current,
    effects: TaskMutationEffectExecutor,
    outboxLeaseDuration: TimeInterval = 30
  ) {
    self.repository = repository
    self.calendar = calendar
    self.effects = effects
    self.outboxLeaseDuration = max(1, outboxLeaseDuration)
  }

  public func create(
    _ draft: TaskDraft,
    now: Date = Date()
  ) async -> TaskMutationResult<PageSnapshot> {
    do {
      let page = try await repository.createTask(draft, now: now, calendar: calendar)
      return await success(
        operation: .create,
        value: page,
        changedPageIDs: [page.id],
        mutationEffects: [
          .scheduleReminder(
            page,
            requestingAuthorization: draft.data.reminder != nil
          ),
          .indexSpotlight(page),
        ]
      )
    } catch {
      return .failure(failure(operation: .create, error: error))
    }
  }

  public func update(
    pageID: PageID,
    data: TaskData,
    title: String? = nil,
    notes: String? = nil,
    now: Date = Date()
  ) async -> TaskMutationResult<PageSnapshot> {
    do {
      let page = try await repository.updateTask(
        pageID: pageID,
        data: data,
        title: title,
        notes: notes,
        now: now,
        calendar: calendar
      )
      return await success(
        operation: .update,
        value: page,
        changedPageIDs: [page.id],
        mutationEffects: [
          .scheduleReminder(page, requestingAuthorization: data.reminder != nil),
          .indexSpotlight(page),
        ]
      )
    } catch {
      return .failure(failure(operation: .update, error: error))
    }
  }

  public func complete(
    _ pageID: PageID,
    now: Date = Date()
  ) async -> TaskMutationResult<TaskCompletionResult> {
    do {
      let result = try await repository.completeTask(
        pageID: pageID,
        now: now,
        calendar: calendar
      )
      var mutationEffects: [TaskMutationEffect] = [
        .cancelReminder(result.completed.id),
        .removeSpotlight(result.completed.id),
      ]
      if let successor = result.successor {
        mutationEffects.append(.scheduleReminder(successor, requestingAuthorization: false))
        mutationEffects.append(.indexSpotlight(successor))
      }
      return await success(
        operation: .complete,
        value: result,
        changedPageIDs: result.changedPageIDs,
        mutationEffects: mutationEffects
      )
    } catch {
      return .failure(failure(operation: .complete, error: error))
    }
  }

  public func undoCompletion(
    _ receipt: TaskCompletionUndoReceipt,
    now: Date = Date()
  ) async -> TaskMutationResult<TaskCompletionUndoResult> {
    do {
      let result = try await repository.undoTaskCompletion(receipt, now: now)
      var mutationEffects: [TaskMutationEffect] = [
        .scheduleReminder(result.reopened, requestingAuthorization: false),
        .indexSpotlight(result.reopened),
      ]
      var purgePageIDs: Set<PageID> = []
      if let removedSuccessorID = result.removedSuccessorID {
        mutationEffects.append(.cancelReminder(removedSuccessorID))
        mutationEffects.append(.removeSpotlight(removedSuccessorID))
        purgePageIDs.insert(removedSuccessorID)
      }
      return await success(
        operation: .undoCompletion,
        value: result,
        changedPageIDs: result.changedPageIDs,
        mutationEffects: mutationEffects,
        purgePageIDs: purgePageIDs
      )
    } catch {
      return .failure(failure(operation: .undoCompletion, error: error))
    }
  }

  public func reopen(
    _ pageID: PageID,
    now: Date = Date()
  ) async -> TaskMutationResult<PageSnapshot> {
    do {
      let page = try await repository.reopenTask(pageID: pageID, now: now)
      return await success(
        operation: .reopen,
        value: page,
        changedPageIDs: [page.id],
        mutationEffects: [
          .scheduleReminder(page, requestingAuthorization: false),
          .indexSpotlight(page),
        ]
      )
    } catch {
      return .failure(failure(operation: .reopen, error: error))
    }
  }

  public func cancel(
    _ pageID: PageID,
    now: Date = Date()
  ) async -> TaskMutationResult<PageSnapshot> {
    do {
      let page = try await repository.cancelTask(pageID: pageID, now: now)
      return await success(
        operation: .cancel,
        value: page,
        changedPageIDs: [page.id],
        mutationEffects: [
          .cancelReminder(page.id),
          .removeSpotlight(page.id),
        ]
      )
    } catch {
      return .failure(failure(operation: .cancel, error: error))
    }
  }

  public func completeTasks(
    _ pageIDs: [PageID],
    now: Date = Date()
  ) async -> TaskMutationResult<TaskBatchMutationResult> {
    do {
      let result = try await repository.completeTasks(pageIDs, now: now, calendar: calendar)
      let sourceEffects = result.tasks.flatMap {
        [TaskMutationEffect.cancelReminder($0.id), .removeSpotlight($0.id)]
      }
      let successorEffects = result.createdSuccessors.flatMap {
        [
          TaskMutationEffect.scheduleReminder($0, requestingAuthorization: false),
          .indexSpotlight($0),
        ]
      }
      return await success(
        operation: .completeTasks,
        value: result,
        changedPageIDs: result.changedPageIDs,
        mutationEffects: sourceEffects + successorEffects
      )
    } catch {
      return .failure(failure(operation: .completeTasks, error: error))
    }
  }

  public func reopenTasks(
    _ pageIDs: [PageID],
    now: Date = Date()
  ) async -> TaskMutationResult<TaskBatchMutationResult> {
    do {
      let result = try await repository.reopenTasks(pageIDs, now: now)
      return await success(
        operation: .reopenTasks,
        value: result,
        changedPageIDs: result.changedPageIDs,
        mutationEffects: result.tasks.flatMap(Self.activeTaskEffects)
      )
    } catch {
      return .failure(failure(operation: .reopenTasks, error: error))
    }
  }

  public func cancelTasks(
    _ pageIDs: [PageID],
    now: Date = Date()
  ) async -> TaskMutationResult<TaskBatchMutationResult> {
    do {
      let result = try await repository.cancelTasks(pageIDs, now: now)
      return await success(
        operation: .cancelTasks,
        value: result,
        changedPageIDs: result.changedPageIDs,
        mutationEffects: result.tasks.flatMap(Self.closedTaskEffects)
      )
    } catch {
      return .failure(failure(operation: .cancelTasks, error: error))
    }
  }

  public func patchTasks(
    _ pageIDs: [PageID],
    patch: TaskMetadataPatch,
    now: Date = Date()
  ) async -> TaskMutationResult<TaskBatchMutationResult> {
    do {
      let result = try await repository.patchTasks(
        pageIDs,
        patch: patch,
        now: now,
        calendar: calendar
      )
      return await success(
        operation: .patchTasks,
        value: result,
        changedPageIDs: result.changedPageIDs,
        mutationEffects: result.tasks.flatMap(Self.effectsForCurrentState)
      )
    } catch {
      return .failure(failure(operation: .patchTasks, error: error))
    }
  }

  public func trashTasks(
    _ pageIDs: [PageID],
    now: Date = Date()
  ) async -> TaskMutationResult<TaskBatchMutationResult> {
    do {
      let result = try await repository.trashTasks(pageIDs, now: now)
      return await success(
        operation: .trashTasks,
        value: result,
        changedPageIDs: result.changedPageIDs,
        mutationEffects: result.tasks.flatMap(Self.closedTaskEffects)
      )
    } catch {
      return .failure(failure(operation: .trashTasks, error: error))
    }
  }

  public func undoTaskBatch(
    _ receipt: TaskBatchUndoReceipt,
    now: Date = Date()
  ) async -> TaskMutationResult<TaskBatchUndoResult> {
    do {
      let result = try await repository.undoTaskBatch(receipt, now: now)
      let restoredEffects = result.restoredTasks.flatMap(Self.effectsForCurrentState)
      let removedEffects = result.removedSuccessorIDs.flatMap {
        [TaskMutationEffect.cancelReminder($0), .removeSpotlight($0)]
      }
      return await success(
        operation: .undoTaskBatch,
        value: result,
        changedPageIDs: result.changedPageIDs,
        mutationEffects: restoredEffects + removedEffects,
        purgePageIDs: Set(result.removedSuccessorIDs)
      )
    } catch {
      return .failure(failure(operation: .undoTaskBatch, error: error))
    }
  }

  public func moveToTrash(
    _ pageID: PageID,
    now: Date = Date()
  ) async -> TaskMutationResult<PageSnapshot> {
    do {
      let page = try await repository.moveTaskToTrash(pageID: pageID, now: now)
      return await success(
        operation: .moveToTrash,
        value: page,
        changedPageIDs: [page.id],
        mutationEffects: [
          .cancelReminder(page.id),
          .removeSpotlight(page.id),
        ]
      )
    } catch {
      return .failure(failure(operation: .moveToTrash, error: error))
    }
  }

  public func restore(
    _ pageID: PageID,
    now: Date = Date()
  ) async -> TaskMutationResult<PageSnapshot> {
    do {
      let page = try await repository.restoreTask(pageID: pageID, now: now)
      return await success(
        operation: .restore,
        value: page,
        changedPageIDs: [page.id],
        mutationEffects: [
          .scheduleReminder(page, requestingAuthorization: false),
          .indexSpotlight(page),
        ]
      )
    } catch {
      return .failure(failure(operation: .restore, error: error))
    }
  }

  public func purge(
    _ pageID: PageID,
    now: Date = Date()
  ) async -> TaskMutationResult<PageID> {
    do {
      try await repository.purgeTask(pageID: pageID, now: now)
      return await success(
        operation: .purge,
        value: pageID,
        changedPageIDs: [pageID],
        mutationEffects: [
          .cancelReminder(pageID),
          .removeSpotlight(pageID),
        ],
        purgePageIDs: [pageID]
      )
    } catch {
      return .failure(failure(operation: .purge, error: error))
    }
  }

  @discardableResult
  public func drainPendingEffects() async -> [TaskMutationEffectOutcome] {
    do {
      let identities = try await repository.pendingTaskEffectOutboxIdentities()
      var outcomes: [TaskMutationEffectOutcome] = []
      for identity in identities {
        outcomes.append(
          await applyDurableEffect(
            identity,
            fallbackEffect: identity.fallbackEffect
          )
        )
      }
      return outcomes
    } catch {
      return [
        TaskMutationEffectOutcome(
          effect: .reloadLibrary,
          disposition: .failed(error.localizedDescription)
        )
      ]
    }
  }

  private func success<Value: Sendable>(
    operation: TaskMutationOperation,
    value: Value,
    changedPageIDs: [PageID],
    mutationEffects: [TaskMutationEffect],
    purgePageIDs: Set<PageID> = []
  ) async -> TaskMutationResult<Value> {
    let changedPageIDs = unique(changedPageIDs)
    let plannedEffects =
      [TaskMutationEffect.reloadLibrary]
      + mutationEffects
      + changedPageIDs.map {
        purgePageIDs.contains($0) ? .syncPurge($0) : .sync($0)
      }
      + [.reloadWidgets]
    var outcomes: [TaskMutationEffectOutcome] = []
    for effect in plannedEffects {
      if let identity = effect.outboxIdentity {
        outcomes.append(
          await applyDurableEffect(identity, fallbackEffect: effect)
        )
      } else {
        outcomes.append(
          TaskMutationEffectOutcome(
            effect: effect,
            disposition: await effects.apply(effect)
          )
        )
      }
    }
    return .success(
      TaskMutationSuccess(
        operation: operation,
        value: value,
        changedPageIDs: changedPageIDs,
        sideEffects: outcomes
      )
    )
  }

  private func applyDurableEffect(
    _ identity: TaskEffectOutboxIdentity,
    fallbackEffect: TaskMutationEffect
  ) async -> TaskMutationEffectOutcome {
    for _ in 0..<16 {
      let claimResult: TaskEffectOutboxClaimResult
      do {
        claimResult = try await repository.claimTaskEffectOutbox(
          identity,
          leaseDuration: outboxLeaseDuration
        )
      } catch {
        return TaskMutationEffectOutcome(
          effect: fallbackEffect,
          disposition: .failed(error.localizedDescription)
        )
      }

      switch claimResult {
      case .noPendingEffect:
        return TaskMutationEffectOutcome(effect: fallbackEffect, disposition: .notNeeded)
      case .busy:
        return TaskMutationEffectOutcome(
          effect: fallbackEffect,
          disposition: .deferred(.durableRetryScheduled)
        )
      case .claimed(let claim):
        let heartbeat = leaseHeartbeat(for: claim)
        let disposition = await effects.apply(claim.effect)
        heartbeat.cancel()
        do {
          let completion = try await repository.finishTaskEffectOutbox(
            claim,
            disposition: disposition
          )
          if completion == .superseded,
            disposition == .applied || disposition == .notNeeded
          {
            continue
          }
        } catch {
          return TaskMutationEffectOutcome(
            effect: claim.effect,
            disposition: .failed(error.localizedDescription)
          )
        }
        return TaskMutationEffectOutcome(effect: claim.effect, disposition: disposition)
      }
    }
    return TaskMutationEffectOutcome(
      effect: fallbackEffect,
      disposition: .deferred(.durableRetryScheduled)
    )
  }

  private func leaseHeartbeat(
    for claim: TaskEffectOutboxClaim
  ) -> Task<Void, Never> {
    let repository = repository
    let leaseDuration = outboxLeaseDuration
    let delay = UInt64(max(0.25, leaseDuration / 3) * 1_000_000_000)
    return Task {
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: delay)
        guard !Task.isCancelled else { return }
        guard
          (try? await repository.renewTaskEffectOutboxLease(
            claim,
            leaseDuration: leaseDuration
          )) == true
        else { return }
      }
    }
  }

  private func unique(_ pageIDs: [PageID]) -> [PageID] {
    var seen: Set<PageID> = []
    return pageIDs.filter { seen.insert($0).inserted }
  }

  private static func activeTaskEffects(_ page: PageSnapshot) -> [TaskMutationEffect] {
    [
      .scheduleReminder(page, requestingAuthorization: false),
      .indexSpotlight(page),
    ]
  }

  private static func closedTaskEffects(_ page: PageSnapshot) -> [TaskMutationEffect] {
    [.cancelReminder(page.id), .removeSpotlight(page.id)]
  }

  private static func effectsForCurrentState(_ page: PageSnapshot) -> [TaskMutationEffect] {
    page.taskData?.state == .active ? activeTaskEffects(page) : closedTaskEffects(page)
  }

  private func failure(
    operation: TaskMutationOperation,
    error: any Error
  ) -> TaskMutationFailure {
    let reason: TaskMutationFailureReason
    switch error {
    case LibraryRepositoryError.pageNotFound:
      reason = .pageNotFound
    case LibraryRepositoryError.pagePurged:
      reason = .pagePurged
    case LibraryRepositoryError.invalidRecord:
      reason = .invalidRecord
    case LibraryRepositoryError.taskNotActive:
      reason = .taskNotActive
    case LibraryRepositoryError.taskNotClosed:
      reason = .taskNotClosed
    case LibraryRepositoryError.taskCompletionUndoUnavailable:
      reason = .completionUndoUnavailable
    case LibraryRepositoryError.databaseUnavailable(let message):
      reason = .databaseUnavailable(message)
    default:
      reason = .unexpected(error.localizedDescription)
    }
    return TaskMutationFailure(operation: operation, reason: reason)
  }
}
