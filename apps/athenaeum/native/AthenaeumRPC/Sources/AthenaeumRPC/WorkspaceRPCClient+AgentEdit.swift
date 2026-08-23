import Foundation

// Phase 3 native slice (plan §"Agent-native editing & gatekeeper integrations", task item 3:
// "accept/revert UI both clients"). Same file-per-concern convention `WorkspaceRPCClient+Graph.swift`
// established: a minimal, mechanical extension of `WorkspaceRPCClient` covering exactly the
// `AgentEditService` RPC methods this stage's SwiftUI surface (`PendingChangesView` /
// `AgentEditViewModel`, in `AthenaeumApp`) and CLI driver (`phase3-driver`) actually call —
// `createChat`, `listChats`, `getChat`, `sendChatMessage`, `mergeChanges`, `revertChanges`,
// `listPendingChanges`. `listChatChanges` (the permanent audit trail — see its own doc comment in
// `packages/domain/src/agent-edit-rpc.ts`) is deliberately NOT mirrored here: nothing this stage's
// scoped-down UI needs ("prioritize the accept/revert flow working for real over a polished chat
// UI") reads it, and `listPendingChanges` is the correct data source for "what's pending now"
// anyway (same reasoning that produced `listPendingChanges` in the first place, per that method's
// own doc comment).

/// Mirrors `packages/domain/src/node.ts`'s `PendingMarker`: `{chatId, sequence?}` — the reusable
/// marker `RPCNode.pending`/`RPCFact.pending`/`RPCEdge.pending` (`WorkspaceRPCClient.swift`/
/// `WorkspaceRPCClient+Graph.swift`) carry while an agent-proposed record is unaccepted. `sequence`
/// absent means "unstamped" (see `PendingMarker`'s TS doc comment for the full crash-recovery
/// meaning); this client only needs it to compute a correct `mergeThrough`/`revertFrom` range for
/// the accept/revert UI (`AgentEditViewModel.accept()`/`.revert()`, `AthenaeumApp`).
public struct RPCPendingMarker: Sendable, Equatable {
    public let chatId: String
    public let sequence: Int?

    init(_ value: CapnWebValue) throws {
        guard let chatId = try value.field("chatId").stringValue else {
            throw CapnWebError.malformedMessage("malformed PendingMarker: \(value)")
        }
        self.chatId = chatId
        self.sequence = try value.field("sequence").intValue
    }

    /// `nil` for an absent `Schema.optional` field, decoded otherwise. Two distinct wire shapes
    /// both mean "absent" here, confirmed empirically against the real running backend (a
    /// genuinely missing object key decodes as `.null` per `CapnWebValue.field(_:)`'s own
    /// fallback — but a real capnweb response for a `Schema.optional` field that IS present as a
    /// key was observed to carry the literal `["undefined"]` wire tag as that key's *value*
    /// (`{"pending":["undefined"]}`), not omit the key — contradicting `CapnWebValue.toWireJSON`'s
    /// doc comment, which describes this client's own *outbound*-encoding choice, not a proven
    /// claim about the server's actual encoder). `CapnWebValue.field(_:)` decodes that tag to
    /// `.undefined`, so both `.null` and `.undefined` must be treated as "no pending marker" here
    /// — only `.object` should ever reach `RPCPendingMarker.init` below.
    static func decodeOptional(_ value: CapnWebValue) throws -> RPCPendingMarker? {
        switch value {
        case .null, .undefined: return nil
        default: return try RPCPendingMarker(value)
        }
    }
}

/// Mirrors `packages/domain/src/chat.ts`'s `Chat`.
public struct RPCChat: Sendable, Equatable, Identifiable {
    public let id: String
    public let workspaceId: String
    public let title: String
    public let createdAt: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let title = try value.field("title").stringValue,
              let createdAt = try value.field("createdAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed Chat: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.createdAt = createdAt
    }
}

/// Mirrors `packages/domain/src/chat.ts`'s `ChatMessageRecord` — deliberately without
/// `toolCalls` (see this file's header comment: the scoped-down UI renders `role`/`content` only,
/// same "not a polished chat UI" scoping the task explicitly allowed).
public struct RPCChatMessage: Sendable, Equatable, Identifiable {
    public let id: String
    public let chatId: String
    public let role: String
    public let content: String
    public let sequence: Int

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let chatId = try value.field("chatId").stringValue,
              let role = try value.field("role").stringValue,
              let content = try value.field("content").stringValue,
              let sequence = try value.field("sequence").intValue
        else { throw CapnWebError.malformedMessage("malformed ChatMessageRecord: \(value)") }
        self.id = id
        self.chatId = chatId
        self.role = role
        self.content = content
        self.sequence = sequence
    }
}

