#if os(macOS)
import SwiftUI

/// A separate workspace companion: captions remain readable while other app windows are in use.
struct MacVoiceConversationView: View {
    @ObservedObject var session: NativeSession
    @ObservedObject var conversation: VoiceConversation
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    @State private var typing = false
    @State private var draft = ""
    @State private var changingMode = false
    @FocusState private var composerFocused: Bool

    private var otherSurfaceActive: Bool { conversation.surface != nil && conversation.surface != .mac }
    private var canSend: Bool {
        !changingMode && !conversation.isSendingText && conversation.surface == nil && session.isConnected &&
            !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.utf16.count <= 4_000
    }
    private var running: Bool { conversation.surface == .mac && (conversation.phase == .connecting || conversation.phase == .connected) }
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .top, spacing: 16) {
                Image(systemName: typing ? "text.bubble" : (conversation.isMuted ? "mic.slash" : "waveform"))
                    .font(.system(size: 30, weight: .light)).foregroundStyle(theme.accent)
                    .frame(width: 64, height: 64).glassEffect(.regular, in: .circle)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(typing ? "Work it through." : "Talk it through.").font(.title.weight(.semibold))
                    Text(conversation.message).font(.body).foregroundStyle(theme.secondary)
                        .accessibilityIdentifier("voiceStatus")
                }
            }
            Picker("Input mode", selection: $typing) {
                Label("Speak", systemImage: "waveform").tag(false)
                Label("Type", systemImage: "keyboard").tag(true)
            }.pickerStyle(.segmented).disabled(changingMode || conversation.isSendingText || otherSurfaceActive)
                .accessibilityIdentifier("conversationInputMode")
            if conversation.captions.rows.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Room for a thought.").font(.title2)
                    Text(typing ? "Ask about your day, or make a change in your graph. Your messages and spoken conversation share the same history." : "Speak naturally while you work. Your conversation stays in this window, and you can mute or end it at any time.")
                        .foregroundStyle(theme.secondary)
                    Text(typing ? "Messages and relevant graph context are sent to OpenAI when you send." : "Audio is sent to OpenAI only after you start a conversation.")
                        .font(.footnote).foregroundStyle(theme.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                VoiceCaptionList(captions: conversation.captions, theme: theme)
            }
            if otherSurfaceActive {
                Text("A conversation is active on another device. End it there before continuing here.")
                    .font(.callout).foregroundStyle(theme.secondary)
            }
            if typing { composer }
            Divider()
            HStack {
                if running && !typing {
                    Button { conversation.toggleMute(surface: .mac) } label: {
                        Label(conversation.isMuted ? "Unmute" : "Mute", systemImage: conversation.isMuted ? "mic.slash" : "mic")
                    }.buttonStyle(.glass).keyboardShortcut("m", modifiers: [.command, .shift])
                        .disabled(conversation.phase != .connected).help("Mute or unmute microphone (⇧⌘M)")
                    Spacer()
                    Button("End conversation", role: .destructive) { Task { await conversation.stop(surface: .mac) } }
                        .buttonStyle(.glassProminent).keyboardShortcut(".", modifiers: .command)
                } else if session.isConnected && !typing {
                    Spacer()
                    Button { conversation.start(surface: .mac, preservingHistory: true) } label: { Label("Start conversation", systemImage: "waveform") }
                        .buttonStyle(.glassProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(changingMode || conversation.isSendingText || !session.isConnected || conversation.surface != nil).accessibilityIdentifier("startVoiceConversation")
                }
            }.controlSize(.large)
            if !session.isConnected { VoiceAccountConnection(session: session) }
        }
        .padding(28).frame(minWidth: 480, minHeight: 400)
        .background(theme.canvas).foregroundStyle(theme.ink)
        .background { VoiceWindowCloseObserver { conversation.stopForWindowClose() }.frame(width: 0, height: 0) }
        .onChange(of: typing) { _, enabled in
            changingMode = true
            Task {
                if enabled { await conversation.stop(surface: .mac) }
                composerFocused = enabled
                changingMode = false
            }
        }
        .onChange(of: session.accountID) { _, _ in draft = "" }
        .onDisappear { Task { await conversation.stop(surface: .mac) } }
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom, spacing: 12) {
                TextField("Message Enchiridion", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...6).focused($composerFocused)
                    .disabled(changingMode || otherSurfaceActive)
                    .accessibilityIdentifier("agentMessageInput")
                    .onKeyPress(.return, phases: .down) { key in
                        if key.modifiers.contains(.shift) { return .ignored }
                        sendMessage()
                        return .handled
                    }
                Button(action: sendMessage) {
                    if conversation.isSendingText { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.up").frame(width: 28, height: 28) }
                }.buttonStyle(.glassProminent).disabled(!canSend)
                    .accessibilityLabel("Send message").accessibilityIdentifier("sendAgentMessage")
                    .help("Send message (Return). Shift-Return adds a new line.")
            }.padding(14).glassEffect(.regular, in: .rect(cornerRadius: 20))
            Text(draft.utf16.count > 4_000 ? "Keep your message under 4,000 characters." : "Return to send · Shift-Return for a new line")
                .font(.caption).foregroundStyle(theme.secondary)
        }
    }

    private func sendMessage() {
        guard typing, canSend else { return }
        let message = draft
        Task { if await conversation.sendText(message), draft == message { draft = "" } }
    }
}
#endif
