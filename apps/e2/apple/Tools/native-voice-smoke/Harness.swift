import SwiftUI
import WebKit

@main
struct NativeVoiceSmokeApp: App {
    var body: some Scene { WindowGroup { SetupView() } }
}
struct SetupView: View {
    @State private var origin = "https://enchiridion.rawkode.academy"
    @State private var model: SmokeModel?
    @State private var error: String?
    var body: some View {
        if let model { SmokeView(model: model, session: model.session, voice: model.voice) }
        else {
            Form {
                TextField("Website origin", text: $origin).textInputAutocapitalization(.never)
                Text("Place synthetic speech at Documents/input.pcm (48 kHz, mono, signed Int16 little endian). No microphone is used.")
                Button("Prepare") {
                    do { model = try SmokeModel(origin: origin) }
                    catch { self.error = error.localizedDescription }
                }
                if let error { Text(error) }
            }
        }
    }
}
@MainActor
final class SmokeModel: ObservableObject {
    let session: NativeSession
    let voice: VoiceConversation
    let device: SyntheticAudioDevice
    @Published private(set) var started = false
    private var deadline: Task<Void, Never>?
    init(origin: String) throws {
        let file = URL.documentsDirectory.appending(path: "input.pcm")
        let input = try Data(contentsOf: file)
        guard !input.isEmpty, input.count <= 48_000 * 2 * 30, input.count % 2 == 0 else { throw CocoaError(.fileReadCorruptFile) }
        device = SyntheticAudioDevice(input: input)
        guard let url = URL(string: origin) else { throw NativeSession.SessionError.invalidOrigin }
        session = try NativeSession(origin: url)
        voice = VoiceConversation(session: session)
        voice.harnessAudioDevice = device
    }
    func start() {
        guard !started else { return }
        started = true
        voice.start(surface: .iphone)
        deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(60))
            guard !Task.isCancelled else { return }
            await self?.stop()
        }
    }
    func stop() async {
        deadline?.cancel(); deadline = nil
        await voice.stop(surface: .iphone)
        try? device.capturedPCM().write(to: URL.documentsDirectory.appending(path: "remote.pcm"), options: .atomic)
        let pcm = device.capturedPCM()
        var squares = 0.0, peak = 0.0, nonzero = 0
        for index in stride(from: 0, to: pcm.count - 1, by: 2) {
            let sample = Double(Int16(bitPattern: UInt16(pcm[index]) | UInt16(pcm[index + 1]) << 8))
            squares += sample * sample; peak = max(peak, abs(sample))
            if sample != 0 { nonzero += 1 }
        }
        let rms = sqrt(squares / Double(max(1, pcm.count / 2)))
        let captions = voice.captions.rows.map { "\($0.speaker.rawValue): \($0.text)" }.joined(separator: "\n")
        let report = "phase=\(voice.phase)\nstatus=\(voice.message)\nserverEndConfirmed=\(voice.harnessEndConfirmed)\nremoteBytes=\(pcm.count)\nnonzeroSamples=\(nonzero)\npeak=\(peak)\nrms=\(rms)\n\(captions)\n"
        try? report.write(to: URL.documentsDirectory.appending(path: "result.txt"), atomically: true, encoding: .utf8)
    }
}
struct SmokeView: View {
    @ObservedObject var model: SmokeModel
    @ObservedObject var session: NativeSession
    @ObservedObject var voice: VoiceConversation
    @State private var signingIn = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Form {
            Text("Synthetic audio — real native transport")
            Text(session.status)
            Button("Sign in") { signingIn = true }
            Button("Verify account") { Task { try? await session.verifyConnection() } }
            Button("Start real paid session") { model.start() }.disabled(!session.isConnected || model.started)
            Button("Send prerecorded speech") { model.device.beginSpeech() }.disabled(voice.phase != .connected)
            Button("Stop and save PCM") { Task { await model.stop() } }
            Text(voice.message)
            ForEach(voice.captions.rows) { row in Text(row.text) }
        }
        .sheet(isPresented: $signingIn) { SignIn(session: session) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { Task { await model.stop() } }
        }
    }
}
struct SignIn: UIViewRepresentable {
    let session: NativeSession
    func makeUIView(context: Context) -> WKWebView { session.makeSignInWebView() }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
