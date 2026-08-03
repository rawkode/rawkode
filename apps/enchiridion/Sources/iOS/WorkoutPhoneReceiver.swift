import EnchiridionCore
import EnchiridionWorkoutTransport
import Foundation
import WatchConnectivity

/// Minimal seam around the queued WatchConnectivity response channel. Tests can
/// supply an in-memory sender; production uses `transferUserInfo`, never an
/// interactive message that would be lost while either app is suspended.
@MainActor
protocol WorkoutAcknowledgementSending: AnyObject {
  func enqueueAcknowledgement(_ data: Data) throws
}

enum WorkoutPhoneReceiveResult: Equatable {
  case imported
  case duplicate
  case pending
  case conflict
  case unavailable
  case rejected
}

@MainActor
final class WorkoutPhoneReceiver {
  private enum RouteRecovery {
    case none
    case recovered(VaultID)
    case conflict, unavailable
  }
  private let vaultSession: VaultSession?
  private let registry: VaultRegistry?
  private let moduleRegistry: ModuleRegistry
  private weak var acknowledgementSender: (any WorkoutAcknowledgementSending)?
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  init(
    vaultSession: VaultSession?,
    registry: VaultRegistry?,
    acknowledgementSender: (any WorkoutAcknowledgementSending)? = nil,
    moduleRegistry: ModuleRegistry? = nil
  ) throws {
    self.vaultSession = vaultSession
    self.registry = registry
    self.acknowledgementSender = acknowledgementSender
    self.moduleRegistry = try moduleRegistry ?? ModuleRegistry(manifests: [WorkoutModule.manifest])
  }

  func receive(_ data: Data) async -> WorkoutPhoneReceiveResult {
    guard let envelope = try? decoder.decode(WorkoutCaptureEnvelope.self, from: data),
      envelope.moduleID == EnchiridionWorkoutTransport.moduleID,
      envelope.version == EnchiridionWorkoutTransport.version,
      envelope.isAuthentic(), UUID(uuidString: envelope.eventID) != nil
    else { return .rejected }
    guard LibraryRepository.isValidWorkoutCapture(envelope) else {
      // The tuple is authentic but cannot be imported. Record it without claiming a vault route,
      // then send the existing terminal conflict disposition so the Watch quarantines it rather
      // than retrying an immutable invalid capture forever.
      if let registry {
        try? registry.quarantineWorkoutCapture(
          moduleID: envelope.moduleID, eventID: envelope.eventID,
          payloadHash: envelope.payloadHash, reason: "invalid workout payload"
        )
        try? registry.enqueueWorkoutResponse(.init(envelope, disposition: .conflict))
        drainAcknowledgements()
      }
      return .conflict
    }
    guard let registry, let vaultSession else { return .pending }

    let route: WorkoutCaptureRoute
    do {
      if let existing = try registry.existingWorkoutCaptureRoute(
        moduleID: envelope.moduleID, eventID: envelope.eventID
      ) {
        guard existing.payloadHash == envelope.payloadHash else {
          throw WorkoutCaptureRouteError.conflictingPayload
        }
        switch try registry.claimWorkoutCaptureRoute(
          moduleID: envelope.moduleID, eventID: envelope.eventID, payloadHash: envelope.payloadHash
        ) {
        case .claimed(let value), .existing(let value): route = value
        }
      } else {
        switch await recoverRoute(for: envelope, vaultSession: vaultSession) {
        case .recovered(let recovered):
          switch try registry.claimRecoveredWorkoutCaptureRoute(
            moduleID: envelope.moduleID, eventID: envelope.eventID,
            payloadHash: envelope.payloadHash, recoveredVaultID: recovered
          ) {
          case .claimed(let value), .existing(let value): route = value
          }
        case .conflict:
          throw WorkoutCaptureRouteError.conflictingPayload
        case .unavailable:
          return .pending
        case .none:
          switch try registry.claimWorkoutCaptureRoute(
            moduleID: envelope.moduleID, eventID: envelope.eventID,
            payloadHash: envelope.payloadHash
          ) {
          case .claimed(let value), .existing(let value): route = value
          }
        }
      }
    } catch WorkoutCaptureRouteError.conflictingPayload {
      try? registry.quarantineWorkoutCapture(
        moduleID: envelope.moduleID, eventID: envelope.eventID,
        payloadHash: envelope.payloadHash, reason: "route payload conflict"
      )
      try? registry.enqueueWorkoutResponse(.init(envelope, disposition: .conflict))
      drainAcknowledgements()
      return .conflict
    } catch WorkoutCaptureRouteError.routedVaultUnavailable {
      return .unavailable
    } catch {
      return .rejected
    }

    do {
      // This opens a background store only. It deliberately does not select the
      // destination vault or rebuild the visible application workspace.
      let store = try await vaultSession.backgroundStore(forVault: route.vaultID)
      let result = try await store.importWorkoutCapture(envelope, registry: moduleRegistry)
      switch result {
      case .conflict:
        try? registry.quarantineWorkoutCapture(
          moduleID: envelope.moduleID, eventID: envelope.eventID,
          payloadHash: envelope.payloadHash, reason: "vault import conflict"
        )
        try? registry.enqueueWorkoutResponse(.init(envelope, disposition: .conflict))
        drainAcknowledgements()
        return .conflict
      case .imported:
        try registry.enqueueWorkoutResponse(.init(envelope, disposition: .imported))
        drainAcknowledgements()
        return .imported
      case .duplicate:
        try registry.enqueueWorkoutResponse(.init(envelope, disposition: .duplicate))
        drainAcknowledgements()
        return .duplicate
      }
    } catch {
      // Import and transport failures remain retryable. The immutable catalog
      // route makes the next Watch delivery safe even after preference changes.
      return .pending
    }
  }

