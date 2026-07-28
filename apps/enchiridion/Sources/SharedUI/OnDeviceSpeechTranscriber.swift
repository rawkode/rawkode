import AVFoundation
import EnchiridionCore
import Foundation
import Speech

enum OnDeviceSpeechAvailability: Sendable, Equatable {
  case available
  case installationRequired
  case downloading
  case unavailable(String)
}

enum AssistantSpeechSetupState: Sendable, Equatable {
  case checking
  case ready
  case installationRequired
  case installing
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
      return "Microphone access is off. Allow it in System Settings to talk to Enchiridion."
    case .noAudioInput:
      return "No microphone input is available on the current audio route."
    case .noSpeech:
      return "I didn't hear a request."
    case .unavailable(let reason):
      return reason
    }
  }
}

@available(iOS 26.0, macOS 26.0, *)
actor OnDeviceSpeechTranscriber: AssistantConversationTranscribing {
  private let managesIOSAudioSession: Bool

  init(managesIOSAudioSession: Bool = true) {
    self.managesIOSAudioSession = managesIOSAudioSession
  }

  func availability(locale: Locale = .current) async -> OnDeviceSpeechAvailability {
    await AssistantSpeechAssets.shared.availability(locale: locale)
  }

  func requestMicrophonePermission() async -> Bool {
    #if os(macOS)
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
      return true
    case .denied, .restricted:
      return false
    case .notDetermined:
      return await AVCaptureDevice.requestAccess(for: .audio)
    @unknown default:
      return false
    }
    #else
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
    #endif
  }

  func transcribe() async throws -> String {
    try await transcribe(
      locale: .current,
      maximumDuration: .seconds(15),
      silenceDuration: .milliseconds(1_200)
    )
  }

  func transcribe(
    locale: Locale,
    maximumDuration: Duration,
    silenceDuration: Duration
  ) async throws -> String {
    let currentAvailability = await availability(locale: locale)
    guard case .available = currentAvailability else {
      if case .installationRequired = currentAvailability {
        throw OnDeviceSpeechError.unavailable("Install the current language's on-device speech model first.")
      } else if case .downloading = currentAvailability {
        throw OnDeviceSpeechError.unavailable("The on-device speech model is still downloading.")
      } else if case .unavailable(let reason) = currentAvailability {
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

    #if os(iOS)
    if managesIOSAudioSession {
      try await HandheldConversationAudioSession.activate()
    }
    #endif
    do {
      let text = try await capture(
        with: transcriber,
        format: format,
        maximumDuration: maximumDuration,
        silenceDuration: silenceDuration
      )
      #if os(iOS)
      if managesIOSAudioSession { await HandheldConversationAudioSession.deactivate() }
      #endif
      guard !text.isEmpty else { throw OnDeviceSpeechError.noSpeech }
      return text
    } catch {
      #if os(iOS)
      if managesIOSAudioSession { await HandheldConversationAudioSession.deactivate() }
      #endif
      throw error
    }
  }

  private func capture(
    with transcriber: SpeechTranscriber,
    format: AVAudioFormat,
    maximumDuration: Duration,
    silenceDuration: Duration
  ) async throws -> String {
    let source = MicrophoneAnalyzerInputSource(targetFormat: format)
    let inputSequence = try source.start()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let activity = TranscriptionActivity()
    let resultTask = Task { () throws -> String in
      var finalText = ""
      var latestText = ""
      for try await result in transcriber.results {
        let value = String(result.text.characters)
        latestText = value
        await activity.record(value)
        if result.isFinal { finalText = value }
      }
      return finalText.isEmpty ? latestText : finalText
    }

    do {
      try await analyzer.prepareToAnalyze(in: format)
      try await analyzer.start(inputSequence: inputSequence)
      try await activity.waitForEndpoint(
        maximumDuration: maximumDuration,
        silenceDuration: silenceDuration
      )
      source.stop()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      return try await resultTask.value.trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
      source.stop()
      resultTask.cancel()
      await analyzer.cancelAndFinishNow()
      throw error
    }
  }
}

@available(iOS 26.0, macOS 26.0, *)
actor AssistantSpeechAssets {
  static let shared = AssistantSpeechAssets()

  func availability(locale: Locale = .current) async -> OnDeviceSpeechAvailability {
    guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil else {
      return .unavailable("This build is missing its microphone privacy description.")
    }
    guard SpeechTranscriber.isAvailable else {
      return .unavailable("On-device speech transcription is unavailable on this device.")
    }
    guard let module = await module(locale: locale) else {
      return .unavailable("On-device speech transcription does not support the current language.")
    }
    switch await AssetInventory.status(forModules: [module]) {
    case .installed: return .available
    case .downloading: return .downloading
    case .supported: return .installationRequired
    case .unsupported:
      return .unavailable("The current language has no compatible on-device speech model.")
    @unknown default:
      return .unavailable("The on-device speech model is unavailable.")
    }
  }

  func setupState(locale: Locale = .current) async -> AssistantSpeechSetupState {
    switch await availability(locale: locale) {
    case .available: .ready
    case .installationRequired: .installationRequired
    case .downloading: .installing
    case .unavailable(let message): .unavailable(message)
    }
  }

  func install(locale: Locale = .current) async throws {
    guard let module = await module(locale: locale) else {
      throw OnDeviceSpeechError.unavailable("The current language is unsupported.")
    }
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) else {
      throw OnDeviceSpeechError.unavailable("The on-device speech model cannot be installed on this device.")
    }
    try await request.downloadAndInstall()
  }

  private func module(locale: Locale) async -> SpeechTranscriber? {
    guard let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
      return nil
    }
    return SpeechTranscriber(locale: supportedLocale, preset: .progressiveTranscription)
  }
}

#if os(iOS)
@available(iOS 26.0, *)
@MainActor
private enum HandheldConversationAudioSession {
  static func activate() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .voiceChat,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
    try session.setActive(true)
  }

  static func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )
  }
}
#endif

@available(iOS 26.0, macOS 26.0, *)
private actor TranscriptionActivity {
  private let clock = ContinuousClock()
  private var latestText = ""
  private var lastChange: ContinuousClock.Instant?

  func record(_ value: String) {
    let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty, normalized != latestText else { return }
    latestText = normalized
    lastChange = clock.now
  }

  func waitForEndpoint(
    maximumDuration: Duration,
    silenceDuration: Duration
  ) async throws {
    let startedAt = clock.now
    while startedAt.duration(to: clock.now) < maximumDuration {
      try Task.checkCancellation()
      if let lastChange, lastChange.duration(to: clock.now) >= silenceDuration {
        return
      }
      try await Task.sleep(for: .milliseconds(100))
    }
  }
}

@available(iOS 26.0, macOS 26.0, *)
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
