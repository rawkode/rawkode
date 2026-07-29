import Foundation
import XCTest

@testable import EnchiridionCore

final class AssistantSpeechVoiceSelectionTests: XCTestCase {
  func testPrefersPremiumWithinExactLocale() {
    let candidates = [
      voice("default", language: "en-GB", quality: .default),
      voice("enhanced", language: "en-GB", quality: .enhanced),
      voice("premium", language: "en-GB", quality: .premium),
    ]

    XCTAssertEqual(select(from: candidates), "premium")
  }

  func testFallsBackFromEnhancedToDefault() {
    XCTAssertEqual(
      select(from: [
        voice("default", language: "en-GB", quality: .default),
        voice("enhanced", language: "en-GB", quality: .enhanced),
      ]),
      "enhanced"
    )
    XCTAssertEqual(
      select(from: [voice("default", language: "en-GB", quality: .default)]),
      "default"
    )
  }

  func testPremiumRegionalVoiceWinsBeforeCompactExactLocaleVoice() {
    let candidates = [
      voice("us-premium", language: "en-US", quality: .premium),
      voice("gb-default", language: "en-GB", quality: .default),
    ]

    XCTAssertEqual(select(from: candidates), "us-premium")
  }

  func testExactLocaleBreaksTiesAtTheSameQuality() {
    let candidates = [
      voice("us-enhanced", language: "en-US", quality: .enhanced),
      voice("gb-enhanced", language: "en-GB", quality: .enhanced),
    ]

    XCTAssertEqual(select(from: candidates), "gb-enhanced")
  }

  func testUsesSameLanguageRegionOnlyWhenExactLocaleIsUnavailable() {
    XCTAssertEqual(
      select(from: [voice("us-enhanced", language: "en-US", quality: .enhanced)]),
      "us-enhanced"
    )
  }

  func testNeverAutomaticallySelectsNoveltyVoice() {
    let candidates = [
      voice("novelty", language: "en-GB", quality: .premium, isNovelty: true),
      voice("standard", language: "en-GB", quality: .enhanced),
    ]

    XCTAssertEqual(select(from: candidates), "standard")
    XCTAssertNil(select(from: [candidates[0]]))
  }

  func testNeverCrossesLanguageBoundary() {
    let candidates = [
      voice("french", language: "fr-FR", quality: .premium),
      voice("german", language: "de-DE", quality: .enhanced),
    ]

    XCTAssertNil(select(from: candidates))
  }

  func testTieBreakIsDeterministic() {
    let candidates = [
      voice("z-voice", language: "en-GB", quality: .enhanced),
      voice("a-voice", language: "en_GB", quality: .enhanced),
    ]

    XCTAssertEqual(select(from: candidates), "a-voice")
  }

  private func select(from candidates: [AssistantSpeechVoiceCandidate]) -> String? {
    AssistantSpeechVoiceSelection.selectIdentifier(
      for: Locale(identifier: "en_GB"),
      from: candidates
    )
  }

  private func voice(
    _ identifier: String,
    language: String,
    quality: AssistantSpeechVoiceQuality,
    isNovelty: Bool = false
  ) -> AssistantSpeechVoiceCandidate {
    AssistantSpeechVoiceCandidate(
      identifier: identifier,
      language: language,
      quality: quality,
      isNovelty: isNovelty
    )
  }
}
