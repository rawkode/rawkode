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
    case authenticationRequired
}

public actor QuickCaptureClient {
    /// Node titles are truncated for display in list/graph views; the full text always survives
    /// intact in the `quick-capture-text` fact regardless of this limit.
    static let titleCharacterLimit = 120
    static let quickCaptureTextPredicateId = "quick-capture-text"

    private let rpcClient: WorkspaceRPCClient
    private let bearerCredential: String?
    public let workspaceId: EntityId
    private struct PendingCapture: Sendable {
        let normalizedText: String
        let nodeId: String
        let nodeRequestId: String
        let tagRequestId: String
        let factRequestId: String
    }
    private var pendingCapture: PendingCapture?

    public init(rpcClient: WorkspaceRPCClient, workspaceId: EntityId, bearerCredential: String? = nil) {
        self.rpcClient = rpcClient
        self.bearerCredential = bearerCredential
        self.workspaceId = workspaceId
    }

    /// Convenience initializer matching `AthenaeumViewModel`'s own `baseURL`/`workspaceId` defaulting
    /// shape, so the watch app's entry point needs no manual `WorkspaceRPCClient` wiring.
    public init(
        baseURL: URL = WatchWorkspaceConfiguration.resolveBackendURL(),
        workspaceId: EntityId = WatchWorkspaceConfiguration.resolveWorkspaceId(),
        bearerCredential: String? = WatchWorkspaceConfiguration.resolveBearerCredential()
    ) {
        let workspaceURL = baseURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.rpcClient = WorkspaceRPCClient(baseURL: workspaceURL, workspaceId: workspaceId.rawValue, bearerCredential: bearerCredential)
        self.bearerCredential = bearerCredential
        self.workspaceId = workspaceId
    }

    /// Captures one piece of dictated/typed text as a new Task-tagged node + full-text fact.
    /// Trims surrounding whitespace first (dictation commonly appends a trailing space/newline);
    /// throws `QuickCaptureError.emptyText` on a blank result rather than creating an empty node.
    @discardableResult
    public func capture(text: String) async throws -> QuickCapture {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw QuickCaptureError.emptyText }
        guard let bearerCredential, !bearerCredential.isEmpty else { throw QuickCaptureError.authenticationRequired }

        let title = Self.truncatedTitle(trimmed)
        // Freeze the complete node/tag/fact operation before the first network call. If the watch
        // loses a response and the user retries the preserved draft, every ledger identity is
        // replayed instead of creating a partial duplicate capture.
        let operation = pendingCapture?.normalizedText == trimmed
            ? pendingCapture!
            : PendingCapture(
                normalizedText: trimmed,
                nodeId: UUID().uuidString.lowercased(),
                nodeRequestId: UUID().uuidString.lowercased(),
                tagRequestId: UUID().uuidString.lowercased(),
                factRequestId: UUID().uuidString.lowercased()
            )
        pendingCapture = operation
        let remoteNode = try await rpcClient.createNodeWithIntent(
            title: title,
            id: operation.nodeId,
            requestId: operation.nodeRequestId,
            commitMessage: "Capture dictated text as a task node.",
            attribution: MutationAttribution(kind: "humanUi", surface: "watch-quick-capture")
        )
        let node = Node(
            id: try EntityId(validating: remoteNode.id),
            workspaceId: try EntityId(validating: remoteNode.workspaceId),
            title: remoteNode.title,
            createdAt: try IsoDateTimeString(validating: remoteNode.createdAt)
        )

        try await rpcClient.assignTag(
            nodeId: node.id.rawValue,
            tagId: BaseTagIds.task.rawValue,
            requestId: operation.tagRequestId,
            commitMessage: "Mark the quick capture as a task.",
            attribution: MutationAttribution(kind: "humanUi", surface: "watch-quick-capture")
        )

        let remoteFact = try await rpcClient.addFact(
            nodeId: node.id.rawValue,
            predicateId: Self.quickCaptureTextPredicateId,
            value: .string(operation.normalizedText),
            requestId: operation.factRequestId,
            commitMessage: "Capture a quick note.",
            attribution: MutationAttribution(kind: "humanUi", surface: "watch-quick-capture")
        )
        let fact = Fact(
            id: try EntityId(validating: remoteFact.id),
            nodeId: try EntityId(validating: remoteFact.nodeId),
            predicateId: remoteFact.predicateId,
            value: try remoteFact.value.toWatchJSONValue()
        )

        pendingCapture = nil
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
