import Foundation

// Piece 2 of 3 (see `PCM16.swift`'s header comment). A live microphone tap delivers small,
// irregularly-sized `AudioSampleBlock`s (AVAudioEngine's own buffer size, ~4096 frames per
// `AVAudioEngineMicrophoneSource`) — sending one RPC call per block would be both too chatty and
// too latency-irrelevant a batching unit to reason about. This type re-batches the incoming
// stream into fixed-duration PCM16 chunks instead, independent of the capture source's own buffer
// boundaries — deliberately NOT `AudioChunker` (that type's silence-cut, 5-30-second chunks are
// tuned for handing ASR one coherent utterance at a time; a realtime voice stream instead wants
// frequent, small, low-latency chunks with no silence-based cutting — the realtime protocol's own
// turn-taking, driven by an explicit client `commit`, per `voice-audio-rpc.ts`'s
// `CommitVoiceAudioInput`, already does the "when does an utterance end" job `AudioChunker` exists
// for in the meetings case).
public final class VoiceAudioBatcher {
    private let targetChunkDurationSeconds: Double
    private var buffer: [Float] = []
    private var sampleRate: Double = 0

    public init(targetChunkDurationSeconds: Double = 0.2) {
        self.targetChunkDurationSeconds = targetChunkDurationSeconds
    }

    /// Feeds one captured block in; returns zero-or-more PCM16-encoded chunks that completed as a
    /// result (almost always zero or one for realistic block sizes).
    public func ingest(_ block: AudioSampleBlock) -> [Data] {
        sampleRate = block.sampleRate
        buffer.append(contentsOf: block.samples)

        var completed: [Data] = []
        let targetFrames = Int(targetChunkDurationSeconds * sampleRate)
        guard targetFrames > 0 else { return completed }
        while buffer.count >= targetFrames {
            let chunk = Array(buffer.prefix(targetFrames))
            completed.append(pcm16Data(from: chunk))
            buffer.removeFirst(targetFrames)
        }
        return completed
    }

    /// Flushes any remaining buffered (sub-target-duration) audio as a final short chunk — call
    /// when capture stops so trailing audio isn't silently dropped.
    public func flush() -> Data? {
        guard !buffer.isEmpty else { return nil }
        let chunk = pcm16Data(from: buffer)
        buffer.removeAll()
        return chunk
    }
}
