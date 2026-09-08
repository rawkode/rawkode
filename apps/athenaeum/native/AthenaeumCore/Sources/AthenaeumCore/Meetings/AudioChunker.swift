import Foundation

/// One completed chunk of audio ready to hand to ASR (on-device first, cloud fallback per
/// docs/meetings-voice-decisions.md §2). `isSilent` lets a caller skip sending a pure-silence
/// chunk to any transcriber at all — a real cost/quality optimization, not decoration.
public struct AudioChunk: Sendable, Equatable {
    public let samples: [Float]
    public let sampleRate: Double
    public let origin: AudioSampleOrigin
    public let isSilent: Bool
}

public struct AudioChunkerConfig: Sendable {
    public var minChunkDurationSeconds: Double
    public var maxChunkDurationSeconds: Double
    public var silenceHoldDurationSeconds: Double
    public var silenceRmsThreshold: Float
    public var silenceWindowSeconds: Double

    public init(
        minChunkDurationSeconds: Double = 5,
        maxChunkDurationSeconds: Double = 30,
        silenceHoldDurationSeconds: Double = 0.6,
        silenceRmsThreshold: Float = 0.01,
        silenceWindowSeconds: Double = 0.02
    ) {
        self.minChunkDurationSeconds = minChunkDurationSeconds
        self.maxChunkDurationSeconds = maxChunkDurationSeconds
        self.silenceHoldDurationSeconds = silenceHoldDurationSeconds
        self.silenceRmsThreshold = silenceRmsThreshold
        self.silenceWindowSeconds = silenceWindowSeconds
    }
}

/// Real chunking + silence detection over a live `AudioCaptureSource` stream (plan §"Meetings &
/// voice": "chunking, buffering, silence detection"). A chunk boundary is cut either (a) once at
/// least `minChunkDurationSeconds` of audio has accumulated AND a trailing silence run of at
/// least `silenceHoldDurationSeconds` is found (a natural pause — the "cut at silence, not
/// mid-word" behavior a real meeting transcript wants), or (b) unconditionally once
/// `maxChunkDurationSeconds` is reached, so one long unbroken utterance still gets sent to ASR
/// incrementally rather than buffering forever.
///
/// One instance handles ONE `AudioSampleOrigin` (system audio OR microphone) — mixing origins in
/// one chunker would corrupt RMS-based silence detection across two independently-gained audio
/// paths; a meeting pipeline runs two chunkers, one per source.
public final class AudioChunker {
    private let config: AudioChunkerConfig
    private var buffer: [Float] = []
    private var sampleRate: Double = 0
    private var origin: AudioSampleOrigin?

    public init(config: AudioChunkerConfig = AudioChunkerConfig()) {
        self.config = config
    }

    /// Feeds one captured block in; returns zero-or-more chunks that completed as a result of
    /// this block (almost always zero or one for realistic block sizes; the loop drains more than
    /// one only if a single block alone exceeds `maxChunkDurationSeconds`).
    public func ingest(_ block: AudioSampleBlock) -> [AudioChunk] {
        if origin == nil { origin = block.origin }
        precondition(
            origin == block.origin,
            "AudioChunker instance is scoped to one AudioSampleOrigin; got \(block.origin) after \(origin!)"
        )
        sampleRate = block.sampleRate
        buffer.append(contentsOf: block.samples)

        var completed: [AudioChunk] = []
        while let cut = nextCutPoint() {
            completed.append(makeChunk(upTo: cut))
            buffer.removeFirst(cut)
        }
        return completed
    }

    /// Flushes any remaining buffered audio as a final (possibly short) chunk — call at the end
    /// of a capture session so trailing speech below `minChunkDurationSeconds` isn't silently
    /// dropped.
    public func flush() -> AudioChunk? {
        guard !buffer.isEmpty, let origin else { return nil }
        let chunk = makeChunk(upTo: buffer.count)
        buffer.removeAll()
        _ = origin // silence "never read" warning in some toolchains; origin used in makeChunk
        return chunk
    }

    private func nextCutPoint() -> Int? {
        let durationSeconds = Double(buffer.count) / max(sampleRate, 1)
        if durationSeconds >= config.maxChunkDurationSeconds {
            return buffer.count // force-cut: include everything accumulated so far
        }
        guard durationSeconds >= config.minChunkDurationSeconds else { return nil }
        let windowFrames = max(1, Int(config.silenceWindowSeconds * sampleRate))
        let holdFrames = Int(config.silenceHoldDurationSeconds * sampleRate)
        guard holdFrames > 0, buffer.count >= holdFrames else { return nil }

        // Scan backward from the end in windows, accumulating a trailing silence run.
        var silentFrames = 0
        var cursor = buffer.count
        while cursor > 0 {
            let start = max(0, cursor - windowFrames)
            let window = buffer[start..<cursor]
            guard rms(window) < config.silenceRmsThreshold else { break }
            silentFrames += window.count
            cursor = start
            if silentFrames >= holdFrames {
                // The whole buffer (including this trailing silence) becomes the chunk — a
                // natural pause just ended it.
                return buffer.count
            }
        }
        return nil
    }

    private func makeChunk(upTo count: Int) -> AudioChunk {
        let samples = Array(buffer.prefix(count))
        return AudioChunk(
            samples: samples,
            sampleRate: sampleRate,
            origin: origin!,
            isSilent: rms(samples) < config.silenceRmsThreshold
        )
    }
}

/// Root-mean-square energy of a sample window — the real, standard silence-detection signal both
/// `AudioChunker` and `SpeakerClusterer`'s voiced/unvoiced gating use.
func rms<S: Sequence>(_ samples: S) -> Float where S.Element == Float {
    var sum: Float = 0
    var count: Float = 0
    for s in samples {
        sum += s * s
        count += 1
    }
    guard count > 0 else { return 0 }
    return (sum / count).squareRoot()
}
