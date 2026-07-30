import XCTest
@testable import EnchiridionCore

final class FoundationModelAssistantResolverTests: XCTestCase {
  func testNoToolGreetingIgnoresSpuriousLocalMetadata() {
    let answer = "Hi! I'm doing well. How can I help?" + String(repeating: " Welcome!", count: 200)

    let response = FoundationModelAssistant.resolveModelTurn(
      answer: answer,
      usesLocalSources: true,
      selectedFactIDs: ["prompt:metadata#current-time"],
      availableFacts: [],
      availableSources: [],
      didUseTools: false
    )

    XCTAssertEqual(response.status, .answered)
    XCTAssertFalse(response.answer.isEmpty)
    XCTAssertLessThanOrEqual(response.answer.count, 1_200)
    XCTAssertTrue(response.answer.hasPrefix("Hi! I'm doing well."))
    XCTAssertTrue(response.sources.isEmpty)
  }

  func testNoToolNormalGreetingReturnsModelAnswerWithoutSources() {
    let response = FoundationModelAssistant.resolveModelTurn(
      answer: "Hello! How are you?",
      usesLocalSources: false,
      selectedFactIDs: [],
      availableFacts: [],
      availableSources: [],
      didUseTools: false
    )

    XCTAssertEqual(response.answer, "Hello! How are you?")
    XCTAssertEqual(response.status, .answered)
    XCTAssertTrue(response.sources.isEmpty)
  }

  func testToolExecutionWithFactsReturnsOnlyGroundedSources() {
    let grounded = fixture(id: "page:grounded", title: "Grounded")
    let unselected = fixture(id: "page:unselected", title: "Unselected")

    let response = FoundationModelAssistant.resolveModelTurn(
      answer: "Model-authored local prose must not escape.",
      usesLocalSources: false,
      selectedFactIDs: [grounded.fact.id],
      availableFacts: [grounded.fact, unselected.fact],
      availableSources: [grounded.source, unselected.source],
      didUseTools: true
    )

    XCTAssertEqual(response.answer, grounded.fact.spokenText)
    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.sources, [grounded.source])
  }

  func testToolExecutionWithNoFactsReturnsTrustedNoResults() {
    let response = FoundationModelAssistant.resolveModelTurn(
      answer: "I found a private result.",
      usesLocalSources: false,
      selectedFactIDs: [],
      availableFacts: [],
      availableSources: [],
      didUseTools: true,
      trustedEmptyAnswer: "There are no matching local notes."
    )

    XCTAssertEqual(response.answer, "There are no matching local notes.")
    XCTAssertEqual(response.status, .noResults)
    XCTAssertTrue(response.sources.isEmpty)
  }

  func testInventedFactIDsFallBackToCollectorFacts() {
    let collected = fixture(id: "page:known", title: "Known")

    let response = FoundationModelAssistant.resolveModelTurn(
      answer: "Invented private detail.",
      usesLocalSources: true,
      selectedFactIDs: ["page:known#invented"],
      availableFacts: [collected.fact],
      availableSources: [collected.source],
      didUseTools: true
    )

    XCTAssertEqual(response.answer, collected.fact.spokenText)
    XCTAssertEqual(response.status, .answered)
    XCTAssertEqual(response.sources, [collected.source])
    XCTAssertFalse(response.answer.contains("Invented"))
  }

  private func fixture(
    id: String,
    title: String
  ) -> (source: AssistantSource, fact: AssistantEvidenceFact) {
    let source = AssistantSource(id: id, kind: .page, title: title)
    let fact = AssistantEvidenceFact(
      id: "\(id)#title",
      sourceID: id,
      kind: .pageTitle,
      spokenText: "A local page is titled \(title)."
    )
    return (source, fact)
  }
}
