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
    /// Server-owned, human-readable review rows. Unlike `pending`, this is safe to render: its
    /// labels never interpolate opaque graph ids or fact values.
    @Published public private(set) var pendingReviewItems: [RPCChatReviewItem] = []
    @Published public private(set) var structuredReviewStatus: RPCChatReviewLaneStatus?
    @Published public private(set) var legacyReviewStatus: RPCChatReviewLaneStatus?
    @Published public private(set) var reviewStatus: LoadStatus = .idle
    /// Legacy note-body edits are projected by the server's explicit `legacy-fork` lane. The
    /// native surface keeps them separate from structured pending changes so an unavailable or
    /// capped fork cannot disable an otherwise safe structured decision.
    @Published public private(set) var pendingNoteForks: [RPCChatForkPreview] = []
    @Published public private(set) var noteForkBusyKey: String?
    @Published public var newChatTitle: String = ""
    @Published public var messageText: String = ""
    @Published public private(set) var isCreatingChat = false
    @Published public private(set) var isSending = false
    @Published public private(set) var isMutatingPending = false
    /// A model outage is an availability state, not a failed workspace mutation. Keep it
    /// separate from `errorMessage` so the native surface can use the same calm warning treatment
    /// as the web drawer without presenting deployment diagnostics as a user error.
    @Published public private(set) var isModelUnavailable = false
    @Published public private(set) var errorMessage: String?
    private var reviewGeneration = 0
    private var reviewWitness: String?

    /// A non-empty lane with omitted or unavailable rows must be visible even when no actionable
    /// fork preview survived projection; otherwise the UI would incorrectly claim there are no
    /// note edits waiting for review.
    public var hasLegacyReviewGap: Bool {
        guard let lane = legacyReviewStatus else { return false }
        return lane.total > lane.shown || lane.truncated || lane.unavailable > 0
    }

    static let modelUnavailableMessage =
        "Agent replies are unavailable for this workspace. Your message is saved. " +
        "You can keep reviewing this conversation and try again later."

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
                pendingReviewItems = []
                structuredReviewStatus = nil
                legacyReviewStatus = nil
                pendingNoteForks = []
                reviewStatus = .idle
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
        reviewGeneration += 1
        let generation = reviewGeneration
        selectedChatId = chatId
        reviewWitness = nil
        reviewStatus = .loading
        messages = []
        pending = RPCPendingChanges()
        pendingReviewItems = []
        structuredReviewStatus = nil
        legacyReviewStatus = nil
        pendingNoteForks = []
        do {
            let review = try await client.getChatReview(chatId: chatId)
            guard generation == reviewGeneration, selectedChatId == chatId, review.chat.id == chatId else { return }
            messages = review.messages
            pendingReviewItems = review.items.filter { $0.lane == "structured" }
            structuredReviewStatus = review.structuredForks
            legacyReviewStatus = review.legacyForks
            pendingNoteForks = review.items.compactMap { item in
                guard item.lane == "legacy-fork", let nodeId = item.nodeId, let lines = item.forkPreviewLines else { return nil }
                return RPCChatForkPreview(
                    nodeId: nodeId,
                    forked: true,
                    text: lines.joined(separator: "\n"),
                    label: item.label,
                    previewLines: lines,
                    previewTruncated: item.forkPreviewTruncated == true,
                    targetAvailable: item.targetAvailable,
                    actionable: item.actionable,
                    previewDigest: item.previewDigest
                )
            }
            reviewWitness = review.witness
            reviewStatus = .loaded
        } catch {
            guard generation == reviewGeneration, selectedChatId == chatId else { return }
            reviewStatus = .error(Self.chatDetailLoadFailureMessage(for: error))
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
        pendingReviewItems = []
        structuredReviewStatus = nil
        legacyReviewStatus = nil
        pendingNoteForks = []
        reviewStatus = .idle
        return chat.id
    }

    // MARK: - Note-body edits (chat-fork accept/revert) — adversarial-review fix

    // The server's getChatReview projection is the sole source of note-fork rows. This keeps
    // hidden, unavailable, and stale candidates in the same witnessed lane as the web client.

    public func acceptNoteFork(nodeId: String) async {
        guard let chatId = selectedChatId else { return }
        guard let fork = pendingNoteForks.first(where: { $0.nodeId == nodeId }),
              fork.forked,
              fork.targetAvailable,
              fork.actionable,
              !fork.previewTruncated,
              let digest = fork.previewDigest else { return }
        noteForkBusyKey = "accept:\(nodeId)"
        errorMessage = nil
        defer { noteForkBusyKey = nil }
        do {
            _ = try await client.acceptChatFork(
                chatId: chatId,
                nodeId: nodeId,
                expectedPreviewDigest: digest
            )
            await selectChat(chatId)
        } catch {
            errorMessage = "We couldn’t confirm that this note edit was accepted. Review it before taking another action."
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
            errorMessage = "We couldn’t confirm that this note edit was reverted. Review it before taking another action."
        }
    }

    // MARK: - Sending a message (minimal — see this file's header comment)

    public func sendMessage() async {
        let text = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        isSending = true
        errorMessage = nil
        isModelUnavailable = false
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
            isModelUnavailable = false
            await selectChat(chatId)
        } catch {
            if Self.isModelUnavailableError(error) {
                isModelUnavailable = true
                errorMessage = nil
            } else {
                errorMessage = Self.describeSendError(error)
            }
        }
    }

    /// A failed lazy chat creation leaves the first message unsent. Keep that draft visible and
    /// ask the caller to inspect their chats rather than exposing transport detail or implying retry safety.
    static func firstMessageChatCreationFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the chat was created. Your message is still here. Review existing chats before taking another action."
    }

    /// Identifies the model availability failure without exposing the provider diagnostic to the
    /// user. The exact backend error remains useful in logs, but the native UI receives only the
    /// stable availability state below.
    static func isModelUnavailableError(_ error: Error) -> Bool {
        guard case AthenaeumDomainError.unexpectedError(let message) = error else { return false }
        return message.contains("ModelClient.converse failed: ModelUnavailable")
    }

    static func describeSendError(_ error: Error) -> String {
        if Self.isModelUnavailableError(error) {
            return Self.modelUnavailableMessage
        }
        return "We couldn’t confirm that your message was sent. Your draft is still here. " +
            "Review the chat before taking another action."
    }

    // MARK: - Accept / revert (the flow this stage is scoped to get right)

    public func accept() async {
        guard let chatId = selectedChatId, reviewStatus == .loaded,
              !pendingReviewItems.isEmpty, let witness = reviewWitness,
              pendingReviewItems.allSatisfy({ $0.stamped && $0.targetAvailable && $0.actionable }) else { return }
        let sequenceBoundary = pendingReviewItems.map(\.sequence).max()!
        isMutatingPending = true
        errorMessage = nil
        defer { isMutatingPending = false }
        do {
            try await client.decideChatReview(chatId: chatId, operation: "accept", sequenceBoundary: sequenceBoundary, expectedWitness: witness, requestId: UUID().uuidString, message: "Accepted reviewed agent changes.", provenance: "chat-review-native")
            await selectChat(chatId)
        } catch {
            errorMessage = Self.pendingChangesAcceptFailureMessage(for: error)
        }
    }

    static func pendingChangesAcceptFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the pending changes were accepted. Review this chat before taking another action."
    }

    public func revert() async {
        guard let chatId = selectedChatId, reviewStatus == .loaded, let witness = reviewWitness,
              !pendingReviewItems.isEmpty, pendingReviewItems.allSatisfy({ $0.stamped && $0.targetAvailable && $0.actionable }) else { return }
        let sequenceBoundary = pendingReviewItems.map(\.sequence).min()!
        isMutatingPending = true
        errorMessage = nil
        defer { isMutatingPending = false }
        do {
            try await client.decideChatReview(chatId: chatId, operation: "revert", sequenceBoundary: sequenceBoundary, expectedWitness: witness, requestId: UUID().uuidString, message: "Reverted reviewed agent changes.", provenance: "chat-review-native")
            await selectChat(chatId)
        } catch {
            errorMessage = Self.pendingChangesRevertFailureMessage(for: error)
        }
    }

    static func pendingChangesRevertFailureMessage(for _: Error) -> String {
        "We couldn’t confirm that the pending changes were reverted. Review this chat before taking another action."
    }
}
