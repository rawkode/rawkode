import Foundation
import AVFoundation

/// The real test double `AudioCaptureSource`'s dependency-injection seam exists for (hard
/// constraint: "genuinely test the rest of the pipeline ... using a synthetic/injected audio
/// source instead of a live tap"). Two construction paths, both real (neither fabricates PCM
/// data out of nothing):
///
/// 1. **`init(fileURL:origin:chunkSize:)`** — decodes an ACTUAL audio file (in practice, a file
///    `say -o file.aiff "..."` genuinely synthesized — real recorded/synthesized speech, not
///    silence or noise) via `AVAudioFile`, exactly the same real-decode path a recorded meeting
///    would go through, and replays it as a sequence of `AudioSampleBlock`s. This is what makes
///    `AudioChunkerTests`/`SpeakerClustererTests` genuine tests against real speech audio rather
///    than synthetic sine waves.
/// 2. **`init(samples:sampleRate:origin:chunkSize:)`** — replays a caller-supplied sample array
///    directly, for tests that want to construct a specific waveform (silence-detection edge
///    cases, etc.) rather than decode a file.
///
/// Playback is synchronous and immediate (no real-time pacing) when driven via `emitAll()` — a
/// test wants deterministic, fast execution, not to wait out real audio duration; `start(onBlock:)`
/// (the actual `AudioCaptureSource` protocol conformance) uses the identical synchronous emission,
/// so tests exercising the protocol interface see the same behavior a "wait for it to arrive
/// slowly" caller would, just compressed to zero wall-clock time.
public final class SyntheticAudioSource: AudioCaptureSource, @unchecked Sendable {
    private let blocks: [AudioSampleBlock]
    private var isRunning = false

    public init(samples: [Float], sampleRate: Double, origin: AudioSampleOrigin, chunkSize: Int = 4096) {
        self.blocks = Self.chunk(samples: samples, sampleRate: sampleRate, origin: origin, chunkSize: chunkSize)
    }

    public convenience init(fileURL: URL, origin: AudioSampleOrigin, chunkSize: Int = 4096) throws {
        let (samples, sampleRate) = try Self.decode(fileURL: fileURL)
        self.init(samples: samples, sampleRate: sampleRate, origin: origin, chunkSize: chunkSize)
    }

    /// All blocks this source will ever emit, without going through the `AudioCaptureSource`
    /// protocol's callback shape — convenient for tests that want the whole decoded signal at
    /// once (e.g. to hand directly to `SpeakerClusterer`, which doesn't need streaming).
    public var allBlocks: [AudioSampleBlock] { blocks }

    public func start(onBlock: @escaping @Sendable (AudioSampleBlock) -> Void) async throws {
        guard !isRunning else { throw AudioCaptureError.alreadyRunning }
        isRunning = true
        for block in blocks { onBlock(block) }
    }

    public func stop() async {
        isRunning = false
    }

    private static func chunk(
        samples: [Float],
        sampleRate: Double,
        origin: AudioSampleOrigin,
        chunkSize: Int
    ) -> [AudioSampleBlock] {
        guard chunkSize > 0, !samples.isEmpty else {
            return samples.isEmpty ? [] : [AudioSampleBlock(samples: samples, sampleRate: sampleRate, origin: origin)]
        }
        var result: [AudioSampleBlock] = []
        var index = 0
        while index < samples.count {
            let end = Swift.min(index + chunkSize, samples.count)
            result.append(AudioSampleBlock(samples: Array(samples[index..<end]), sampleRate: sampleRate, origin: origin))
            index = end
        }
        return result
    }

    /// Real decode of a real audio file (AIFF/WAV/CAF/etc. — anything `AVAudioFile` reads) into
    /// mono Float32 samples at the file's own sample rate. `AVAudioFile` requires no TCC
    /// permission for reading a local file the process already has filesystem access to (this is
    /// NOT microphone/speech capture — it's ordinary file I/O), so this path runs correctly in
    /// this sandboxed environment with zero permission prompts, confirmed by
    /// `SyntheticAudioSourceTests`.
    private static func decode(fileURL: URL) throws -> (samples: [Float], sampleRate: Double) {
        let file = try AVAudioFile(forReading: fileURL)
        let format = file.processingFormat
        // A genuinely zero-length file (e.g. `say` given only whitespace) has no frames to read
        // at all — `AVAudioPCMBuffer(frameCapacity: 0)` is a real, valid empty buffer, but
        // `AVAudioFile.read(into:)` rejects it (Core Audio error -50), so this is handled as its
        // own real case rather than an unhandled crash.
        guard file.length > 0 else { return ([], format.sampleRate) }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length)) else {
            throw AudioCaptureError.startFailed("could not allocate PCM buffer for \(fileURL.lastPathComponent)")
        }
        try file.read(into: buffer)
        guard let channelData = buffer.floatChannelData else {
            throw AudioCaptureError.startFailed("no float channel data in \(fileURL.lastPathComponent)")
        }
        let frameCount = Int(buffer.frameLength)
        let channelCount = Int(format.channelCount)
        var mono = [Float](repeating: 0, count: frameCount)
        for channel in 0..<channelCount {
            let samples = channelData[channel]
            for frame in 0..<frameCount {
                mono[frame] += samples[frame] / Float(channelCount)
            }
        }
        return (mono, format.sampleRate)
    }
}
