import Foundation
import AthenaeumDomain
import AthenaeumRPC

// The watchOS quick-capture write path — the plan's documented CRDT-choice fallback for watchOS
// (`native/docs/decisions.md`'s Decision 2: "watchOS gets the plan's documented fallback: a
// plain-text quick-capture flow synced as a minimal structured record... not a live Automerge
// document on-device"), built for real against `AthenaeumRPC`'s structured-record methods, all of
// which were already proven to build and run on watchOS in that same stage.
//
// Deliberately NOT a `PageDocumentStore`/`WorkspaceSyncClient.applyLocalEdit` call: those live in
// `AthenaeumCore`, which links `automerge-swift`, which has no watchOS slice (see
// `AthenaeumCore/Package.swift`'s top doc comment and this package's own). A quick capture here
// becomes one real graph node (`createNode`), tagged `Task` (`BaseTagIds.task` — the plan's own
// "Task" Base Tag, `tag.ts`'s eighth seeded supertag) so it shows up in the phone/Mac app's
// existing `graph_nodes` view alongside everything else, plus one `Fact` holding the *full*
// captured text under a `quick-capture-text` predicate — the node's `title` alone is truncated for
// display (long dictated text makes an unwieldy title), but the fact always preserves the whole
// utterance verbatim, so nothing dictated is ever silently dropped.
//
// Not durable-before-sync in the `LocalWorkspaceStore` sense (there is no local SQLite authority on
// this platform, per `WatchWorkspaceConfiguration`'s doc comment) — a capture that fails the network
// round trip surfaces as a thrown error to the view model rather than being queued for retry. A
// real background-retry queue for the offline case is explicitly out of scope for this stage (the
// task brief scoped this to "get it building for the watchOS Simulator at minimum" plus an honest
// note on constraints, not a full offline-durability redesign) — flagging it here as the one
// concrete piece of the plan's "durable-before-sync" discipline this platform does not get, and
// why (no `sqlite3` local authority target exists in this package, unlike `AthenaeumCore`'s).

public struct QuickCapture: Sendable, Equatable {
    public let node: Node
    public let fact: Fact
}

public enum QuickCaptureError: Error, Sendable, Equatable {
    case emptyText
}

public actor QuickCaptureClient {
    /// Node titles are truncated for display in list/graph views; the full text always survives
    /// intact in the `quick-capture-text` fact regardless of this limit.
    static let titleCharacterLimit = 120
    static let quickCaptureTextPredicateId = "quick-capture-text"

    private let rpcClient: WorkspaceRPCClient
    public let workspaceId: EntityId

    public init(rpcClient: WorkspaceRPCClient, workspaceId: EntityId) {
        self.rpcClient = rpcClient
        self.workspaceId = workspaceId
    }

    /// Convenience initializer matching `AthenaeumViewModel`'s own `baseURL`/`workspaceId` defaulting
    /// shape, so the watch app's entry point needs no manual `WorkspaceRPCClient` wiring.
    public init(baseURL: URL = WatchWorkspaceConfiguration.resolveBackendURL(), workspaceId: EntityId = WatchWorkspaceConfiguration.resolveWorkspaceId()) {
        let workspaceURL = baseURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.rpcClient = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue)
        self.workspaceId = workspaceId
    }

    /// Captures one piece of dictated/typed text as a new Task-tagged node + full-text fact.
    /// Trims surrounding whitespace first (dictation commonly appends a trailing space/newline);
    /// throws `QuickCaptureError.emptyText` on a blank result rather than creating an empty node.
    @discardableResult
    public func capture(text: String) async throws -> QuickCapture {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw QuickCaptureError.emptyText }

        let title = Self.truncatedTitle(trimmed)
        let remoteNode = try await rpcClient.createNode(title: title, id: nil)
        let node = Node(
            id: try EntityId(validating: remoteNode.id),
            workspaceId: try EntityId(validating: remoteNode.workspaceId),
            title: remoteNode.title,
            createdAt: try IsoDateTimeString(validating: remoteNode.createdAt)
        )

        try await rpcClient.assignTag(nodeId: node.id.rawValue, tagId: BaseTagIds.task.rawValue)

        let remoteFact = try await rpcClient.addFact(
            nodeId: node.id.rawValue,
            predicateId: Self.quickCaptureTextPredicateId,
            value: .string(trimmed)
        )
        let fact = Fact(
            id: try EntityId(validating: remoteFact.id),
            nodeId: try EntityId(validating: remoteFact.nodeId),
            predicateId: remoteFact.predicateId,
            value: try remoteFact.value.toWatchJSONValue()
        )

        return QuickCapture(node: node, fact: fact)
    }

    static func truncatedTitle(_ text: String) -> String {
        guard text.count > titleCharacterLimit else { return text }
        let cut = text.index(text.startIndex, offsetBy: titleCharacterLimit)
        return String(text[..<cut]) + "…"
    }
}

// MARK: - CapnWebValue <-> JSONValue bridging (same shape as `AthenaeumCore/WorkspaceSyncClient.swift`'s
// private bridge — duplicated, not shared, for the identical package-boundary reason
// `WatchWorkspaceConfiguration`'s doc comment gives).

enum WatchJSONValueBridgeError: Error, Sendable {
    case unsupportedCapnWebValue(String)
}

extension CapnWebValue {
    func toWatchJSONValue() throws -> JSONValue {
        switch self {
        case .null, .undefined: return .null
        case .bool(let value): return .bool(value)
        case .number(let value): return .number(value)
        case .string(let value): return .string(value)
        case .array(let values): return .array(try values.map { try $0.toWatchJSONValue() })
        case .object(let fields):
            var result: [String: JSONValue] = [:]
            for (key, value) in fields { result[key] = try value.toWatchJSONValue() }
            return .object(result)
        case .bytes, .error:
            throw WatchJSONValueBridgeError.unsupportedCapnWebValue("\(self)")
        }
    }
}
