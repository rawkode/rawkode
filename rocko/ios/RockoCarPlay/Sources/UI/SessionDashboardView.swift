import SwiftUI
import UIKit

private enum RockoPalette {
  static let appBlue = Color(red: 0.0, green: 0.48, blue: 1.0)
  static let inboxBackground = Color(uiColor: .systemGroupedBackground)
  static let threadBackground = Color(uiColor: .systemBackground)
  static let incomingBubble = Color(uiColor: .systemGray5)
  static let outgoingBubble = appBlue
  static let separator = Color(uiColor: .separator)
  static let secondaryText = Color(uiColor: .secondaryLabel)
  static let tertiaryText = Color(uiColor: .tertiaryLabel)
}

struct SessionDashboardView: View {
  @ObservedObject var store: LiveSessionStore
  @State private var searchText = ""

  var body: some View {
    NavigationSplitView {
      MessagesSidebarView(
        store: store,
        searchText: $searchText,
        selectedAgentID: selectedAgentBinding
      )
    } detail: {
      if let selectedAgentID = store.selectedTextAgentID {
        MessageThreadView(store: store, agentID: selectedAgentID)
      } else {
        InboxEmptyStateView(
          title: "No conversation selected",
          message: "Choose an agent from the inbox to start chatting."
        )
      }
    }
    .tint(RockoPalette.appBlue)
    .task {
      await store.loadTextAgentsIfNeeded()
    }
  }

  private var selectedAgentBinding: Binding<String?> {
    Binding(
      get: { store.selectedTextAgentID },
      set: { newValue in
        guard let newValue else { return }
        store.selectTextAgent(newValue)
      }
    )
  }
}

private struct MessagesSidebarView: View {
  @ObservedObject var store: LiveSessionStore
  @Binding var searchText: String
  @Binding var selectedAgentID: String?

  var body: some View {
    List(selection: $selectedAgentID) {
      if let errorMessage = store.errorMessage {
        Section {
          ErrorListRow(message: errorMessage)
            .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20))
            .listRowBackground(Color.clear)
        }
      }

      ForEach(filteredThreads) { thread in
        MessageThreadRow(thread: thread, isSelected: selectedAgentID == thread.id)
          .tag(thread.id)
          .listRowInsets(EdgeInsets(top: 10, leading: 18, bottom: 10, trailing: 18))
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(RockoPalette.inboxBackground)
    .navigationTitle("Messages")
    .searchable(text: $searchText, placement: .sidebar, prompt: "Search")
    .overlay {
      if filteredThreads.isEmpty {
        InboxEmptyStateView(
          title: store.availableTextAgents.isEmpty ? "No agents available" : "No matches",
          message: store.availableTextAgents.isEmpty
            ? "Check `ROCKO_API_URL` if the Mastra HTTP API runs on a different origin."
            : "Try a different search term."
        )
      }
    }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          Task {
            await store.refreshTextAgents()
          }
        } label: {
          if store.isLoadingTextAgents {
            ProgressView()
          } else {
            Image(systemName: "arrow.clockwise")
          }
        }
        .accessibilityLabel("Refresh agents")
      }
    }
  }

  private var filteredThreads: [TextConversationThread] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return store.textConversationThreads }

    return store.textConversationThreads.filter { thread in
      let haystack = [
        thread.agent.name,
        thread.agent.id,
        thread.agent.description ?? "",
        thread.previewText,
      ]
      .joined(separator: " ")
      .localizedCaseInsensitiveContains(query)

      return haystack
    }
  }
}

private struct MessageThreadRow: View {
  let thread: TextConversationThread
  let isSelected: Bool

  var body: some View {
    HStack(spacing: 14) {
      AgentAvatar(agentID: thread.agent.id, label: thread.agent.name, size: 54)

      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(thread.agent.name)
            .font(.system(.body, design: .rounded).weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)

          Spacer(minLength: 8)

          if let lastActivityAt = thread.lastActivityAt {
            Text(timestampText(for: lastActivityAt))
              .font(.caption.weight(.medium))
              .foregroundStyle(RockoPalette.secondaryText)
          }
        }

        HStack(spacing: 8) {
          Text(thread.previewText)
            .font(.subheadline)
            .foregroundStyle(RockoPalette.secondaryText)
            .lineLimit(2)
            .multilineTextAlignment(.leading)

          Spacer(minLength: 6)

          if thread.isAwaitingResponse {
            ProgressView()
              .controlSize(.small)
              .tint(RockoPalette.appBlue)
          }
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .fill(isSelected ? Color.white : Color.clear)
        .overlay(
          RoundedRectangle(cornerRadius: 20, style: .continuous)
            .stroke(isSelected ? RockoPalette.separator.opacity(0.18) : Color.clear, lineWidth: 1)
        )
    )
  }

