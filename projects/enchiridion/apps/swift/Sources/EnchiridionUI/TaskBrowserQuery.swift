// TaskBrowserQuery.swift
// EnchiridionUI
//
// Task #82. The task list/kanban screens' read path: an unbounded, local,
// in-app browse of every Task-supertagged page — deliberately NOT built on
// `EnchiridionCore.AssistantTurnRetrievalAuthorization`/
// `EnchiridionStore.AssistantReadTools.searchTasks`. Per the task brief:
// P5's read tools exist to bound what a MODEL's tool call can ask for in
// one assistant turn (pre-approved query terms, a single pre-approved
// scope, a small result cap) — none of that pre-flight-authorization
// ceremony has a reason to exist for a plain screen the user opened
// themselves to look at their own tasks. This file instead adapts
// `AssistantReadTools.searchTasks`'s underlying SQL shape directly (same
// `graph_nodes`/`graph_node_tags`/`graph_facts` join over
// `CoreTaskFieldIDs`' fields) with no scope filter, no query filter, and no
// `LIMIT` — a full local browse, matching this file's actual job.
//
// Lives in `EnchiridionUI` (not `EnchiridionStore`, where
// `AssistantReadTools.swift` lives) so this task's file set doesn't
// overlap the sibling P7 tracks' likely files, and because this query's
// only consumers are this package's task-browsing views.

import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import Foundation

extension LocalGraphStore {
  /// Every non-deleted Task-supertagged page, decoded into `TaskListItem`.
  /// No result cap, no scope/query filter — see this file's header for why.
  /// `nonisolated`, matching `LocalGraphStore.query`'s own isolation (the
  /// bounded SQL executor opens its own read connection and needs no actor
  /// hop) and `AssistantReadTools`' read-tool convention.
  public nonisolated func fetchAllTasks() throws -> [TaskListItem] {
    let taskTag = CoreTaskFieldIDs.supertagID.rawValue
    let result = try query(
      sql: """
        SELECT n.node_id AS node_id, n.title AS title, n.modified_at AS modified_at,
          MAX(CASE WHEN f.field_id = :fStatus THEN f.text_value END) AS status,
          MAX(CASE WHEN f.field_id = :fPlacement THEN f.text_value END) AS placement,
          MAX(CASE WHEN f.field_id = :fScheduled THEN f.date_time_value END) AS scheduled_at,
          MAX(CASE WHEN f.field_id = :fDeadline THEN f.local_date_value END) AS deadline_at,
          MAX(CASE WHEN f.field_id = :fDue THEN f.date_time_value END) AS due_at,
          MAX(CASE WHEN f.field_id = :fCompletedAt THEN f.date_time_value END) AS completed_at,
          MAX(CASE WHEN f.field_id = :fPriority THEN f.text_value END) AS priority
        FROM graph_nodes n
        JOIN graph_node_tags t ON t.node_id = n.node_id AND t.tag_id = :taskTag
        LEFT JOIN graph_facts f ON f.node_id = n.node_id AND f.tag_id = :taskTag
        WHERE n.deleted_at IS NULL
        GROUP BY n.node_id, n.title, n.modified_at
        """,
      arguments: [
        ":taskTag": .text(taskTag),
        ":fStatus": .text(CoreTaskFieldIDs.status.rawValue),
        ":fPlacement": .text(CoreTaskFieldIDs.placement.rawValue),
        ":fScheduled": .text(CoreTaskFieldIDs.scheduled.rawValue),
        ":fDeadline": .text(CoreTaskFieldIDs.deadline.rawValue),
        ":fDue": .text(CoreTaskFieldIDs.due.rawValue),
        ":fCompletedAt": .text(CoreTaskFieldIDs.completedAt.rawValue),
        ":fPriority": .text(CoreTaskFieldIDs.priority.rawValue),
      ]
    )

    let columnNames = result.columns.map(\.name)
    return result.rows.compactMap { row in
      let dict = Dictionary(uniqueKeysWithValues: zip(columnNames, row.values))
      return TaskListItem.decode(from: dict)
    }
  }
}

extension TaskListItem {
  fileprivate static func decode(from dict: [String: GraphSQLValue]) -> TaskListItem? {
    guard let nodeID = dict["node_id"]?.stringValue, let title = dict["title"]?.stringValue else {
      return nil
    }
    return TaskListItem(
      pageID: PageID(rawValue: nodeID),
      title: title,
      status: dict["status"]?.stringValue.flatMap(CoreTaskStatus.init(rawValue:)),
      placement: dict["placement"]?.stringValue.flatMap(CoreTaskPlacement.init(rawValue:)),
      priority: dict["priority"]?.stringValue.flatMap(CoreTaskPriority.init(rawValue:)),
      scheduledAt: dict["scheduled_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      deadlineAt: dict["deadline_at"]?.stringValue.flatMap(Date.fromEnchiridionISO8601),
      dueAt: dict["due_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      completedAt: dict["completed_at"]?.int64Value.map(Date.init(millisecondsSince1970:)),
      modifiedAt: dict["modified_at"]?.int64Value.map(Date.init(millisecondsSince1970:))
    )
  }
}

// MARK: - GraphSQLValue decoding helpers
//
// `GraphSQLValue`/`GraphQueryResult` (EnchiridionStore/GraphQueryModels.swift)
// expose no public `dictionaries()`/`.stringValue`-shaped convenience —
// `AssistantReadTools.swift` declares an identical `fileprivate` pair
// scoped to itself; this file needs its own copy for the same reason
// (fileprivate, not shared) rather than depending on that file's
// internals.

extension GraphSQLValue {
  fileprivate var stringValue: String? {
    if case .text(let value) = self { value } else { nil }
  }

  fileprivate var int64Value: Int64? {
    if case .integer(let value) = self { value } else { nil }
  }
}

// MARK: - Epoch-millisecond timestamps
//
// Mirrors `LocalGraphStore.swift`'s private `Date(millisecondsSince1970:)`
// initializer (EnchiridionStore, internal to that module) — needed again
// here since this file decodes the same epoch-millisecond `INTEGER`
// columns (`LocalGraphSchema`'s timestamp convention) from another module.

extension Date {
  fileprivate init(millisecondsSince1970 milliseconds: Int64) {
    self.init(timeIntervalSince1970: Double(milliseconds) / 1_000)
  }
}
