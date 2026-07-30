import AVFoundation
import EnchiridionCore
import Foundation
import Observation

private final class AssistantVoiceNotificationObservation: @unchecked Sendable {
  private let token: NSObjectProtocol

  init(token: NSObjectProtocol) {
    self.token = token
  }

  func cancel() {
    NotificationCenter.default.removeObserver(token)
  }
}

struct AssistantInstalledVoice: Identifiable, Equatable {
  let identifier: String
  let name: String
  let language: String
  let localizedLocaleName: String
  let quality: AssistantSpeechVoiceQuality
  let isPersonalVoice: Bool

  var id: String { identifier }

  var qualityName: String {
    switch quality {
    case .default: "Basic"
    case .enhanced: "Enhanced"
    case .premium: "Premium"
    }
  }
}

@MainActor
@Observable
final class AssistantVoicePreferences: NSObject {
  static let previewPhrase = "Here’s what matters today. You have time to focus."

  private(set) var preference: AssistantVoicePreference
  private(set) var availableVoices: [AssistantInstalledVoice] = []
  private(set) var isPreviewing = false

  @ObservationIgnored private let locale: Locale
  @ObservationIgnored private let store: AssistantVoicePreferenceDefaultsStore
  @ObservationIgnored private let previewSynthesizer: AVSpeechSynthesizer
  @ObservationIgnored private var availableVoicesObservation: AssistantVoiceNotificationObservation?
  @ObservationIgnored private var activePreviewUtterance: AVSpeechUtterance?
  @ObservationIgnored private var previewVoiceIdentifier: String?

  init(
    locale: Locale = .current,
    defaults: UserDefaults = .standard,
    previewSynthesizer: AVSpeechSynthesizer = AVSpeechSynthesizer()
  ) {
    self.locale = locale
    store = AssistantVoicePreferenceDefaultsStore(defaults: defaults)
    preference = store.load()
    self.previewSynthesizer = previewSynthesizer
    super.init()
    previewSynthesizer.delegate = self
    let token = NotificationCenter.default.addObserver(
      forName: AVSpeechSynthesizer.availableVoicesDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor [weak self] in
        self?.refresh()
      }
    }
    availableVoicesObservation = AssistantVoiceNotificationObservation(token: token)
    refresh()
  }

  deinit {
    availableVoicesObservation?.cancel()
  }

  var effectiveVoice: AssistantInstalledVoice? {
    effectiveVoice(for: locale)
  }

  var isStoredSelectionUnavailable: Bool {
    guard case .specific(let identifier) = preference else { return false }
    return !availableVoices.contains { $0.identifier == identifier }
  }

  var preferenceName: String {
    switch preference {
    case .automatic:
      "Automatic"
    case .specific(let identifier):
      availableVoices.first { $0.identifier == identifier }?.name ?? "Unavailable Voice"
    }
  }

  func select(_ preference: AssistantVoicePreference) {
    stopPreview()
    self.preference = preference
    store.save(preference)
  }

  func refresh() {
    let refreshedVoices = selectableSystemVoices().map(Self.describe)
    if refreshedVoices != availableVoices {
      availableVoices = refreshedVoices
    }
    if let previewVoiceIdentifier,
      !refreshedVoices.contains(where: { $0.identifier == previewVoiceIdentifier })
    {
      stopPreview()
    }
  }

  func selectedSystemVoice(for locale: Locale) -> AVSpeechSynthesisVoice? {
    let voices = selectableSystemVoices()
    let candidates = voices.map(Self.candidate)
    let requestedTag = locale.identifier(.bcp47)
    let resolution = AssistantSpeechVoiceSelection.resolve(
      preference,
      for: locale,
      from: candidates,
      frameworkPreferredIdentifier: AVSpeechSynthesisVoice(language: requestedTag)?.identifier
    )
    guard let identifier = resolution.effectiveIdentifier else { return nil }
    return voices.first { $0.identifier == identifier }
  }

  func effectiveVoice(for locale: Locale) -> AssistantInstalledVoice? {
    selectedSystemVoice(for: locale).map(Self.describe)
  }

  func togglePreview() {
    if isPreviewing {
      stopPreview()
      return
    }
    guard let voice = selectedSystemVoice(for: locale) else { return }
    let utterance = AVSpeechUtterance(string: Self.previewPhrase)
    utterance.voice = voice
    activePreviewUtterance = utterance
    previewVoiceIdentifier = voice.identifier
    isPreviewing = true
    previewSynthesizer.speak(utterance)
  }

  func stopPreview() {
    guard isPreviewing || previewSynthesizer.isSpeaking else { return }
    previewSynthesizer.stopSpeaking(at: .immediate)
    activePreviewUtterance = nil
    previewVoiceIdentifier = nil
    isPreviewing = false
  }

  private func selectableSystemVoices() -> [AVSpeechSynthesisVoice] {
    let personalVoiceIsAuthorized =
      AVSpeechSynthesizer.personalVoiceAuthorizationStatus == .authorized
    return AVSpeechSynthesisVoice.speechVoices()
      .filter { voice in
        guard !voice.voiceTraits.contains(.isNoveltyVoice) else { return false }
        return !voice.voiceTraits.contains(.isPersonalVoice) || personalVoiceIsAuthorized
      }
      .sorted { lhs, rhs in
        if lhs.language != rhs.language {
          return lhs.language.localizedStandardCompare(rhs.language) == .orderedAscending
        }
        let nameOrder = lhs.name.localizedStandardCompare(rhs.name)
        if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
        return lhs.identifier < rhs.identifier
      }
  }

  private static func candidate(_ voice: AVSpeechSynthesisVoice)
    -> AssistantSpeechVoiceCandidate
  {
    AssistantSpeechVoiceCandidate(
      identifier: voice.identifier,
      language: voice.language,
      quality: quality(of: voice),
      isNovelty: voice.voiceTraits.contains(.isNoveltyVoice),
      isPersonalVoice: voice.voiceTraits.contains(.isPersonalVoice)
    )
  }

  private static func describe(_ voice: AVSpeechSynthesisVoice) -> AssistantInstalledVoice {
    AssistantInstalledVoice(
      identifier: voice.identifier,
      name: voice.name,
      language: voice.language,
      localizedLocaleName: Locale.current.localizedString(forIdentifier: voice.language)
        ?? voice.language,
      quality: quality(of: voice),
      isPersonalVoice: voice.voiceTraits.contains(.isPersonalVoice)
    )
  }

  private static func quality(of voice: AVSpeechSynthesisVoice)
    -> AssistantSpeechVoiceQuality
  {
    switch voice.quality {
    case .premium: .premium
    case .enhanced: .enhanced
    default: .default
    }
  }
}

extension AssistantVoicePreferences: @preconcurrency AVSpeechSynthesizerDelegate {
  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    guard
      synthesizer === previewSynthesizer,
      utterance === activePreviewUtterance
    else { return }
    activePreviewUtterance = nil
    previewVoiceIdentifier = nil
    isPreviewing = false
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    guard
      synthesizer === previewSynthesizer,
      utterance === activePreviewUtterance
    else { return }
    activePreviewUtterance = nil
    previewVoiceIdentifier = nil
    isPreviewing = false
  }
}
