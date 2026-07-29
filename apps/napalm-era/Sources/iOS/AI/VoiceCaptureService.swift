@preconcurrency import AVFoundation
import Foundation
import Observation
import Speech

@MainActor
@Observable
final class VoiceCaptureService: NSObject, AVAudioRecorderDelegate {
    private(set) var isRecording = false
    private var recorder: AVAudioRecorder?
    private var temporaryURL: URL?

    func start() async throws {
        let permitted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard permitted else { throw VoiceCaptureError.permissionDenied }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("napalm-era-\(UUID().uuidString)")
            .appendingPathExtension("caf")
        let recorder = try AVAudioRecorder(
            url: url,
            settings: [
                AVFormatIDKey: Int(kAudioFormatLinearPCM),
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
            ]
        )
        recorder.delegate = self
        recorder.prepareToRecord()
        guard recorder.record() else { throw VoiceCaptureError.couldNotRecord }
        self.recorder = recorder
        temporaryURL = url
        isRecording = true
    }

    func stopAndTranscribe() async throws -> String {
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let url = temporaryURL else { throw VoiceCaptureError.missingRecording }
        defer { deleteTemporaryFile() }

        let locale = await SpeechTranscriber.supportedLocale(equivalentTo: .autoupdatingCurrent) ?? Locale(identifier: "en_GB")
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let audioFile = try AVAudioFile(forReading: url)

        let analysis = Task { try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true) }
        var transcript = ""
        do {
            for try await result in transcriber.results {
                transcript = String(result.text.characters)
            }
            try await analysis.value
        } catch {
            analysis.cancel()
            throw error
        }
        return transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancelAndDelete() {
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        deleteTemporaryFile()
    }

    private func deleteTemporaryFile() {
        if let temporaryURL { try? FileManager.default.removeItem(at: temporaryURL) }
        temporaryURL = nil
    }
}

enum VoiceCaptureError: LocalizedError {
    case permissionDenied, couldNotRecord, missingRecording

    var errorDescription: String? {
        switch self {
        case .permissionDenied: "Microphone access is required for voice nutrition entry."
        case .couldNotRecord: "The voice recording could not start."
        case .missingRecording: "The temporary voice recording was not available."
        }
    }
}
