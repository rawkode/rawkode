import Foundation

#if canImport(WidgetKit)
  import WidgetKit
#endif

public enum TaskMutationOperation: String, Equatable, Sendable {
  case create
  case update
  case complete
  case reopen
  case cancel
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
      "Only active tasks can be completed."
    case .taskNotClosed:
      "Only completed or canceled tasks can be reopened."
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
    case .reopen: "reopened"
    case .cancel: "canceled"
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
        await TaskReminderScheduler.shared.schedule(
          page,
          requestingAuthorization: requestingAuthorization
        )
        return .applied
      case .cancelReminder(let pageID):
        guard surface.canManageAppNotifications else {
          return .deferred(.hostApplicationRequired)
        }
        await TaskReminderScheduler.shared.cancel(pageID)
        return .applied
      case .indexSpotlight(let page):
        await TaskSystemSpotlight.index(page)
        return .applied
      case .removeSpotlight(let pageID):
        await TaskSystemSpotlight.remove(pageID)
        return .applied
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
    case LibraryRepositoryError.databaseUnavailable(let message):
      reason = .databaseUnavailable(message)
    default:
      reason = .unexpected(error.localizedDescription)
    }
    return TaskMutationFailure(operation: operation, reason: reason)
  }
}
