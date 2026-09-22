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
        VStack(alignment: .leading, spacing: 16) {
            if conversation.isEnding || (!conversation.message.isEmpty && conversation.message != "Talk through your day.") {
                Text(conversation.isEnding ? "Ending conversation…" : conversation.message)
                    .font(.callout).foregroundStyle(theme.secondary).accessibilityIdentifier("voiceStatus")
            }
            Picker("Input mode", selection: $typing) {
                Label("Speak", systemImage: "waveform").tag(false)
                Label("Type", systemImage: "keyboard").tag(true)
            }.pickerStyle(.segmented).disabled(changingMode || conversation.isSendingText || otherSurfaceActive)
                .accessibilityIdentifier("conversationInputMode")
            if conversation.captions.rows.isEmpty {
                if session.isConnected {
                    ContentUnavailableView("Ask about your day", systemImage: typing ? "text.bubble" : "waveform",
                        description: Text(typing ? "Send a message about your calendar, notes or graph." : "Start a conversation about your calendar, notes or graph."))
                        .frame(maxHeight: .infinity)
                } else {
                    VoiceAccountConnection(session: session).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                VoiceCaptionList(captions: conversation.captions, theme: theme)
            }
            if otherSurfaceActive {
                Text("A conversation is active on another device. End it there before continuing here.")
                    .font(.callout).foregroundStyle(theme.secondary)
            }
            if session.isConnected && !running && conversation.captions.rows.isEmpty {
                Text(typing ? "Messages and relevant graph context are sent to OpenAI when you send." : "Audio is sent to OpenAI only after you start.")
                    .font(.footnote).foregroundStyle(theme.secondary)
            }
            if typing { composer }
            if !typing && session.isConnected { Divider() }
            HStack {
                if running && !typing {
                    Button { conversation.toggleMute(surface: .mac) } label: {
                        Label(conversation.isMuted ? "Unmute" : "Mute", systemImage: conversation.isMuted ? "mic.slash" : "mic")
                    }.buttonStyle(.bordered).keyboardShortcut("m", modifiers: [.command, .shift])
                        .disabled(conversation.phase != .connected || conversation.isEnding).help("Mute or unmute microphone (⇧⌘M)")
                    Spacer()
                    Button("End conversation", role: .destructive) { Task { await conversation.stop(surface: .mac) } }
                        .buttonStyle(.borderedProminent).keyboardShortcut(".", modifiers: .command).disabled(conversation.isEnding)
                } else if session.isConnected && !typing {
                    Spacer()
                    Button { conversation.start(surface: .mac, preservingHistory: true) } label: { Label("Start conversation", systemImage: "waveform") }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(changingMode || conversation.isSendingText || !session.isConnected || conversation.surface != nil).accessibilityIdentifier("startVoiceConversation")
                }
            }.controlSize(.large)
            if !session.isConnected && !conversation.captions.rows.isEmpty { VoiceAccountConnection(session: session) }
        }
        .padding(20).frame(minWidth: 480, minHeight: 400)
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
        .onChange(of: session.accountID) { previous, current in
            if previous != nil && previous != current { draft = "" }
        }
        .onDisappear { Task { await conversation.stop(surface: .mac) } }
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom, spacing: 12) {
                TextField(session.isConnected ? "Message Enchiridion" : "Draft a message", text: $draft, axis: .vertical)
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
                }.buttonStyle(.borderedProminent).disabled(!canSend)
                    .accessibilityLabel("Send message").accessibilityIdentifier("sendAgentMessage")
                    .help("Send message (Return). Shift-Return adds a new line.")
            }.padding(10).background(.background, in: .rect(cornerRadius: 8))
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
