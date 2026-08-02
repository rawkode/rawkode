import SwiftUI

/// Owns the flush boundaries for editors in one navigation surface.
///
/// A `true` result means every registered editor reported its latest draft
/// durable. Lifecycle callers deliberately treat a `false` result as a
/// best-effort failure; leaving the app must never be represented as a
/// successful durable boundary when an editor could not flush.
@MainActor
final class EditorFlushController {
  typealias Flusher = @MainActor () async -> Bool

  private static var liveControllers: [ObjectIdentifier: WeakController] = [:]

  private var flushers: [UUID: Flusher] = [:]

  init() {
    Self.liveControllers[ObjectIdentifier(self)] = WeakController(self)
  }

  func register(_ id: UUID, flusher: @escaping Flusher) {
    flushers[id] = flusher
  }

  func unregister(_ id: UUID) {
    flushers[id] = nil
  }

  /// Flushes only the editors owned by this navigation surface.
  @discardableResult
  func flush() async -> Bool {
    var succeeded = true
    for flusher in Array(flushers.values) {
      if !(await flusher()) {
        succeeded = false
      }
    }
    return succeeded
  }

  /// Best-effort lifecycle boundary for every live editor surface.
  ///
  /// The caller may be suspended before this completes, so the Boolean is
  /// intentionally preserved for tests and non-lifecycle callers rather than
  /// being turned into a durability claim.
  @discardableResult
  static func flushRegisteredEditors() async -> Bool {
    pruneReleasedControllers()

    var succeeded = true
    for controller in liveControllers.values.compactMap(\.value) {
      if !(await controller.flush()) {
        succeeded = false
      }
    }
    return succeeded
  }

  /// Starts a best-effort flush as an app moves out of the foreground.
  static func flushForLifecycleTransition() {
    Task { @MainActor in
      _ = await flushRegisteredEditors()
    }
  }

  private static func pruneReleasedControllers() {
    liveControllers = liveControllers.filter { $0.value.value != nil }
  }
}

@MainActor
private final class WeakController {
  weak var value: EditorFlushController?

  init(_ value: EditorFlushController) {
    self.value = value
  }
}
