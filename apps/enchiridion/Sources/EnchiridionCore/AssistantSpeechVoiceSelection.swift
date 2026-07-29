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

  public init(
    identifier: String,
    language: String,
    quality: AssistantSpeechVoiceQuality,
    isNovelty: Bool = false
  ) {
    self.identifier = identifier
    self.language = language
    self.quality = quality
    self.isNovelty = isNovelty
  }
}

public enum AssistantSpeechVoiceSelection {
  /// Selects a predictable system voice without crossing language boundaries.
  /// Voice quality wins before an exact regional locale match so an installed
  /// premium or enhanced voice is never displaced by a compact legacy voice.
  public static func selectIdentifier(
    for locale: Locale,
    from candidates: [AssistantSpeechVoiceCandidate]
  ) -> String? {
    let requestedTag = normalizedLanguageTag(locale.identifier(.bcp47))
    let requestedLanguage = languageCode(in: requestedTag)

    return
      candidates
      .compactMap { candidate -> RankedCandidate? in
        guard !candidate.isNovelty else { return nil }

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
        return lhs.candidate.identifier < rhs.candidate.identifier
      }
      .first?
      .candidate
      .identifier
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
