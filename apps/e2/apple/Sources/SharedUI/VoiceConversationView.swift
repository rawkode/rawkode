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

    private var running: Bool { conversation.surface == .iphone && (conversation.phase == .connecting || conversation.phase == .connected) }
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Picker("Input mode", selection: $typing) {
                    Label("Speak", systemImage: "waveform").tag(false)
                    Label("Type", systemImage: "keyboard").tag(true)
                }.pickerStyle(.segmented)
                    .disabled(changingMode || conversation.isSendingText)
                    .accessibilityIdentifier("conversationInputMode")
                if !conversation.captions.rows.isEmpty {
                    VoiceCaptionList(captions: conversation.captions, theme: theme)
                } else {
                Spacer()
                Image(systemName: typing ? "text.bubble" : (conversation.isMuted ? "mic.slash" : "waveform"))
                    .font(.system(size: typing ? 28 : 64, weight: .light))
                    .foregroundStyle(theme.accent)
                    .frame(width: typing ? 64 : 160, height: typing ? 64 : 160)
                    .glassEffect(.regular, in: .circle)
                    .accessibilityHidden(true)
                VStack(spacing: 12) {
                    Text(typing ? "What would you like to do?" : "A little clarity.").font(typing ? .title2.weight(.semibold) : .largeTitle.weight(.semibold))
                    Text(typing && conversation.message == "Talk through your day." ? "Ask about your day, or make a change in your graph." : conversation.message).font(.body).foregroundStyle(theme.secondary)
                        .multilineTextAlignment(.center).accessibilityIdentifier("voiceStatus")
                }
                if !running {
                    Text(typing ? "Messages and relevant graph context are sent to OpenAI when you send." : "Your voice is sent to OpenAI during the conversation. Start when you’re ready.")
                        .font(.footnote).foregroundStyle(theme.secondary).multilineTextAlignment(.center)
                }
                Spacer()
                }
                if !conversation.captions.rows.isEmpty {
                    Text(conversation.message).font(.footnote).foregroundStyle(theme.secondary)
                        .accessibilityIdentifier("voiceStatus")
                }
                if running && !typing {
                    Menu {
                        Button("Speaker", systemImage: "speaker.wave.2") { conversation.selectAudioOutput("speaker") }
                        Button("iPhone", systemImage: "iphone") { conversation.selectAudioOutput("receiver") }
                        ForEach(conversation.audioOutputs) { output in
                            Button(output.name, systemImage: "headphones") { conversation.selectAudioOutput(output.id) }
                        }
                    } label: {
                        Label(conversation.audioOutputName, systemImage: "speaker.wave.2")
                            .frame(minHeight: 44)
                    }.buttonStyle(.glass).accessibilityIdentifier("voiceAudioOutput")
                    if let error = conversation.audioOutputError {
                        Text(error).font(.caption).foregroundStyle(theme.secondary)
                    }
                }
                if typing {
                    HStack(alignment: .bottom, spacing: 12) {
                        TextField("Message Enchiridion", text: $draft, axis: .vertical)
                            .lineLimit(1...5).focused($composerFocused)
                            .accessibilityIdentifier("agentMessageInput")
                        Button {
                            let message = draft
                            Task { if await conversation.sendText(message), draft == message { draft = "" } }
                        } label: {
                            if conversation.isSendingText { ProgressView() }
                            else { Image(systemName: "arrow.up").frame(width: 44, height: 44) }
                        }.buttonStyle(.glassProminent)
                            .accessibilityLabel("Send message")
                            .accessibilityIdentifier("sendAgentMessage")
                            .disabled(changingMode || running || conversation.isSendingText || !session.isConnected || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.utf16.count > 4_000)
                    }.padding(12).glassEffect(.regular, in: .rect(cornerRadius: 24))
                }
                HStack(spacing: 24) {
                    if running && !typing {
                        Button { conversation.toggleMute(surface: .iphone) } label: {
                            Label(conversation.isMuted ? "Unmute" : "Mute", systemImage: conversation.isMuted ? "mic.slash" : "mic")
                        }.buttonStyle(.glass).disabled(conversation.phase != .connected)
                        Button("End", role: .destructive) { Task { await conversation.stop(surface: .iphone) } }.buttonStyle(.glassProminent)
                    } else if session.isConnected && !typing {
                        Button { conversation.start(surface: .iphone, preservingHistory: true) } label: { Label("Start conversation", systemImage: "waveform") }
                            .buttonStyle(.glassProminent).disabled(!session.isConnected || conversation.surface != nil)
                            .accessibilityIdentifier("startVoiceConversation")
                    }
                }.controlSize(.large)
                if !session.isConnected { VoiceAccountConnection(session: session) }
            }
            .padding(28).padding(.bottom, 24)
            .frame(maxWidth: .infinity).background(theme.canvas).foregroundStyle(theme.ink)
            .navigationTitle("Enchiridion").navigationBarTitleDisplayMode(.inline)
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
        .onChange(of: session.accountID) { _, _ in draft = "" }
        .interactiveDismissDisabled(running || conversation.isSendingText)
        .onChange(of: scenePhase) { _, phase in if phase == .background { Task { await conversation.stop(surface: .iphone) } } }
        .onDisappear { Task { await conversation.stop(surface: .iphone) } }
    }
}

#endif
