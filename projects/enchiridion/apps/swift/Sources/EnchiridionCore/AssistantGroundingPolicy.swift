// AssistantGroundingPolicy.swift
// EnchiridionCore
//
// Ported near-verbatim from
// `apps/enchiridion/Sources/EnchiridionCore/AssistantModels.swift`'s
// `AssistantGroundingPolicy` enum (split into its own file here since the
// plan and task #65 both call this out as the single most important piece
// to review in isolation).
//
// This is the enforcement point for the grounding contract described in
// the plan's "Assistant (P5)" section: "This is 'sources+facts or reject,'
// not 'cite your sources' — the model physically cannot get its own prose
// into an answer that claims a fact." Concretely:
//   - a model turn selects fact IDs (`selectedFactIDs`) from what a local
//     tool call actually returned this turn (`availableFacts`);
//   - every selected ID, and the source ID it claims to belong to, MUST
//     already be present in `availableFacts`/`availableSources` — an ID
//     that doesn't resolve is rejected outright (`unknownFact`/
//     `unknownSource`), never clamped, ignored, or best-effort matched;
//   - the final answer text is assembled ONLY by concatenating the
//     selected facts' own `spokenText` — model-authored prose never
//     becomes part of the answer.
//
// Do not weaken the `unknownFact`/`unknownSource` checks below to a
// best-effort or fuzzy match under any circumstance — that is exactly the
// gap that would let a compromised or confused model cite a source it
// never actually retrieved this turn.

import Foundation

public enum AssistantGroundingPolicy {
  /// Hard cap on how many facts one spoken answer may cite. Also the input
  /// bound below which `.tooManyFacts` fires.
  public static let maximumSelectedFacts = 5
  public static let maximumSpokenWords = 70
  public static let maximumSpokenCharacters = 600

  /// Validates a model's fact selection against this turn's real retrieval
  /// results and, only if every check passes, assembles a grounded
  /// response. Throws `AssistantGroundingError` on any violation — this
  /// function never silently drops an invalid selection down to a smaller
  /// valid one.
  ///
  /// - Parameters:
  ///   - selectedFactIDs: fact IDs the model chose to cite, in the order it
  ///     chose them. Duplicates are deduplicated (order-preserving);
  ///     duplication alone is never an error.
  ///   - availableFacts: the complete set of facts a local tool call
  ///     actually returned this turn. Any `selectedFactIDs` entry not
  ///     found here is an `unknownFact` — including a fact ID that is
  ///     syntactically plausible, reused from a prior turn, or otherwise
  ///     not part of *this* turn's real results.
  ///   - availableSources: the complete set of sources a local tool call
  ///     actually returned this turn. Every selected fact's `sourceID`
  ///     must resolve here too — a fact that exists but whose declared
  ///     source was never actually returned this turn (e.g. the source
  ///     was dropped, rotated out, or the fact's `sourceID` simply doesn't
  ///     match any real source) is an `unknownSource`, not a pass.
  ///   - ambiguousTitles: page/event titles the caller already knows are
  ///     ambiguous (e.g. two same-titled people), folded into the
  ///     `.ambiguous` status below even if none of the cited sources
  ///     themselves flag a conflict.
  public static func groundedResponse(
    selectedFactIDs: [String],
    availableFacts: [AssistantEvidenceFact],
    availableSources: [AssistantSource],
    ambiguousTitles: [String] = []
  ) throws -> GroundedAssistantResponse {
    let sourceByID = Dictionary(uniqueKeysWithValues: availableSources.map { ($0.id, $0) })
    let factByID = Dictionary(uniqueKeysWithValues: availableFacts.map { ($0.id, $0) })
    let uniqueFactIDs = selectedFactIDs.reduce(into: [String]()) { result, id in
      if !result.contains(id) { result.append(id) }
    }
    guard !uniqueFactIDs.isEmpty else { throw AssistantGroundingError.noSources }
    guard uniqueFactIDs.count <= maximumSelectedFacts else {
      throw AssistantGroundingError.tooManyFacts
    }
    for id in uniqueFactIDs where factByID[id] == nil {
      throw AssistantGroundingError.unknownFact(id)
    }
    let facts = uniqueFactIDs.compactMap { factByID[$0] }
    let sourceIDs = facts.reduce(into: [String]()) { result, fact in
      if !result.contains(fact.sourceID) { result.append(fact.sourceID) }
    }
    for id in sourceIDs where sourceByID[id] == nil {
      throw AssistantGroundingError.unknownSource(id)
    }
    let sources = sourceIDs.compactMap { sourceByID[$0] }
    let answer = boundedSpeech(facts.map(\.spokenText).joined(separator: " "))
    guard !answer.isEmpty else { throw AssistantGroundingError.emptyAnswer }
    let status: AssistantResponseStatus
    if sources.contains(where: \.hasConflicts) {
      status = .conflicting
    } else if sources.contains(where: \.isStale) {
      status = .stale
    } else if !ambiguousTitles.isEmpty
      || (facts.contains { $0.kind != .taskSummary } && hasAmbiguousTitles(sources))
    {
      status = .ambiguous
    } else {
      status = .answered
    }
    return GroundedAssistantResponse(answer: answer, status: status, sources: sources)
  }

  /// Renders trusted repository facts in their supplied order when
  /// model-selected identifiers are unusable (e.g. the model returned no
  /// tool call at all but a caller still wants a deterministic grounded
  /// fallback). This never incorporates model-authored factual prose —
  /// it's the same validator, just fed a caller-chosen selection instead
  /// of a model-chosen one.
  public static func groundedResponseUsingTrustedFacts(
    availableFacts: [AssistantEvidenceFact],
    availableSources: [AssistantSource],
    ambiguousTitles: [String] = []
  ) throws -> GroundedAssistantResponse {
    try groundedResponse(
      selectedFactIDs: availableFacts.prefix(maximumSelectedFacts).map(\.id),
      availableFacts: availableFacts,
      availableSources: availableSources,
      ambiguousTitles: ambiguousTitles
    )
  }

  /// A safe, non-factual response for when a retrieval genuinely found
  /// nothing. Never guesses.
  public static func noResults() -> GroundedAssistantResponse {
    GroundedAssistantResponse(
      answer: "I couldn't find a relevant result in your local Enchiridion data.",
      status: .noResults
    )
  }

  /// A safe, non-factual response for when no assistant provider can be
  /// reached at all.
  public static func unavailable(_ availability: AssistantAvailability) -> GroundedAssistantResponse
  {
    GroundedAssistantResponse(answer: availability.message, status: .unavailable)
  }

  private static func hasAmbiguousTitles(_ sources: [AssistantSource]) -> Bool {
    let normalized = sources.map {
      $0.title.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
    return Set(normalized).count < normalized.count
  }

  /// Trims trusted fact text to a size safe for spoken (or short-form
  /// text) presentation. Operates only on already-selected, already-
  /// validated trusted text — never on raw model output.
  private static func boundedSpeech(_ value: String) -> String {
    let words = value.split(whereSeparator: { $0.isWhitespace })
    var result = words.prefix(maximumSpokenWords).joined(separator: " ")
    if result.count > maximumSpokenCharacters {
      result = String(result.prefix(maximumSpokenCharacters - 1))
    }
    if words.count > maximumSpokenWords || result.count < value.count {
      result += "…"
    }
    return result
  }
}
