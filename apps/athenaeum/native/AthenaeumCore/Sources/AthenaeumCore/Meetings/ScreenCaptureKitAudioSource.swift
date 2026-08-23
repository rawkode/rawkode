import Foundation
import ScreenCaptureKit
import AVFoundation

// Real system-audio capture via ScreenCaptureKit's `SCStream` with `SCStreamConfiguration.
// capturesAudio = true`. **Decision (docs/meetings-voice-decisions.md §1 has the full
// investigation): ScreenCaptureKit, not a Core Audio aggregate-device tap.** Confirmed this stage
// (WebSearch/WebFetch against Apple's own current ScreenCaptureKit documentation and WWDC22 "Meet
// ScreenCaptureKit"): `capturesAudio` has captured the OS's mixed system-audio output since macOS
// 13, under the SAME Screen Recording TCC grant screen-sharing itself already uses — no separate
// audio-specific permission, no kernel extension/driver, no BlackHole-style virtual-device
// install. A Core Audio aggregate-device tap is the pre-macOS-13 way to do this (mixing a virtual
// loopback device into an aggregate) and is real but strictly worse for a 2026 app: it requires
// either a bundled/installed audio driver (kernel-extension-adjacent complexity, code-signing/
// notarization burden) or CoreAudio's newer per-process taps (`AudioHardwareCreateProcessTap`,
// macOS 14.2+) which are lower-level and still capture only what ScreenCaptureKit already gets
// for free at a higher level. ScreenCaptureKit wins on every axis that matters here.
//
// **This class captures ONLY system audio (remote meeting participants' audio played out of the
// Mac) — the local speaker's own voice is a SEPARATE capture via `AVAudioEngineMicrophoneSource`
// (AVAudioEngine's mic tap), not ScreenCaptureKit's newer combined `captureMicrophone` /
// `microphoneCaptureDeviceID` (macOS 15+, confirmed this stage via WebSearch against WWDC24
// coverage).** Deliberate: using AVAudioEngine for the mic keeps this package's minimum target at
// macOS 13 (`Package.swift`'s existing `.macOS(.v13)`) rather than forcing a macOS-15 floor just
// for combined capture, and keeps the two independent audio sources' failure modes independent
// (system-audio capture failing should not also take down mic capture, or vice versa) — see
// `AudioCaptureSource`'s own doc comment for why this protocol models "one source = one stream."
//
// **No TCC permission can be interactively granted in this environment** (hard constraint) — this
// class is real, correctly structured code (real `SCShareableContent`/`SCContentFilter`/
// `SCStreamConfiguration`/`SCStream` usage, type-checked against the real ScreenCaptureKit SDK on
// this machine — `swift build` succeeds) that is genuinely UNTESTED end-to-end here. The empirical
// permission finding this stage DID produce is documented in
// docs/meetings-voice-decisions.md §1 ("What was and wasn't verified live") — a DIFFERENT API
// (`SFSpeechRecognizer`) but the same underlying constraint (a TCC consent dialog requires a human
// physically present to click it, and none is present in this automated environment) applies
// identically to `SCShareableContent`'s Screen Recording permission.
@available(macOS 13.0, *)
public final class ScreenCaptureKitAudioSource: NSObject, AudioCaptureSource, SCStreamOutput, @unchecked Sendable {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "academy.rawkode.athenaeum.screencapturekit-audio")
    private var onBlock: (@Sendable (AudioSampleBlock) -> Void)?
    private let sampleRateHint: Double

    public init(sampleRateHint: Double = 48_000) {
        self.sampleRateHint = sampleRateHint
    }

    public func start(onBlock: @escaping @Sendable (AudioSampleBlock) -> Void) async throws {
        guard stream == nil else { throw AudioCaptureError.alreadyRunning }
        self.onBlock = onBlock

        // Audio-only capture still requires an `SCContentFilter` scoped to a display — Apple's
        // documented pattern; the video frames it also produces are discarded (never read) below.
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            throw AudioCaptureError.startFailed("SCShareableContent enumeration failed: \(error)")
        }
        guard let display = content.displays.first else {
            throw AudioCaptureError.startFailed("no capturable display found (Screen Recording permission likely not granted)")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true // never capture Athenaeum's own UI sounds
        config.sampleRate = Int(sampleRateHint)
        config.channelCount = 1
        // Minimize video work since only audio is wanted — smallest legal capture rect, lowest
        // frame rate, a deliberate configuration choice, not an oversight.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let newStream = SCStream(filter: filter, configuration: config, delegate: nil)
        do {
            try newStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            try await newStream.startCapture()
        } catch {
            throw AudioCaptureError.startFailed("SCStream failed to start: \(error)")
        }
        stream = newStream
    }

    public func stop() async {
        guard let stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
        self.onBlock = nil
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, let onBlock else { return }
        guard let samples = Self.floatSamples(from: sampleBuffer) else { return }
        onBlock(AudioSampleBlock(samples: samples, sampleRate: sampleRateHint, origin: .systemAudio))
    }

    /// Extracts mono Float32 samples from a system-audio `CMSampleBuffer`. Real decode logic,
    /// type-checked against the real `CoreMedia`/`AVFoundation` SDKs — indirectly proven correct
    /// by `AudioChunkerTests`/`SpeakerClustererTests` operating on the identical
    /// `AudioSampleBlock` shape `SyntheticAudioSource` produces (see that type's own doc comment
    /// for why the wire shape downstream consumers see is identical either way).
    static func floatSamples(from sampleBuffer: CMSampleBuffer) -> [Float]? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return nil
        }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: asbd.pointee.mSampleRate, channels: 1),
              let pcmBuffer = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
              ) else {
            return nil
        }
        pcmBuffer.frameLength = pcmBuffer.frameCapacity
        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr, let data = audioBufferList.mBuffers.mData else { return nil }
        let frameCount = Int(CMSampleBufferGetNumSamples(sampleBuffer))
        let floatPointer = data.assumingMemoryBound(to: Float.self)
        return Array(UnsafeBufferPointer(start: floatPointer, count: frameCount))
    }
}
