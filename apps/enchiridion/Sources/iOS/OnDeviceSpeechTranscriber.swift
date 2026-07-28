import AVFoundation
import Foundation
import Speech

enum OnDeviceSpeechAvailability: Sendable, Equatable {
  case available
  case unavailable(String)
}

enum OnDeviceSpeechError: Error, LocalizedError {
  case microphonePermissionDenied
  case noAudioInput
  case noSpeech
  case unavailable(String)

  var errorDescription: String? {
    switch self {
    case .microphonePermissionDenied:
      return "Microphone access is off. Allow it on the iPhone to use Enchiridion in CarPlay."
    case .noAudioInput:
      return "No microphone input is available on the current audio route."
    case .noSpeech:
      return "I didn't hear a request."
    case .unavailable(let reason):
      return reason
    }
  }
}

@available(iOS 26.0, *)
actor OnDeviceSpeechTranscriber {
  func availability(locale: Locale = .current) async -> OnDeviceSpeechAvailability {
    guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil else {
      return .unavailable("This build is missing its microphone privacy description.")
    }
    guard SpeechTranscriber.isAvailable else {
      return .unavailable("On-device speech transcription is unavailable on this iPhone.")
    }
    guard let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
      return .unavailable("On-device speech transcription does not support the current language.")
    }

    let module = SpeechTranscriber(locale: supportedLocale, preset: .transcription)
    switch await AssetInventory.status(forModules: [module]) {
    case .installed:
      return .available
    case .downloading:
      return .unavailable("The on-device speech model is still downloading on the iPhone.")
    case .supported:
      return .unavailable("Install the current language's speech model on the iPhone before driving.")
    case .unsupported:
      return .unavailable("The current language has no compatible on-device speech model.")
    @unknown default:
      return .unavailable("The on-device speech model is unavailable.")
    }
  }

  func requestMicrophonePermission() async -> Bool {
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      return true
    case .denied:
      return false
    case .undetermined:
      return await withCheckedContinuation { continuation in
        AVAudioApplication.requestRecordPermission { granted in
          continuation.resume(returning: granted)
        }
      }
    @unknown default:
      return false
    }
  }

  func transcribe(locale: Locale = .current, maximumDuration: Duration = .seconds(10)) async throws -> String {
    guard case .available = await availability(locale: locale) else {
      if case .unavailable(let reason) = await availability(locale: locale) {
        throw OnDeviceSpeechError.unavailable(reason)
      }
      throw OnDeviceSpeechError.unavailable("On-device speech transcription is unavailable.")
    }
    guard await requestMicrophonePermission() else {
      throw OnDeviceSpeechError.microphonePermissionDenied
    }

    guard let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
      throw OnDeviceSpeechError.unavailable("The current language is unsupported.")
    }
    let transcriber = SpeechTranscriber(locale: supportedLocale, preset: .progressiveTranscription)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw OnDeviceSpeechError.noAudioInput
    }

    let source = MicrophoneAnalyzerInputSource(targetFormat: format)
    let inputSequence = try source.start()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let resultTask = Task { () throws -> String in
      var finalText = ""
      var latestText = ""
      for try await result in transcriber.results {
        let value = String(result.text.characters)
        latestText = value
        if result.isFinal { finalText = value }
      }
      return finalText.isEmpty ? latestText : finalText
    }

    do {
      try await analyzer.prepareToAnalyze(in: format)
      try await analyzer.start(inputSequence: inputSequence)
      try await Task.sleep(for: maximumDuration)
      source.stop()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      let text = try await resultTask.value.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { throw OnDeviceSpeechError.noSpeech }
      return text
    } catch {
      source.stop()
      resultTask.cancel()
      await analyzer.cancelAndFinishNow()
      throw error
    }
  }
}

@available(iOS 26.0, *)
private final class MicrophoneAnalyzerInputSource: @unchecked Sendable {
  private let engine = AVAudioEngine()
  private let targetFormat: AVAudioFormat
  private let lock = NSLock()
  private var continuation: AsyncStream<AnalyzerInput>.Continuation?
  private var isRunning = false

  init(targetFormat: AVAudioFormat) {
    self.targetFormat = targetFormat
  }

  func start() throws -> AsyncStream<AnalyzerInput> {
    let stream = AsyncStream<AnalyzerInput> { continuation in
      lock.withLock { self.continuation = continuation }
    }
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
      throw OnDeviceSpeechError.noAudioInput
    }

    let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
    input.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat) { [weak self] buffer, _ in
      guard let self else { return }
      if inputFormat == self.targetFormat {
        self.yield(buffer)
        return
      }
      guard let converter,
        let converted = AVAudioPCMBuffer(
          pcmFormat: self.targetFormat,
          frameCapacity: AVAudioFrameCount(
            Double(buffer.frameLength) * self.targetFormat.sampleRate / inputFormat.sampleRate
          ) + 1
        )
      else { return }

      var supplied = false
      var conversionError: NSError?
      converter.convert(to: converted, error: &conversionError) { _, status in
        guard !supplied else {
          status.pointee = .noDataNow
          return nil
        }
        supplied = true
        status.pointee = .haveData
        return buffer
      }
      guard conversionError == nil else { return }
      self.yield(converted)
    }

    engine.prepare()
    try engine.start()
    lock.withLock { isRunning = true }
    return stream
  }

  func stop() {
    let shouldStop = lock.withLock { () -> Bool in
      guard isRunning else { return false }
      isRunning = false
      return true
    }
    guard shouldStop else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    lock.withLock {
      continuation?.finish()
      continuation = nil
    }
  }

  private func yield(_ buffer: AVAudioPCMBuffer) {
    _ = lock.withLock { continuation?.yield(AnalyzerInput(buffer: buffer)) }
  }
}
