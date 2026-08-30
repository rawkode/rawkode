import SwiftUI
import AthenaeumRPC

/// Selecting a chat performs several immutable reads before the existing model replaces the
/// visible messages and pending changes. Keep the short interaction claim in the view so a
/// second Picker activation cannot leave a later selection paired with an earlier response.
enum ChatDetailSelectionPresentation {
    static func canStartSelection(pendingChatId: String?) -> Bool {
        pendingChatId == nil
    }

    static func pendingChatId(afterCompleting chatId: String, pendingChatId: String?) -> String? {
        pendingChatId == chatId ? nil : pendingChatId
    }
}

/// Structured pending changes act on the whole selected chat. Claim the visible decision before
/// its Task starts so a rapid mixed Accept/Revert activation cannot issue two conflicting calls.
enum ChatPendingDecision: Equatable {
    case accept
    case revert
}

enum ChatPendingDecisionPresentation {
    static func canStartDecision(pendingDecision: ChatPendingDecision?) -> Bool {
        pendingDecision == nil
    }

    static func pendingDecision(
        afterCompleting decision: ChatPendingDecision,
        pendingDecision: ChatPendingDecision?
    ) -> ChatPendingDecision? {
        pendingDecision == decision ? nil : pendingDecision
    }
}

/// Catalog loading remains model-owned. This short view-local claim only closes the gap between a
/// Retry activation and the model's asynchronous `.loading` publication.
enum ChatListRetryPresentation {
    static func canStartRetry(isRetryInFlight: Bool) -> Bool {
        !isRetryInFlight
    }

    static func retryTitle(isRetryInFlight: Bool) -> String {
        isRetryInFlight ? "Retrying…" : "Retry"
    }
}

/// Named chat creation stays model-owned. This short view-local claim closes the interval before
/// the model publishes `isCreatingChat`, so a rapid second activation cannot schedule another
/// create request for the same visible form.
enum ChatNamedCreationPresentation {
    static func canStartCreation(isModelCreating: Bool, isCreationInFlight: Bool) -> Bool {
        !isModelCreating && !isCreationInFlight
    }

    static func isCreating(isModelCreating: Bool, isCreationInFlight: Bool) -> Bool {
        isModelCreating || isCreationInFlight
    }
}

/// The native composer uses the same model method for an active-chat send and a first-message
/// create-then-send. Claim either activation in the view before its Task starts so Return and the
/// Send button cannot schedule duplicate work before the model publishes its existing busy state.
enum ChatComposerSendPresentation {
    static func canStartSend(
        isModelSending: Bool,
        isModelCreating: Bool,
        isSendInFlight: Bool
    ) -> Bool {
        !isModelSending && !isModelCreating && !isSendInFlight
    }

    static func isBusy(
        isModelSending: Bool,
        isModelCreating: Bool,
        isSendInFlight: Bool
    ) -> Bool {
        isModelSending || isModelCreating || isSendInFlight
    }

    static func actionTitle(
        isModelSending: Bool,
        isModelCreating: Bool,
        isSendInFlight: Bool,
        hasSelectedChat: Bool
    ) -> String {
        guard isBusy(
            isModelSending: isModelSending,
            isModelCreating: isModelCreating,
            isSendInFlight: isSendInFlight
        ) else {
            return "Send"
        }

        if isModelCreating || (isSendInFlight && !hasSelectedChat) {
            return "Starting…"
        }
        return "Sending…"
    }
}

/// Native mirror of the web stage's `ChatPanel.tsx`, scoped per this stage's own instructions to
/// prioritize the accept/revert flow over a polished chat UI (see `AgentEditViewModel`'s header
/// comment for exactly what's scoped down). Three sections: chat picker/creation, a minimal
/// message log + compose box, and the pending-changes summary with real Accept/Revert buttons.
public struct PendingChangesView: View {
    @ObservedObject var model: AgentEditViewModel
    @State private var pendingChatSelectionId: String?
    @State private var pendingChatDecision: ChatPendingDecision?
    @State private var isChatListRetryInFlight = false
    @State private var isNamedChatCreationInFlight = false
    @State private var isComposerSendInFlight = false

