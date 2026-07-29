import Foundation

public enum TaskMutationWarningRecovery: Equatable, Sendable {
  case notificationsSettings
  case retryPendingEffects
}

/// A small, deterministic policy for turning side-effect failures from one persisted
/// task change (or one outbox drain) into a single user-facing warning.
public struct TaskMutationWarningPresentation: Equatable, Sendable {
  public let title: String
  public let message: String
  public let recovery: TaskMutationWarningRecovery?

  public init(
    title: String,
    message: String,
    recovery: TaskMutationWarningRecovery?
  ) {
    self.title = title
    self.message = message
    self.recovery = recovery
  }

  public static func make(
    warnings: [TaskMutationWarning]
  ) -> TaskMutationWarningPresentation? {
    let grouped = WarningGroup.allCases.compactMap { group -> WarningSection? in
      let messages = unique(
        warnings
          .filter { WarningGroup(warning: $0) == group }
          .map(\.message)
      )
      return messages.isEmpty ? nil : WarningSection(group: group, messages: messages)
    }
    guard let first = grouped.first else { return nil }

    let reminderWarnings = warnings.filter { WarningGroup(warning: $0) == .reminder }
    let notificationAuthorizationDenied = reminderWarnings.contains {
      $0.message.localizedCaseInsensitiveContains("authorization is denied")
    }
    let recovery: TaskMutationWarningRecovery?
    if notificationAuthorizationDenied {
      recovery = .notificationsSettings
    } else if grouped.contains(where: { $0.group == .reminder || $0.group == .spotlight }) {
      recovery = .retryPendingEffects
    } else {
      recovery = nil
    }

    let title: String
    if notificationAuthorizationDenied {
      title = "Task Change Saved, but Notifications Are Off"
    } else {
      switch first.group {
      case .reminder:
        title = "Task Change Saved, but Reminder Failed"
      case .spotlight:
        title = "Task Change Saved, but Search Update Failed"
      case .other:
        title = "Task Change Saved with Warnings"
      }
    }

    return TaskMutationWarningPresentation(
      title: title,
      message: grouped.flatMap(\.messages).joined(separator: "\n\n"),
      recovery: recovery
    )
  }
}

private struct WarningSection {
  let group: WarningGroup
  let messages: [String]
}

private enum WarningGroup: Int, CaseIterable {
  case reminder
  case spotlight
  case other

  init(warning: TaskMutationWarning) {
    switch warning.effect {
    case .scheduleReminder, .cancelReminder:
      self = .reminder
    case .indexSpotlight, .removeSpotlight:
      self = .spotlight
    case .reloadLibrary, .sync, .syncPurge, .reloadWidgets:
      self = .other
    }
  }
}

private func unique(_ values: [String]) -> [String] {
  var seen: Set<String> = []
  return values.filter { seen.insert($0).inserted }
}
