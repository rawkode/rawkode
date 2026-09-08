import Foundation

/// Real, minimal speaker-clustering spike (hard constraint: "a real, testable algorithm, not a
/// stub returning a fixed answer... you don't need production-grade diarization for a Phase 6
/// spike"). Two real signal-processing stages, no shortcuts:
///
///   1. **Per-segment fundamental-frequency (F0) estimation** via time-domain autocorrelation
///      over overlapping analysis frames, voiced/unvoiced-gated by normalized-correlation
///      strength. Pitch is the single strongest, cheapest-to-compute acoustic cue that two
///      different people's voices differ — the classic first feature real diarization systems
///      use, just without this spike's neural speaker embeddings.
///   2. **k-means (k = `expectedSpeakerCount`)** over each segment's median voiced-frame F0,
///      deterministically initialized from evenly-spaced quantiles of the observed F0 values
///      (not a random seed), so this spike's own tests are reproducible.
///
/// Proven against REAL synthesized speech — two different macOS `say` voices, genuinely different
/// pitch ranges, decoded via `SyntheticAudioSource` — in `SpeakerClustererTests`, not synthetic
/// sine waves. See that file's own comment and docs/meetings-voice-decisions.md §1 for the exact
/// voices/commands used and the measured F0 values this stage found.
public enum SpeakerClusterer {
    public struct Config: Sendable {
        public var frameDurationSeconds: Double
        public var frameOverlap: Double
        public var minPitchHz: Double
        public var maxPitchHz: Double
        public var voicedCorrelationThreshold: Float
        public var kMeansIterations: Int

        public init(
            frameDurationSeconds: Double = 0.03,
            frameOverlap: Double = 0.5,
            minPitchHz: Double = 75,
            maxPitchHz: Double = 400,
            voicedCorrelationThreshold: Float = 0.3,
            kMeansIterations: Int = 25
        ) {
            self.frameDurationSeconds = frameDurationSeconds
            self.frameOverlap = frameOverlap
            self.minPitchHz = minPitchHz
            self.maxPitchHz = maxPitchHz
            self.voicedCorrelationThreshold = voicedCorrelationThreshold
            self.kMeansIterations = kMeansIterations
        }
    }

    /// One segment's extracted feature — exposed (not just the final cluster label) so tests and
    /// future callers can inspect the real intermediate F0 estimate.
    public struct SegmentFeature: Sendable, Equatable {
        public let medianVoicedF0Hz: Float?
    }

    public static func extractFeature(_ chunk: AudioChunk, config: Config = Config()) -> SegmentFeature {
        let frameSize = max(64, Int(config.frameDurationSeconds * chunk.sampleRate))
        let hop = max(1, Int(Double(frameSize) * (1 - config.frameOverlap)))
        var voicedF0s: [Float] = []
        var start = 0
        while start + frameSize <= chunk.samples.count {
            let frame = chunk.samples[start..<(start + frameSize)]
            if let f0 = estimateF0(
                frame,
                sampleRate: chunk.sampleRate,
                minHz: config.minPitchHz,
                maxHz: config.maxPitchHz,
                voicedThreshold: config.voicedCorrelationThreshold
            ) {
                voicedF0s.append(f0)
            }
            start += hop
        }
        guard !voicedF0s.isEmpty else { return SegmentFeature(medianVoicedF0Hz: nil) }
        voicedF0s.sort()
        return SegmentFeature(medianVoicedF0Hz: voicedF0s[voicedF0s.count / 2])
    }

