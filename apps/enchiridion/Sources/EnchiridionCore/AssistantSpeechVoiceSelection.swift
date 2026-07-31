import Foundation

public enum AssistantSpeechVoiceQuality: Int, Sendable {
  case `default`
  case enhanced
  case premium
}

public struct AssistantSpeechVoiceCandidate: Equatable, Sendable {
  public var identifier: String
  public var language: String
  public var quality: AssistantSpeechVoiceQuality
  public var isNovelty: Bool
  public var isPersonalVoice: Bool

  public init(
    identifier: String,
    language: String,
    quality: AssistantSpeechVoiceQuality,
    isNovelty: Bool = false,
    isPersonalVoice: Bool = false
  ) {
    self.identifier = identifier
    self.language = language
    self.quality = quality
    self.isNovelty = isNovelty
    self.isPersonalVoice = isPersonalVoice
  }
}

public enum AssistantVoicePreference: Equatable, Sendable {
  case automatic
  case specific(identifier: String)
}

public struct AssistantVoiceResolution: Equatable, Sendable {
  public var effectiveIdentifier: String?
  public var isUsingAutomaticFallback: Bool

  public init(
    effectiveIdentifier: String?,
    isUsingAutomaticFallback: Bool
  ) {
    self.effectiveIdentifier = effectiveIdentifier
    self.isUsingAutomaticFallback = isUsingAutomaticFallback
  }
}

public enum AssistantSpeechVoiceSelection {
  /// Selects a predictable system voice without crossing language boundaries.
  /// Voice quality wins before an exact regional locale match so an installed
  /// premium or enhanced voice is never displaced by a compact legacy voice.
  /// Within the same quality and locale tier, Apple's requested-language voice
  /// wins before the deterministic identifier fallback.
  public static func selectIdentifier(
    for locale: Locale,
    from candidates: [AssistantSpeechVoiceCandidate],
    frameworkPreferredIdentifier: String? = nil
  ) -> String? {
    let requestedTag = normalizedLanguageTag(locale.identifier(.bcp47))
    let requestedLanguage = languageIdentity(for: requestedTag)

    return
      candidates
      .compactMap { candidate -> RankedCandidate? in
        guard !candidate.isNovelty, !candidate.isPersonalVoice else { return nil }

        let candidateTag = normalizedLanguageTag(candidate.language)
        let candidateLanguage = languageIdentity(for: candidateTag)
        guard
          candidateLanguage.languageCode == requestedLanguage.languageCode,
          scriptsAreCompatible(candidateLanguage.script, requestedLanguage.script)
        else { return nil }

        return RankedCandidate(
          candidate: candidate,
          isExactLocaleMatch: candidateTag == requestedTag
        )
      }
      .sorted { lhs, rhs in
        if lhs.candidate.quality != rhs.candidate.quality {
          return lhs.candidate.quality.rawValue > rhs.candidate.quality.rawValue
        }
        if lhs.isExactLocaleMatch != rhs.isExactLocaleMatch {
          return lhs.isExactLocaleMatch
        }
        let lhsIsFrameworkPreferred =
          lhs.candidate.identifier == frameworkPreferredIdentifier
        let rhsIsFrameworkPreferred =
          rhs.candidate.identifier == frameworkPreferredIdentifier
        if lhsIsFrameworkPreferred != rhsIsFrameworkPreferred {
          return lhsIsFrameworkPreferred
        }
        return lhs.candidate.identifier < rhs.candidate.identifier
      }
      .first?
      .candidate
      .identifier
  }

  /// Resolves the stored preference without mutating it. A missing explicit
  /// voice uses Automatic until the same identifier becomes available again.
  public static func resolve(
    _ preference: AssistantVoicePreference,
    for locale: Locale,
    from candidates: [AssistantSpeechVoiceCandidate],
    frameworkPreferredIdentifier: String? = nil
  ) -> AssistantVoiceResolution {
    switch preference {
    case .automatic:
      return AssistantVoiceResolution(
        effectiveIdentifier: selectIdentifier(
          for: locale,
          from: candidates,
          frameworkPreferredIdentifier: frameworkPreferredIdentifier
        ),
        isUsingAutomaticFallback: false
      )
    case .specific(let identifier):
      if candidates.contains(where: {
        $0.identifier == identifier && !$0.isNovelty
      }) {
        return AssistantVoiceResolution(
          effectiveIdentifier: identifier,
          isUsingAutomaticFallback: false
        )
      }
      return AssistantVoiceResolution(
        effectiveIdentifier: selectIdentifier(
          for: locale,
          from: candidates,
          frameworkPreferredIdentifier: frameworkPreferredIdentifier
        ),
        isUsingAutomaticFallback: true
      )
    }
  }

