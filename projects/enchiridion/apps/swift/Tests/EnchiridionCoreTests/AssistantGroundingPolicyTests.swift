// AssistantGroundingPolicyTests.swift
// EnchiridionCoreTests
//
// Ported with equal or greater rigor from the grounding-policy cases in
// `apps/enchiridion/Tests/EnchiridionCoreTests/AssistantCoreTests.swift`
// (`testEmptyResultsProduceSafeNonFactualResponse`,
// `testAmbiguousPeopleAreSurfaced`,
// `testConflictingNotesCannotBePresentedAsSettled`,
// `testStaleCalendarProjectionIsExplicit`,
// `testInventedFactIsRejectedEvenWhenItUsesAValidSource`,
// `testGroundedSpeechRejectsTooManySelectedFacts`), rewritten against bare
// `AssistantEvidenceFact`/`AssistantSource` values instead of the old
// app's `LibraryRepository`-backed fixtures (task #65 explicitly does not
// port read tools, so there is no repository here to search against —
// every test below constructs "this turn's real results" directly).
//
// The single most important test in this file is
// `testFactWhoseSourceWasNotReturnedThisTurnIsRejected` — it proves a fact
// that legitimately exists in `availableFacts` but whose declared
// `sourceID` points at a source NOT present in `availableSources` this
// turn is rejected outright (`unknownSource`), not clamped or silently
// dropped. That is the exact mechanism that stops a model from citing a
// source it never actually retrieved this turn.

import Foundation
import XCTest

@testable import EnchiridionCore

final class AssistantGroundingPolicyTests: XCTestCase {
  // MARK: - Rejection: empty / over-long selections

  func testEmptySelectedFactIDsThrowsNoSources() {
    let source = AssistantSource(id: "page:a", kind: .page, title: "A")
    let fact = AssistantEvidenceFact(
      id: "page:a#1", sourceID: source.id, kind: .pageExcerpt, spokenText: "A is a page.")

    XCTAssertThrowsError(
      try AssistantGroundingPolicy.groundedResponse(
        selectedFactIDs: [],
        availableFacts: [fact],
        availableSources: [source]
      )
    ) { error in
      XCTAssertEqual(error as? AssistantGroundingError, .noSources)
    }
  }

  func testTooManySelectedFactsRejected() {
    let source = AssistantSource(id: "page:bounded", kind: .page, title: "Bounded")
    let facts = (0..<(AssistantGroundingPolicy.maximumSelectedFacts + 1)).map {
      AssistantEvidenceFact(
        id: "page:bounded#\($0)", sourceID: source.id, kind: .pageExcerpt,
        spokenText: "Fact \($0).")
    }

    XCTAssertThrowsError(
      try AssistantGroundingPolicy.groundedResponse(
        selectedFactIDs: facts.map(\.id),
        availableFacts: facts,
        availableSources: [source]
      )
    ) { error in
      XCTAssertEqual(error as? AssistantGroundingError, .tooManyFacts)
    }
  }

  func testExactlyMaximumSelectedFactsIsAllowed() throws {
    let source = AssistantSource(id: "page:bounded", kind: .page, title: "Bounded")
    let facts = (0..<AssistantGroundingPolicy.maximumSelectedFacts).map {
      AssistantEvidenceFact(
        id: "page:bounded#\($0)", sourceID: source.id, kind: .pageExcerpt,
        spokenText: "Fact \($0).")
    }

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: facts.map(\.id),
      availableFacts: facts,
      availableSources: [source]
    )