/// The three pending-record collections a chat can currently have outstanding — mirrors
/// `agent-edit-rpc.ts`'s `ListPendingChangesOutput` exactly (`{nodes, facts, edges}`).
public struct RPCPendingChanges: Sendable, Equatable {
    public let nodes: [RPCNode]
    public let facts: [RPCFact]
    public let edges: [RPCEdge]

    public init(nodes: [RPCNode] = [], facts: [RPCFact] = [], edges: [RPCEdge] = []) {
        self.nodes = nodes
        self.facts = facts
        self.edges = edges
    }

    public var isEmpty: Bool { nodes.isEmpty && facts.isEmpty && edges.isEmpty }
    public var count: Int { nodes.count + facts.count + edges.count }
}

/// One node's live chat-fork preview — mirrors `chat-fork-rpc.ts`'s `ChatForkPreviewOutput` plus
/// the `nodeId` it was queried for (the wire response itself doesn't echo it back, so this client
/// attaches it — see `WorkspaceRPCClient.chatForkPreview(chatId:nodeId:)`). Note-body-edit counterpart
/// to `RPCPendingChanges` above; `Identifiable` so `AgentEditViewModel.pendingNoteForks` can drive
/// a SwiftUI `ForEach` directly.
public struct RPCChatForkPreview: Sendable, Equatable, Identifiable {
    public let nodeId: String
    public let forked: Bool
    public let text: String
    public var id: String { nodeId }
}

extension WorkspaceRPCClient {
    // MARK: - Chats

    public func createChat(title: String) async throws -> RPCChat {
        let result = try await rpc("createChat", ["title": .string(title)])
        return try RPCChat(result.field("chat"))
    }

    public func listChats() async throws -> [RPCChat] {
        let result = try await rpc("listChats", [:])
        let chats = try result.field("chats").arrayValue ?? []
        return try chats.map(RPCChat.init)
    }

    /// `workspaceId` is deliberately not sent — `getChat`/`sendChatMessage`/`mergeChanges`/
    /// `revertChanges`/`listPendingChanges` resolve the workspace from the chat itself server-side
    /// (see `workspace-durable-object.ts`'s `getChat` + `requireOwnWorkspace(workspaceId, chat.workspaceId)`
    /// pattern), unlike every node/graph method above which is keyed directly off this client's
    /// own `workspaceId`. Calling `rpc(_:_:)` (which always injects `workspaceId`) is still correct here
    /// — the server simply ignores/independently re-derives it via the chat lookup — so reusing
    /// it keeps this file's dispatch identical to every other method rather than adding a second
    /// call path.
    public func getChat(chatId: String) async throws -> (chat: RPCChat, messages: [RPCChatMessage]) {
        let result = try await rpc("getChat", ["chatId": .string(chatId)])
        let messages = try result.field("messages").arrayValue ?? []
        return (try RPCChat(result.field("chat")), try messages.map(RPCChatMessage.init))
    }

    public func sendChatMessage(
        chatId: String,
        text: String
    ) async throws -> (messages: [RPCChatMessage], changesSequences: [Int]) {
        let result = try await rpc("sendChatMessage", ["chatId": .string(chatId), "text": .string(text)])
        let messages = try result.field("messages").arrayValue ?? []
        let sequences = try result.field("changesSequences").arrayValue ?? []
        return (try messages.map(RPCChatMessage.init), sequences.compactMap(\.intValue))
    }

    // MARK: - Pending changes (accept/revert)

    public func listPendingChanges(chatId: String) async throws -> RPCPendingChanges {
        let result = try await rpc("listPendingChanges", ["chatId": .string(chatId)])
        let nodes = try result.field("nodes").arrayValue ?? []
        let facts = try result.field("facts").arrayValue ?? []
        let edges = try result.field("edges").arrayValue ?? []
        return RPCPendingChanges(
            nodes: try nodes.map(RPCNode.init),
            facts: try facts.map(RPCFact.init),
            edges: try edges.map(RPCEdge.init)
        )
    }

