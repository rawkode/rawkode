import Foundation

@main struct TaskListProjectionTests {
    static func main() {
        let id = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
        let create = PendingTaskEdit(id: id, title: "Plan the day", dueDate: "2026-09-14", priority: "high", status: "open")
        let local = projectTaskList(tasks: [], pending: [create])
        precondition(local.count == 1 && local[0].id == id.lowercased())
        let remote = GraphTask(id: id.lowercased(), title: create.title, status: "open",
            dueDate: create.dueDate, priority: "high", projectId: "project", linkedEntityIds: ["link"], revision: 1)
        // Server saved the task, its response was lost, then a refresh discovered it.
        let refreshed = projectTaskList(tasks: [remote], pending: [create])
        precondition(refreshed.count == 1, "Lost replies must not duplicate tasks")
        precondition(refreshed[0].id == local[0].id, "Acknowledgement must retain row identity")
        precondition(taskEdit(for: refreshed[0], pending: [create])?.id == id)
        precondition(refreshed[0].revision == 1 && refreshed[0].linkedEntityIds == ["link"])
        let acknowledged = projectTaskList(tasks: [remote], pending: [])
        precondition(acknowledged == refreshed)
        precondition(taskEdit(for: acknowledged[0], pending: []) == nil)

        let update = PendingTaskEdit(taskID: id, expectedRevision: 1, title: "Updated locally", dueDate: nil, priority: "low", status: "completed")
        let projected = projectTaskList(tasks: [remote], pending: [update])
        precondition(projected.count == 1 && projected[0].status == "completed")
        precondition(projected[0].projectId == remote.projectId && projected[0].revision == remote.revision)
        precondition(remote.status == "open", "Projection must not mutate server data")
        var conflict = update; conflict.conflict = true
        precondition(projectTaskList(tasks: [remote], pending: [conflict]) == [remote])
        let missing = projectTaskList(tasks: [], pending: [conflict])
        precondition(missing.count == 1 && taskEdit(for: missing[0], pending: [conflict])?.conflict == true)
        print("Task projection: lost reply, acknowledgement, updates and conflicts passed")
    }
}