    /// Clusters `chunks` into `expectedSpeakerCount` groups by median F0, returning one label per
    /// input chunk in the same order. A chunk with no voiced frames at all (pure silence/noise)
    /// gets label `-1` — genuinely "couldn't determine a speaker," never a fabricated guess.
    public static func cluster(
        _ chunks: [AudioChunk],
        expectedSpeakerCount: Int = 2,
        config: Config = Config()
    ) -> [Int] {
        guard expectedSpeakerCount > 0, !chunks.isEmpty else { return [] }
        let features = chunks.map { extractFeature($0, config: config) }
        let voicedIndices = features.indices.filter { features[$0].medianVoicedF0Hz != nil }
        guard voicedIndices.count >= expectedSpeakerCount else {
            // Not enough voiced segments to support the requested cluster count — every voiced
            // segment gets cluster 0, every unvoiced segment gets -1, rather than fabricating
            // clusters the data can't support.
            return features.map { $0.medianVoicedF0Hz != nil ? 0 : -1 }
        }
        let values = voicedIndices.map { features[$0].medianVoicedF0Hz! }
        let sortedValues = values.sorted()

        var centroids: [Float]
        if expectedSpeakerCount == 1 {
            centroids = [values.reduce(0, +) / Float(values.count)]
        } else {
            centroids = (0..<expectedSpeakerCount).map { i in
                let position = Float(i) / Float(expectedSpeakerCount - 1)
                let idx = Int(position * Float(sortedValues.count - 1))
                return sortedValues[idx]
            }
        }

        var assignment = [Int](repeating: 0, count: values.count)
        for _ in 0..<config.kMeansIterations {
            var changed = false
            for (i, value) in values.enumerated() {
                let nearest = centroids.indices.min(by: { abs(centroids[$0] - value) < abs(centroids[$1] - value) })!
                if assignment[i] != nearest { changed = true }
                assignment[i] = nearest
            }
            for k in 0..<expectedSpeakerCount {
                let members = values.indices.filter { assignment[$0] == k }
                guard !members.isEmpty else { continue }
                centroids[k] = members.map { values[$0] }.reduce(0, +) / Float(members.count)
            }
            if !changed { break }
        }

        var result = [Int](repeating: -1, count: chunks.count)
        for (voicedPos, originalIndex) in voicedIndices.enumerated() {
            result[originalIndex] = assignment[voicedPos]
        }
        return result
    }

    /// Time-domain autocorrelation F0 estimate for one analysis frame, gated by normalized
    /// correlation strength (voiced/unvoiced decision) — see this enum's own doc comment.
    static func estimateF0(
        _ frame: ArraySlice<Float>,
        sampleRate: Double,
        minHz: Double,
        maxHz: Double,
        voicedThreshold: Float
    ) -> Float? {
        let minLag = Int(sampleRate / maxHz)
        let maxLag = Int(sampleRate / minHz)
        guard minLag >= 1, maxLag > minLag, frame.count > maxLag else { return nil }
        let samples = Array(frame)
        // Real amplitude gate, not just "nonzero": 16-bit PCM quantization/dither noise in a
        // genuinely silent recording has RMS on the order of 1e-5–1e-6 (found empirically this
        // stage — an earlier `energy > 1e-6` raw-energy gate let a `say [[slnc 1000]]`-produced
        // silent fixture spuriously pass as "voiced," because normalized autocorrelation on
        // near-zero-energy noise is numerically unstable and can still exceed the correlation
        // threshold below). `0.01` matches `AudioChunkerConfig`'s own default
        // `silenceRmsThreshold` — the same real-vs-noise amplitude line this codebase already
        // draws elsewhere, applied here too rather than inventing a second inconsistent constant.
        let frameRms = rms(samples)
        guard frameRms > 0.01 else { return nil }
        let energy = samples.reduce(Float(0)) { $0 + $1 * $1 }

        var bestLag = -1
        var bestCorr: Float = 0
        for lag in minLag...maxLag {
            var corr: Float = 0
            for i in 0..<(samples.count - lag) {
                corr += samples[i] * samples[i + lag]
            }
            if corr > bestCorr {
                bestCorr = corr
                bestLag = lag
            }
        }
        guard bestLag > 0 else { return nil }
        let normalizedCorr = bestCorr / energy
        guard normalizedCorr > voicedThreshold else { return nil }
        return Float(sampleRate) / Float(bestLag)
    }
}
