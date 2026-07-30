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
    let requestedLanguage = languageCode(in: requestedTag)

    return
      candidates
      .compactMap { candidate -> RankedCandidate? in
        guard !candidate.isNovelty, !candidate.isPersonalVoice else { return nil }

        let candidateTag = normalizedLanguageTag(candidate.language)
        guard languageCode(in: candidateTag) == requestedLanguage else { return nil }

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

  private static func normalizedLanguageTag(_ identifier: String) -> String {
    identifier
      .replacingOccurrences(of: "_", with: "-")
      .lowercased()
  }

  private static func languageCode(in tag: String) -> Substring {
    tag.split(separator: "-", maxSplits: 1).first ?? Substring(tag)
  }
}
