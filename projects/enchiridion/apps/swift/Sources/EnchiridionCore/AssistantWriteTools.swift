// AssistantWriteTools.swift
// EnchiridionCore
//
// Local graph write proposals — task #67 ("Assistant (P5)", plan: "Local
// graph writes ... get an `AssistantTaskMutationProposalLedger`-equivalent:
// one-shot, immutable proposals recorded when the model calls a write
// tool, sitting in an `awaitingNativeConfirmation` state until an explicit
// in-app confirm action consumes them"). Ported concept (state machine
// near-verbatim) from
// `apps/enchiridion/Sources/EnchiridionCore/AssistantToolAuthorization.swift`'s
// `AssistantTaskMutationProposal`/`AssistantTaskMutationPatch`/
// `AssistantTaskMutationConfirmationState`/`AssistantTaskMutationProposalLedger`,
// adapted to this package's real types:
//   - `TaskDraft`/`TaskPageVersion` (old app, Automerge-era) -> this
//     file's `AssistantTaskDraft` + `AssistantPageVersionToken`. The old
//     app's `TaskPageVersion` carried an `AutomergeHeads`; this package's
//     CRDT-doc version equivalent is `EnchiridionSync.PageDocumentVersion`
//     (an encoded Loro version vector). `AssistantPageVersionToken` is
//     deliberately its own opaque `Data`-wrapping type, NOT a re-export of
//     `PageDocumentVersion`, because `EnchiridionSync` depends on
//     `EnchiridionCore` (not the reverse — see PageDocument.swift's own
//     header for that exact argument) so nothing CRDT-shaped can live
//     here. `EnchiridionSync/AssistantTaskMutationApplier.swift` (the
//     apply-to-graph step, which DOES depend on EnchiridionSync) converts
//     between the two by wrapping/unwrapping the same `encoded: Data`.
//   - The old app's `AssistantTaskMutationPatch.priority`/`.placement`
//     used `TaskPriority`/`TaskPlacement` from its own `TaskModels.swift`.
//     This file reuses `TaskSemantics.swift`'s `TaskPriority` directly for
//     `priority` (its four raw values already match the generated task
//     supertag's `priority` select field exactly — see
//     `EnchiridionSchema/Generated/CoreSupertags.swift`'s
//     `CoreTaskPriority` — so no local re-declaration was needed).
//     `placement` is DELIBERATELY NOT `TaskSemantics.TaskPlacement`: that
//     type's four cases (`inbox`/`today`/`scheduled`/`someday`) model a
//     dated-scheduling concept `TaskSemantics.swift`'s own header admits
//     is not yet reconciled with anything real, whereas the task
//     supertag's ACTUAL `placement` select field
//     (`CoreTaskFieldIDs.placement`, `CoreTaskPlacement` in the generated
//     schema) only has three options: `inbox`/`anytime`/`someday`. Rather
//     than write a `today`/`scheduled` value into a select field that
//     doesn't recognize it, this file declares its own
//     `AssistantTaskPlacement` mirroring the REAL three-option field
//     exactly — see that type's doc comment.
//
// SCOPE: this file carries the pure-domain proposal/patch/ledger types —
// no CRDT dependency, matching every other `Assistant*.swift` file in this
// module. The apply-to-graph step (what happens when a CONFIRMED proposal
// is consumed) lives in `EnchiridionSync/AssistantTaskMutationApplier.swift`
// instead, for the identical layering reason `PageDocument.swift` is in
// `EnchiridionSync` and not here — see that file's header.
//
// ============================================================================
// THE SECURITY PROPERTY THIS FILE EXISTS TO ENFORCE (read this in full —
// this is the actual point of the file, not a side note)
// ============================================================================
//
// Two independent adversarial reviews already found and fixed the SAME bug
// twice in the gadget system (plan §Gadgets, P4 tasks #55 and the original
// `graph.propose()` implementation — see
// `workers/gadget-host/src/graph-propose-capability.ts`'s file header for
// the full writeup): a component that can both PROPOSE and CONFIRM its own
// write in one continuous code path, with zero human involvement, defeats
// the entire point of "writes are always proposals." The gadget-host fix
// was structural, not a comment: `graphConfirmProposal` was removed from
// `GadgetCapabilityEnv` ENTIRELY — the object gadget code actually holds a
// reference to has no `confirm` method on it, full stop, not merely an
// unused one.
//
// This file applies the identical discipline in Swift, via a real,
// checkable access-control mechanism (not a "please don't call this here"
// comment):
//
//   1. `AssistantTaskMutationProposalLedger`'s `record`/`confirm`/`reject`/
//      `consumeConfirmed`/`proposal(for:)`/`state(for:)` methods are all
//      `fileprivate`. No code ANYWHERE ELSE IN THIS MODULE — including a
//      caller that somehow ends up holding a direct reference to the
//      ledger actor itself — can call them. The only callers that can are
//      the two facade types defined in THIS SAME FILE, below.
//
//   2. `AssistantWriteProposalRecorder` (conforms to
//      `AssistantWriteProposalSubmitting`) is the ONLY interface the
//      assistant's tool-call dispatch code (task #68's OpenAI Responses
//      API tool executor, or equivalent) may ever be constructed with. It
//      exposes exactly one method, `record(_:)`. It has no `confirm`,
//      `reject`, or `consumeConfirmed` method — not hidden, not
//      deprecated, ABSENT from the type. `record`/`confirm`/`reject`/
//      `consumeConfirmed`/`proposal(for:)`/`state(for:)` being fileprivate
//      to this file already makes the wide capability (the raw ledger
//      reference) unusable for anything but the two facades below, but the
//      TYPE-LEVEL guarantee is what task #68 should actually rely on:
//      constructing tool-dispatch code with a value of static type
//      `AssistantWriteProposalRecorder` (or, generically, `any
//      AssistantWriteProposalSubmitting`) means the Swift compiler itself
//      rejects any attempt to call `.confirm`/`.reject`/`.consumeConfirmed`
//      on it — `value of type 'AssistantWriteProposalRecorder' has no
//      member 'confirm'`. See `AssistantWriteToolsTests.swift`'s
//      `testProposalRecorderCannotBeTreatedAsAConfirmer` for the
//      executable proof: the concrete recorder value returned by
//      `.proposalRecorder` genuinely does not conform to
//      `AssistantWriteProposalConfirming` (a runtime dynamic-cast check,
//      not just "the source doesn't call it today").
//
//   3. `AssistantWriteProposalReviewer` (conforms to
//      `AssistantWriteProposalConfirming`) exposes `confirm`/`reject`/
//      `consumeConfirmed` plus read accessors (`proposal(for:)`/
//      `state(for:)`, needed to render a confirmation UI before acting).
//      This MUST only ever be handed to explicit, human-driven UI code —
//      a confirm/reject button's action handler — never to the tool-call
//      dispatch path. Nothing in this file hands one out automatically;
//      `ledger.proposalReviewer` must be called deliberately by whichever
//      layer owns building the confirmation UI.
//
// THE PART THAT IS STILL A CONVENTION, NOT A COMPILER GUARANTEE (stated
// honestly, per this task's brief: "pick a real enforcement mechanism...
// use your judgment"): both facades are freely obtainable from any live
// `AssistantTaskMutationProposalLedger` reference (`.proposalRecorder`/
// `.proposalReviewer` are both `public`). If a FUTURE caller mistakenly
// constructs the tool-dispatch layer with the raw ledger (or with an
// `AssistantWriteProposalReviewer`) instead of an
// `AssistantWriteProposalRecorder`, that mistake would reopen the hole.
// This file cannot prevent a future call site from doing that — no Swift
// access-control feature can enforce "only construct type X with type Y,
// never type Z" across arbitrary future call sites. What it DOES guarantee
// unconditionally is the piece that actually matters for the "component
// self-confirms its own write" bug specifically: GIVEN that tool-dispatch
// code is constructed with an `AssistantWriteProposalRecorder` (as it
// must be, to do its job at all — it needs to record proposals), there is
// NO path from that value to `confirm`/`reject`/`consumeConfirmed`, by
// construction, verified by the compiler. Task #68 (the tool-dispatch
// wiring) should type its own initializer parameter as `any
// AssistantWriteProposalSubmitting` (or the concrete
// `AssistantWriteProposalRecorder`), never as
// `AssistantTaskMutationProposalLedger` or `AssistantWriteProposalReviewer`
// — that is the one call site this whole mechanism depends on being wired
// correctly, and it should be the first thing a reviewer checks when #68
// lands.

