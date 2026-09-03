import Foundation
import AthenaeumDomain

/// Native mirror of `packages/domain/src/search-rpc.ts`'s FTS-backed `searchNodes` method.
/// Keeping the response projected to `SearchResultEntry` means the command center never needs to
/// know about read-model tables or backend-specific snippets.
extension WorkspaceRPCClient {
    public func searchNodes(query: String, limit: Int? = nil) async throws -> [SearchResultEntry] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        var args: [String: CapnWebValue] = ["query": .string(trimmed)]
        args["limit"] = limit.map(CapnWebValue.int) ?? .undefined
        let result = try await rpc("searchNodes", args)
        let values = try result.field("results").arrayValue ?? []
        return try values.map { value in
            guard let rawId = try value.field("nodeId").stringValue,
                  let title = try value.field("title").stringValue,
                  let snippet = try value.field("snippet").stringValue
            else {
                throw CapnWebError.malformedMessage("malformed search result: \(value)")
            }
            return SearchResultEntry(
                nodeId: try EntityId(validating: rawId),
                title: title,
                snippet: snippet
            )
        }
    }
}
