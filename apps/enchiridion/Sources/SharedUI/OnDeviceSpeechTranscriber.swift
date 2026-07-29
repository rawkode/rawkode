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
  private var activeSource: MicrophoneAnalyzerInputSource?
  private var activeAnalyzer: SpeechAnalyzer?
  private var activeResultTask: Task<String, any Error>?

  init(managesIOSAudioSession: Bool = true) {
    self.managesIOSAudioSession = managesIOSAudioSession
  }

  func availability() async -> AssistantVoiceAvailability {
    await availability(locale: .current)
  }

  func availability(locale: Locale) async -> AssistantVoiceAvailability {
    switch await AssistantSpeechAssets.shared.availability(locale: locale) {
    case .installationRequired:
      return .installationRequired
    case .downloading:
      return .installing
    case .unavailable(let reason):
      return .unavailable(reason)
    case .available:
      break
    }

    #if os(macOS)
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized: return .available
      case .notDetermined: return .permissionRequired
      case .denied, .restricted: return .permissionDenied
      @unknown default: return .unavailable("Microphone permission could not be determined.")
      }
    #else
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return .available
      case .undetermined: return .permissionRequired
      case .denied: return .permissionDenied
      @unknown default: return .unavailable("Microphone permission could not be determined.")
      }
    #endif
  }

  func requestPermission() async -> AssistantVoiceAvailability {
    guard await requestMicrophonePermission() else { return .permissionDenied }
    return await availability()
  }

  func installAssets() async throws {
    try await AssistantSpeechAssets.shared.install()
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
    let selectedModule = await AssistantSpeechAssets.shared.selectedModule(locale: locale)
    try Task.checkCancellation()
    guard let selectedModule else {
      throw OnDeviceSpeechError.unavailable(
        "Neither on-device transcription path supports the current language."
      )
    }
    let assetStatus = await AssetInventory.status(forModules: [selectedModule.module])
    try Task.checkCancellation()
    switch assetStatus {
    case .installed:
      break
    case .supported:
      throw OnDeviceSpeechError.unavailable(
        "Install the current language's on-device speech model first.")
    case .downloading:
      throw OnDeviceSpeechError.unavailable("The on-device speech model is still downloading.")
    case .unsupported:
      throw OnDeviceSpeechError.unavailable("The selected on-device speech model is unsupported.")
    @unknown default:
      throw OnDeviceSpeechError.unavailable("On-device speech transcription is unavailable.")
    }
    let hasMicrophonePermission = await requestMicrophonePermission()
    try Task.checkCancellation()
    guard hasMicrophonePermission else {
      throw OnDeviceSpeechError.microphonePermissionDenied
    }
    let format = await SpeechAnalyzer.bestAvailableAudioFormat(
      compatibleWith: [selectedModule.module]
    )
    try Task.checkCancellation()
    guard let format else {
      throw OnDeviceSpeechError.noAudioInput
    }

    do {
      #if os(iOS)
        if managesIOSAudioSession {
          try await HandheldConversationAudioSession.activate()
          try Task.checkCancellation()
        }
      #endif
      let text: String
      switch selectedModule {
      case .speech(let transcriber):
        text = try await capture(
          with: transcriber,
          format: format,
          maximumDuration: maximumDuration,
          silenceDuration: silenceDuration,
          text: { String($0.text.characters) }
        )
      case .dictation(let transcriber):
        text = try await capture(
          with: transcriber,
          format: format,
          maximumDuration: maximumDuration,
          silenceDuration: silenceDuration,
          text: { String($0.text.characters) }
        )
      }
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

  private func capture<Module: SpeechModule>(
    with transcriber: Module,
    format: AVAudioFormat,
    maximumDuration: Duration,
    silenceDuration: Duration,
    text: @escaping @Sendable (Module.Result) -> String
  ) async throws -> String {
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    do {
      try await analyzer.prepareToAnalyze(in: format)
      try Task.checkCancellation()
    } catch {
      await analyzer.cancelAndFinishNow()
      throw error
    }

    let source = MicrophoneAnalyzerInputSource(targetFormat: format)
    let inputSequence: AsyncStream<AnalyzerInput>
    do {
      inputSequence = try source.start()
      try Task.checkCancellation()
    } catch {
      source.stop()
      await analyzer.cancelAndFinishNow()
      throw error
    }
    let activity = TranscriptionActivity()
    let resultTask = Task { () throws -> String in
      var finalText = ""
      var latestText = ""
      for try await result in transcriber.results {
        let value = text(result)
        latestText = value
        await activity.record(value)
        if result.isFinal { finalText = value }
      }
      return finalText.isEmpty ? latestText : finalText
    }
    activeSource = source
    activeAnalyzer = analyzer
    activeResultTask = resultTask

    do {
      try await analyzer.start(inputSequence: inputSequence)
      try Task.checkCancellation()
      try await activity.waitForEndpoint(
        maximumDuration: maximumDuration,
        silenceDuration: silenceDuration
      )
      source.stop()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      let result = try await resultTask.value.trimmingCharacters(in: .whitespacesAndNewlines)
      clearCaptureIfCurrent(source)
      return result
    } catch {
      await stopCapture(source: source, analyzer: analyzer, resultTask: resultTask)
      throw error
    }
  }

  func stop() async {
    guard let source = activeSource else {
      #if os(iOS)
        if managesIOSAudioSession { await HandheldConversationAudioSession.deactivate() }
      #endif
      return
    }
    let analyzer = activeAnalyzer
    let resultTask = activeResultTask
    source.stop()
    resultTask?.cancel()
    if let analyzer { await analyzer.cancelAndFinishNow() }
    if let resultTask { _ = try? await resultTask.value }
    clearCaptureIfCurrent(source)
    #if os(iOS)
      if managesIOSAudioSession { await HandheldConversationAudioSession.deactivate() }
    #endif
  }

  private func stopCapture(
    source: MicrophoneAnalyzerInputSource,
    analyzer: SpeechAnalyzer,
    resultTask: Task<String, any Error>
  ) async {
    source.stop()
    resultTask.cancel()
    await analyzer.cancelAndFinishNow()
    _ = try? await resultTask.value
    clearCaptureIfCurrent(source)
  }

  private func clearCaptureIfCurrent(_ source: MicrophoneAnalyzerInputSource) {
    guard activeSource === source else { return }
    activeSource = nil
    activeAnalyzer = nil
    activeResultTask = nil
  }
}

@available(iOS 26.0, macOS 26.0, *)
actor AssistantSpeechAssets {
  static let shared = AssistantSpeechAssets()
  private var dictationFallbackLocales: Set<String> = []

  func availability(locale: Locale = .current) async -> OnDeviceSpeechAvailability {
    guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil else {
      return .unavailable("This build is missing its microphone privacy description.")
    }
    guard let selectedModule = await selectedModule(locale: locale) else {
      return .unavailable(
        "Neither on-device transcription path supports the current language."
      )
    }
    switch await AssetInventory.status(forModules: [selectedModule.module]) {
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
    guard let selection = await selectedModule(locale: locale) else {
      throw OnDeviceSpeechError.unavailable(
        "Neither on-device transcription path supports the current language."
      )
    }
    do {
      guard
        let request = try await AssetInventory.assetInstallationRequest(
          supporting: [selection.module]
        )
      else {
        throw OnDeviceSpeechError.unavailable(
          "The preferred on-device speech model cannot be installed on this device."
        )
      }
      try await request.downloadAndInstall()
    } catch {
      guard case .speech = selection,
        let fallback = await dictationModule(locale: locale)
      else { throw error }

      // Remember the fallback so status checks and live capture select the same
      // exact module type and locale that this installation request reserved.
      dictationFallbackLocales.insert(localeIdentifier(locale))
      switch await AssetInventory.status(forModules: [fallback.module]) {
      case .installed:
        return
      case .supported, .downloading:
        guard
          let fallbackRequest = try await AssetInventory.assetInstallationRequest(
            supporting: [fallback.module]
          )
        else {
          throw OnDeviceSpeechError.unavailable(
            "Neither local speech model can be installed on this device."
          )
        }
        try await fallbackRequest.downloadAndInstall()
      case .unsupported:
        throw OnDeviceSpeechError.unavailable(
          "Neither local speech model can be installed on this device."
        )
      @unknown default:
        throw OnDeviceSpeechError.unavailable("The on-device speech model is unavailable.")
      }
    }
  }

  fileprivate func selectedModule(locale: Locale) async -> SelectedSpeechModule? {
    if dictationFallbackLocales.contains(localeIdentifier(locale)) {
      return await dictationModule(locale: locale)
    }

    if SpeechTranscriber.isAvailable,
      let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
    {
      let progressive = SelectedSpeechModule.speech(
        SpeechTranscriber(locale: supportedLocale, preset: .progressiveTranscription)
      )
      if await AssetInventory.status(forModules: [progressive.module]) != .unsupported {
        return progressive
      }
    }
    return await dictationModule(locale: locale)
  }

  private func dictationModule(locale: Locale) async -> SelectedSpeechModule? {
    guard let supportedLocale = await DictationTranscriber.supportedLocale(equivalentTo: locale)
    else {
      return nil
    }
    return .dictation(
      DictationTranscriber(locale: supportedLocale, preset: .progressiveShortDictation)
    )
  }

  private func localeIdentifier(_ locale: Locale) -> String {
    locale.identifier(.bcp47)
  }
}

@available(iOS 26.0, macOS 26.0, *)
private enum SelectedSpeechModule: Sendable {
  case speech(SpeechTranscriber)
  case dictation(DictationTranscriber)

  var module: any SpeechModule {
    switch self {
    case .speech(let module): module
    case .dictation(let module): module
    }
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
        mode: .default,
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
  private var hasInstalledTap = false
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
    lock.withLock { hasInstalledTap = true }

    do {
      engine.prepare()
      try engine.start()
      lock.withLock { isRunning = true }
      return stream
    } catch {
      stop()
      throw error
    }
  }

  func stop() {
    let cleanup = lock.withLock { () -> (removeTap: Bool, stopEngine: Bool) in
      let cleanup = (hasInstalledTap, isRunning)
      hasInstalledTap = false
      isRunning = false
      return cleanup
    }
    guard cleanup.removeTap || cleanup.stopEngine else { return }
    if cleanup.removeTap { engine.inputNode.removeTap(onBus: 0) }
    if cleanup.stopEngine { engine.stop() }
    lock.withLock {
      continuation?.finish()
      continuation = nil
    }
  }

  private func yield(_ buffer: AVAudioPCMBuffer) {
    _ = lock.withLock { continuation?.yield(AnalyzerInput(buffer: buffer)) }
  }
}
