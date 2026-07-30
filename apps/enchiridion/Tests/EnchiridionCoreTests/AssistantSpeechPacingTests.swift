import AVFoundation
import XCTest

@testable import EnchiridionCore

final class AssistantSpeechPacingTests: XCTestCase {
  func testEmptyAndWhitespaceOnlyTextProduceNoSegments() {
    XCTAssertTrue(plan("").segments.isEmpty)
    XCTAssertTrue(plan(" \n\t ").segments.isEmpty)
  }

  func testOneSentenceHasNoTrailingDelay() {
    XCTAssertEqual(
      plan("  One complete sentence.  ").segments,
      [AssistantSpeechPacingSegment(text: "One complete sentence.", postUtteranceDelay: 0)]
    )
  }

  func testTwoEnglishSentencesHaveOneNaturalPause() {
    XCTAssertEqual(
      plan("First sentence. Second sentence!").segments,
      [
        AssistantSpeechPacingSegment(text: "First sentence.", postUtteranceDelay: 0.12),
        AssistantSpeechPacingSegment(text: "Second sentence!", postUtteranceDelay: 0),
      ]
    )
  }

  func testTokenizerKeepsAbbreviationsInitialsAndDecimalsTogether() {
    XCTAssertEqual(
      plan("Meet Dr. A. Smith at 10.30 today. Bring notes.").segments.map(\.text),
      ["Meet Dr. A. Smith at 10.30 today.", "Bring notes."]
    )
  }

  func testJapaneseAndChineseSentenceBoundaries() {
    XCTAssertEqual(
      plan("今日は晴れです。散歩しましょう。", language: "ja-JP").segments.map(\.text),
      ["今日は晴れです。", "散歩しましょう。"]
    )
    XCTAssertEqual(
      plan("今天很晴朗。我们去散步吧。", language: "zh-Hans-CN").segments.map(\.text),
      ["今天很晴朗。", "我们去散步吧。"]
    )
  }

  func testSegmentationPreservesWordsAndPunctuation() {
    let text = "“Ready?” Yes, at 10.30. Great!"
    let segments = plan(text).segments.map(\.text)

    XCTAssertEqual(segments.joined(separator: " "), text)
  }

  func testPreviewUsesNeutralConfigurationForEveryUtterance() throws {
    let voice = try XCTUnwrap(AVSpeechSynthesisVoice(language: "en-GB"))
    let utterances = AssistantSpeechUtteranceFactory.makeUtterances(
      for: "Here’s what matters today. You have time to focus.",
      voice: voice
    )

    XCTAssertEqual(
      utterances.map(\.speechString),
      [
        "Here’s what matters today.",
        "You have time to focus.",
      ])
    XCTAssertEqual(utterances.map(\.postUtteranceDelay), [0.12, 0])
    for utterance in utterances {
      XCTAssertEqual(utterance.voice?.identifier, voice.identifier)
      XCTAssertEqual(utterance.rate, AVSpeechUtteranceDefaultSpeechRate)
      XCTAssertEqual(utterance.pitchMultiplier, 1)
    }
  }

  private func plan(_ text: String, language: String = "en-GB")
    -> AssistantSpeechPacingPlan
  {
    AssistantSpeechPacingPlan(text: text, languageIdentifier: language)
  }
}

final class AssistantSpeechBatchLifecycleTests: XCTestCase {
  func testIntermediateFinishDoesNotCompleteTheBatch() {
    var lifecycle = AssistantSpeechBatchLifecycle<TestUtterance>()
    let first = TestUtterance()
    let terminal = TestUtterance()
    let batchID = UUID()
    lifecycle.begin([first, terminal], id: batchID)

    XCTAssertNil(lifecycle.finish(first))
    XCTAssertTrue(lifecycle.isActive)
    XCTAssertEqual(lifecycle.utteranceCount, 2)
    XCTAssertEqual(lifecycle.finish(terminal), batchID)
    XCTAssertFalse(lifecycle.isActive)
    XCTAssertNil(lifecycle.finish(terminal))
  }

  func testActiveLifecycleRetainsEntireBatchUntilTerminalFinish() throws {
    var lifecycle = AssistantSpeechBatchLifecycle<TestUtterance>()
    weak var retainedFirst: TestUtterance?
    weak var retainedTerminal: TestUtterance?

    do {
      let first = TestUtterance()
      let terminal = TestUtterance()
      retainedFirst = first
      retainedTerminal = terminal
      lifecycle.begin([first, terminal])
    }

    XCTAssertNotNil(retainedFirst)
    XCTAssertNotNil(retainedTerminal)
    let terminal = try XCTUnwrap(retainedTerminal)
    _ = lifecycle.finish(terminal)
    XCTAssertNil(retainedFirst)
  }

  func testCancellationCompletesOnlyOnceAndIgnoresOldCallbacks() {
    var lifecycle = AssistantSpeechBatchLifecycle<TestUtterance>()
    let oldFirst = TestUtterance()
    let oldTerminal = TestUtterance()
    let oldBatchID = UUID()
    lifecycle.begin([oldFirst, oldTerminal], id: oldBatchID)

    XCTAssertEqual(lifecycle.cancel(), oldBatchID)
    XCTAssertNil(lifecycle.cancel())
    XCTAssertNil(lifecycle.finish(oldTerminal))

    let newTerminal = TestUtterance()
    let newBatchID = UUID()
    lifecycle.begin([newTerminal], id: newBatchID)

    XCTAssertNil(lifecycle.cancel(batchID: oldBatchID))
    XCTAssertNil(lifecycle.finish(oldTerminal))
    XCTAssertTrue(lifecycle.isActive)
    XCTAssertEqual(lifecycle.finish(newTerminal), newBatchID)
  }
}

private final class TestUtterance {}
