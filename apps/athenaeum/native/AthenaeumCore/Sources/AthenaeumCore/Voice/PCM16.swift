import Foundation

// Native voice-UI task's mic->realtime-voice-path pipeline, piece 1 of 3 (`PCM16.swift` ->
// `VoiceAudioBatcher.swift` -> `VoiceAudioStreamer.swift`). Pure, dependency-free conversion —
// deliberately its own file/function so `PCM16Tests.swift` can assert exact byte output against
// known inputs without any audio hardware or capture source involved at all.

/// Encodes normalized `[-1.0, 1.0]` Float PCM samples (`AudioSampleBlock.samples`'s own shape,
/// `AudioCaptureSource.swift`) as little-endian, mono, 16-bit signed PCM bytes — the wire format
/// `voice-audio-rpc.ts`'s `SendVoiceAudioChunkInput.pcm16Base64` expects (base64 is applied at the
/// RPC-call boundary, `WorkspaceRPCClient.sendVoiceAudioChunk`, not here — this function's own output
/// is the raw bytes).
///
/// **Deliberate, documented simplification**: this does NOT resample to any particular target
/// rate (e.g. OpenAI's commonly-documented 24kHz) — it encodes at whatever sample rate the capture
/// source actually produced (`AudioSampleBlock.sampleRate`, typically the hardware's native rate,
/// 44.1kHz or 48kHz on most Macs/iPhones), and that same rate is what
/// `RealtimeVoiceSessionConfig.inputAudioSampleRateHz` reports to the backend
/// (`WorkspaceRPCClient.openVoiceAudioSession`). Real resampling to a provider-specific target rate is
/// exactly the kind of gap that needs a live key to verify correctly (same "flagged, not silently
/// assumed" discipline `realtime-voice-client-openai.ts`'s own header comment already applies to
/// its `session.audio` sub-shape gap) — not built here.
public func pcm16Data(from samples: [Float]) -> Data {
    var data = Data(capacity: samples.count * 2)
    for sample in samples {
        let clamped = max(-1.0, min(1.0, sample))
        let scaled = clamped < 0 ? clamped * 32768.0 : clamped * 32767.0
        let intSample = Int16(scaled.rounded())
        withUnsafeBytes(of: intSample.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
}