  private func timestampText(for date: Date) -> String {
    let calendar = Calendar.current

    if calendar.isDateInToday(date) {
      return date.formatted(date: .omitted, time: .shortened)
    }

    if calendar.isDateInYesterday(date) {
      return "Yesterday"
    }

    return date.formatted(.dateTime.month(.abbreviated).day())
  }
}

private struct MessageThreadView: View {
  @ObservedObject var store: LiveSessionStore
  let agentID: String
  @State private var draftMessage = ""

  var body: some View {
    Group {
      if let thread = store.textThread(agentID: agentID) {
        ScrollViewReader { proxy in
          ZStack(alignment: .bottom) {
            RockoPalette.threadBackground
              .ignoresSafeArea()

            ScrollView {
              LazyVStack(spacing: 14) {
                ThreadHeroCard(thread: thread)
                  .padding(.top, 18)

                if thread.messages.isEmpty {
                  EmptyConversationView(thread: thread)
                } else {
                  ConversationDatePill(date: thread.messages.first?.createdAt ?? .now)

                  ForEach(thread.messages) { message in
                    IMessageBubble(message: message)
                  }
                }

                if thread.isAwaitingResponse {
                  TypingBubble()
                }

                Color.clear
                  .frame(height: 1)
                  .id(bottomAnchorID)
              }
              .padding(.horizontal, 14)
              .padding(.bottom, 96)
            }
            .onAppear {
              scrollToBottom(using: proxy)
            }
            .onChange(of: thread.messages.last?.id) {
              scrollToBottom(using: proxy)
            }
            .onChange(of: thread.isAwaitingResponse) {
              scrollToBottom(using: proxy)
            }
          }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .principal) {
            ThreadNavigationTitle(thread: thread)
          }
        }
        .safeAreaInset(edge: .bottom) {
          MessageComposer(
            title: thread.agent.name,
            draftMessage: $draftMessage,
            isSending: store.isSendingText(to: thread.id),
            onSend: { sendDraftMessage(to: thread.id) }
          )
        }
      } else {
        InboxEmptyStateView(
          title: "Conversation unavailable",
          message: "Refresh the agent list and try again."
        )
      }
    }
  }

  private let bottomAnchorID = "thread-bottom-anchor"

  private func sendDraftMessage(to agentID: String) {
    let message = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty else { return }

    draftMessage = ""

    Task {
      let didSend = await store.sendTextMessage(message, to: agentID)
      if !didSend {
        await MainActor.run {
          draftMessage = message
        }
      }
    }
  }

  private func scrollToBottom(using proxy: ScrollViewProxy) {
    withAnimation(.easeOut(duration: 0.2)) {
      proxy.scrollTo(bottomAnchorID, anchor: .bottom)
    }
  }
}

private struct ThreadHeroCard: View {
  let thread: TextConversationThread

  var body: some View {
    HStack(spacing: 16) {
      AgentAvatar(agentID: thread.agent.id, label: thread.agent.name, size: 62)

      VStack(alignment: .leading, spacing: 5) {
        Text(thread.agent.name)
          .font(.system(.title3, design: .rounded).weight(.semibold))

        Text(thread.agent.description ?? "Mastra agent")
          .font(.subheadline)
          .foregroundStyle(RockoPalette.secondaryText)
          .lineLimit(2)

        Text("Powered by the Mastra API")
          .font(.caption.weight(.semibold))
          .foregroundStyle(RockoPalette.tertiaryText)
      }

      Spacer()
    }
    .padding(18)
    .background(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(Color(uiColor: .secondarySystemBackground))
    )
  }
}

private struct ThreadNavigationTitle: View {
  let thread: TextConversationThread

  var body: some View {
    HStack(spacing: 10) {
      AgentAvatar(agentID: thread.agent.id, label: thread.agent.name, size: 32)

      VStack(spacing: 1) {
        Text(thread.agent.name)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)

        Text(thread.isAwaitingResponse ? "Replying…" : "Mastra agent")
          .font(.caption2.weight(.medium))
          .foregroundStyle(RockoPalette.secondaryText)
      }
    }
  }
}

private struct EmptyConversationView: View {
  let thread: TextConversationThread

  var body: some View {
    VStack(spacing: 16) {
      Spacer(minLength: 32)

      AgentAvatar(agentID: thread.agent.id, label: thread.agent.name, size: 86)

      VStack(spacing: 6) {
        Text(thread.agent.name)
          .font(.system(.title2, design: .rounded).weight(.semibold))

        Text(thread.agent.description ?? "Start the first conversation with this Mastra agent.")
          .font(.body)
          .foregroundStyle(RockoPalette.secondaryText)
          .multilineTextAlignment(.center)
      }

      Spacer(minLength: 16)
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 36)
  }
}

private struct IMessageBubble: View {
  let message: ConversationMessage

  var body: some View {
    HStack(alignment: .bottom, spacing: 10) {
      if message.role == .assistant {
        bubble(background: RockoPalette.incomingBubble, foreground: .primary)

        Spacer(minLength: 56)
      } else {
        Spacer(minLength: 56)

        bubble(background: RockoPalette.outgoingBubble, foreground: .white)
      }
    }
  }

