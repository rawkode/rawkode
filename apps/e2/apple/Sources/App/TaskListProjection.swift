import Foundation

func taskEdit(for task: GraphTask, pending: [PendingTaskEdit]) -> PendingTaskEdit? {
    pending.first { ($0.taskID ?? $0.id).lowercased() == task.id.lowercased() }
}

/// Local intent occupies the same row as its eventual server acknowledgement.
/// Conflicts retain the remote value so the two versions can be reviewed honestly.
func projectTaskList(tasks: [GraphTask], pending: [PendingTaskEdit]) -> [GraphTask] {
    var result = Dictionary(tasks.map { ($0.id.lowercased(), $0) }, uniquingKeysWith: { first, _ in first })
    for edit in pending {
        let id = (edit.taskID ?? edit.id).lowercased()
        if edit.conflict && result[id] != nil { continue }
        var task = result[id] ?? GraphTask(id: id, title: edit.title, status: edit.status,
            priority: edit.priority, linkedEntityIds: [], revision: 0)
        task.title = edit.title
        task.status = edit.status
        task.dueDate = edit.dueDate
        task.priority = edit.priority
        result[id] = task
    }
    return Array(result.values)
}
