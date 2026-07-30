import AVFoundation
#if os(macOS)
  import CoreAudio
#endif
import EnchiridionCore
import Foundation
import OSLog

enum AppleSystemSpeechOutputError: Error, LocalizedError {
  case voiceUnavailable(String)

  var errorDescription: String? {
    switch self {
    case .voiceUnavailable(let language):
      return "No standard system voice is installed for \(language)."
    }
  }
}

/// Speaks assistant responses through Apple's public, on-device speech synthesizer.
/// The synthesizer is main-actor isolated because its delegate and audio route are
/// process-global UI concerns on Apple platforms.
@MainActor
final class AppleSystemSpeechOutput: NSObject, AssistantConversationSpeaking {
  private let locale: Locale
  private let synthesizer: AVSpeechSynthesizer
  private let managesIOSAudioSession: Bool
  private let logger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion",
    category: "AssistantSpeechOutput"
  )
  private var activeUtterance: AVSpeechUtterance?
  private var continuation: CheckedContinuation<Void, any Error>?

  init(
    locale: Locale = .current,
    synthesizer: AVSpeechSynthesizer = AVSpeechSynthesizer(),
    managesIOSAudioSession: Bool = true
  ) {
    self.locale = locale
    self.synthesizer = synthesizer
    self.managesIOSAudioSession = managesIOSAudioSession
    super.init()
    synthesizer.delegate = self
    #if os(iOS)
      synthesizer.usesApplicationAudioSession = true
    #endif
  }

  func speak(_ text: String) async throws {
    let spokenText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !spokenText.isEmpty else { return }

    cancelCurrentSpeech()
    try Task.checkCancellation()

    let language = locale.identifier(.bcp47)
    guard let voice = selectedVoice(for: locale) else {
      throw AppleSystemSpeechOutputError.voiceUnavailable(language)
    }

    #if os(iOS)
      if managesIOSAudioSession { try AssistantSpeechAudioSession.activate() }
    #endif

    logSelection(voice)

    let utterance = AVSpeechUtterance(string: spokenText)
    utterance.voice = voice
    activeUtterance = utterance

    do {
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          self.continuation = continuation
          if Task.isCancelled {
            completeCurrentSpeech(with: .failure(CancellationError()))
          } else {
            synthesizer.speak(utterance)
          }
        }
      } onCancel: {
        Task { @MainActor [weak self] in
          self?.cancelCurrentSpeech()
        }
      }
    } catch {
      finishAudioSession()
      throw error
    }
  }

  func stop() async {
    cancelCurrentSpeech()
  }

  private func selectedVoice(for locale: Locale) -> AVSpeechSynthesisVoice? {
    let voices = AVSpeechSynthesisVoice.speechVoices()
    let requestedTag = locale.identifier(.bcp47)
    let frameworkPreferredIdentifier =
      AVSpeechSynthesisVoice(language: requestedTag)?.identifier
    let candidates = voices.map { voice in
      AssistantSpeechVoiceCandidate(
        identifier: voice.identifier,
        language: voice.language,
        quality: quality(of: voice),
        isNovelty: voice.voiceTraits.contains(.isNoveltyVoice)
      )
    }
    guard
      let identifier = AssistantSpeechVoiceSelection.selectIdentifier(
        for: locale,
        from: candidates,
        frameworkPreferredIdentifier: frameworkPreferredIdentifier
      )
    else {
      return nil
    }
    return voices.first { $0.identifier == identifier }
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
      "speech_voice_selected identifier=\(voice.identifier, privacy: .public) name=\(voice.name, privacy: .public) language=\(voice.language, privacy: .public) quality=\(self.qualityDescription(of: voice), privacy: .public) output_route=\(self.currentOutputRouteDescription(), privacy: .public)"
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

  private func cancelCurrentSpeech() {
    guard activeUtterance != nil || continuation != nil else { return }
    synthesizer.stopSpeaking(at: .immediate)
    completeCurrentSpeech(with: .failure(CancellationError()))
  }

  private func completeCurrentSpeech(with result: Result<Void, any Error>) {
    activeUtterance = nil
    let pendingContinuation = continuation
    continuation = nil
    finishAudioSession()
    pendingContinuation?.resume(with: result)
  }

  private func finishAudioSession() {
    #if os(iOS)
      if managesIOSAudioSession { AssistantSpeechAudioSession.deactivate() }
    #endif
  }
}

extension AppleSystemSpeechOutput: @preconcurrency AVSpeechSynthesizerDelegate {
  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    guard utterance === activeUtterance else { return }
    completeCurrentSpeech(with: .success(()))
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    guard utterance === activeUtterance else { return }
    completeCurrentSpeech(with: .failure(CancellationError()))
  }
}

#if os(iOS)
  @MainActor
  private enum AssistantSpeechAudioSession {
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