import Foundation

// MARK: - Version token

/// The opaque, page-document-version-vector-shaped token a write-tool
/// caller must present alongside an `.update`/`.complete` proposal —
/// mirrors `EnchiridionSync.PageDocumentVersion`'s `encoded: Data` shape
/// exactly (same underlying encoded Loro version vector) without this
/// module depending on `EnchiridionSync`. See this file's header,
/// "adapted to this package's real types," for why this is a distinct
/// type rather than a re-export.
public struct AssistantPageVersionToken: Codable, Hashable, Sendable {
  public var encoded: Data

  public init(encoded: Data) {
    self.encoded = encoded
  }
}

// MARK: - Task placement (real select-field vocabulary)

/// The task supertag's REAL `placement` select-field options
/// (`CoreTaskFieldIDs.placement` / `CoreTaskPlacement` in
/// `EnchiridionSchema/Generated/CoreSupertags.swift`) — deliberately not
/// `TaskSemantics.TaskPlacement`; see this file's header for why those two
/// vocabularies currently diverge and which one is real.
public enum AssistantTaskPlacement: String, Codable, CaseIterable, Hashable, Sendable {
  case inbox
  case anytime
  case someday
}

// MARK: - Proposal vocabulary

/// A deliberately small mutation vocabulary for an `.update` proposal.
/// Omitted (`nil`) fields preserve the corresponding local value, so a
/// confirmed edit never needs to round-trip metadata the model didn't
/// touch. Ported concept from the old app's `AssistantTaskMutationPatch`.
public struct AssistantTaskMutationPatch: Codable, Equatable, Hashable, Sendable {
  public var title: String?
  public var notes: String?
  public var priority: TaskPriority?
  public var placement: AssistantTaskPlacement?
  public var estimatedMinutes: Int?

