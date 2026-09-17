#if os(iOS)
import ApsidesCore
import Combine
import CoreMedia
import Foundation
import Speech
import UIKit
@preconcurrency import AVFoundation

/// Owns one foreground microphone session. No cloud transport or speaker inference.
@MainActor
final class MeetingRecorder: ObservableObject {
    enum State { case idle, preparing, recording, finalizing, interrupted, failed }
    @Published private(set) var transcript: MeetingTranscript
    @Published private(set) var state: State = .idle
    @Published private(set) var error: String?
    @Published private(set) var liveSegment: MeetingTranscriptSegment?
    private var engine: AVAudioEngine?
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var resultTask: Task<Void, Never>?
    private var operation: UUID?
    private var observers = Set<AnyCancellable>()

    init(transcript: MeetingTranscript = .init()) {
        self.transcript = transcript.restored()
        if self.transcript.recordingState == .interrupted { state = .interrupted }
        let notifications = NotificationCenter.default
        notifications.publisher(for: AVAudioSession.interruptionNotification)
            .merge(with: notifications.publisher(for: AVAudioSession.routeChangeNotification),
                   notifications.publisher(for: UIApplication.didEnterBackgroundNotification))
            .receive(on: RunLoop.main)
            .sink { [weak self] notification in
                guard let self, self.state == .recording || self.state == .preparing || self.state == .finalizing else { return }
                if notification.name == AVAudioSession.routeChangeNotification {
                    guard self.state != .preparing,
                          let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                          let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                          reason != .categoryChange else { return }
                }
                if notification.name == AVAudioSession.interruptionNotification,
                   (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) != AVAudioSession.InterruptionType.began.rawValue { return }
                Task { await self.interrupt() }
            }.store(in: &observers)
    }

    func updateNote(_ text: String) { transcript.note = text }

