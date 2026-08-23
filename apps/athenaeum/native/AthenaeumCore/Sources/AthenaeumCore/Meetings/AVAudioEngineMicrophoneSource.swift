import Foundation
import AVFoundation

/// Real local-microphone capture via `AVAudioEngine`'s input-node tap — the standard,
/// long-stable real API for microphone PCM access on macOS/iOS (distinct from ScreenCaptureKit's
/// system-audio capture — see `ScreenCaptureKitAudioSource`'s own header comment for why these
/// are two independent sources, not one). Requires the Microphone TCC permission
/// (`NSMicrophoneUsageDescription`) — same "cannot be interactively granted in this environment,
/// real code, genuinely untested live here" story as `ScreenCaptureKitAudioSource`; see
/// docs/meetings-voice-decisions.md §1.
public final class AVAudioEngineMicrophoneSource: AudioCaptureSource, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var isRunning = false

    public init() {}

    public func start(onBlock: @escaping @Sendable (AudioSampleBlock) -> Void) async throws {
        guard !isRunning else { throw AudioCaptureError.alreadyRunning }
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw AudioCaptureError.startFailed("microphone input format unavailable (sampleRate 0) — likely no Microphone permission")
        }

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
            guard let channelData = buffer.floatChannelData else { return }
            let frameCount = Int(buffer.frameLength)
            // Downmix to mono by averaging channels — same "one physical stream, one AudioSampleBlock
            // shape" contract every AudioCaptureSource honors (AudioCaptureSource's own doc comment).
            let channelCount = Int(buffer.format.channelCount)
            var mono = [Float](repeating: 0, count: frameCount)
            for channel in 0..<channelCount {
                let samples = channelData[channel]
                for frame in 0..<frameCount {
                    mono[frame] += samples[frame] / Float(channelCount)
                }
            }
            onBlock(AudioSampleBlock(samples: mono, sampleRate: inputFormat.sampleRate, origin: .microphone))
        }

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw AudioCaptureError.startFailed("AVAudioEngine failed to start: \(error)")
        }
        isRunning = true
    }

    public func stop() async {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRunning = false
    }
}