    /// Promotes (accepts) every pending node/fact/edge this chat produced with
    /// `sequence <= mergeThrough` — the "Accept" half of the accept/revert flow.
    @discardableResult
    public func mergeChanges(chatId: String, mergeThrough: Int) async throws -> Int {
        let result = try await rpc(
            "mergeChanges",
            ["chatId": .string(chatId), "mergeThrough": .int(mergeThrough)]
        )
        return try result.field("mergeThrough").intValue ?? mergeThrough
    }

    /// Deletes every pending node/fact/edge this chat produced with `sequence >= revertFrom` —
    /// the "Revert" half of the accept/revert flow.
    @discardableResult
    public func revertChanges(chatId: String, revertFrom: Int) async throws -> Int {
        let result = try await rpc(
            "revertChanges",
            ["chatId": .string(chatId), "revertFrom": .int(revertFrom)]
        )
        return try result.field("revertFrom").intValue ?? revertFrom
    }

    // MARK: - Note-body edits (chat-fork accept/revert) — adversarial-review fix
    //
    // Mirrors `chat-fork-rpc.ts`'s `forkChatEdit`/`chatForkPreview`/`acceptChatFork`/
    // `revertChatFork` — the exact four method names the finding this fixes names as absent ("No
    // references anywhere in AthenaeumRPC or AthenaeumApp to forkChatEdit/acceptChatFork/
    // revertChatFork/chatForkPreview... zero capability to review or act on agent note-body
    // edits"). `applyChatForkEdit` deliberately NOT mirrored — it's the agent tool's own internal
    // edit-application step (`editNoteTool`, backend-side only); no review-only client surface
    // ever calls it, so mirroring it here would be speculative surface area with nothing to
    // exercise it, the same reasoning `WorkspaceRPCClient.swift`'s own header comment already applies
    // to its other out-of-scope methods. `workspaceId` (unlike `chatId`-only methods above) IS
    // required on the wire for all four — `chat-fork-rpc.ts`'s input schemas all carry it,
    // matching `rpc(_:_:)`'s own always-inject-`workspaceId` behavior exactly, so no special-casing is
    // needed here.

    /// Forks the mainline page for `(chatId, nodeId)` if not already forked — idempotent, per
    /// `ChatForkService.fork`'s own doc comment. Included for interface completeness against the
    /// backend's full chat-fork surface; this review-only client's own UI never calls it directly
    /// (forking happens server-side, automatically, the first time an agent's `editNote` tool call
    /// targets a node — see `agent-edit-service-live.ts`'s `editNoteTool`).
    @discardableResult
    public func forkChatEdit(chatId: String, nodeId: String) async throws -> String {
        let result = try await rpc("forkChatEdit", ["chatId": .string(chatId), "nodeId": .string(nodeId)])
        return try result.field("text").stringValue ?? ""
    }

    /// Live preview of a chat's note-body fork for `nodeId`, safe to poll from any number of
    /// watchers (`chat-fork-service-live.ts`'s own doc comment) — `forked == false` means no
    /// active fork (never/already accepted/reverted), NOT "the fork agrees with mainline."
    public func chatForkPreview(chatId: String, nodeId: String) async throws -> RPCChatForkPreview {
        let result = try await rpc("chatForkPreview", ["chatId": .string(chatId), "nodeId": .string(nodeId)])
        return RPCChatForkPreview(
            nodeId: nodeId,
            forked: try result.field("forked").boolValue ?? false,
            text: try result.field("text").stringValue ?? ""
        )
    }

    /// Merges the chat's fork into freshly-reloaded mainline via real `Automerge.merge` and
    /// discards the fork — the "Accept" half of the note-edit review flow.
    public func acceptChatFork(chatId: String, nodeId: String) async throws -> (page: RPCPage, text: String) {
        let result = try await rpc("acceptChatFork", ["chatId": .string(chatId), "nodeId": .string(nodeId)])
        return (try RPCPage(result.field("page")), try result.field("text").stringValue ?? "")
    }

    /// Discards the chat's fork for `nodeId`, if any — never fails even if nothing was pending
    /// (`ChatForkService.revert`'s own doc comment) — the "Revert" half of the note-edit review
    /// flow.
    public func revertChatFork(chatId: String, nodeId: String) async throws {
        _ = try await rpc("revertChatFork", ["chatId": .string(chatId), "nodeId": .string(nodeId)])
    }
}
