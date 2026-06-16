import Foundation

struct QueryResult: Equatable, Sendable {
    var columns: [String]
    var rows: [[String: String]]
}
