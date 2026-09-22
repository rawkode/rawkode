import Foundation

public enum TodayQueryCompatibility {
    /// A rolling deployment can expose the older schema briefly. Only retry this
    /// exact validation failure, never an execution, authorization or network error.
    public static func lacksGitHubCompleteness(_ data: Data) -> Bool {
        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              envelope["data"] == nil || envelope["data"] is NSNull,
              let errors = envelope["errors"] as? [[String: Any]], !errors.isEmpty else { return false }
        return errors.allSatisfy { error in
            guard let message = error["message"] as? String, error["path"] == nil else { return false }
            return message.hasPrefix("Cannot query field \"githubActivityPartial\" on type \"Today\".")
        }
    }
}