    func start(participantsInformed: Bool, locale: Locale = .current) async {
        guard state == .idle || state == .interrupted || state == .failed else { return }
        guard participantsInformed else { error = "Let everyone know before recording."; return }
        guard transcript.recordingState != .stopped else { error = "Start a new meeting to record again."; return }
        let id = UUID()
        operation = id
        state = .preparing
        error = nil
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw RecorderFailure.message("Microphone access is off. Enable it in Settings to record this meeting.")
            }
            try check(id)
            guard SpeechTranscriber.isAvailable,
                  let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
                throw RecorderFailure.message("On-device transcription is not available for this device or language.")
            }
            try check(id)
            let transcriber = SpeechTranscriber(locale: supported, preset: .timeIndexedProgressiveTranscription)
            if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await installation.downloadAndInstall()
            }
            try check(id)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setActive(true)
            let audioEngine = AVAudioEngine()
            let microphone = audioEngine.inputNode
            let microphoneFormat = microphone.outputFormat(forBus: 0)
            guard microphoneFormat.sampleRate > 0, microphoneFormat.channelCount > 0,
                  let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: microphoneFormat) else {
                throw RecorderFailure.message("The microphone's audio format is unavailable.")
            }
            try check(id)
            let speech = SpeechAnalyzer(modules: [transcriber])
            analyzer = speech
            try await speech.prepareToAnalyze(in: format)
            try check(id)
            let sequence = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(16))
            input = sequence.continuation
            let pump = try MeetingAudioPump(from: microphoneFormat, to: format, output: sequence.continuation) { [weak self] message in
                Task { @MainActor in
                    guard let self, self.operation == id else { return }
                    await self.fail(message, operation: id)
                }
            }
            let offset = max(transcript.segments.map(\.end).max() ?? 0, Date().timeIntervalSince(transcript.startedAt))
            resultTask = Task { [weak self] in
                var revision = 0
                do {
                    for try await result in transcriber.results {
                        guard let self, self.operation == id else { return }
                        let start = CMTimeGetSeconds(result.range.start)
                        let end = CMTimeGetSeconds(CMTimeRangeGetEnd(result.range))
                        let itemID = MeetingSegmentID(stream: id, item: "\(CMTimeConvertScale(result.range.start, timescale: 1_000_000_000, method: .default).value)")
                        let text = String(result.text.characters)
                        if let previous = self.transcript.segments.first(where: { $0.id == itemID }),
                           previous.isFinal && result.isFinal && previous.text == text &&
                           previous.start == offset + start && previous.end == offset + end { continue }
                        revision += 1
                        let segment = try MeetingTranscriptSegment(
                            id: itemID, revision: revision, start: offset + start, end: offset + end,
                            text: text, isFinal: result.isFinal)
                        try self.transcript.reconcileRecognition(segment)
                        if result.isFinal {
                            if self.liveSegment?.start ?? .infinity < segment.end { self.liveSegment = nil }
                        } else { self.liveSegment = segment }
                    }
                } catch {
                    guard let self, self.operation == id else { return }
                    await self.fail("Transcription stopped: \(error.localizedDescription)", operation: id)
                }
            }
            try await speech.start(inputSequence: sequence.stream)
            try check(id)
            microphone.installTap(onBus: 0, bufferSize: 4096, format: microphoneFormat) { buffer, _ in pump.receive(buffer) }
            engine = audioEngine
            audioEngine.prepare()
            try audioEngine.start()
            try transcript.start(participantsInformed: true)
            state = .recording
        } catch {
            if operation == id { await fail(error.localizedDescription, operation: id) }
        }
    }

    func stop() async {
        if (state == .interrupted || state == .failed) && transcript.recordingState == .interrupted {
            try? transcript.stop()
            error = nil
            state = .idle
            return
        }
        guard state == .recording, let id = operation else { return }
        state = .finalizing
        let finishingAnalyzer = analyzer
        let finishingResults = resultTask
        stopMicrophone()
        input?.finish()
        input = nil
        let deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            guard let self, self.operation == id else { return }
            await self.fail("Transcription took too long to finish. The available transcript is preserved.", operation: id)
        }
        defer { deadline.cancel() }
        do {
            try await finishingAnalyzer?.finalizeAndFinishThroughEndOfInput()
            guard operation == id else { return }
            await finishingResults?.value
            guard operation == id else { return }
            try transcript.stop()
            operation = nil
            liveSegment = nil
            analyzer = nil
            resultTask = nil
            state = .idle
        } catch { await fail(error.localizedDescription, operation: id) }
    }

    func interrupt() async {
        guard let id = operation else { return }
        await finishInterrupted(operation: id)
        if operation == nil && state == .interrupted {
            error = "Recording paused. Tap Resume when you are ready."
        }
    }

    private func check(_ id: UUID) throws {
        try Task.checkCancellation()
        guard operation == id else { throw CancellationError() }
    }

    private func fail(_ message: String, operation id: UUID) async {
        guard operation == id else { return }
        await finishInterrupted(operation: id)
        if operation == nil && state == .interrupted { error = message; state = .failed }
    }

    private func finishInterrupted(operation id: UUID) async {
        guard operation == id else { return }
        operation = nil
        stopMicrophone()
        input?.finish()
        input = nil
        liveSegment = nil
        if transcript.recordingState == .recording { try? transcript.interrupt() }
        let oldAnalyzer = analyzer
        analyzer = nil
        resultTask?.cancel()
        resultTask = nil
        state = .interrupted
        await oldAnalyzer?.cancelAndFinishNow()
    }

    private func stopMicrophone() {
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

private enum RecorderFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(text) = self { return text }; return nil }
}

/// AVAudioEngine invokes the tap off the main actor. Conversion state is guarded
/// here; every yielded AnalyzerInput owns a newly allocated PCM buffer.
private final class MeetingAudioPump: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    private let output: AsyncStream<AnalyzerInput>.Continuation
    private let failure: @Sendable (String) -> Void
    private let lock = NSLock()
    private var frames: Int64 = 0
    private var failed = false

    init(from: AVAudioFormat, to: AVAudioFormat, output: AsyncStream<AnalyzerInput>.Continuation, failure: @escaping @Sendable (String) -> Void) throws {
        guard let converter = AVAudioConverter(from: from, to: to) else { throw RecorderFailure.message("Microphone conversion is unavailable.") }
        self.converter = converter; format = to; self.output = output; self.failure = failure
    }

    func receive(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard !failed else { return }
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate)) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { fail("Audio buffer allocation failed."); return }
        var supplied = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil else { fail("The microphone format changed. Resume recording to reconnect it."); return }
        guard converted.frameLength > 0 else { return }
        let time = CMTime(value: frames, timescale: CMTimeScale(format.sampleRate))
        frames += Int64(converted.frameLength)
        if case .dropped = output.yield(AnalyzerInput(buffer: converted, bufferStartTime: time)) {
            fail("Transcription could not keep up. Recording paused so audio is not silently lost.")
        }
    }

    private func fail(_ message: String) { failed = true; failure(message) }
}
#endif
