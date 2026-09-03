import Foundation

// Phase 6 spike (plan §"Meetings & voice"; hard constraint: "build the real capture abstraction
// ... behind a real Swift protocol/interface so it CAN be dependency-injected with a test audio
// source"). This file owns only the *interface* — the same domain/implementation split every
// other Phase 6 seam in this repo follows (`ModelClient`, `CloudTranscriptionClient`,
// `RealtimeVoiceClient` in `packages/domain`). Two real implementations exist:
// `ScreenCaptureKitAudioSource` (system audio — the real capture device, genuinely untested live
// in this environment, see its own header comment) and `SyntheticAudioSource` (a real, file-backed
// test double — decodes an actual `say`-synthesized AIFF file into the same `AudioSampleBlock`
// wire shape, used to prove `AudioChunker`/`SpeakerClusterer` correct end-to-end without any
// capture hardware or TCC permission). Full architecture decision, including why capture is TWO
// independent sources (system audio + microphone) rather than one:
// docs/meetings-voice-decisions.md §1.

/// One fixed-format block of PCM audio samples handed from an `AudioCaptureSource` to its
/// consumer. A plain value type (`[Float]`, not `CMSampleBuffer`/`AVAudioPCMBuffer`) so the real
/// ScreenCaptureKit source and a synthetic test source produce the exact same shape — the
/// dependency-injection point the hard constraint asks for.
public struct AudioSampleBlock: Sendable, Equatable {
    /// Mono PCM samples, already downmixed if the source was multi-channel, normalized to
    /// roughly `[-1.0, 1.0]` (standard Float PCM).
    public let samples: [Float]
    public let sampleRate: Double
    /// Which physical source produced this block. A meeting mixes two independent capture
    /// streams (system audio = remote participants' audio; microphone = the local speaker — see
    /// the capture-architecture decision in docs/meetings-voice-decisions.md §1) and downstream
    /// speaker-clustering wants to know which one it's looking at even before clustering runs.
    public let origin: AudioSampleOrigin
    public let capturedAt: Date

    public init(samples: [Float], sampleRate: Double, origin: AudioSampleOrigin, capturedAt: Date = Date()) {
        self.samples = samples
        self.sampleRate = sampleRate
        self.origin = origin
        self.capturedAt = capturedAt
    }
}

public enum AudioSampleOrigin: String, Sendable, Equatable {
    case systemAudio
    case microphone
}

public enum AudioCaptureError: Error, Sendable, Equatable {
    case permissionDenied
    case startFailed(String)
    case alreadyRunning
    case notRunning
}

/// The real dependency-injection seam. One `AudioCaptureSource` = one physical stream (system
/// audio OR microphone) — a meeting mixes two instances (see `MeetingAudioPipeline`), not one
/// source implementing both, because ScreenCaptureKit (system audio) and AVAudioEngine
/// (microphone) are two independent Apple frameworks with independent lifecycles, permission
/// grants, and error modes; forcing them behind one concrete type would hide that reality rather
/// than model it (full "why two frameworks, not one, and not macOS 15's combined
/// `captureMicrophone`" reasoning: docs/meetings-voice-decisions.md §1).
public protocol AudioCaptureSource: Sendable {
    /// Starts capture, calling `onBlock` for every block of audio as it becomes available.
    /// `onBlock` may be called from any thread/queue the source chooses — consumers must not
    /// assume a specific execution context.
    func start(onBlock: @escaping @Sendable (AudioSampleBlock) -> Void) async throws
    func stop() async
}
