#if os(macOS)
import SwiftUI

/// A separate workspace companion: captions remain readable while other app windows are in use.
struct MacVoiceConversationView: View {
    @ObservedObject var session: NativeSession
    @ObservedObject var conversation: VoiceConversation
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    private var running: Bool { conversation.surface == .mac && (conversation.phase == .connecting || conversation.phase == .connected) }
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .top, spacing: 16) {
                Image(systemName: conversation.isMuted ? "mic.slash" : "waveform")
                    .font(.system(size: 30, weight: .light)).foregroundStyle(theme.accent)
                    .frame(width: 64, height: 64).glassEffect(.regular, in: .circle)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Talk it through.").font(.title.weight(.semibold))
                    Text(conversation.message).font(.body).foregroundStyle(theme.secondary)
                        .accessibilityIdentifier("voiceStatus")
                }
            }
            if conversation.captions.rows.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Room for a thought.").font(.title2)
                    Text("Speak naturally while you work. Your conversation stays in this window, and you can mute or end it at any time.")
                        .foregroundStyle(theme.secondary)
                    Text("Audio is sent to OpenAI only after you start a conversation.")
                        .font(.footnote).foregroundStyle(theme.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                VoiceCaptionList(captions: conversation.captions, theme: theme)
            }
            Divider()
            HStack {
                if running {
                    Button { conversation.toggleMute(surface: .mac) } label: {
                        Label(conversation.isMuted ? "Unmute" : "Mute", systemImage: conversation.isMuted ? "mic.slash" : "mic")
                    }.buttonStyle(.glass).keyboardShortcut("m", modifiers: [.command, .shift])
                        .disabled(conversation.phase != .connected).help("Mute or unmute microphone (⇧⌘M)")
                    Spacer()
                    Button("End conversation", role: .destructive) { Task { await conversation.stop(surface: .mac) } }
                        .buttonStyle(.glassProminent).keyboardShortcut(".", modifiers: .command)
                } else if session.isConnected {
                    Spacer()
                    Button { conversation.start(surface: .mac) } label: { Label("Start conversation", systemImage: "waveform") }
                        .buttonStyle(.glassProminent).keyboardShortcut(.return, modifiers: .command)
                        .disabled(!session.isConnected || conversation.surface != nil).accessibilityIdentifier("startVoiceConversation")
                }
            }.controlSize(.large)
            if !session.isConnected { VoiceAccountConnection(session: session) }
        }
        .padding(28).frame(minWidth: 480, minHeight: 400)
        .background(theme.canvas).foregroundStyle(theme.ink)
        .background { VoiceWindowCloseObserver { conversation.stopForWindowClose() }.frame(width: 0, height: 0) }
        .onDisappear { Task { await conversation.stop(surface: .mac) } }
    }
}
#endif
