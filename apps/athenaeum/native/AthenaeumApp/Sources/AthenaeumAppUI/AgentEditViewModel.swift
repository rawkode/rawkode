import Foundation
import AthenaeumDomain
import AthenaeumRPC

// Native slice of Phase 3 (plan §"Agent-native editing & gatekeeper integrations", task item 3:
// "A minimal SwiftUI surface... list pending changes for a chat, Accept/Revert buttons. A full
// chat-message-composing UI is nice-to-have but NOT required this stage if time-constrained —
// prioritize the accept/revert flow working for real over a polished chat UI").
//
// Scoping note (deliberate, stated explicitly per the task's own instruction to "say clearly what
// you scoped down"): this view model DOES include a minimal message-compose affordance
// (`sendMessage()`) — cheap to add once `WorkspaceRPCClient+AgentEdit.swift` exists and it's what
// makes the accept/revert flow demonstrable end-to-end *inside the app itself*, not only via the
// `phase3-driver` CLI. The composer is intentionally first-class: an empty workspace can start
// with a prompt and the model creates a deterministic chat title from it, while the explicit
// title form remains available for users who want to name a conversation before writing. What it
// deliberately does NOT do, staying inside the "not required" scope: render `toolCalls` content,
// distinguish/collapse `"tool"`-role log rows specially, or support multiple concurrent in-flight
// sends. `errorMessage`'s `describeSendError` also gives the plan's own "model not configured"
// case (no `ANTHROPIC_API_KEY` in this environment, per this task's hard constraint) a clear,
// specific message rather than a raw stringified error, mirroring the web stage's `ChatPanel.tsx`
// banner.
@MainActor
public final class AgentEditViewModel: ObservableObject {
    public enum LoadStatus: Equatable {
        case idle
        case loading
        case loaded
        case error(String)
    }

    @Published public private(set) var status: LoadStatus = .idle
    @Published public private(set) var chats: [RPCChat] = []
    @Published public var selectedChatId: String?
    @Published public private(set) var messages: [RPCChatMessage] = []
    @Published public private(set) var pending = RPCPendingChanges()
    /// Adversarial-review fix (finding: "No references anywhere in AthenaeumRPC or AthenaeumApp
    /// to forkChatEdit/acceptChatFork/revertChatFork/chatForkPreview... the native client has
    /// zero capability to review or act on agent note-body edits") — the note-body-edit
    /// counterpart to `pending` above. Populated by `selectChat`/`sendMessage` via
    /// `refreshNoteForks()`: scan the chat's own message log for candidate node ids (see that
    /// method's doc comment), then re-check each against the real, live `chatForkPreview` state —
    /// mirrors the web stage's `ChatPanel.tsx` `forkNodeIds`/`forksState` design exactly.
    @Published public private(set) var pendingNoteForks: [RPCChatForkPreview] = []
    @Published public private(set) var noteForkBusyKey: String?
    @Published public var newChatTitle: String = ""
    @Published public var messageText: String = ""
    @Published public private(set) var isCreatingChat = false
    @Published public private(set) var isSending = false
    @Published public private(set) var isMutatingPending = false
    @Published public private(set) var errorMessage: String?

    /// A `mergeThrough`/`revertFrom` value comfortably beyond any real `ChangesMessage.sequence`
    /// a single chat will ever produce — "accept/revert everything currently pending for this
    /// chat," the same wide-range-is-a-safe-no-op-beyond-what-exists pattern
    /// `agent-edit.test.ts`'s own `mergeThrough: 100` reconcile-sweep assertion already relies on
    /// (see that test's comment: "A merge over any range is a safe no-op — there is nothing left
    /// pending to promote"). Deliberately not computed as `max(pending sequences)`: a record can
    /// legitimately have no stamped `sequence` yet (§Q15's "unstamped" window, node.ts's
    /// `PendingMarker` doc comment) between being written and the enclosing turn's flush, and
    /// `sendChatMessage` has already returned by the time this UI ever sees a chat's pending list
    /// — so this sentinel is simpler and exactly as correct as a computed max would be here.
    private static let acceptAllSentinel = 1_000_000_000

