import Foundation
import NaturalLanguage

public struct AssistantSpeechPacingSegment: Equatable, Sendable {
  public var text: String
  public var postUtteranceDelay: TimeInterval

  public init(text: String, postUtteranceDelay: TimeInterval) {
    self.text = text
    self.postUtteranceDelay = postUtteranceDelay
  }
}

public struct AssistantSpeechPacingPlan: Equatable, Sendable {
  public static let interSentenceDelay: TimeInterval = 0.12

  public var segments: [AssistantSpeechPacingSegment]

  public init(text: String, languageIdentifier: String?) {
    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedText.isEmpty else {
      segments = []
      return
    }

    let tokenizer = NLTokenizer(unit: .sentence)
    tokenizer.string = trimmedText
    if let language = Self.naturalLanguage(for: languageIdentifier) {
      tokenizer.setLanguage(language)
    }

    var sentenceTexts: [String] = []
    tokenizer.enumerateTokens(in: trimmedText.startIndex..<trimmedText.endIndex) {
      range,
      _ in
      let sentence = trimmedText[range].trimmingCharacters(in: .whitespacesAndNewlines)
      if !sentence.isEmpty {
        sentenceTexts.append(sentence)
      }
      return true
    }

    if sentenceTexts.isEmpty {
      sentenceTexts = [trimmedText]
    }

    let terminalIndex = sentenceTexts.index(before: sentenceTexts.endIndex)
    segments = sentenceTexts.enumerated().map { index, sentence in
      AssistantSpeechPacingSegment(
        text: sentence,
        postUtteranceDelay: index == terminalIndex ? 0 : Self.interSentenceDelay
      )
    }
  }

  private static func naturalLanguage(for identifier: String?) -> NLLanguage? {
    guard let identifier else { return nil }
    let normalized = identifier.replacingOccurrences(of: "_", with: "-")
    let subtags = normalized.split(separator: "-", omittingEmptySubsequences: false)
    guard
      let language = subtags.first,
      (2...8).contains(language.count),
      language.allSatisfy(\.isASCIIAlpha),
      subtags.dropFirst().allSatisfy({
        (1...8).contains($0.count) && $0.allSatisfy(\.isASCIIAlphaNumeric)
      })
    else { return nil }
    return NLLanguage(rawValue: normalized)
  }
}

extension Character {
  fileprivate var isASCIIAlpha: Bool {
    isASCII && isLetter
  }

  fileprivate var isASCIIAlphaNumeric: Bool {
    isASCII && (isLetter || isNumber)
  }
}
