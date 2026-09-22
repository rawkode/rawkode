import Foundation
import AudioToolbox
@preconcurrency import WebRTC

/// No AVAudioEngine, audio unit, microphone, or speaker is opened.
// WebRTC owns initialization properties on its ADM thread. All state shared with
// the PCM worker/UI (play, record, finish, enable, output) is protected by lock;
// input is immutable. The fixture rejects a second initialization.
final class SyntheticAudioDevice: NSObject, RTCAudioDevice, @unchecked Sendable {
    let deviceInputSampleRate = 48000.0, deviceOutputSampleRate = 48000.0
    let inputIOBufferDuration = 0.01, outputIOBufferDuration = 0.01
    let inputNumberOfChannels = 1, outputNumberOfChannels = 1
    let inputLatency = 0.0, outputLatency = 0.0
    private(set) var isInitialized = false
    private(set) var isPlayoutInitialized = false
    private(set) var isRecordingInitialized = false
    var isPlaying: Bool { lock.lock(); defer { lock.unlock() }; return playing }
    var isRecording: Bool { lock.lock(); defer { lock.unlock() }; return recording }
    private let lock = NSLock()
    private var playing = false, recording = false, finished = false, enabled = false
    private var used = false
    private var delegate: RTCAudioDeviceDelegate?
    private var worker: Thread?
    private let input: Data
    private var output = Data()
    init(input: Data) { self.input = input; super.init() }
    func beginSpeech() { lock.lock(); enabled = true; lock.unlock() }
    func capturedPCM() -> Data { lock.lock(); defer { lock.unlock() }; return output }
    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        // A single-run fixture: never let a new ADM reuse an earlier pump.
        guard !used else { return false }
        used = true
        self.delegate = delegate; isInitialized = true
        let thread = Thread { [weak self] in self?.pump(delegate) }
        worker = thread; thread.start(); return true
    }
    func terminateDevice() -> Bool {
        lock.lock(); finished = true; playing = false; recording = false; lock.unlock()
        // The worker owns the callback delegate until its final iteration completes.
        delegate = nil; isInitialized = false; return true
    }
    func initializePlayout() -> Bool { isPlayoutInitialized = true; return true }
    func initializeRecording() -> Bool { isRecordingInitialized = true; return true }
    func startPlayout() -> Bool { lock.lock(); playing = true; lock.unlock(); return true }
    func stopPlayout() -> Bool { lock.lock(); playing = false; lock.unlock(); return true }
    func startRecording() -> Bool { lock.lock(); recording = true; lock.unlock(); return true }
    func stopRecording() -> Bool { lock.lock(); recording = false; lock.unlock(); return true }
    private func pump(_ delegate: RTCAudioDeviceDelegate) {
        var offset = 0, sampleTime = 0.0
        let bytes = 960
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: bytes, alignment: 2)
        defer { buffer.deallocate() }
        while true {
            let start = Date()
            lock.lock()
            if finished { lock.unlock(); return }
            let record = recording, play = playing, speech = enabled
            // Termination waits for this callback pair and prevents subsequent calls.
            var flags: AudioUnitRenderActionFlags = []
            var timestamp = AudioTimeStamp(); timestamp.mSampleTime = sampleTime; timestamp.mFlags = .sampleTimeValid
            var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(bytes), mData: buffer))
            if record {
                buffer.initializeMemory(as: UInt8.self, repeating: 0, count: bytes)
                if speech && offset < input.count {
                    let count = min(bytes, input.count - offset)
                    input.withUnsafeBytes { source in buffer.copyMemory(from: source.baseAddress!.advanced(by: offset), byteCount: count) }
                    offset += count
                }
                _ = delegate.deliverRecordedData(&flags, &timestamp, 0, 480, &list, nil, nil)
            }
            if play {
                buffer.initializeMemory(as: UInt8.self, repeating: 0, count: bytes)
                if delegate.getPlayoutData(&flags, &timestamp, 0, 480, &list) == noErr {
                    if output.count < 48_000 * 2 * 90 { output.append(buffer.assumingMemoryBound(to: UInt8.self), count: bytes) }
                }
            }
            lock.unlock()
            sampleTime += 480
            Thread.sleep(forTimeInterval: max(0, 0.01 - Date().timeIntervalSince(start)))
        }
    }
}