    /// Turns a first prompt into the same compact, deterministic title used by the web composer.
    /// Determinism matters here: a retry after a failed model call should continue the existing
    /// chat rather than creating a differently named conversation.
    static func chatTitleFromMessage(_ message: String) -> String {
        let normalized = message.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard !normalized.isEmpty else { return "New chat" }
        guard normalized.count > 48 else { return normalized }
        return "\(normalized.prefix(47).trimmingCharacters(in: .whitespacesAndNewlines))…"
    }

    /// A failed catalog read does not prove that the workspace has no chats. Keep that failure
    /// presentation-safe, rather than surfacing transport detail or inviting a first-message
    /// create flow against an unknown catalog.
    static func chatListLoadFailureMessage(for _: Error) -> String {
        "Chats couldn’t be loaded. Nothing has been changed. Retry to check your conversations."
    }

    /// The empty-state composer may start a chat, so it is available only after a successful
    /// catalog read has explicitly established that no chats exist.
    static func isLoadedEmptyChatCatalog(chatsAreEmpty: Bool, status: LoadStatus) -> Bool {
        chatsAreEmpty && status == .loaded
    }

    private let client: WorkspaceRPCClient
    public let workspaceId: EntityId

    public init(
        baseURL: URL = WorkspaceConfiguration.resolveBackendURL(),
        workspaceId: EntityId = WorkspaceConfiguration.resolveWorkspaceId(),
        bearerCredential: String? = nil
    ) {
        self.workspaceId = workspaceId
        let workspaceURL = baseURL.appendingPathComponent("api/workspace/\(workspaceId.rawValue)")
        self.client = WorkspaceRPCClient(
            baseURL: workspaceURL,
            workspaceId: workspaceId.rawValue,
            bearerCredential: bearerCredential
        )
    }

    /// Test/CLI-driver-only escape hatch: build a view model against an already-constructed
    /// `WorkspaceRPCClient` (e.g. one pointed at a `wrangler dev` instance via
    /// `ATHENAEUM_TEST_BACKEND_URL`), rather than resolving one from `WorkspaceConfiguration`'s
    /// `UserDefaults`-backed production defaults.
    init(client: WorkspaceRPCClient, workspaceId: EntityId) {
        self.client = client
        self.workspaceId = workspaceId
    }

    // MARK: - Chats

    public func start() async {
        await reloadChats()
    }

    public func reloadChats() async {
        status = .loading
        do {
            chats = try await client.listChats()
            if let selectedChatId, chats.contains(where: { $0.id == selectedChatId }) {
                await selectChat(selectedChatId)
            } else if let first = chats.first {
                await selectChat(first.id)
            } else {
                selectedChatId = nil
                messages = []
                pending = RPCPendingChanges()
                pendingNoteForks = []
            }
            status = .loaded
        } catch {
            status = .error(Self.chatListLoadFailureMessage(for: error))
        }
    }

    public func createChat() async {
        let title = newChatTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        isCreatingChat = true
        errorMessage = nil
        defer { isCreatingChat = false }
        do {
            let chat = try await client.createChat(title: title)
            newChatTitle = ""
            chats.insert(chat, at: 0)
            await selectChat(chat.id)
        } catch {
            errorMessage = Self.namedChatCreationFailureMessage(for: error)
        }
    }

