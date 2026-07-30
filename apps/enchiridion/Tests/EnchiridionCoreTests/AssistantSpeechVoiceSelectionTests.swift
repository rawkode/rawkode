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

  func testTieBreakRemainsDeterministicWithoutFrameworkPreference() {
    let candidates = [
      voice("z-voice", language: "en-GB", quality: .enhanced),
      voice("a-voice", language: "en_GB", quality: .enhanced),
    ]

    XCTAssertEqual(select(from: candidates), "a-voice")
  }

  func testFrameworkPreferredBasicVoiceWinsWithinItsQualityAndLocaleTier() {
    let daniel = "com.apple.voice.compact.en-GB.Daniel"
    let candidates = [
      voice("com.apple.eloquence.en-GB.Eddy", language: "en-GB", quality: .default),
      voice(daniel, language: "en-GB", quality: .default),
    ]

    XCTAssertEqual(select(from: candidates, preferred: daniel), daniel)
  }

  func testHigherQualityVoiceBeatsFrameworkPreferredBasicVoice() {
    let preferredBasic = voice("preferred-basic", language: "en-GB", quality: .default)

    XCTAssertEqual(
      select(
        from: [preferredBasic, voice("enhanced", language: "en-GB", quality: .enhanced)],
        preferred: preferredBasic.identifier
      ),
      "enhanced"
    )
    XCTAssertEqual(
      select(
        from: [preferredBasic, voice("premium", language: "en-GB", quality: .premium)],
        preferred: preferredBasic.identifier
      ),
      "premium"
    )
  }

  func testAbsentFrameworkPreferredIdentifierUsesDeterministicFallback() {
    let candidates = [
      voice("z-voice", language: "en-GB", quality: .default),
      voice("a-voice", language: "en-GB", quality: .default),
    ]

    XCTAssertEqual(select(from: candidates, preferred: "not-installed"), "a-voice")
  }

  func testFrameworkPreferredNoveltyOrWrongLanguageVoiceIsIgnored() {
    let standard = voice("standard", language: "en-GB", quality: .default)
    let novelty = voice(
      "novelty",
      language: "en-GB",
      quality: .premium,
      isNovelty: true
    )
    let french = voice("french", language: "fr-FR", quality: .premium)

    XCTAssertEqual(
      select(from: [standard, novelty], preferred: novelty.identifier),
      standard.identifier
    )
    XCTAssertEqual(
      select(from: [standard, french], preferred: french.identifier),
      standard.identifier
    )
  }

  private func select(
    from candidates: [AssistantSpeechVoiceCandidate],
    preferred: String? = nil
  ) -> String? {
    AssistantSpeechVoiceSelection.selectIdentifier(
      for: Locale(identifier: "en_GB"),
      from: candidates,
      frameworkPreferredIdentifier: preferred
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
