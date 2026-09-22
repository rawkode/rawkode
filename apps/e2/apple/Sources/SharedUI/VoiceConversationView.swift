#if os(iOS)
import ApsidesCore
import SwiftUI

struct VoiceConversationView: View {
    @ObservedObject var session: NativeSession
    @ObservedObject var conversation: VoiceConversation
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn
    @State private var typing = false
    @State private var draft = ""
    @State private var changingMode = false
    @FocusState private var composerFocused: Bool

    private var otherSurfaceActive: Bool { conversation.surface != nil && conversation.surface != .iphone }
    private var running: Bool { conversation.surface == .iphone && (conversation.phase == .connecting || conversation.phase == .connected) }
    private var canSend: Bool {
        !changingMode && !conversation.isSendingText && conversation.surface == nil && session.isConnected &&
            !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.utf16.count <= 4_000
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Picker("Input mode", selection: $typing) {
                    Label("Speak", systemImage: "waveform").tag(false)
                    Label("Type", systemImage: "keyboard").tag(true)
                }.pickerStyle(.segmented)
                    .disabled(changingMode || conversation.isSendingText || otherSurfaceActive)
                    .accessibilityIdentifier("conversationInputMode")
                if !conversation.captions.rows.isEmpty {
                    VoiceCaptionList(captions: conversation.captions, theme: theme)
                } else {
                    ScrollView {
                        VStack(spacing: 20) {
                            if session.isConnected {
                                ContentUnavailableView("Ask about your day", systemImage: typing ? "text.bubble" : "waveform",
                                    description: Text(typing ? "Send a message about your calendar, notes or graph." : "Start a conversation about your calendar, notes or graph."))
                            } else {
                                VoiceAccountConnection(session: session).padding(.vertical, 24)
                            }
                        }
                    }.frame(maxHeight: .infinity)
                }
                if otherSurfaceActive {
                    Text("A conversation is active in CarPlay. End it there before continuing here.")
                        .font(.callout).foregroundStyle(theme.secondary).accessibilityIdentifier("voiceOtherSurface")
                } else if conversation.isEnding || (!conversation.message.isEmpty && conversation.message != "Talk through your day.") {
                    Text(conversation.isEnding ? "Ending conversation…" : conversation.message)
                        .font(.footnote).foregroundStyle(theme.secondary).accessibilityIdentifier("voiceStatus")
                }
                if !session.isConnected && !conversation.captions.rows.isEmpty { VoiceAccountConnection(session: session) }
            }
            .padding(.horizontal, 20).padding(.top, 12)
            .background(theme.canvas).foregroundStyle(theme.ink)
            .safeAreaInset(edge: .bottom, spacing: 0) { controls.padding(16).background(.bar) }
            .navigationTitle("Conversation").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button("Done") { Task { await conversation.stop(surface: .iphone); dismiss() } }
            } }
        }
        .onChange(of: typing) { _, enabled in
            changingMode = true
            Task {
                if enabled { await conversation.stop(surface: .iphone) }
                composerFocused = enabled
                changingMode = false
            }
        }
        .onChange(of: session.accountID) { previous, current in
            if previous != nil && previous != current { draft = "" }
        }
        .interactiveDismissDisabled(running || conversation.isSendingText)
        .onChange(of: scenePhase) { _, phase in if phase == .background { Task { await conversation.stop(surface: .iphone) } } }
        .onDisappear { Task { await conversation.stop(surface: .iphone) } }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if session.isConnected && !running && conversation.captions.rows.isEmpty {
                Text(typing ? "Messages and relevant graph context are sent to OpenAI when you send." : "Audio is sent to OpenAI only after you start.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if typing {
                HStack(alignment: .bottom, spacing: 12) {
                    TextField(session.isConnected ? "Message Enchiridion" : "Draft a message", text: $draft, axis: .vertical)
                        .lineLimit(1...5).focused($composerFocused)
                        .disabled(changingMode || otherSurfaceActive)
                        .accessibilityIdentifier("agentMessageInput")
                    Button(action: sendMessage) {
                        if conversation.isSendingText { ProgressView() }
                        else { Image(systemName: "arrow.up").frame(width: 28, height: 28) }
                    }.buttonStyle(.borderedProminent).controlSize(.large)
                        .accessibilityLabel("Send message").accessibilityIdentifier("sendAgentMessage").disabled(!canSend)
                }
                if draft.utf16.count > 4_000 { Text("Keep your message under 4,000 characters.").font(.caption).foregroundStyle(.secondary) }
            } else if running {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { callButtons }.fixedSize(horizontal: true, vertical: false)
                    VStack(spacing: 12) { callButtons }
                }.buttonStyle(.bordered).controlSize(.large)
                if let error = conversation.audioOutputError { Text(error).font(.caption).foregroundStyle(.secondary) }
            } else if session.isConnected {
                Button { conversation.start(surface: .iphone, preservingHistory: true) } label: { Label("Start conversation", systemImage: "waveform") }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(changingMode || conversation.isSendingText || conversation.surface != nil)
                    .accessibilityIdentifier("startVoiceConversation")
            }
        }
    }

    @ViewBuilder private var callButtons: some View {
                    Menu {
                        Button("Speaker", systemImage: "speaker.wave.2") { conversation.selectAudioOutput("speaker") }
                        Button("iPhone", systemImage: "iphone") { conversation.selectAudioOutput("receiver") }
                        ForEach(conversation.audioOutputs) { output in
                            Button(output.name, systemImage: "headphones") { conversation.selectAudioOutput(output.id) }
                        }
                    } label: { Label(conversation.audioOutputName, systemImage: "speaker.wave.2") }
                        .accessibilityIdentifier("voiceAudioOutput")
                    Button { conversation.toggleMute(surface: .iphone) } label: {
                        Label(conversation.isMuted ? "Unmute" : "Mute", systemImage: conversation.isMuted ? "mic.slash" : "mic")
                    }.disabled(conversation.phase != .connected || conversation.isEnding)
                    Button("End", role: .destructive) { Task { await conversation.stop(surface: .iphone) } }
                        .disabled(conversation.isEnding)
    }

    private func sendMessage() {
        guard typing, canSend else { return }
        let message = draft
        Task { if await conversation.sendText(message), draft == message { draft = "" } }
    }
}
#endif