  /// Searches only downloaded vaults for deterministic root provenance before
  /// first-observation routing. More than one match is intentionally refused:
  /// selecting either one would silently cross a vault boundary.
  private func recoverRoute(
    for envelope: WorkoutCaptureEnvelope,
    vaultSession: VaultSession
  ) async -> RouteRecovery {
    let candidates = vaultSession.snapshot.vaults.filter { $0.isDownloaded && $0.deletedAt == nil }
    var matches: [VaultID] = []
    var conflict = false
    var unavailable = false
    for descriptor in candidates {
      do {
        let store = try await vaultSession.backgroundStore(forVault: descriptor.id)
        let provenance = try await store.workoutCaptureProvenance(
          moduleID: envelope.moduleID, eventID: envelope.eventID, payloadHash: envelope.payloadHash
        )
        switch provenance {
        case .matching: matches.append(descriptor.id)
        case .conflicting: conflict = true
        case .absent: break
        }
      } catch {
        unavailable = true
      }
    }
    if conflict || matches.count > 1 { return .conflict }
    // A failed probe cannot be treated as absence: that could duplicate a
    // previously imported capture into the current default vault.
    if unavailable { return .unavailable }
    return matches.first.map(RouteRecovery.recovered) ?? .none
  }

  func drainAcknowledgements() {
    guard let registry, let acknowledgementSender else { return }
    for item in (try? registry.pendingWorkoutAcknowledgements()) ?? [] {
      guard let data = try? encoder.encode(item.response) else { continue }
      do {
        try acknowledgementSender.enqueueAcknowledgement(data)
      } catch {
        // The durable outbox stays intact for the next activation.
        return
      }
    }
  }

  func observeAcknowledgement(_ acknowledgement: WorkoutImportAcknowledgement) {
    try? registry?.acknowledgeWorkoutAcknowledgementDelivery(acknowledgement)
  }
}

@MainActor
final class WorkoutWatchConnectivityTransport: NSObject, WorkoutAcknowledgementSending {
  private let session: WCSession
  private var receiver: WorkoutPhoneReceiver?

  init(session: WCSession = .default) {
    self.session = session
    super.init()
    self.session.delegate = self
  }

  func start(receiver: WorkoutPhoneReceiver) {
    self.receiver = receiver
    guard WCSession.isSupported() else { return }
    session.activate()
    receiver.drainAcknowledgements()
  }

  func enqueueAcknowledgement(_ data: Data) throws {
    guard WCSession.isSupported() else { throw WorkoutWatchConnectivityError.unavailable }
    _ = session.transferUserInfo([WorkoutWatchConnectivityWire.responseKey: data])
  }
}

private enum WorkoutWatchConnectivityError: Error { case unavailable }

extension WorkoutWatchConnectivityTransport: WCSessionDelegate {
  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    guard activationState == .activated, error == nil else { return }
    Task { @MainActor [weak self] in self?.receiver?.drainAcknowledgements() }
  }

  nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    if let data = userInfo[WorkoutWatchConnectivityWire.responseObservedKey] as? Data,
      let acknowledgement = try? JSONDecoder().decode(WorkoutImportAcknowledgement.self, from: data)
    {
      Task { @MainActor [weak self] in self?.receiver?.observeAcknowledgement(acknowledgement) }
      return
    }
    guard let data = userInfo[WorkoutWatchConnectivityWire.envelopeKey] as? Data else { return }
    Task { @MainActor [weak self] in _ = await self?.receiver?.receive(data) }
  }

  nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
  nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