  public init(
    title: String? = nil,
    notes: String? = nil,
    priority: TaskPriority? = nil,
    placement: AssistantTaskPlacement? = nil,
    estimatedMinutes: Int? = nil
  ) {
    self.title = title
    self.notes = notes
    self.priority = priority
    self.placement = placement
    self.estimatedMinutes = estimatedMinutes
  }
}

/// The fields a `.create` proposal may populate on a brand-new task page.
/// Ported concept from the old app's `TaskDraft` — `title` is trimmed at
/// construction the same way the old app's draft trimmed it, so a
/// whitespace-only model-authored title never becomes a real page title.
public struct AssistantTaskDraft: Codable, Equatable, Hashable, Sendable {
  public var title: String
  public var notes: String?
  public var priority: TaskPriority?
  public var placement: AssistantTaskPlacement?
  public var estimatedMinutes: Int?

  public init(
    title: String,
    notes: String? = nil,
    priority: TaskPriority? = nil,
    placement: AssistantTaskPlacement? = nil,
    estimatedMinutes: Int? = nil
  ) {
    self.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
    self.notes = notes
    self.priority = priority
    self.placement = placement
    self.estimatedMinutes = estimatedMinutes
  }
}

/// One-shot, immutable local write proposal — recorded verbatim from a
/// model's tool call and never mutated afterward (a confirming/rejecting
/// caller only ever transitions its STATE in the ledger below, never its
/// content). Ported concept from the old app's
/// `AssistantTaskMutationProposal`.
public enum AssistantTaskMutationProposal: Hashable, Sendable {
  case create(callID: AssistantToolCallID, draft: AssistantTaskDraft)
  case update(
    callID: AssistantToolCallID,
    pageID: PageID,
    version: AssistantPageVersionToken,
    patch: AssistantTaskMutationPatch
  )
  case complete(callID: AssistantToolCallID, pageID: PageID, version: AssistantPageVersionToken)

