// OfflineOutbox.swift
// EnchiridionSync
//
// Plan §Native apps: "Non-CRDT actions (approvals, gadget calls) go through
// an outbox with idempotency keys." CRDT edits don't need this (Loro
// handles offline-then-merge natively); this queue is specifically for
// actions that are NOT CRDT ops — approving a calendar RSVP, invoking a
// gadget capability, etc. — where "sent twice" would be a real bug (double
// -RSVP, double-send) rather than a harmless CRDT merge.
//
// Persistence is in-memory only for this skeleton.
// TODO(EnchiridionStore): once EnchiridionStore's GRDB layer exists, this
// actor's storage should move to a GRDB table so pending actions survive an
// app relaunch while offline — the plan calls this out explicitly ("real
// queue logic, persistence can be in-memory for now with a TODO for
// GRDB-backed persistence once EnchiridionStore exists").

import EnchiridionCore
import Foundation

/// A non-CRDT action queued for delivery to the server, identified by an
/// idempotency key so a retry after a dropped response can never be applied
/// twice server-side.
public struct OutboxAction: Sendable, Equatable, Identifiable {
  /// Caller-supplied idempotency key. Re-enqueuing an action with a key
  /// already present in the outbox is a no-op (`OfflineOutbox.enqueue`
  /// returns `false` and does not duplicate it) — this is what makes retry
  /// safe from the call site, not just from the wire.
  public var idempotencyKey: String
  public var id: String { idempotencyKey }

  /// What kind of non-CRDT action this is (e.g. `"calendar.rsvp"`,
  /// `"gadget.invoke"`) — free-form for the skeleton; a real
  /// implementation would likely make this a closed enum once the action
  /// catalog (plan §"Google gatekeeper" writes, §Gadgets capabilities) is
  /// defined.
  public var kind: String

  /// Action-specific, pre-serialized payload (e.g. JSON) — kept opaque
  /// here so the outbox doesn't need to know every action shape.
  public var payload: Data

  /// When this action was enqueued, for ordering and staleness diagnostics.
  public var enqueuedAt: Date

  public init(
    idempotencyKey: String = UUID().uuidString,
    kind: String,
    payload: Data,
    enqueuedAt: Date = Date()
  ) {
    self.idempotencyKey = idempotencyKey
    self.kind = kind
    self.payload = payload
    self.enqueuedAt = enqueuedAt
  }
}

/// Actor-protected FIFO queue of pending non-CRDT actions, deduplicated by
/// idempotency key.
public actor OfflineOutbox {
  private var order: [String] = []
  private var actionsByKey: [String: OutboxAction] = [:]

  public init() {}

  /// Enqueues `action`. Returns `false` without modifying the queue if an
  /// action with the same idempotency key is already pending — this is the
  /// queue's half of retry safety (the other half is the server treating a
  /// repeated key as a no-op).
  @discardableResult
  public func enqueue(_ action: OutboxAction) -> Bool {
    guard actionsByKey[action.idempotencyKey] == nil else {
      return false
    }
    actionsByKey[action.idempotencyKey] = action
    order.append(action.idempotencyKey)
    return true
  }

  /// All currently pending actions, oldest first — for a sync loop that
  /// wants to drain the whole queue.
  public func pendingActions() -> [OutboxAction] {
    order.compactMap { actionsByKey[$0] }
  }

  public var pendingCount: Int {
    order.count
  }

  /// Removes `idempotencyKey` from the queue after the server has
  /// confirmed it (successfully applied, or definitively rejected —
  /// either way there's nothing left to retry).
  @discardableResult
  public func acknowledge(idempotencyKey: String) -> Bool {
    guard actionsByKey.removeValue(forKey: idempotencyKey) != nil else {
      return false
    }
    order.removeAll { $0 == idempotencyKey }
    return true
  }

  /// Removes and returns the oldest pending action without acknowledging
  /// it — for a send loop that wants to pop-attempt-reenqueue-on-failure
  /// rather than iterate `pendingActions()` directly.
  public func dequeueOldest() -> OutboxAction? {
    guard let key = order.first else { return nil }
    order.removeFirst()
    return actionsByKey.removeValue(forKey: key)
  }

  /// Re-enqueues an action at the back of the queue after a failed send
  /// attempt (e.g. the WebSocket dropped mid-send). Distinct from
  /// `enqueue` only in intent — dedup still applies, so if something else
  /// already re-added this key first, this is a no-op.
  @discardableResult
  public func requeue(_ action: OutboxAction) -> Bool {
    enqueue(action)
  }

  public func removeAll() {
    order.removeAll()
    actionsByKey.removeAll()
  }
}
