import Foundation

@MainActor
final class TodayWorkspaceTransitionCoordinator {
  enum Panel: Hashable { case plan, note }
  struct Target: Hashable {
    let day: Date
    let panel: Panel
  }

  private(set) var generation = 0
  private(set) var target: Target
  private var task: Task<Void, Never>?

  init(day: Date, panel: Panel = .plan) { target = .init(day: day, panel: panel) }
  deinit { task?.cancel() }

  func request(_ target: Target, operation: @escaping @MainActor (Int, Target) async -> Void) {
    guard target != self.target || task == nil else { return }
    task?.cancel()
    self.target = target
    generation &+= 1
    let requestGeneration = generation
    task = Task { [weak self] in
      await operation(requestGeneration, target)
      guard let self, self.generation == requestGeneration, self.target == target else { return }
      self.task = nil
    }
  }

  func isCurrent(_ generation: Int, target: Target) -> Bool {
    !Task.isCancelled && self.generation == generation && self.target == target
  }

  @discardableResult
  func commitIfCurrent(
    _ generation: Int, target: Target, materialized: Bool = true, commit: () -> Void
  ) -> Bool {
    guard materialized, isCurrent(generation, target: target) else { return false }
    commit()
    return true
  }
}
