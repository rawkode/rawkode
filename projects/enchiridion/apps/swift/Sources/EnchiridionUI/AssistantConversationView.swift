// AssistantConversationView.swift
// EnchiridionUI
//
// Task #68 ("Assistant provider integration + conversation UI"). A
// deliberately minimal SwiftUI surface — the task brief: "Keep this UI
// genuinely minimal — this is not a design task, it exists to prove the
// wiring works end-to-end, not to be polished." No voice, no CarPlay, no
// Siri/App Intents (explicitly P6 per the plan's Assistant (P5) section).
//
// Message list + input field, enough to exercise:
//   - ask a question -> tool call -> grounded answer + cited sources
//     rendered (`AssistantConversationMessage.sources`);
//   - propose a write -> pending-confirmation UI shown -> explicit user
//     tap required before `AssistantConversationController.confirmProposal(_:)`
//     is ever called (which is itself the only path to
//     `AssistantTaskMutationApplier.apply`/`confirmApproval` — see that
//     type's header). This view NEVER calls `confirmProposal(_:)` except
//     from a button's own action closure, and never on appear/automatically.

import EnchiridionCore
import SwiftUI

public struct AssistantConversationView: View {
  @Bindable private var controller: AssistantConversationController
  @State private var draft: String = ""

  public init(controller: AssistantConversationController) {
    self.controller = controller
  }

  public var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(controller.messages) { message in
              AssistantMessageRow(message: message)
                .id(message.id)
            }
            ForEach(controller.pendingProposals, id: \.callID) { proposal in
              AssistantPendingProposalRow(
                proposal: proposal,
                onConfirm: { Task { await controller.confirmProposal(proposal) } },
                onReject: { Task { await controller.rejectProposal(proposal) } }
              )
            }
          }
          .padding()
        }
        .onChange(of: controller.messages.count) {
          guard let last = controller.messages.last else { return }
          withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
        }
      }

      if let lastError = controller.lastError {
        Text(lastError)
          .font(.footnote)
          .foregroundStyle(.red)
          .padding(.horizontal)
      }

      Divider()

      HStack(alignment: .bottom, spacing: 8) {
        TextField("Ask Enchiridion…", text: $draft, axis: .vertical)
          .textFieldStyle(.roundedBorder)
          .lineLimit(1...4)
          .disabled(controller.isSending)
          .onSubmit(send)

        Button(action: send) {
          if controller.isSending {
            ProgressView()
          } else {
            Image(systemName: "arrow.up.circle.fill")
              .font(.title2)
          }
        }
        .disabled(controller.isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      .padding()
    }
  }

  private func send() {
    let utterance = draft
    guard !utterance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    draft = ""
    Task { await controller.send(utterance) }
  }
}

private struct AssistantMessageRow: View {
  let message: AssistantConversationMessage

  var body: some View {
    VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
      Text(message.text)
        .padding(10)
        .background(message.role == .user ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12))
      if !message.sources.isEmpty {
        AssistantSourcesRow(sources: message.sources)
      }
      if let status = message.status, status != .answered {
        Text(statusLabel(status))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
  }

  private func statusLabel(_ status: AssistantResponseStatus) -> String {
    switch status {
    case .answered: ""
    case .noResults: "No local match found"
    case .ambiguous: "This may refer to more than one thing"
    case .stale: "This information may be out of date"
    case .conflicting: "This information has unresolved conflicts"
    case .unavailable: "The assistant is unavailable"
    case .ungrounded: "Unverified"
    }
  }
}

private struct AssistantSourcesRow: View {
  let sources: [AssistantSource]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(sources) { source in
          Text(source.title)
            .font(.caption)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.secondary.opacity(0.15))
            .clipShape(Capsule())
        }
      }
    }
  }
}

private struct AssistantPendingProposalRow: View {
  let proposal: AssistantPendingWriteSummary
  let onConfirm: () -> Void
  let onReject: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(proposal.summary, systemImage: "pencil.and.outline")
        .font(.subheadline)
      HStack {
        Button("Confirm", role: .none, action: onConfirm)
          .buttonStyle(.borderedProminent)
        Button("Dismiss", role: .cancel, action: onReject)
          .buttonStyle(.bordered)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.orange.opacity(0.12))
    .clipShape(RoundedRectangle(cornerRadius: 12))
  }
}
