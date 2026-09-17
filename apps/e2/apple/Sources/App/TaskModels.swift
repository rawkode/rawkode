import Foundation

struct GraphTask: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    var status: String
    var dueDate: String?
    var priority: String
    var projectId: String?
    var linkedEntityIds: [String]
    var revision: Int
    var bodyDocumentId: String?
}

struct PendingTaskEdit: Codable, Identifiable {
    var id = UUID().uuidString
    var taskID: String?
    var expectedRevision: Int?
    var title: String
    var dueDate: String?
    var priority: String
    var status: String
    var conflict = false
}