    /// A lost creation response cannot prove that a named chat was not recorded. The view keeps
    /// the title, so direct the caller to inspect their chats without exposing transport detail.
    static func namedChatCreationFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the chat was created. Your title is still here. Review existing chats before creating another."
    }

    /// A failed detail read may include transport diagnostics and does not prove any cached chat
    /// content changed. Keep the existing selection and detail state intact while presenting a
    /// safe recovery path.
    static func chatDetailLoadFailureMessage(for _: Error) -> String {
        "This chat couldn’t be loaded. Nothing has been changed. Select it again or reload conversations."
    }

    public func selectChat(_ chatId: String) async {
        selectedChatId = chatId
        do {
            let (_, chatMessages) = try await client.getChat(chatId: chatId)
            let pendingChanges = try await client.listPendingChanges(chatId: chatId)
            messages = chatMessages
            pending = pendingChanges
            await refreshNoteForks(chatId: chatId, messages: chatMessages)
        } catch {
            errorMessage = Self.chatDetailLoadFailureMessage(for: error)
        }
    }

    /// Creates the first chat lazily from the user's prompt. Keeping this at the view-model
    /// boundary means both the native composer and any future native surfaces share the same
    /// no-empty-title invariant without adding a new RPC or a second chat-creation path.
    private func ensureChat(for message: String) async throws -> String {
        if let selectedChatId = selectedChatId {
            return selectedChatId
        }

        isCreatingChat = true
        defer { isCreatingChat = false }
        let chat = try await client.createChat(title: Self.chatTitleFromMessage(message))
        chats.insert(chat, at: 0)
        selectedChatId = chat.id
        messages = []
        pending = RPCPendingChanges()
        pendingNoteForks = []
        return chat.id
    }

    // MARK: - Note-body edits (chat-fork accept/revert) — adversarial-review fix

    /// Every `"tool"`-role message's content is `{toolUseId, entityIds, result, isError}` JSON
    /// (`agent-edit-service-live.ts`'s `executeToolCall` convention — same shape the web stage's
    /// `ChatPanel.tsx` decodes via `decodeToolLogEntry`). An `editNote` call is identified
    /// structurally rather than by tool name — this view model deliberately doesn't decode
    /// `toolCalls` (see this file's header comment) — by TWO facts that are jointly unique to it
    /// among today's tools: `entityIds` is empty (only `readNote`/`editNote` ever leave it empty —
    /// see `EditNoteToolOutput`'s own doc comment in agent-tools.ts for why `editNote` never
    /// populates `refs`), AND its JSON-stringified `result` (`EditNoteToolOutput`) carries a
    /// `nodeId` string field that `readNote`'s own output (`ReadNoteToolOutput`, `{text}` only)
    /// does not. `createNode`'s output also has a `nodeId` field, but always with a non-empty
    /// `entityIds` — so the combined check has no false positives against any tool this codebase
    /// implements today. (If a future tool is added whose output also carries a bare `nodeId` key
    /// with empty `entityIds`, this heuristic would need revisiting — flagged here rather than
    /// silently assumed permanent.)
    private static func editNoteCandidateNodeIds(from messages: [RPCChatMessage]) -> [String] {
        var ids: [String] = []
        var seen = Set<String>()
        for message in messages where message.role == "tool" {
            guard let logData = message.content.data(using: .utf8),
                  let log = try? JSONSerialization.jsonObject(with: logData) as? [String: Any],
                  let entityIds = log["entityIds"] as? [Any], entityIds.isEmpty,
                  let resultString = log["result"] as? String,
                  let resultData = resultString.data(using: .utf8),
                  let result = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any],
                  let nodeId = result["nodeId"] as? String
            else { continue }
            if seen.insert(nodeId).inserted { ids.append(nodeId) }
        }
        return ids
    }

    /// Re-checks every candidate node id from this chat's own log against the real, live
    /// `chatForkPreview` state, keeping only those still actually forked — a chat's history
    /// includes edits already accepted/reverted in earlier turns too, so candidates are never
    /// assumed still active. Called after every load/send/accept/revert that could change fork
    /// state, mirroring `selectChat`'s own refresh-after-mutate pattern.
    private func refreshNoteForks(chatId: String, messages: [RPCChatMessage]) async {
        let candidates = Self.editNoteCandidateNodeIds(from: messages)
        var previews: [RPCChatForkPreview] = []
        for nodeId in candidates {
            if let preview = try? await client.chatForkPreview(chatId: chatId, nodeId: nodeId), preview.forked {
                previews.append(preview)
            }
        }
        pendingNoteForks = previews
    }

    public func acceptNoteFork(nodeId: String) async {
        guard let chatId = selectedChatId else { return }
        noteForkBusyKey = "accept:\(nodeId)"
        errorMessage = nil
        defer { noteForkBusyKey = nil }
        do {
            _ = try await client.acceptChatFork(chatId: chatId, nodeId: nodeId)
            await selectChat(chatId)
        } catch {
            errorMessage = "Failed to accept note edit: \(error)"
        }
    }

    public func revertNoteFork(nodeId: String) async {
        guard let chatId = selectedChatId else { return }
        noteForkBusyKey = "revert:\(nodeId)"
        errorMessage = nil
        defer { noteForkBusyKey = nil }
        do {
            try await client.revertChatFork(chatId: chatId, nodeId: nodeId)
            await selectChat(chatId)
        } catch {
            errorMessage = "Failed to revert note edit: \(error)"
        }
    }

    // MARK: - Sending a message (minimal — see this file's header comment)

    public func sendMessage() async {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        isSending = true
        errorMessage = nil
        defer { isSending = false }

        let chatId: String
        do {
            chatId = try await ensureChat(for: text)
        } catch {
            errorMessage = Self.firstMessageChatCreationFailureMessage(for: error)
            return
        }

        do {
            _ = try await client.sendChatMessage(chatId: chatId, text: text)
            messageText = ""
            await selectChat(chatId)
        } catch {
            errorMessage = Self.describeSendError(error)
        }
    }

    /// A failed lazy chat creation leaves the first message unsent. Keep that draft visible and
    /// ask the caller to inspect their chats rather than exposing transport detail or implying retry safety.
    static func firstMessageChatCreationFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the chat was created. Your message is still here. Review existing chats before taking another action."
    }

    /// Mirrors the web stage's `ChatPanel.tsx` banner: `sendChatMessage` against the real
    /// (in this environment, unconfigured — no `ANTHROPIC_API_KEY`, per this task's hard
    /// constraint) `ModelClientAnthropic` fails with a typed `UnexpectedError` whose message
    /// contains `"ModelClient.converse failed: ModelUnavailable"` — a deliberate, documented
    /// stable-string contract (see `agent-edit-service-live.ts`), not a fragile accident to match
    /// against.
    static func describeSendError(_ error: Error) -> String {
        if case AthenaeumDomainError.unexpectedError(let message) = error,
           message.contains("ModelUnavailable")
        {
            return "The agent model isn't configured in this environment (no ANTHROPIC_API_KEY " +
                "secret) — this is expected, not a bug. See docs/agent-model-client.md."
        }
        return "We couldn’t confirm that your message was sent. Your draft is still here. " +
            "Review the chat before taking another action."
    }

    // MARK: - Accept / revert (the flow this stage is scoped to get right)

    public func accept() async {
        guard let chatId = selectedChatId else { return }
        isMutatingPending = true
        errorMessage = nil
        defer { isMutatingPending = false }
        do {
            _ = try await client.mergeChanges(chatId: chatId, mergeThrough: Self.acceptAllSentinel)
            await selectChat(chatId)
        } catch {
            errorMessage = Self.pendingChangesAcceptFailureMessage(for: error)
        }
    }

    static func pendingChangesAcceptFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the pending changes were accepted. Review this chat before taking another action."
    }

    public func revert() async {
        guard let chatId = selectedChatId else { return }
        isMutatingPending = true
        errorMessage = nil
        defer { isMutatingPending = false }
        do {
            _ = try await client.revertChanges(chatId: chatId, revertFrom: 0)
            await selectChat(chatId)
        } catch {
            errorMessage = Self.pendingChangesRevertFailureMessage(for: error)
        }
    }

    static func pendingChangesRevertFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the pending changes were reverted. Review this chat before taking another action."
    }
}
