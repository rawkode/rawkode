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

private enum SpeechPermissionState: Sendable, Equatable {
  case authorized
  case notDetermined
  case denied
  case unknown
}

enum OnDeviceSpeechError: Error, LocalizedError {
  case microphonePermissionDenied
  case speechRecognitionPermissionDenied
  case noAudioInput
  case noSpeech
  case unavailable(String)

  var errorDescription: String? {
    switch self {
    case .microphonePermissionDenied:
      return "Microphone access is off. Allow it in System Settings to talk to Enchiridion."
    case .speechRecognitionPermissionDenied:
      return "Speech Recognition access is off. Allow it in System Settings to talk to Enchiridion."
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
  private var activeResultTask: Task<Void, any Error>?

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

    return permissionAvailability()
  }

  func requestPermission() async -> AssistantVoiceAvailability {
    guard await requestMicrophonePermission() else { return .permissionDenied }
    guard await requestSpeechRecognitionPermission() else { return .permissionDenied }
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

  private var microphonePermissionIsAuthorized: Bool {
    #if os(macOS)
      AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    #else
      AVAudioApplication.shared.recordPermission == .granted
    #endif
  }

  private var speechRecognitionPermissionIsAuthorized: Bool {
    SFSpeechRecognizer.authorizationStatus() == .authorized
  }

  private func requestSpeechRecognitionPermission() async -> Bool {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
      return true
    case .denied, .restricted:
      return false
    case .notDetermined:
      return await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { status in
          continuation.resume(returning: status == .authorized)
        }
      }
    @unknown default:
      return false
    }
  }

  private func permissionAvailability() -> AssistantVoiceAvailability {
    let microphone: SpeechPermissionState
    #if os(macOS)
      microphone =
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: .authorized
        case .notDetermined: .notDetermined
        case .denied, .restricted: .denied
        @unknown default: .unknown
        }
    #else
      microphone =
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .authorized
        case .undetermined: .notDetermined
        case .denied: .denied
        @unknown default: .unknown
        }
    #endif

    let speech: SpeechPermissionState =
      switch SFSpeechRecognizer.authorizationStatus() {
      case .authorized: .authorized
      case .notDetermined: .notDetermined
      case .denied, .restricted: .denied
      @unknown default: .unknown
      }

    if microphone == .denied || speech == .denied { return .permissionDenied }
    if microphone == .notDetermined || speech == .notDetermined { return .permissionRequired }
    if microphone == .unknown || speech == .unknown {
      return .unavailable("Voice permission could not be determined.")
    }
    return .available
  }

  func transcribe() async throws -> String {
    switch try await transcribe(
      reportingProgress: { _ in },
      locale: .current,
      firstHypothesisTimeout: .seconds(5),
      maximumDuration: .seconds(15),
      stabilityDuration: .milliseconds(1_200)
    ) {
    case .utterance(let utterance):
      return utterance
    case .noSpeech:
      throw OnDeviceSpeechError.noSpeech
    }
  }

  func transcribe(
    reportingProgress: @escaping AssistantTranscriptionProgressHandler
  ) async throws -> AssistantTranscriptionOutcome {
    try await transcribe(
      reportingProgress: reportingProgress,
      locale: .current,
      firstHypothesisTimeout: .seconds(5),
      maximumDuration: .seconds(15),
      stabilityDuration: .milliseconds(1_200)
    )
  }

  func transcribe(
    reportingProgress: @escaping AssistantTranscriptionProgressHandler,
    locale: Locale,
    firstHypothesisTimeout: Duration,
    maximumDuration: Duration,
    stabilityDuration: Duration
  ) async throws -> AssistantTranscriptionOutcome {
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
    guard microphonePermissionIsAuthorized else {
      throw OnDeviceSpeechError.microphonePermissionDenied
    }
    guard speechRecognitionPermissionIsAuthorized else {
      throw OnDeviceSpeechError.speechRecognitionPermissionDenied
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
      let outcome: AssistantTranscriptionOutcome
      switch selectedModule {
      case .speech(let transcriber):
        outcome = try await capture(
          with: transcriber,
          format: format,
          reportingProgress: reportingProgress,
          firstHypothesisTimeout: firstHypothesisTimeout,
          maximumDuration: maximumDuration,
          stabilityDuration: stabilityDuration,
          text: { String($0.text.characters) }
        )
      case .dictation(let transcriber):
        outcome = try await capture(
          with: transcriber,
          format: format,
          reportingProgress: reportingProgress,
          firstHypothesisTimeout: firstHypothesisTimeout,
          maximumDuration: maximumDuration,
          stabilityDuration: stabilityDuration,
          text: { String($0.text.characters) }
        )
      }
      #if os(iOS)
        if managesIOSAudioSession { await HandheldConversationAudioSession.deactivate() }
      #endif
      return outcome
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
    reportingProgress: @escaping AssistantTranscriptionProgressHandler,
    firstHypothesisTimeout: Duration,
    maximumDuration: Duration,
    stabilityDuration: Duration,
    text: @escaping @Sendable (Module.Result) -> String
  ) async throws -> AssistantTranscriptionOutcome {
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
    let activity = TranscriptionActivity(
      firstHypothesisTimeout: firstHypothesisTimeout,
      stabilityDuration: stabilityDuration,
      hardLimit: maximumDuration
    )
    let resultTask = Task {
      for try await result in transcriber.results {
        let value = text(result)
        if let progress = await activity.record(value) {
          await reportingProgress(progress)
        }
      }
    }
    activeSource = source
    activeAnalyzer = analyzer
    activeResultTask = resultTask

    do {
      try await analyzer.start(inputSequence: inputSequence)
      try Task.checkCancellation()
      let outcome = try await activity.waitForEndpoint()
      source.stop()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      try await resultTask.value
      let finalizedOutcome = await activity.finalizedOutcome(preserving: outcome)
      clearCaptureIfCurrent(source)
      return finalizedOutcome
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
    resultTask: Task<Void, any Error>
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
    guard Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil
    else {
      return .unavailable("This build is missing its speech recognition privacy description.")
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
  private let startedAt: ContinuousClock.Instant
  private var tracker: AssistantTranscriptStabilityTracker

  init(
    firstHypothesisTimeout: Duration,
    stabilityDuration: Duration,
    hardLimit: Duration
  ) {
    let clock = ContinuousClock()
    self.startedAt = clock.now
    self.tracker = AssistantTranscriptStabilityTracker(
      firstHypothesisTimeout: firstHypothesisTimeout,
      stabilityDuration: stabilityDuration,
      hardLimit: hardLimit
    )
  }

  func record(_ value: String) -> String? {
    tracker.record(value, at: startedAt.duration(to: clock.now))
  }

  func waitForEndpoint() async throws -> AssistantTranscriptionOutcome {
    while true {
      try Task.checkCancellation()
      switch tracker.decision(at: startedAt.duration(to: clock.now)) {
      case .continueListening:
        try await Task.sleep(for: .milliseconds(100))
      case .finalize(let utterance):
        return .utterance(utterance)
      case .noSpeech:
        return .noSpeech
      }
    }
  }

  func finalizedOutcome(
    preserving endpointOutcome: AssistantTranscriptionOutcome
  ) -> AssistantTranscriptionOutcome {
    tracker.finalizedOutcome(preserving: endpointOutcome)
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
