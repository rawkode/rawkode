#if os(iOS)
import ApsidesCore
import SwiftUI

struct VoiceConversationView: View {
    @ObservedObject var session: NativeSession
    @StateObject private var conversation: VoiceConversation
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    init(session: NativeSession) {
        self.session = session
        _conversation = StateObject(wrappedValue: VoiceConversation(session: session))
    }
    private var running: Bool { conversation.phase == .connecting || conversation.phase == .connected }
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
                HStack(spacing: 24) {
                    if running {
                        Button { conversation.toggleMute() } label: {
                            Label(conversation.isMuted ? "Unmute" : "Mute", systemImage: conversation.isMuted ? "mic.slash" : "mic")
                        }.buttonStyle(.glass).disabled(conversation.phase != .connected)
                        Button("End", role: .destructive) { Task { await conversation.stop() } }.buttonStyle(.glassProminent)
                    } else {
                        Button { conversation.start() } label: { Label("Start conversation", systemImage: "waveform") }
                            .buttonStyle(.glassProminent).disabled(!session.isConnected)
                            .accessibilityIdentifier("startVoiceConversation")
                    }
                }.controlSize(.large)
                if !session.isConnected { Text("Connect your account in Settings first.").font(.footnote) }
            }
            .padding(28).padding(.bottom, 24)
            .frame(maxWidth: .infinity).background(theme.canvas).foregroundStyle(theme.ink)
            .navigationTitle("Voice").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button("Done") { Task { await conversation.stop(); dismiss() } }
            } }
        }
        .interactiveDismissDisabled(running)
        .onChange(of: session.accountID) { _, _ in Task { await conversation.stop(message: "Your account changed. Start a new conversation.") } }
        .onChange(of: scenePhase) { _, phase in if phase == .background { Task { await conversation.stop(message: "Conversation paused while the app is in the background.") } } }
        .onDisappear { Task { await conversation.stop() } }
    }
}

private struct VoiceCaptionList: View {
    let captions: VoiceCaptions
    let theme: ApsidesTheme
    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Conversation").font(.title2.weight(.semibold))
                    Spacer()
                    Button("Latest") {
                        if let id = captions.rows.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                    }.font(.subheadline)
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        if captions.earlierCaptionsOmitted {
                            Text("Earlier captions are no longer shown.").font(.footnote).foregroundStyle(theme.secondary)
                        }
                        ForEach(captions.rows) { row in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(row.speaker == .user ? "You" : "Enchiridion")
                                    .font(.caption.weight(.semibold)).foregroundStyle(theme.secondary)
                                Text(row.text).font(.body).textSelection(.enabled)
                            }.frame(maxWidth: .infinity, alignment: .leading).id(row.id)
                        }
                    }.padding(.vertical, 12)
                }.accessibilityIdentifier("voiceCaptions")
            }
        }
    }
}
#endif
