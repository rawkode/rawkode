#if os(iOS)
import ApsidesCore
import SwiftUI

struct VoiceConversationView: View {
    @ObservedObject var session: NativeSession
    @ObservedObject var conversation: VoiceConversation
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    private var running: Bool { conversation.surface == .iphone && (conversation.phase == .connecting || conversation.phase == .connected) }
    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                if !conversation.captions.rows.isEmpty {
                    VoiceCaptionList(captions: conversation.captions, theme: theme)
                } else {
                Spacer()
                Image(systemName: conversation.isMuted ? "mic.slash" : "waveform")
                    .font(.system(size: 64, weight: .light))
                    .foregroundStyle(theme.accent)
                    .frame(width: 160, height: 160)
                    .glassEffect(.regular, in: .circle)
                    .accessibilityHidden(true)
                VStack(spacing: 12) {
                    Text("A little clarity.").font(.largeTitle.weight(.semibold))
                    Text(conversation.message).font(.body).foregroundStyle(theme.secondary)
                        .multilineTextAlignment(.center).accessibilityIdentifier("voiceStatus")
                }
                if !running {
                    Text("Your voice is sent to OpenAI during the conversation. Start when you’re ready.")
                        .font(.footnote).foregroundStyle(theme.secondary).multilineTextAlignment(.center)
                }
                Spacer()
                }
                if !conversation.captions.rows.isEmpty {
                    Text(conversation.message).font(.footnote).foregroundStyle(theme.secondary)
                        .accessibilityIdentifier("voiceStatus")
                }
                if running {
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
                HStack(spacing: 24) {
                    if running {
                        Button { conversation.toggleMute(surface: .iphone) } label: {
                            Label(conversation.isMuted ? "Unmute" : "Mute", systemImage: conversation.isMuted ? "mic.slash" : "mic")
                        }.buttonStyle(.glass).disabled(conversation.phase != .connected)
                        Button("End", role: .destructive) { Task { await conversation.stop(surface: .iphone) } }.buttonStyle(.glassProminent)
                    } else if session.isConnected {
                        Button { conversation.start(surface: .iphone) } label: { Label("Start conversation", systemImage: "waveform") }
                            .buttonStyle(.glassProminent).disabled(!session.isConnected || conversation.surface != nil)
                            .accessibilityIdentifier("startVoiceConversation")
                    }
                }.controlSize(.large)
                if !session.isConnected { VoiceAccountConnection(session: session) }
            }
            .padding(28).padding(.bottom, 24)
            .frame(maxWidth: .infinity).background(theme.canvas).foregroundStyle(theme.ink)
            .navigationTitle("Voice").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button("Done") { Task { await conversation.stop(surface: .iphone); dismiss() } }
            } }
        }
        .interactiveDismissDisabled(running)
        .onChange(of: scenePhase) { _, phase in if phase == .background { Task { await conversation.stop(surface: .iphone) } } }
        .onDisappear { Task { await conversation.stop(surface: .iphone) } }
    }
}

#endif
