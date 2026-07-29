import Foundation

public struct TaskWidgetActionFeedback: Codable, Equatable, Sendable {
  public static let lifetime: TimeInterval = 5 * 60

  public let message: String
  public let createdAt: Date

  public init(message: String, createdAt: Date = Date()) {
    self.message = message
    self.createdAt = createdAt
  }

  public func isCurrent(at date: Date = Date()) -> Bool {
    date.timeIntervalSince(createdAt) >= 0
      && date.timeIntervalSince(createdAt) <= Self.lifetime
  }
}

public final class TaskWidgetActionFeedbackStore: @unchecked Sendable {
  private static let storageKey = "task-widget-action-feedback"

  private let defaults: UserDefaults
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public convenience init() {
    self.init(
      defaults: UserDefaults(
        suiteName: LibraryRepository.applicationGroupIdentifier
      ) ?? .standard
    )
  }

  public init(defaults: UserDefaults) {
    self.defaults = defaults
  }

  public func recordFailure(_ message: String, at date: Date = Date()) {
    let feedback = TaskWidgetActionFeedback(message: message, createdAt: date)
    guard let data = try? encoder.encode(feedback) else { return }
    defaults.set(data, forKey: Self.storageKey)
  }

  public func clear() {
    defaults.removeObject(forKey: Self.storageKey)
  }

  public func current(at date: Date = Date()) -> TaskWidgetActionFeedback? {
    guard
      let data = defaults.data(forKey: Self.storageKey),
      let feedback = try? decoder.decode(TaskWidgetActionFeedback.self, from: data)
    else { return nil }
    guard feedback.isCurrent(at: date) else {
      clear()
      return nil
    }
    return feedback
  }
}