  public var callID: AssistantToolCallID {
    switch self {
    case .create(let id, _), .update(let id, _, _, _), .complete(let id, _, _): id
    }
  }
}

/// Ported verbatim (as a state vocabulary) from the old app's
/// `AssistantTaskMutationConfirmationState`.
public enum AssistantTaskMutationConfirmationState: Equatable, Sendable {
  case awaitingNativeConfirmation
  case confirmed
  case rejected
  case consumed
}

// MARK: - Narrow facade protocols

/// The ONLY capability the assistant's tool-call dispatch code may be
/// constructed with. See this file's header for the full security
/// argument — a value of this (existential or concrete) type has no path
/// to `confirm`/`reject`/`consumeConfirmed`.
public protocol AssistantWriteProposalSubmitting: Sendable {
  /// Records `proposal`, transitioning it to
  /// `.awaitingNativeConfirmation`. Returns `false` (never throws) if
  /// `proposal.callID` was already recorded this session — a provider
  /// retry/duplicate tool call must not silently overwrite or re-arm an
  /// existing proposal.
  @discardableResult
  func record(_ proposal: AssistantTaskMutationProposal) async -> Bool
}

/// The capability explicit, human-driven confirmation UI code (a
/// confirm/reject button's action handler) may be constructed with. MUST
/// NEVER be handed to the assistant's tool-call dispatch path — see this
/// file's header.
public protocol AssistantWriteProposalConfirming: Sendable {
  func proposal(for callID: AssistantToolCallID) async -> AssistantTaskMutationProposal?
  func state(for callID: AssistantToolCallID) async -> AssistantTaskMutationConfirmationState?

  /// Transitions `.awaitingNativeConfirmation` -> `.confirmed`. Returns
  /// `false` if the proposal is unknown or not in that state (already
  /// confirmed/rejected/consumed, or never recorded).
  @discardableResult
  func confirm(_ callID: AssistantToolCallID) async -> Bool

  /// Transitions `.awaitingNativeConfirmation` -> `.rejected`. Same
  /// `false`-on-wrong-state contract as `confirm(_:)`.
  @discardableResult
  func reject(_ callID: AssistantToolCallID) async -> Bool

  /// One-shot: transitions `.confirmed` -> `.consumed` and returns the
  /// proposal, or returns `nil` (without transitioning anything) if the
  /// proposal isn't currently `.confirmed`. A second call for the same
  /// `callID` always returns `nil` — a confirmed proposal can be applied
  /// to the graph exactly once.
  func consumeConfirmed(_ callID: AssistantToolCallID) async -> AssistantTaskMutationProposal?
}

// MARK: - Ledger