    XCTAssertEqual(response.status, .answered)
  }

  // MARK: - Rejection: hallucinated citations (the core adversarial cases)

  func testInventedFactIDIsRejectedEvenWhenItUsesAValidSource() {
    let source = AssistantSource(id: "page:known", kind: .page, title: "Known")
    let fact = AssistantEvidenceFact(
      id: "page:known#title", sourceID: source.id, kind: .pageTitle,
      spokenText: "A local page is titled Known.")

    XCTAssertThrowsError(
      try AssistantGroundingPolicy.groundedResponse(
        selectedFactIDs: ["page:known#invented-date"],
        availableFacts: [fact],
        availableSources: [source]
      )
    ) { error in
      XCTAssertEqual(error as? AssistantGroundingError, .unknownFact("page:known#invented-date"))
    }
  }

  /// The core adversarial case task #65 calls out by name: a fact ID that
  /// genuinely exists in `availableFacts` this turn, but whose `sourceID`
  /// belongs to a source that was NOT returned this turn (i.e. the fact
  /// claims a source different from anything actually retrieved). This
  /// must be rejected — not clamped to the facts whose source did resolve,
  /// and not silently ignored.
  func testFactWhoseSourceWasNotReturnedThisTurnIsRejected() {
    // Note: `returnedSource` is a real, well-formed source — but it is not
    // the one `fact` claims, and `claimedSource` (below) was never handed
    // to the policy as an available source at all this turn.
    let returnedSource = AssistantSource(id: "page:returned", kind: .page, title: "Returned")
    let fact = AssistantEvidenceFact(
      id: "page:phantom#excerpt",
      sourceID: "page:phantom-source",  // never present in availableSources
      kind: .pageExcerpt,
      spokenText: "A phantom claim."
    )

    XCTAssertThrowsError(
      try AssistantGroundingPolicy.groundedResponse(
        selectedFactIDs: [fact.id],
        availableFacts: [fact],
        availableSources: [returnedSource]
      )
    ) { error in
      XCTAssertEqual(error as? AssistantGroundingError, .unknownSource("page:phantom-source"))
    }
  }

  /// A stricter variant of the above: the fact's declared source ID is
  /// syntactically identical to a real source ID's *shape*, and even
  /// shares a title/kind with a real returned source, but it is a
  /// genuinely distinct source object this turn's tool call did not
  /// return. This proves the check is real set-membership by ID against
  /// this turn's actual results, not a heuristic name/shape match.
  func testFactClaimingADifferentSourceThanWhatWasActuallyRetrievedIsRejected() {
    let actuallyRetrieved = AssistantSource(id: "page:alpha", kind: .page, title: "Alpha")
    // `page:beta` looks like a perfectly plausible sibling ID, but it was
    // never included in `availableSources` this turn.
    let fact = AssistantEvidenceFact(
      id: "page:alpha#claim", sourceID: "page:beta", kind: .pageExcerpt,
      spokenText: "Alpha says something.")

    XCTAssertThrowsError(
      try AssistantGroundingPolicy.groundedResponse(
        selectedFactIDs: [fact.id],
        availableFacts: [fact],
        availableSources: [actuallyRetrieved]
      )
    ) { error in
      XCTAssertEqual(error as? AssistantGroundingError, .unknownSource("page:beta"))
    }
  }

  // MARK: - Answer assembly is trusted-text-only

  func testAnswerIsAssembledOnlyFromSelectedFactsSpokenTextInSelectionOrder() throws {
    let source = AssistantSource(id: "page:mix", kind: .page, title: "Mix")
    let first = AssistantEvidenceFact(
      id: "page:mix#1", sourceID: source.id, kind: .pageExcerpt, spokenText: "First fact.")
    let second = AssistantEvidenceFact(
      id: "page:mix#2", sourceID: source.id, kind: .pageExcerpt, spokenText: "Second fact.")
    let unselected = AssistantEvidenceFact(
      id: "page:mix#3", sourceID: source.id, kind: .pageExcerpt,
      spokenText: "Unselected should never appear.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [second.id, first.id],
      availableFacts: [first, second, unselected],
      availableSources: [source]
    )

    XCTAssertEqual(response.answer, "Second fact. First fact.")
    XCTAssertFalse(response.answer.contains("Unselected"))
  }

  func testDuplicateSelectedFactIDsAreDedupedNotRepeatedInAnswer() throws {
    let source = AssistantSource(id: "page:dup", kind: .page, title: "Dup")
    let fact = AssistantEvidenceFact(
      id: "page:dup#1", sourceID: source.id, kind: .pageExcerpt, spokenText: "Only once.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [fact.id, fact.id, fact.id],
      availableFacts: [fact],
      availableSources: [source]
    )

    XCTAssertEqual(response.answer, "Only once.")
  }

  func testBoundedSpeechTruncatesOverlongAnswersWithEllipsis() throws {
    let source = AssistantSource(id: "page:long", kind: .page, title: "Long")
    let longWord = "word"
    let manyWords = Array(repeating: longWord, count: 200).joined(separator: " ")
    let fact = AssistantEvidenceFact(
      id: "page:long#1", sourceID: source.id, kind: .pageExcerpt, spokenText: manyWords)

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [fact.id],
      availableFacts: [fact],
      availableSources: [source]
    )

    XCTAssertTrue(response.answer.hasSuffix("…"))
    XCTAssertLessThanOrEqual(
      response.answer.split(whereSeparator: \.isWhitespace).count,
      AssistantGroundingPolicy.maximumSpokenWords + 1  // +1 tolerates the trailing ellipsis token
    )
  }

  // MARK: - Status derivation

  func testConflictingSourceProducesConflictingStatus() throws {
    let source = AssistantSource(
      id: "page:decision", kind: .page, title: "Launch decision",
      excerpt: "Ship Tuesday; another value says Thursday.", hasConflicts: true)
    let fact = AssistantEvidenceFact(
      id: "page:decision#excerpt", sourceID: source.id, kind: .pageExcerpt,
      spokenText: "Launch decision contains conflicting dates.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [fact.id],
      availableFacts: [fact],
      availableSources: [source]
    )

    XCTAssertEqual(response.status, .conflicting)
  }

  func testStaleSourceProducesStaleStatus() throws {
    let source = AssistantSource(id: "page:stale", kind: .calendarEvent, title: "Old meeting", isStale: true)
    let fact = AssistantEvidenceFact(
      id: "page:stale#schedule", sourceID: source.id, kind: .eventSchedule,
      spokenText: "Old meeting was scheduled.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [fact.id],
      availableFacts: [fact],
      availableSources: [source]
    )

    XCTAssertEqual(response.status, .stale)
  }

  func testConflictingTakesPrecedenceOverStale() throws {
    let source = AssistantSource(
      id: "page:both", kind: .page, title: "Both", isStale: true, hasConflicts: true)
    let fact = AssistantEvidenceFact(
      id: "page:both#1", sourceID: source.id, kind: .pageExcerpt, spokenText: "Both flags set.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [fact.id],
      availableFacts: [fact],
      availableSources: [source]
    )

    XCTAssertEqual(response.status, .conflicting)
  }

  func testExplicitAmbiguousTitlesProduceAmbiguousStatus() throws {
    let source = AssistantSource(id: "page:gavin-1", kind: .page, title: "Gavin")
    let fact = AssistantEvidenceFact(
      id: "page:gavin-1#title", sourceID: source.id, kind: .pageTitle,
      spokenText: "A page is titled Gavin.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [fact.id],
      availableFacts: [fact],
      availableSources: [source],
      ambiguousTitles: ["Gavin"]
    )

    XCTAssertEqual(response.status, .ambiguous)
  }

  func testDuplicateSourceTitlesProduceAmbiguousStatusForNonTaskFacts() throws {
    let sourceA = AssistantSource(id: "page:gavin-a", kind: .page, title: "Gavin")
    let sourceB = AssistantSource(id: "page:gavin-b", kind: .page, title: "Gavin")
    let factA = AssistantEvidenceFact(
      id: "page:gavin-a#title", sourceID: sourceA.id, kind: .pageTitle,
      spokenText: "One page is titled Gavin.")
    let factB = AssistantEvidenceFact(
      id: "page:gavin-b#title", sourceID: sourceB.id, kind: .pageTitle,
      spokenText: "Another page is titled Gavin.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [factA.id, factB.id],
      availableFacts: [factA, factB],
      availableSources: [sourceA, sourceB]
    )

    XCTAssertEqual(response.status, .ambiguous)
  }

  /// Task titles are expected to repeat routinely (e.g. recurring habits),
  /// so a duplicate-titled task source alone should not flip status to
  /// `.ambiguous` — this mirrors the old app's `hasAmbiguousTitles`
  /// special case for `.taskSummary` facts.
  func testDuplicateTaskTitlesAloneDoNotProduceAmbiguousStatus() throws {
    let sourceA = AssistantSource(id: "task:a", kind: .page, title: "Follow up")
    let sourceB = AssistantSource(id: "task:b", kind: .page, title: "Follow up")
    let factA = AssistantEvidenceFact(
      id: "task:a#summary", sourceID: sourceA.id, kind: .taskSummary,
      spokenText: "Follow up is due today.")
    let factB = AssistantEvidenceFact(
      id: "task:b#summary", sourceID: sourceB.id, kind: .taskSummary,
      spokenText: "Follow up is due tomorrow.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [factA.id, factB.id],
      availableFacts: [factA, factB],
      availableSources: [sourceA, sourceB]
    )

    XCTAssertEqual(response.status, .answered)
  }

  func testCleanSelectionProducesAnsweredStatus() throws {
    let source = AssistantSource(id: "page:clean", kind: .page, title: "Clean")
    let fact = AssistantEvidenceFact(
      id: "page:clean#1", sourceID: source.id, kind: .pageExcerpt, spokenText: "Nothing wrong here.")

    let response = try AssistantGroundingPolicy.groundedResponse(
      selectedFactIDs: [fact.id],
      availableFacts: [fact],
      availableSources: [source]
    )

    XCTAssertEqual(response.status, .answered)
  }

  // MARK: - Trusted-fallback builder

  func testGroundedResponseUsingTrustedFactsUsesDeterministicPrefixOrder() throws {
    let source = AssistantSource(id: "page:trusted", kind: .page, title: "Trusted")
    let facts = (0..<(AssistantGroundingPolicy.maximumSelectedFacts + 3)).map {
      AssistantEvidenceFact(
        id: "page:trusted#\($0)", sourceID: source.id, kind: .pageExcerpt,
        spokenText: "Fact \($0).")
    }

    let response = try AssistantGroundingPolicy.groundedResponseUsingTrustedFacts(
      availableFacts: facts,
      availableSources: [source]
    )

    XCTAssertEqual(response.answer, "Fact 0. Fact 1. Fact 2. Fact 3. Fact 4.")
    XCTAssertEqual(response.status, .answered)
  }

  // MARK: - Safe non-factual builders

  func testNoResultsBuilderReturnsEmptySourcesAndNoResultsStatus() {
    let response = AssistantGroundingPolicy.noResults()

    XCTAssertEqual(response.status, .noResults)
    XCTAssertTrue(response.sources.isEmpty)
    XCTAssertFalse(response.answer.isEmpty)
  }

  func testUnavailableBuilderReturnsUnavailableStatusWithAvailabilityMessage() {
    let response = AssistantGroundingPolicy.unavailable(.appleIntelligenceNotEnabled)

    XCTAssertEqual(response.status, .unavailable)
    XCTAssertEqual(response.answer, AssistantAvailability.appleIntelligenceNotEnabled.message)
    XCTAssertTrue(response.sources.isEmpty)
  }
}
