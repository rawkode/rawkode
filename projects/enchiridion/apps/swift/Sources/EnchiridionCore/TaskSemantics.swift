// TaskSemantics.swift
// EnchiridionCore
//
// Minimal task-domain vocabulary, ported concept (not code) from the old
// app's `apps/enchiridion/Sources/EnchiridionCore/TaskModels.swift`.
//
// Scope note: the old app's `TaskModels.swift` is ~600 lines covering
// recurrence rules, clarification drafts, and successor generation — that is
// P1 work ("full editor ... core supertag module ported" per the plan's
// phasing). This file carries only the vocabulary `EnchiridionSync` needs to
// express a task mutation as a `CRDTMutation.mapSet` today (state, priority,
// placement), so the sync layer has real domain types to build against
// instead of bare strings. Expand this file, don't fork it, when P1 ports
// the rest.

import Foundation

/// Where a task sits in its lifecycle. Ported concept from the old app's
/// `TaskState`.
public enum TaskState: String, Codable, CaseIterable, Hashable, Sendable {
  case open
  case doing
  case done
  case cancelled
}

/// Ported concept from the old app's `TaskPriority`.
public enum TaskPriority: String, Codable, CaseIterable, Hashable, Sendable, Comparable {
  case low
  case medium
  case high
  case urgent

  private var sortRank: Int {
    switch self {
    case .low: return 0
    case .medium: return 1
    case .high: return 2
    case .urgent: return 3
    }
  }

  public static func < (lhs: Self, rhs: Self) -> Bool {
    lhs.sortRank < rhs.sortRank
  }
}

/// Where a task is surfaced for planning — ported concept from the old
/// app's `TaskPlacement`.
public enum TaskPlacement: String, Codable, CaseIterable, Hashable, Sendable {
  case inbox
  case today
  case scheduled
  case someday
}
