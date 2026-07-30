import Foundation

public struct TaskSystemHandoffOutcome: Equatable, Sendable {
  public let route: TaskDeepLinkRoute?
  public let pages: [PageSnapshot]

  public init(route: TaskDeepLinkRoute?, pages: [PageSnapshot]) {
    self.route = route
    self.pages = pages
  }
}

/// Serializes app activation and task-link refreshes so only the newest request
/// can update navigation state. An undelivered task route survives a subsequent
/// activation request and is delivered after that request's fresh repository read.
public actor TaskSystemHandoffCoordinator {
  public typealias Refresh = @MainActor @Sendable () async -> [PageSnapshot]?

  private struct PendingRequest {
    let id: UInt64
    let refresh: Refresh
    let continuation: CheckedContinuation<TaskSystemHandoffOutcome?, Never>
  }

  private var latestRequestID: UInt64 = 0
  private var latestRoute: (id: UInt64, route: TaskDeepLinkRoute)?
  private var lastDeliveredRouteID: UInt64 = 0
  private var pendingRequest: PendingRequest?
  private var isDraining = false

  public init() {}

  public func activate(using refresh: @escaping Refresh) async -> TaskSystemHandoffOutcome? {
    await submit(route: nil, refresh: refresh)
  }

  public func open(
    _ route: TaskDeepLinkRoute,
    using refresh: @escaping Refresh
  ) async -> TaskSystemHandoffOutcome? {
    await submit(route: route, refresh: refresh)
  }

  func submittedRequestCount() -> UInt64 {
    latestRequestID
  }

  private func submit(
    route: TaskDeepLinkRoute?,
    refresh: @escaping Refresh
  ) async -> TaskSystemHandoffOutcome? {
    latestRequestID &+= 1
    let requestID = latestRequestID
    if let route {
      latestRoute = (requestID, route)
    }

    return await withCheckedContinuation { continuation in
      pendingRequest?.continuation.resume(returning: nil)
      pendingRequest = PendingRequest(
        id: requestID,
        refresh: refresh,
        continuation: continuation
      )
      guard !isDraining else { return }
      isDraining = true
      Task { await drain() }
    }
  }

  private func drain() async {
    while let request = pendingRequest {
      pendingRequest = nil
      let pages = await request.refresh()

      guard request.id == latestRequestID else {
        request.continuation.resume(returning: nil)
        continue
      }
      guard let pages else {
        request.continuation.resume(returning: nil)
        continue
      }

      let route: TaskDeepLinkRoute?
      if let pendingRoute = latestRoute,
        pendingRoute.id > lastDeliveredRouteID
      {
        route = pendingRoute.route.validated(against: pages)
        lastDeliveredRouteID = pendingRoute.id
      } else {
        route = nil
      }
      request.continuation.resume(
        returning: TaskSystemHandoffOutcome(route: route, pages: pages)
      )
    }
    isDraining = false
  }
}

/// Runs system mutations one at a time even when an operation suspends. Actors
/// are otherwise reentrant across `await`, which is unsafe for replace-all
/// operations such as Spotlight reconciliation.
actor TaskSystemExclusiveOperationLane {
  private var isActive = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func perform<Value: Sendable>(
    _ operation: @escaping @Sendable () async throws -> Value
  ) async rethrows -> Value {
    await acquire()
    defer { release() }
    return try await operation()
  }

  private func acquire() async {
    guard isActive else {
      isActive = true
      return
    }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }

  private func release() {
    guard !waiters.isEmpty else {
      isActive = false
      return
    }
    waiters.removeFirst().resume()
  }
}

/// Coalesces expensive system reconciliation behind one serial lane. If state
/// changes while a reconciliation is running, only the newest queued snapshot
/// runs next and therefore becomes the final Spotlight and notification state.
public actor TaskSystemReconciliationCoordinator {
  public typealias Operation = @Sendable (VaultID, [PageSnapshot]) async -> Void

  public static let shared = TaskSystemReconciliationCoordinator { vaultID, pages in
    await TaskSystemSpotlight.reconcile(pages, vaultID: vaultID)
    await TaskReminderScheduler.shared.reconcile(
      pages.filter { $0.hasSupertag(BuiltInSupertags.task) },
      vaultID: vaultID
    )
  }

  private let operation: Operation
  private var pendingSnapshots: [VaultID: [PageSnapshot]] = [:]
  private var pendingVaultIDs: [VaultID] = []
  private var isDraining = false
  private var idleWaiters: [CheckedContinuation<Void, Never>] = []

  init(operation: @escaping Operation) {
    self.operation = operation
  }

  public func submit(vaultID: VaultID, pages: [PageSnapshot]) {
    if pendingSnapshots[vaultID] == nil {
      pendingVaultIDs.append(vaultID)
    }
    pendingSnapshots[vaultID] = pages
    guard !isDraining else { return }
    isDraining = true
    Task { await drain() }
  }

  func waitUntilIdle() async {
    guard isDraining || !pendingVaultIDs.isEmpty else { return }
    await withCheckedContinuation { continuation in
      idleWaiters.append(continuation)
    }
  }

  private func drain() async {
    while let vaultID = pendingVaultIDs.first {
      pendingVaultIDs.removeFirst()
      guard let pages = pendingSnapshots.removeValue(forKey: vaultID) else { continue }
      await operation(vaultID, pages)
    }
    isDraining = false
    let waiters = idleWaiters
    idleWaiters.removeAll()
    for waiter in waiters {
      waiter.resume()
    }
  }
}
