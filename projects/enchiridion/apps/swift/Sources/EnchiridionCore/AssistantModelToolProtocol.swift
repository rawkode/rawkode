// AssistantModelToolProtocol.swift
// EnchiridionCore
//
// Task #68 ("Assistant provider integration + conversation UI"). The
// single seam between a model provider's turn loop
// (`OpenAIResponsesAssistant.swift`, this module) and the code that
// actually executes a tool call against local/remote state.
//
// *** WHY THIS PROTOCOL LIVES HERE, AND WHY ITS CONFORMER DOES NOT ***
//
// `AssistantReadToolModels.swift`'s header already explains this exact
// layering constraint for #66's read tools ("EnchiridionStore ... depends
// ON EnchiridionCore, not the other way around ... putting a function here
// that calls GraphSQLExecutor.execute would be circular"). The same is true
// here, one level up: a REAL tool executor needs `EnchiridionStore`'s
// `LocalGraphStore` (for the four local read tools), `EnchiridionAPI`'s
// `VaultEmailSearchClient` (for `searchEmailThreads`), and the write-tool
// facades from `AssistantWriteTools.swift`/`AssistantRemoteWriteTools.swift`
// (already in this module) — but `EnchiridionCore` cannot import
// `EnchiridionStore` or `EnchiridionAPI` without a cycle.
//
// So, exactly like `AssistantEmailSearchClient` (declared here, implemented
// concretely by `EnchiridionAPI`'s `VaultEmailSearchClient`): this file
// declares the PROTOCOL the turn loop actually calls
// (`AssistantModelToolExecuting`), and the REAL conforming type
// (`AssistantLocalToolDispatcher`) lives in `EnchiridionUI` — the one
// target in this package's dependency graph that already imports
// `EnchiridionCore`, `EnchiridionStore`, `EnchiridionSync`, and
// `EnchiridionAPI` together (see `Package.swift`). `OpenAIResponsesAssistant`
// itself never imports any of those three targets; it only ever sees this
// protocol.
//
// *** THE SECURITY PROPERTY THIS PROTOCOL IS DESIGNED AROUND ***
//
// A conformer of `AssistantModelToolExecuting` is the ONLY code in this
// whole feature that is ever invoked with raw, model-supplied tool-call
// arguments. Per the plan's Assistant (P5) section and this task's brief,
// every method here also takes the turn's pre-flight
// `AssistantTurnRetrievalAuthorization`/`AssistantTurnWriteAuthorization` —
// constructed by app code before the model ever ran — and a conformer MUST
// reject (throw) any call whose tool name isn't present in
// `retrievalAuthorization.allowedTools`/`writeAuthorization.allowedTools`,
// or whose arguments fail that tool's own authorization struct's bounds
// checks (`AssistantApprovedQuery.permits(_:)`, scope/source-ID membership,
// etc. — all already enforced one layer down by
// `EnchiridionStore.AssistantReadTools.swift`/
// `EnchiridionCore.searchEmailThreads` themselves; a conformer here should
// call straight through to those, not re-implement the checks).
//
// For write tools specifically: a conformer of this protocol must be
// constructed holding ONLY `any AssistantWriteProposalSubmitting` (never
// `AssistantWriteProposalConfirming`) and `any AssistantRemoteWriteTransport`
// (never `AssistantRemoteWriteReviewTransport`) — see
// `AssistantWriteTools.swift`/`AssistantRemoteWriteTools.swift`'s own
// headers for the full argument. This protocol's method signature has no
// parameter through which a confirm/reject/consumeConfirmed/confirmApproval
// call could even be expressed, which is the first half of that guarantee;
// the second half (that the concrete conformer's stored properties are
// narrow-typed) is `AssistantLocalToolDispatcher`'s job, proven in
// `AssistantLocalToolDispatcherTests.testWriteFacadesCannotBeSwappedForReviewerShapedValues`.

import Foundation

/// Provider-neutral representation of one tool call a model made this turn.
/// A provider's own wire-format decoder (`OpenAIResponsesCodec`, this
/// module) is responsible for producing this from its own frame shape —
/// nothing below this type should ever need to know which provider is in
/// use.
public struct AssistantModelToolCall: Equatable, Sendable {
  public let name: String
  public let callID: AssistantToolCallID
  /// Raw, UNVALIDATED JSON object text exactly as the model supplied it.
  /// A conformer of `AssistantModelToolExecuting` is responsible for
  /// parsing and validating every field before acting on it — this string
  /// carries no trust of its own.
  public let arguments: String