    public init(model: AgentEditViewModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Agent chat").font(.headline)

            chatPicker

            if model.selectedChatId != nil {
                Divider()
                if pendingChatSelectionId != nil {
                    ProgressView("Loading conversation…")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(.updatesFrequently)
                } else {
                    messageLog
                    composeBox
                    if !model.pending.isEmpty {
                        Divider()
                        pendingSummary
                    }
                    if !model.pendingNoteForks.isEmpty {
                        Divider()
                        noteForkSummary
                    }
                }
            } else if AgentEditViewModel.isLoadedEmptyChatCatalog(
                chatsAreEmpty: model.chats.isEmpty,
                status: model.status
            ) {
                Divider()
                firstPrompt
            }

            if model.isModelUnavailable {
                agentUnavailableNotice
            }

            if let error = model.errorMessage {
                Text(error).foregroundStyle(.red).font(.caption)
            }
        }
        .task { await model.start() }
    }

    private var chatPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            if case .loading = model.status {
                ProgressView("Loading conversations…")
            }

            if case .error(let message) = model.status {
                VStack(alignment: .leading, spacing: 6) {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.red)
                    Button(
                        ChatListRetryPresentation.retryTitle(
                            isRetryInFlight: isChatListRetryInFlight
                        )
                    ) {
                        startChatListRetry()
                    }
                    .disabled(isChatListRetryInFlight)
                }
            }

            if AgentEditViewModel.isLoadedEmptyChatCatalog(
                chatsAreEmpty: model.chats.isEmpty,
                status: model.status
            ) {
                Text("No conversations yet — send a request below and Athenaeum will name the conversation for you.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else if !model.chats.isEmpty {
                Picker("Chat", selection: Binding(
                    get: { model.selectedChatId ?? model.chats.first?.id ?? "" },
                    set: { newId in selectChatDetail(newId) }
                )) {
                    ForEach(model.chats) { chat in
                        Text(chat.title).tag(chat.id)
                    }
                }
                .labelsHidden()
                .disabled(
                    model.isCreatingChat || !ChatDetailSelectionPresentation.canStartSelection(
                        pendingChatId: pendingChatSelectionId
                    )
                )
                .accessibilityHint("Loads the selected conversation before showing its messages and pending changes.")

                HStack {
                    TextField("Optional conversation title", text: $model.newChatTitle)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isCreatingNamedChat || pendingChatSelectionId != nil)
                    Button(isCreatingNamedChat ? "Creating…" : "New chat") {
                        startNamedChatCreation()
                    }
                    .disabled(
                        isCreatingNamedChat || pendingChatSelectionId != nil ||
                            model.newChatTitle.trimmingCharacters(in: .whitespaces).isEmpty
                    )
                }
            }
        }
    }

    private var isCreatingNamedChat: Bool {
        ChatNamedCreationPresentation.isCreating(
            isModelCreating: model.isCreatingChat,
            isCreationInFlight: isNamedChatCreationInFlight
        )
    }

    private func startNamedChatCreation() {
        guard ChatNamedCreationPresentation.canStartCreation(
            isModelCreating: model.isCreatingChat,
            isCreationInFlight: isNamedChatCreationInFlight
        ) else {
            return
        }

        isNamedChatCreationInFlight = true
        Task { @MainActor in
            defer { isNamedChatCreationInFlight = false }
            await model.createChat()
        }
    }

    private func startChatListRetry() {
        guard ChatListRetryPresentation.canStartRetry(
            isRetryInFlight: isChatListRetryInFlight
        ) else {
            return
        }

        isChatListRetryInFlight = true
        Task { @MainActor in
            defer { isChatListRetryInFlight = false }
            await model.reloadChats()
        }
    }

    private func selectChatDetail(_ chatId: String) {
        guard ChatDetailSelectionPresentation.canStartSelection(
            pendingChatId: pendingChatSelectionId
        ) else {
            return
        }

        pendingChatSelectionId = chatId
        Task { @MainActor in
            await model.selectChat(chatId)
            pendingChatSelectionId = ChatDetailSelectionPresentation.pendingChatId(
                afterCompleting: chatId,
                pendingChatId: pendingChatSelectionId
            )
        }
    }

    private var messageLog: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.messages.isEmpty {
                Text("No messages yet — say something below.")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(model.messages) { message in
                    HStack(alignment: .top, spacing: 6) {
                        Text(roleLabel(message.role)).bold().font(.caption)
                            .foregroundStyle(roleColor(message.role))
                            .frame(width: 64, alignment: .leading)
                        Text(message.content.isEmpty ? "(tool calls, no text)" : message.content)
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func roleLabel(_ role: String) -> String {
        switch role {
        case "user": return "You"
        case "assistant": return "Agent"
        case "tool": return "Tool"
        default: return role
        }
    }

    private func roleColor(_ role: String) -> Color {
        switch role {
        case "user": return .primary
        case "assistant": return .blue
        case "tool": return .secondary
        default: return .secondary
        }
    }

    private var composeBox: some View {
        HStack {
            TextField("Message the agent…", text: $model.messageText)
                .textFieldStyle(.roundedBorder)
                .disabled(isComposerSendBusy)
                .onSubmit(startComposerSend)
            Button(composerSendActionTitle) {
                startComposerSend()
            }
            .disabled(
                isComposerSendBusy ||
                    model.messageText.trimmingCharacters(in: .whitespaces).isEmpty
            )
        }
    }

    private var isComposerSendBusy: Bool {
        ChatComposerSendPresentation.isBusy(
            isModelSending: model.isSending,
            isModelCreating: model.isCreatingChat,
            isSendInFlight: isComposerSendInFlight
        )
    }

    private var composerSendActionTitle: String {
        ChatComposerSendPresentation.actionTitle(
            isModelSending: model.isSending,
            isModelCreating: model.isCreatingChat,
            isSendInFlight: isComposerSendInFlight,
            hasSelectedChat: model.selectedChatId != nil
        )
    }

    private func startComposerSend() {
        guard ChatComposerSendPresentation.canStartSend(
            isModelSending: model.isSending,
            isModelCreating: model.isCreatingChat,
            isSendInFlight: isComposerSendInFlight
        ) else {
            return
        }

        isComposerSendInFlight = true
        Task { @MainActor in
            defer { isComposerSendInFlight = false }
            await model.sendMessage()
        }
    }

    private var firstPrompt: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Start with a request")
                .font(.subheadline.bold())
            Text("Athenaeum will create a conversation from your first message.")
                .font(.callout)
                .foregroundStyle(.secondary)
            composeBox
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var agentUnavailableNotice: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Agent replies are unavailable for this workspace", systemImage: "sparkles")
                .font(.subheadline.bold())
            Text("Your message is saved. You can keep reviewing this conversation and try again later.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(.orange.opacity(0.35), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(AgentEditViewModel.modelUnavailableMessage)
    }

    private var pendingSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pending changes").font(.subheadline.bold())

            if model.pending.isEmpty {
                Text("Nothing pending for this chat.")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(model.pending.nodes, id: \.id) { node in
                    Label("New node: \(node.title)", systemImage: "circle.fill")
                        .font(.callout)
                }
                ForEach(model.pending.facts, id: \.id) { fact in
                    Label("New fact: \(fact.predicateId) on \(fact.nodeId)", systemImage: "tag.fill")
                        .font(.callout)
                }
                ForEach(model.pending.edges, id: \.id) { edge in
                    Label("New link: \(edge.sourceNodeId) → \(edge.targetNodeId)", systemImage: "arrow.right")
                        .font(.callout)
                }

                HStack {
                    let accepting = pendingChatDecision == .accept || (
                        pendingChatDecision == nil && model.isMutatingPending
                    )
                    let reverting = pendingChatDecision == .revert || (
                        pendingChatDecision == nil && model.isMutatingPending
                    )
                    let decisionsBusy = model.isMutatingPending || pendingChatDecision != nil

                    Button(accepting ? "Accepting…" : "Accept") {
                        startPendingDecision(.accept)
                    }
                    .disabled(decisionsBusy)
                    .buttonStyle(.borderedProminent)

                    Button(reverting ? "Reverting…" : "Revert") {
                        startPendingDecision(.revert)
                    }
                    .disabled(decisionsBusy)
                    .buttonStyle(.bordered)
                    .tint(.red)
                }
            }
        }
    }

    private func startPendingDecision(_ decision: ChatPendingDecision) {
        guard !model.isMutatingPending,
              ChatPendingDecisionPresentation.canStartDecision(
                  pendingDecision: pendingChatDecision
              )
        else {
            return
        }

        pendingChatDecision = decision
        Task { @MainActor in
            defer {
                pendingChatDecision = ChatPendingDecisionPresentation.pendingDecision(
                    afterCompleting: decision,
                    pendingDecision: pendingChatDecision
                )
            }
            switch decision {
            case .accept:
                await model.accept()
            case .revert:
                await model.revert()
            }
        }
    }

    /// Adversarial-review fix: note-body (`editNote`) pending edits — the Phase 3 Automerge-fork
    /// mechanism (`chat-fork-rpc.ts` / `docs/automerge-fork-spike.md`), deliberately a separate
    /// section from `pendingSummary` above (different accept/revert RPC methods, per-node instead
    /// of whole-chat — see `AgentEditViewModel.pendingNoteForks`'s own doc comment).
    private var noteForkSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pending note edits").font(.subheadline.bold())

            ForEach(model.pendingNoteForks) { fork in
                VStack(alignment: .leading, spacing: 4) {
                    Text("Note: \(fork.nodeId)").font(.caption).foregroundStyle(.secondary)
                    Text(fork.text)
                        .font(.callout)
                        .textSelection(.enabled)
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 6))

                    HStack {
                        let acceptBusy = model.noteForkBusyKey == "accept:\(fork.nodeId)"
                        let revertBusy = model.noteForkBusyKey == "revert:\(fork.nodeId)"
                        let anyBusy = model.noteForkBusyKey != nil

                        Button(acceptBusy ? "Accepting…" : "Accept") {
                            Task { await model.acceptNoteFork(nodeId: fork.nodeId) }
                        }
                        .disabled(anyBusy)
                        .buttonStyle(.borderedProminent)

                        Button(revertBusy ? "Reverting…" : "Revert") {
                            Task { await model.revertNoteFork(nodeId: fork.nodeId) }
                        }
                        .disabled(anyBusy)
                        .buttonStyle(.bordered)
                        .tint(.red)
                    }
                }
                .padding(.bottom, 4)
            }
        }
    }
}
