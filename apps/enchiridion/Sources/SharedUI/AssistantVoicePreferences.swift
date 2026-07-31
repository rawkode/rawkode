import AVFoundation
import EnchiridionCore
import Foundation
import Observation

@MainActor
protocol AssistantSystemVoiceCatalog: AnyObject {
  func installedVoices() -> [AVSpeechSynthesisVoice]
  func observeChanges(
    _ onChange: @escaping @MainActor @Sendable () -> Void
  ) -> AssistantVoiceCatalogChangeObservation
}

@MainActor
final class AppleAssistantSystemVoiceCatalog: AssistantSystemVoiceCatalog {
  private let notificationCenter: NotificationCenter

  init(notificationCenter: NotificationCenter = .default) {
    self.notificationCenter = notificationCenter
  }

  func installedVoices() -> [AVSpeechSynthesisVoice] {
    AVSpeechSynthesisVoice.speechVoices()
  }

  func observeChanges(
    _ onChange: @escaping @MainActor @Sendable () -> Void
  ) -> AssistantVoiceCatalogChangeObservation {
    AssistantVoiceCatalogChangeObservation(
      notificationCenter: notificationCenter,
      name: AVSpeechSynthesizer.availableVoicesDidChangeNotification,
      onChange: onChange
    )
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
  private(set) var isConversationSpeechActive = false

  @ObservationIgnored private let locale: Locale
  @ObservationIgnored private let store: AssistantVoicePreferenceDefaultsStore
  @ObservationIgnored private let voiceCatalog: any AssistantSystemVoiceCatalog
  @ObservationIgnored private let speechCoordinator: AssistantLocalSpeechCoordinator
  @ObservationIgnored private let previewSynthesizer: AVSpeechSynthesizer
  @ObservationIgnored private var availableVoicesObservation:
    AssistantVoiceCatalogChangeObservation?
  @ObservationIgnored private var previewBatch =
    AssistantSpeechBatchLifecycle<AVSpeechUtterance>()
  @ObservationIgnored private var previewVoiceIdentifier: String?
  @ObservationIgnored private var previewSpeechLease: AssistantLocalSpeechLease?

  init(
    locale: Locale = .current,
    defaults: UserDefaults = .standard,
    voiceCatalog: any AssistantSystemVoiceCatalog = AppleAssistantSystemVoiceCatalog(),
    speechCoordinator: AssistantLocalSpeechCoordinator = AssistantLocalSpeechCoordinator(),
    previewSynthesizer: AVSpeechSynthesizer = AVSpeechSynthesizer()
  ) {
    self.locale = locale
    store = AssistantVoicePreferenceDefaultsStore(defaults: defaults)
    preference = store.load()
    self.voiceCatalog = voiceCatalog
    self.speechCoordinator = speechCoordinator
    self.previewSynthesizer = previewSynthesizer
    super.init()
    previewSynthesizer.delegate = self
    availableVoicesObservation = voiceCatalog.observeChanges { [weak self] in
      self?.refresh()
    }
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
      "Best Available"
    case .specific(let identifier):
      availableVoices.first { $0.identifier == identifier }?.name ?? "Unavailable Voice"
    }
  }

  func isPreferredLanguage(_ language: String) -> Bool {
    Locale.Language(identifier: language).languageCode
      == Locale.Language(identifier: locale.identifier(.bcp47)).languageCode
  }

  func isPreferredLocale(_ language: String) -> Bool {
    language.replacingOccurrences(of: "_", with: "-").lowercased()
      == locale.identifier(.bcp47).lowercased()
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
    let utterances = AssistantSpeechUtteranceFactory.makeUtterances(
      for: Self.previewPhrase,
      voice: voice
    )
    guard previewBatch.begin(utterances) != nil else { return }
    guard
      let lease = speechCoordinator.acquire(
        owner: .preview,
        stop: { [weak self] in
          self?.stopPreview()
        })
    else {
      _ = previewBatch.cancel()
      return
    }
    previewSpeechLease = lease
    previewVoiceIdentifier = voice.identifier
    isPreviewing = true
    for utterance in utterances {
      previewSynthesizer.speak(utterance)
    }
  }

  func stopPreview() {
    guard
      previewBatch.cancel() != nil || isPreviewing || previewSynthesizer.isSpeaking
        || previewSynthesizer.isPaused
    else {
      return
    }
    if let previewSpeechLease {
      _ = speechCoordinator.release(previewSpeechLease)
    }
    previewSpeechLease = nil
    previewVoiceIdentifier = nil
    isPreviewing = false
    previewSynthesizer.stopSpeaking(at: .immediate)
  }

  func acquireConversationSpeech(
    owner: AssistantLocalSpeechOwner,
    stop: @escaping @MainActor () -> Void
  ) -> AssistantLocalSpeechLease? {
    guard let lease = speechCoordinator.acquire(owner: owner, stop: stop) else {
      return nil
    }
    isConversationSpeechActive = true
    return lease
  }

  func releaseConversationSpeech(_ lease: AssistantLocalSpeechLease) {
    _ = speechCoordinator.release(lease)
    isConversationSpeechActive = speechCoordinator.hasActiveConversationSpeech
  }

  private func selectableSystemVoices() -> [AVSpeechSynthesisVoice] {
    let personalVoiceIsAuthorized =
      AVSpeechSynthesizer.personalVoiceAuthorizationStatus == .authorized
    return voiceCatalog.installedVoices()
      .filter { voice in
        guard !voice.voiceTraits.contains(.isNoveltyVoice) else { return false }
        return !voice.voiceTraits.contains(.isPersonalVoice) || personalVoiceIsAuthorized
      }
      .sorted { lhs, rhs in
        if lhs.language != rhs.language {
          return lhs.language.localizedStandardCompare(rhs.language) == .orderedAscending
        }
        if lhs.quality != rhs.quality {
          return lhs.quality.rawValue > rhs.quality.rawValue
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
      previewBatch.finish(utterance) != nil
    else { return }
    if let previewSpeechLease {
      _ = speechCoordinator.release(previewSpeechLease)
    }
    previewSpeechLease = nil
    previewVoiceIdentifier = nil
    isPreviewing = false
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    guard
      synthesizer === previewSynthesizer,
      previewBatch.contains(utterance)
    else { return }
    stopPreview()
  }
}