  public init(name: String, callID: AssistantToolCallID, arguments: String) {
    self.name = name
    self.callID = callID
    self.arguments = arguments
  }
}

/// The result of executing one local/remote READ tool call. Ported concept
/// from the old app's `OpenAILocalToolResult` (`OpenAILocalToolExecutor.swift`),
/// generalized off any one provider.
public struct AssistantRetrievalToolOutput: Sendable {
  /// The bounded JSON text handed back to the model as this tool call's
  /// `function_call_output` — informational only for the model's own next
  /// turn; never itself trusted as the source of a final answer's prose
  /// (see `AssistantGroundingPolicy`).
  public let jsonOutput: String
  public let sources: [AssistantSource]
  public let facts: [AssistantEvidenceFact]
  public let ambiguousTitles: [String]
  /// A trusted, app-authored answer to fall back to if the model's next
  /// turn produces no tool call and no usable structured answer but this
  /// tool call genuinely found nothing (e.g. `AssistantTaskScope.emptyAnswer`).
  public let trustedEmptyAnswer: String?
  /// Calendar `AssistantSource.id`s this call actually returned — the
  /// eligibility set a later `meetingBrief` call in the SAME turn must be a
  /// member of (ported discipline from the old app's
  /// `eligibleCalendarSourceIDs`; see `OpenAILocalToolExecutor.swift`'s
  /// `briefCalendarEvent` case and this task's own report for why: the
  /// model must find an event before it can brief it, not invent a
  /// syntactically-plausible source ID from a pre-authorized allowlist it
  /// never actually saw this turn).
  public let eligibleCalendarSourceIDs: Set<String>
  /// Task `AssistantSource.id`s this call actually returned — the same
  /// discipline applied to `proposeTaskUpdate`/`proposeTaskComplete`'s
  /// `pageID` argument (task #68's own extension of the identical pattern
  /// to local write tools).
  public let eligibleTaskPageIDs: Set<String>
  /// `AssistantEmailThreadResults.threadPageIDs` this call actually
  /// returned — the same discipline applied to the 5 Gmail triage write
  /// tools' (`proposeArchiveEmail`/`proposeApplyLabel`/`proposeRemoveLabel`/
  /// `proposeMarkRead`/`proposeMarkUnread`) `threadPageID` argument: a
  /// triage action must only ever target a thread `searchEmailThreads`
  /// actually returned earlier in the SAME turn, never a
  /// syntactically-plausible ID the model invented.
  public let eligibleEmailThreadIDs: Set<String>

  public init(
    jsonOutput: String,
    sources: [AssistantSource],
    facts: [AssistantEvidenceFact],
    ambiguousTitles: [String] = [],
    trustedEmptyAnswer: String? = nil,
    eligibleCalendarSourceIDs: Set<String> = [],
    eligibleTaskPageIDs: Set<String> = [],
    eligibleEmailThreadIDs: Set<String> = []
  ) {
    self.jsonOutput = jsonOutput
    self.sources = sources
    self.facts = facts
    self.ambiguousTitles = ambiguousTitles
    self.trustedEmptyAnswer = trustedEmptyAnswer
    self.eligibleCalendarSourceIDs = eligibleCalendarSourceIDs
    self.eligibleTaskPageIDs = eligibleTaskPageIDs
    self.eligibleEmailThreadIDs = eligibleEmailThreadIDs
  }
}

/// The result of executing one WRITE tool call — always the outcome of a
/// PROPOSE-only call (`AssistantWriteProposalSubmitting.record` or
/// `AssistantRemoteWriteTransport.createEvent`/`.rsvp`/`.sendEmail`), never
/// a confirm. `summary` is trusted, app-authored text describing what was
/// proposed (built from the already-validated draft/input fields, the same
/// way `AssistantReadToolSupport`'s evidence facts are app-authored, not
/// model prose) — see `AssistantConversationTurnOutcome.pendingWriteConfirmation`.
public struct AssistantWriteToolOutput: Sendable {
  public let jsonOutput: String
  public let summary: String
  /// Set only for the three REMOTE write tools (`proposeCreateEvent`/
  /// `proposeRsvp`/`proposeSendEmail`) — the server's own freshly-minted,
  /// still-`pending` row (`AssistantRemoteWriteTransport.createEvent`/
  /// `.rsvp`/`.sendEmail`'s return value), carrying the `id`/`versionToken`
  /// a later human-confirm action needs to call
  /// `AssistantRemoteWriteReviewTransport.confirmApproval(id:versionToken:)`.
  /// `nil` for the three LOCAL task write tools, whose confirm path goes
  /// through `AssistantWriteProposalConfirming` (keyed by
  /// `AssistantToolCallID`) instead — see
  /// `AssistantRemoteWriteTools.swift`'s header for why remote writes need
  /// no separate client-side ledger the way local writes do.
  public let remoteApproval: AssistantPendingApproval?