  private func bubble(background: Color, foreground: Color) -> some View {
    Text(message.text)
      .font(.body)
      .foregroundStyle(foreground)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(background)
      )
      .frame(maxWidth: 320, alignment: message.role == .assistant ? .leading : .trailing)
  }
}

private struct TypingBubble: View {
  @State private var phase = 0

  var body: some View {
    HStack {
      HStack(spacing: 7) {
        ForEach(0 ..< 3, id: \.self) { index in
          Circle()
            .fill(RockoPalette.secondaryText.opacity(index == phase ? 0.95 : 0.28))
            .frame(width: 8, height: 8)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .background(
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(RockoPalette.incomingBubble)
      )

      Spacer(minLength: 56)
    }
    .task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(280))
        phase = (phase + 1) % 3
      }
    }
  }
}

private struct ConversationDatePill: View {
  let date: Date

  var body: some View {
    Text(label)
      .font(.caption.weight(.semibold))
      .foregroundStyle(RockoPalette.secondaryText)
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(
        Capsule()
          .fill(Color(uiColor: .secondarySystemBackground))
      )
      .padding(.vertical, 6)
  }

  private var label: String {
    let calendar = Calendar.current

    if calendar.isDateInToday(date) {
      return "Today"
    }

    if calendar.isDateInYesterday(date) {
      return "Yesterday"
    }

    return date.formatted(.dateTime.month(.wide).day().year())
  }
}

private struct MessageComposer: View {
  let title: String
  @Binding var draftMessage: String
  let isSending: Bool
  let onSend: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      Divider()

      HStack(alignment: .bottom, spacing: 12) {
        TextField("iMessage \(title)", text: $draftMessage, axis: .vertical)
          .lineLimit(1 ... 5)
          .font(.body)
          .padding(.horizontal, 16)
          .padding(.vertical, 12)
          .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
              .fill(Color(uiColor: .secondarySystemBackground))
          )

        Button(action: onSend) {
          ZStack {
            Circle()
              .fill(canSend ? RockoPalette.appBlue : RockoPalette.tertiaryText.opacity(0.24))
              .frame(width: 38, height: 38)

            if isSending {
              ProgressView()
                .controlSize(.small)
                .tint(.white)
            } else {
              Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.white)
            }
          }
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
      }
      .padding(.horizontal, 14)
      .padding(.top, 10)
      .padding(.bottom, 12)
      .background(.ultraThinMaterial)
    }
  }

  private var canSend: Bool {
    !draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
  }
}

private struct AgentAvatar: View {
  let agentID: String
  let label: String
  let size: CGFloat

  private static let gradients: [[Color]] = [
    [Color(red: 0.25, green: 0.51, blue: 0.96), Color(red: 0.35, green: 0.78, blue: 0.98)],
    [Color(red: 0.98, green: 0.48, blue: 0.38), Color(red: 0.98, green: 0.67, blue: 0.35)],
    [Color(red: 0.37, green: 0.69, blue: 0.42), Color(red: 0.63, green: 0.86, blue: 0.47)],
    [Color(red: 0.57, green: 0.39, blue: 0.94), Color(red: 0.83, green: 0.51, blue: 0.96)],
    [Color(red: 0.12, green: 0.64, blue: 0.67), Color(red: 0.34, green: 0.83, blue: 0.74)],
  ]

  var body: some View {
    ZStack {
      Circle()
        .fill(
          LinearGradient(
            colors: gradientColors,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )

      Text(initials)
        .font(.system(size: size * 0.34, weight: .semibold, design: .rounded))
        .foregroundStyle(.white)
    }
    .frame(width: size, height: size)
  }

  private var gradientColors: [Color] {
    let index = Int(agentID.hashValue.magnitude % UInt(Self.gradients.count))
    return Self.gradients[index]
  }

  private var initials: String {
    let words = label
      .split(separator: " ")
      .prefix(2)
      .map { String($0.prefix(1)).uppercased() }

    let joined = words.joined()
    return joined.isEmpty ? "R" : joined
  }
}

private struct ErrorListRow: View {
  let message: String

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(Color.red)

      Text(message)
        .font(.footnote)
        .foregroundStyle(.primary)
        .multilineTextAlignment(.leading)
    }
    .padding(14)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(Color.red.opacity(0.08))
    )
  }
}

private struct InboxEmptyStateView: View {
  let title: String
  let message: String

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: "bubble.left.and.bubble.right.fill")
        .font(.system(size: 34))
        .foregroundStyle(RockoPalette.secondaryText)

      Text(title)
        .font(.headline)

      Text(message)
        .font(.subheadline)
        .foregroundStyle(RockoPalette.secondaryText)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 24)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(RockoPalette.inboxBackground)
  }
}

struct SessionDashboardView_Previews: PreviewProvider {
  static var previews: some View {
    SessionDashboardView(store: .shared)
  }
}
