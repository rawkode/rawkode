import AVFoundation
import EnchiridionCore
import Foundation
import OSLog

#if os(macOS)
  import CoreAudio
#endif

enum AppleSystemSpeechOutputError: Error, LocalizedError {
  case voiceUnavailable(String)
  case speechRouteUnavailable

  var errorDescription: String? {
    switch self {
    case .voiceUnavailable(let language):
      return "No standard system voice is installed for \(language)."
    case .speechRouteUnavailable:
      return "The local speech route is unavailable."
    }
  }
}

/// Speaks assistant responses through Apple's public, on-device speech synthesizer.
/// The synthesizer is main-actor isolated because its delegate and audio route are
/// process-global UI concerns on Apple platforms.
@MainActor
final class AppleSystemSpeechOutput: NSObject, AssistantConversationSpeaking {
  typealias SynthesizerFactory = @MainActor @Sendable () -> AVSpeechSynthesizer

  private let locale: Locale
  private let voicePreferences: AssistantVoicePreferences
  private let speechOwner: AssistantLocalSpeechOwner
  private let synthesizerFactory: SynthesizerFactory
  private var synthesizer: AVSpeechSynthesizer
  private let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion",
    category: "AssistantSpeechOutput"
  )
  private var activeBatch = AssistantSpeechBatchLifecycle<AVSpeechUtterance>()
  private var continuation: CheckedContinuation<Void, any Error>?
  private var continuationBatchID: UUID?
  private var activeSpeechLease: (batchID: UUID, lease: AssistantLocalSpeechLease)?

  init(
    voicePreferences: AssistantVoicePreferences,
    speechOwner: AssistantLocalSpeechOwner = .assistant,
    locale: Locale = .current,
    synthesizerFactory: @escaping SynthesizerFactory = { AVSpeechSynthesizer() }
  ) {
    self.voicePreferences = voicePreferences
    self.speechOwner = speechOwner
    self.locale = locale
    self.synthesizerFactory = synthesizerFactory
    self.synthesizer = synthesizerFactory()
    super.init()
    configureSynthesizer()
  }

  func speak(_ text: String) async throws {
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

    cancelCurrentSpeech()
    try Task.checkCancellation()

    let language = locale.identifier(.bcp47)
    guard let voice = selectedVoice(for: locale) else {
      throw AppleSystemSpeechOutputError.voiceUnavailable(language)
    }

    logSelection(voice)

    let utterances = AssistantSpeechUtteranceFactory.makeUtterances(for: text, voice: voice)
    guard !utterances.isEmpty else { return }
    guard let batchID = activeBatch.begin(utterances) else { return }
    guard
      let speechLease = voicePreferences.acquireConversationSpeech(
        owner: speechOwner,
        stop: { [weak self] in
          self?.cancelCurrentSpeech(batchID: batchID)
        }
      )
    else {
      _ = activeBatch.cancel(batchID: batchID)
      throw AppleSystemSpeechOutputError.speechRouteUnavailable
    }
    activeSpeechLease = (batchID, speechLease)

    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        self.continuation = continuation
        continuationBatchID = batchID
        if Task.isCancelled {
          cancelCurrentSpeech(batchID: batchID)
        } else {
          for utterance in utterances {
            synthesizer.speak(utterance)
          }
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.cancelCurrentSpeech(batchID: batchID)
      }
    }
  }

  func stop() async {
    cancelCurrentSpeech()
  }

  func resetAfterMediaServicesReset() async {
    cancelCurrentSpeech()
    synthesizer.delegate = nil
    synthesizer = synthesizerFactory()
    configureSynthesizer()
  }

  private func configureSynthesizer() {
    synthesizer.delegate = self
    #if os(iOS)
      synthesizer.usesApplicationAudioSession = true
    #endif
  }

  private func selectedVoice(for locale: Locale) -> AVSpeechSynthesisVoice? {
    voicePreferences.selectedSystemVoice(for: locale)
  }

  private func quality(of voice: AVSpeechSynthesisVoice) -> AssistantSpeechVoiceQuality {
    switch voice.quality {
    case .premium:
      return .premium
    case .enhanced:
      return .enhanced
    default:
      return .default
    }
  }

  private func logSelection(_ voice: AVSpeechSynthesisVoice) {
    logger.info(
      "speech_voice_selected identifier=\(voice.identifier, privacy: .private) name=\(voice.name, privacy: .private) language=\(voice.language, privacy: .public) quality=\(self.qualityDescription(of: voice), privacy: .public) output_route=\(self.currentOutputRouteDescription(), privacy: .public)"
    )
  }

  private func qualityDescription(of voice: AVSpeechSynthesisVoice) -> String {
    switch voice.quality {
    case .premium:
      return "premium"
    case .enhanced:
      return "enhanced"
    default:
      return "default"
    }
  }

  private func currentOutputRouteDescription() -> String {
    #if os(iOS)
      let outputTypes = AVAudioSession.sharedInstance().currentRoute.outputs.map {
        $0.portType.rawValue
      }
      return outputTypes.isEmpty ? "none" : outputTypes.sorted().joined(separator: ",")
    #elseif os(macOS)
      return Self.macOSOutputRouteDescription()
    #else
      return "unknown"
    #endif
  }

  #if os(macOS)
    private static func macOSOutputRouteDescription() -> String {
      var outputDevice = AudioDeviceID(kAudioObjectUnknown)
      var propertySize = UInt32(MemoryLayout<AudioDeviceID>.size)
      var propertyAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      let outputDeviceStatus = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &propertyAddress,
        0,
        nil,
        &propertySize,
        &outputDevice
      )
      guard outputDeviceStatus == noErr, outputDevice != kAudioObjectUnknown else {
        return "unavailable"
      }

      var transportType: UInt32 = 0
      propertySize = UInt32(MemoryLayout<UInt32>.size)
      propertyAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
      )
      let transportStatus = AudioObjectGetPropertyData(
        outputDevice,
        &propertyAddress,
        0,
        nil,
        &propertySize,
        &transportType
      )
      guard transportStatus == noErr else { return "unknown" }

      switch transportType {
      case kAudioDeviceTransportTypeBuiltIn:
        return "built-in"
      case kAudioDeviceTransportTypeAggregate:
        return "aggregate"
      case kAudioDeviceTransportTypeVirtual:
        return "virtual"
      case kAudioDeviceTransportTypePCI:
        return "pci"
      case kAudioDeviceTransportTypeUSB:
        return "usb"
      case kAudioDeviceTransportTypeBluetooth:
        return "bluetooth"
      case kAudioDeviceTransportTypeBluetoothLE:
        return "bluetooth-le"
      case kAudioDeviceTransportTypeHDMI:
        return "hdmi"
      case kAudioDeviceTransportTypeDisplayPort:
        return "display-port"
      case kAudioDeviceTransportTypeAirPlay:
        return "airplay"
      case kAudioDeviceTransportTypeThunderbolt:
        return "thunderbolt"
      default:
        return "other"
      }
    }
  #endif

  private func cancelCurrentSpeech(batchID expectedBatchID: UUID? = nil) {
    guard
      let batchID = activeBatch.cancel(batchID: expectedBatchID) ?? continuationBatchID,
      expectedBatchID == nil || batchID == expectedBatchID
    else { return }
    synthesizer.stopSpeaking(at: .immediate)
    completeContinuation(for: batchID, with: .failure(CancellationError()))
  }

  private func completeContinuation(
    for batchID: UUID,
    with result: Result<Void, any Error>
  ) {
    if let activeSpeechLease, activeSpeechLease.batchID == batchID {
      voicePreferences.releaseConversationSpeech(activeSpeechLease.lease)
      self.activeSpeechLease = nil
    }
    guard continuationBatchID == batchID else { return }
    let pendingContinuation = continuation
    continuation = nil
    continuationBatchID = nil
    pendingContinuation?.resume(with: result)
  }
}

extension AppleSystemSpeechOutput: @preconcurrency AVSpeechSynthesizerDelegate {
  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    guard synthesizer === self.synthesizer, let batchID = activeBatch.finish(utterance) else {
      return
    }
    completeContinuation(for: batchID, with: .success(()))
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    guard synthesizer === self.synthesizer, activeBatch.contains(utterance) else { return }
    cancelCurrentSpeech()
  }
}