/// One-shot, immutable mutation proposals, keyed by `AssistantToolCallID`.
/// State machine ported near-verbatim from the old app's
/// `AssistantTaskMutationProposalLedger`: `record()` ->
/// `awaitingNativeConfirmation` -> `confirm()`/`reject()` ->
/// `consumeConfirmed()`. See this file's header for why every method here
/// is `fileprivate` and how `proposalRecorder`/`proposalReviewer` are the
/// only intended way to reach them.
public actor AssistantTaskMutationProposalLedger {
  private var proposals: [AssistantToolCallID: AssistantTaskMutationProposal] = [:]
  private var states: [AssistantToolCallID: AssistantTaskMutationConfirmationState] = [:]

  public init() {}

  /// Hand this to the assistant's tool-call dispatch layer — and ONLY
  /// that layer. See this file's header.
  public nonisolated var proposalRecorder: AssistantWriteProposalRecorder {
    AssistantWriteProposalRecorder(ledger: self)
  }

  /// Hand this to explicit, human-driven confirmation UI code — and ONLY
  /// that code. See this file's header.
  public nonisolated var proposalReviewer: AssistantWriteProposalReviewer {
    AssistantWriteProposalReviewer(ledger: self)
  }

  fileprivate func record(_ proposal: AssistantTaskMutationProposal) -> Bool {
    guard proposals[proposal.callID] == nil else { return false }
    proposals[proposal.callID] = proposal
    states[proposal.callID] = .awaitingNativeConfirmation
    return true
  }

  fileprivate func proposal(for callID: AssistantToolCallID) -> AssistantTaskMutationProposal? {
    proposals[callID]
  }

  fileprivate func state(for callID: AssistantToolCallID) -> AssistantTaskMutationConfirmationState? {
    states[callID]
  }

  fileprivate func confirm(_ callID: AssistantToolCallID) -> Bool {
    guard states[callID] == .awaitingNativeConfirmation else { return false }
    states[callID] = .confirmed
    return true
  }

  fileprivate func reject(_ callID: AssistantToolCallID) -> Bool {
    guard states[callID] == .awaitingNativeConfirmation else { return false }
    states[callID] = .rejected
    return true
  }

  fileprivate func consumeConfirmed(_ callID: AssistantToolCallID) -> AssistantTaskMutationProposal? {
    guard states[callID] == .confirmed, let proposal = proposals[callID] else { return nil }
    states[callID] = .consumed
    return proposal
  }
}

// MARK: - Facades

/// Tool-dispatch-facing facade. Exposes exactly `record(_:)` — see this
/// file's header. `init` is `fileprivate`: the only way to obtain one is
/// `AssistantTaskMutationProposalLedger.proposalRecorder`.
public struct AssistantWriteProposalRecorder: AssistantWriteProposalSubmitting {
  fileprivate let ledger: AssistantTaskMutationProposalLedger

  fileprivate init(ledger: AssistantTaskMutationProposalLedger) {
    self.ledger = ledger
  }

  @discardableResult
  public func record(_ proposal: AssistantTaskMutationProposal) async -> Bool {
    await ledger.record(proposal)
  }
}

/// Human-UI-facing facade. Exposes `confirm`/`reject`/`consumeConfirmed`
/// plus read accessors — see this file's header for who may hold one.
/// `init` is `fileprivate`: the only way to obtain one is
/// `AssistantTaskMutationProposalLedger.proposalReviewer`.
public struct AssistantWriteProposalReviewer: AssistantWriteProposalConfirming {
  fileprivate let ledger: AssistantTaskMutationProposalLedger

  fileprivate init(ledger: AssistantTaskMutationProposalLedger) {
    self.ledger = ledger
  }

  public func proposal(for callID: AssistantToolCallID) async -> AssistantTaskMutationProposal? {
    await ledger.proposal(for: callID)
  }

  public func state(for callID: AssistantToolCallID) async -> AssistantTaskMutationConfirmationState? {
    await ledger.state(for: callID)
  }

  @discardableResult
  public func confirm(_ callID: AssistantToolCallID) async -> Bool {
    await ledger.confirm(callID)
  }

  @discardableResult
  public func reject(_ callID: AssistantToolCallID) async -> Bool {
    await ledger.reject(callID)
  }

  public func consumeConfirmed(_ callID: AssistantToolCallID) async -> AssistantTaskMutationProposal? {
    await ledger.consumeConfirmed(callID)
  }
}