  private struct RankedCandidate {
    var candidate: AssistantSpeechVoiceCandidate
    var isExactLocaleMatch: Bool
  }

  private struct LanguageIdentity {
    var languageCode: String
    var script: String?
  }

  private static func normalizedLanguageTag(_ identifier: String) -> String {
    identifier
      .replacingOccurrences(of: "_", with: "-")
      .lowercased()
  }

  /// Foundation's locale data applies Unicode likely-subtag inference. This
  /// keeps an underspecified locale such as zh-TW compatible with Hant voices,
  /// while rejecting an installed Hans voice that would pronounce different
  /// written text despite sharing the same base language code.
  private static func languageIdentity(for tag: String) -> LanguageIdentity {
    let language = Locale.Language(identifier: tag)
    let languageCode =
      language.languageCode?.identifier.lowercased()
      ?? tag.split(separator: "-", maxSplits: 1).first.map(String.init)
      ?? tag
    return LanguageIdentity(
      languageCode: languageCode,
      script: language.script?.identifier.lowercased()
    )
  }

  private static func scriptsAreCompatible(_ lhs: String?, _ rhs: String?) -> Bool {
    guard let lhs, let rhs else { return true }
    return lhs == rhs
  }
}

public enum AssistantLocalSpeechOwner: Equatable, Sendable {
  case assistant
  case carPlay
  case preview
}

public struct AssistantLocalSpeechLease: Equatable, Sendable {
  public let owner: AssistantLocalSpeechOwner
  public let generation: UInt64

  public init(owner: AssistantLocalSpeechOwner, generation: UInt64) {
    self.owner = owner
    self.generation = generation
  }
}

/// Serializes every local synthesizer that shares the process audio route.
/// Assistant and CarPlay speech may preempt a preview. A preview never
/// interrupts an active conversation and instead declines to start.
@MainActor
public final class AssistantLocalSpeechCoordinator {
  private struct ActiveLease {
    let lease: AssistantLocalSpeechLease
    let stop: @MainActor () -> Void
  }

  private var generation: UInt64 = 0
  private var active: ActiveLease?

  public init() {}

  public var activeOwner: AssistantLocalSpeechOwner? {
    active?.lease.owner
  }

  public var hasActiveConversationSpeech: Bool {
    guard let owner = activeOwner else { return false }
    return owner == .assistant || owner == .carPlay
  }

  @discardableResult
  public func acquire(
    owner: AssistantLocalSpeechOwner,
    stop: @escaping @MainActor () -> Void
  ) -> AssistantLocalSpeechLease? {
    if owner == .preview, active != nil {
      return nil
    }

    generation &+= 1
    let lease = AssistantLocalSpeechLease(owner: owner, generation: generation)
    let displaced = active
    active = ActiveLease(lease: lease, stop: stop)
    displaced?.stop()
    return lease
  }

  /// Only the exact owner generation may release the route. Delayed delegate
  /// callbacks from a displaced synthesizer are harmless.
  @discardableResult
  public func release(_ lease: AssistantLocalSpeechLease) -> Bool {
    guard active?.lease == lease else { return false }
    active = nil
    return true
  }

  /// Stops and releases only an exact live lease. Calling this repeatedly or
  /// with a stale generation is an intentional no-op.
  @discardableResult
  public func stop(_ lease: AssistantLocalSpeechLease) -> Bool {
    guard active?.lease == lease else { return false }
    let stopping = active
    active = nil
    stopping?.stop()
    return true
  }
}

private final class AssistantVoiceCatalogObservationState: @unchecked Sendable {
  private let lock = NSLock()
  private var active = true

  func cancel() {
    lock.withLock { active = false }
  }

  var isActive: Bool {
    lock.withLock { active }
  }
}

/// Bridges system voice-catalog notifications onto the main actor and fences
/// queued callbacks after cancellation or teardown.
public final class AssistantVoiceCatalogChangeObservation: @unchecked Sendable {
  private let notificationCenter: NotificationCenter
  private let state: AssistantVoiceCatalogObservationState
  private let token: NSObjectProtocol

  public init(
    notificationCenter: NotificationCenter = .default,
    name: Notification.Name,
    onChange: @escaping @MainActor @Sendable () -> Void
  ) {
    self.notificationCenter = notificationCenter
    let state = AssistantVoiceCatalogObservationState()
    self.state = state
    token = notificationCenter.addObserver(
      forName: name,
      object: nil,
      queue: nil
    ) { _ in
      guard state.isActive else { return }
      Task { @MainActor in
        guard state.isActive else { return }
        onChange()
      }
    }
  }

  public func cancel() {
    state.cancel()
    notificationCenter.removeObserver(token)
  }

  deinit {
    cancel()
  }
}