  public init(jsonOutput: String, summary: String, remoteApproval: AssistantPendingApproval? = nil) {
    self.jsonOutput = jsonOutput
    self.summary = summary
    self.remoteApproval = remoteApproval
  }
}

/// What executing one tool call produced — a conformer of
/// `AssistantModelToolExecuting` returns this so the turn loop
/// (`OpenAIResponsesAssistant`) knows whether to keep looping (retrieval:
/// feed the output back to the model for its next turn) or stop the turn
/// immediately with a pending-confirmation outcome (write: never ask the
/// model for more text about its own write proposal — see
/// `OpenAIResponsesAssistant.swift`'s header for why).
public enum AssistantModelToolExecutionResult: Sendable {
  case retrieval(AssistantRetrievalToolOutput)
  case writeProposed(AssistantToolCallID, AssistantWriteToolOutput)
}

/// Errors a conformer of `AssistantModelToolExecuting` throws when a
/// model's tool call fails validation before ever reaching local/remote
/// state — distinct from `AssistantDataAccessError`/
/// `AssistantTurnRetrievalAuthorizationError` (which the read tools
/// themselves throw one layer down); this is the dispatch boundary's own
/// error surface.
public enum AssistantModelToolError: Error, LocalizedError, Equatable, Sendable {
  case unknownTool
  case toolNotAuthorizedThisTurn
  case invalidArguments
  case candidateNotEligibleThisTurn
  case outputTooLarge
  /// `proposeRsvp` specifically (see `AssistantLocalToolDispatcher.swift`'s
  /// `executeProposeRsvp`): thrown when no `findCalendarEvents`/
  /// `meetingBrief` call happened earlier in the same turn. As of task #96
  /// (plan §Live Backend Connectivity (P8)), `proposeRsvp` ALSO requires
  /// its `eventSourceID` argument to be a member of this turn's real
  /// `eligibleCalendarSourceIDs` (`.candidateNotEligibleThisTurn` if not) —
  /// this case alone only rules out a completely cold, zero-context RSVP
  /// proposal; the eligibility check is what actually ties the proposal to
  /// a real event the model saw this turn.
  case noCalendarContextThisTurn

  public var errorDescription: String? {
    switch self {
    case .unknownTool: "The assistant tried to call a tool that does not exist."
    case .toolNotAuthorizedThisTurn: "The assistant tried to call a tool that is not available this turn."
    case .invalidArguments: "The assistant supplied invalid arguments for a tool call."
    case .candidateNotEligibleThisTurn:
      "The assistant referenced a result it did not actually retrieve this turn."
    case .outputTooLarge: "The tool result was too large to return safely."
    case .noCalendarContextThisTurn:
      "The assistant tried to propose an RSVP without looking at any calendar data this turn."
    }
  }
}

/// The seam `OpenAIResponsesAssistant` (or any future provider's turn loop)
/// calls to actually execute one tool call. See this file's header for the
/// full layering and security argument.
public protocol AssistantModelToolExecuting: Sendable {
  func execute(
    _ call: AssistantModelToolCall,
    now: Date,
    eligibleCalendarSourceIDs: Set<String>,
    eligibleTaskPageIDs: Set<String>,
    /// `AssistantEmailThreadResults.threadPageIDs` accumulated across every
    /// `searchEmailThreads` call so far THIS turn — threaded the same way
    /// `eligibleCalendarSourceIDs`/`eligibleTaskPageIDs` are, for the 5
    /// Gmail triage write tools' benefit (see
    /// `AssistantRetrievalToolOutput.eligibleEmailThreadIDs`).
    eligibleEmailThreadIDs: Set<String>,
    /// Whether `findCalendarEvents` or `meetingBrief` was actually called
    /// (and produced a retrieval result) earlier in THIS turn — threaded
    /// the same way `eligibleCalendarSourceIDs`/`eligibleTaskPageIDs` are,
    /// for `proposeRsvp`'s benefit (see `AssistantModelToolError.noCalendarContextThisTurn`).
    calendarContextEstablishedThisTurn: Bool,
    retrievalAuthorization: AssistantTurnRetrievalAuthorization,
    writeAuthorization: AssistantTurnWriteAuthorization
  ) async throws -> AssistantModelToolExecutionResult
}
