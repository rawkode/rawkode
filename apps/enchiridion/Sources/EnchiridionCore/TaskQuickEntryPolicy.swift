import Foundation

public enum TaskQuickEntryTrigger: Hashable, Sendable {
  case submit
  case interpret
}

public enum TaskQuickEntryCommand: Hashable, Sendable {
  case saveLiteral(TaskDraft)
  case reviewInterpretation(String)
}

/// Keeps the fast literal-capture path separate from optional model interpretation.
public enum TaskQuickEntryPolicy {
  public static func command(
    for input: String,
    trigger: TaskQuickEntryTrigger
  ) -> TaskQuickEntryCommand? {
    let normalized = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }

    switch trigger {
    case .submit:
      return .saveLiteral(TaskDraft(title: normalized, data: TaskData(placement: .inbox)))
    case .interpret:
      return .reviewInterpretation(normalized)
    }
  }
}
