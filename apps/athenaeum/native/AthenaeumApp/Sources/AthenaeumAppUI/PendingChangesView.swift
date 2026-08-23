import SwiftUI
import AthenaeumRPC

/// Native mirror of the web stage's `ChatPanel.tsx`, scoped per this stage's own instructions to
/// prioritize the accept/revert flow over a polished chat UI (see `AgentEditViewModel`'s header
/// comment for exactly what's scoped down). Three sections: chat picker/creation, a minimal
/// message log + compose box, and the pending-changes summary with real Accept/Revert buttons.
public struct PendingChangesView: View {
    @ObservedObject var model: AgentEditViewModel

    public init(model: AgentEditViewModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Agent chat").font(.headline)

            chatPicker

            if model.selectedChatId != nil {
                Divider()
                messageLog
                composeBox
                Divider()
                pendingSummary
                if !model.pendingNoteForks.isEmpty {
                    Divider()
                    noteForkSummary
                }
            }

            if let error = model.errorMessage {
                Text(error).foregroundStyle(.red).font(.caption)
            }
        }
        .task { await model.start() }
    }

    private var chatPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.chats.isEmpty {
                Text("No chats yet.").font(.callout).foregroundStyle(.secondary)
            } else {
                Picker("Chat", selection: Binding(
                    get: { model.selectedChatId ?? model.chats.first?.id ?? "" },
                    set: { newId in Task { await model.selectChat(newId) } }
                )) {
                    ForEach(model.chats) { chat in
                        Text(chat.title).tag(chat.id)
                    }
                }
                .labelsHidden()
            }

            HStack {
                TextField("New chat title", text: $model.newChatTitle)
                    .textFieldStyle(.roundedBorder)
                    .disabled(model.isCreatingChat)
                Button(model.isCreatingChat ? "Creating…" : "New chat") {
                    Task { await model.createChat() }
                }
                .disabled(model.isCreatingChat || model.newChatTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            }
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
                .disabled(model.isSending)
                .onSubmit { Task { await model.sendMessage() } }
            Button(model.isSending ? "Sending…" : "Send") {
                Task { await model.sendMessage() }
            }
            .disabled(model.isSending || model.messageText.trimmingCharacters(in: .whitespaces).isEmpty)
        }
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
                    Button(model.isMutatingPending ? "Accepting…" : "Accept") {
                        Task { await model.accept() }
                    }
                    .disabled(model.isMutatingPending)
                    .buttonStyle(.borderedProminent)

                    Button(model.isMutatingPending ? "Reverting…" : "Revert") {
                        Task { await model.revert() }
                    }
                    .disabled(model.isMutatingPending)
                    .buttonStyle(.bordered)
                    .tint(.red)
                }
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
