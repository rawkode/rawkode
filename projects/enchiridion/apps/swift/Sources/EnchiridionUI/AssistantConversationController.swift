// AssistantConversationController.swift
// EnchiridionUI
//
// Task #68 ("Assistant provider integration + conversation UI"). The
// `@Observable` view-model `AssistantConversationView.swift` binds to —
// same convention as `PageEditorController.swift` (`@MainActor @Observable
// public final class`). Owns the conversation transcript, submits turns to
// `OpenAIResponsesAssistant`, and is the ONE place in this feature that
// ever holds BOTH halves of a write facade split at once — deliberately,
// and deliberately keeping them in two separate stored properties that are
// handed to two separate consumers, never merged into one wider type:
//
//   - `AssistantTaskMutationProposalLedger.proposalRecorder` (narrow,
//     `AssistantWriteProposalSubmitting`) goes to `AssistantLocalToolDispatcher`
//     at `init` time — the tool-dispatch path. See that file's header.
//   - `AssistantTaskMutationProposalLedger.proposalReviewer` (wide,
//     `AssistantWriteProposalConfirming`) is obtained ONLY inside
//     `confirmProposal(_:)`/`rejectProposal(_:)` below — reached ONLY from
//     an explicit call this type's own public API makes in response to a
//     person tapping a confirm/reject button in
//     `AssistantConversationView.swift`. Nothing in the tool-dispatch path
//     (`send(_:)` -> `OpenAIResponsesAssistant.respond(to:)` ->
//     `AssistantLocalToolDispatcher.execute`) ever touches
//     `ledger.proposalReviewer`.
//
// Same split for remote writes: `remoteWriteClient` (propose-only) is
// handed to the dispatcher at `init`; `remoteWriteReviewClient`
// (confirm-only) is used ONLY inside `confirmProposal(_:)`.
//
// `AssistantTaskMutationApplier.apply` — the local write's actual
// apply-to-graph step — is likewise called ONLY from `confirmProposal(_:)`,
// never from `send(_:)`'s turn-submission path. This satisfies the task
// brief's required property directly: "explicit user tap required before
// AssistantTaskMutationApplier.apply or AssistantRemoteWriteClient's
// reviewer-side confirm is ever called."
//
// TASK #78 UPDATE — DEFAULT PERSISTENCE: the paragraph below described a
// real gap as of #65-68 (nothing durably persisted an applied task
// mutation's snapshot). That gap is now closed at the default-behavior
// level: `confirmProposal(_:)` still hands the result to
// `onLocalTaskMutationApplied` when a caller supplies one (so a production
// app can add extra bookkeeping — sync queuing, analytics — around the
// applied result), but when that closure is `nil`, this controller now
// persists the result itself via `store` — `saveDocumentSnapshot` for the
// real CRDT snapshot (`EnchiridionStore/LocalGraphStore.swift`, task #78)
// plus `writeProjection` for the derived projection, the same two calls
// `PageEditorController.flush()`/`ShareCapture.capture` make for every
// other local write path. This is what makes
// "Sources/EnchiridionUI/AssistantLocalToolDispatcher.swift's write
// dispatch (P5)"'s actual apply step (which happens HERE, in
// `confirmProposal`, not in the dispatcher itself — see
// `AssistantLocalToolDispatcher.swift`'s own file: it only ever records a
// PROPOSAL into the in-memory ledger, never calls `PageDocument` directly)
// a real, persisting write path rather than one whose result silently
// evaporates whenever no app-assembly closure happens to be wired up
// (which, before this task, was always — nothing in this repository ever
// constructed this controller outside of tests).
//
// WHAT THIS TYPE STILL DELIBERATELY DOES NOT DO (scope, stated honestly):
// the persisted result is not queued for sync — the same "sync wiring is a
// separate, later task" boundary `PageEditorController.swift`'s header
// states for its own flush path applies identically here.

import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation
import Observation

/// One rendered conversation message. `sources` is populated only for
/// grounded assistant answers — see `GroundedAssistantResponse.sources`.
public struct AssistantConversationMessage: Identifiable, Sendable, Equatable {
  public enum Role: Sendable, Equatable { case user, assistant }

  public let id: AssistantToolCallID
  public var role: Role
  public var text: String
  public var status: AssistantResponseStatus?
  public var sources: [AssistantSource]

  public init(
    id: AssistantToolCallID = AssistantToolCallID(rawValue: UUID().uuidString),
    role: Role,
    text: String,
    status: AssistantResponseStatus? = nil,
    sources: [AssistantSource] = []
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.status = status
    self.sources = sources
  }
}

@MainActor
@Observable
public final class AssistantConversationController {
  public private(set) var messages: [AssistantConversationMessage] = []
  public private(set) var pendingProposals: [AssistantPendingWriteSummary] = []
  public private(set) var isSending = false
  public private(set) var lastError: String?

  private let assistant: OpenAIResponsesAssistant
  private let ledger: AssistantTaskMutationProposalLedger
  private let remoteWriteReviewClient: (any AssistantRemoteWriteReviewTransport)?
  private let taskSnapshotProvider: (any AssistantTaskSnapshotProviding)?
  private let onLocalTaskMutationApplied: (@Sendable (AssistantTaskMutationApplyResult) async -> Void)?
  /// Task #78: retained (unlike before, when `store` was used only to build
  /// the dispatcher at `init` and then discarded) so `confirmProposal(_:)`
  /// can persist an applied local task mutation itself when no
  /// `onLocalTaskMutationApplied` closure is supplied — see this file's
  /// header. `nil` only via the internal test seam init below, for tests
  /// that supply their own recording closure and have no real store to
  /// persist into.
  private let store: LocalGraphStore?
  private let retrievalAuthorization: @MainActor () -> AssistantTurnRetrievalAuthorization
  private let writeAuthorization: @MainActor () -> AssistantTurnWriteAuthorization
  private let now: @MainActor () -> Date

  /// - Parameters:
  ///   - remoteWriteClient: propose-only — handed to the dispatcher, never
  ///     retained by this type itself.
  ///   - remoteWriteReviewClient: confirm-only — retained here, used only
  ///     from `confirmProposal(_:)`. See this file's header.
  ///   - onLocalTaskMutationApplied: when supplied, `confirmProposal(_:)`
  ///     hands an applied local task mutation to this closure INSTEAD OF
  ///     persisting it itself — use this if a caller needs extra
  ///     bookkeeping (sync queuing, analytics) around the applied result.
  ///     When `nil` (the default), `confirmProposal(_:)` persists the
  ///     result into `store` itself (`saveDocumentSnapshot` +
  ///     `writeProjection` — task #78). Either way, the result is never
  ///     silently dropped.
  public init(
    modelID: String,
    credential: @escaping @Sendable () async throws -> String,
    store: LocalGraphStore,
    emailClient: (any AssistantEmailSearchClient)? = nil,
    remoteWriteClient: (any AssistantRemoteWriteTransport)? = nil,
    remoteWriteReviewClient: (any AssistantRemoteWriteReviewTransport)? = nil,
    taskSnapshotProvider: (any AssistantTaskSnapshotProviding)? = nil,
    retrievalAuthorization: @escaping @MainActor () -> AssistantTurnRetrievalAuthorization,
    writeAuthorization: @escaping @MainActor () -> AssistantTurnWriteAuthorization = { .none },
    now: @escaping @MainActor () -> Date = { Date() },
    onLocalTaskMutationApplied: (@Sendable (AssistantTaskMutationApplyResult) async -> Void)? = nil
  ) {
    let ledger = AssistantTaskMutationProposalLedger()
    self.ledger = ledger
    let dispatcher = AssistantLocalToolDispatcher(
      store: store,
      emailClient: emailClient,
      writeProposalRecorder: ledger.proposalRecorder,
      remoteWriteTransport: remoteWriteClient,
      taskSnapshotProvider: taskSnapshotProvider
    )
    self.assistant = OpenAIResponsesAssistant(modelID: modelID, executor: dispatcher, credential: credential)
    self.remoteWriteReviewClient = remoteWriteReviewClient
    self.taskSnapshotProvider = taskSnapshotProvider
    self.onLocalTaskMutationApplied = onLocalTaskMutationApplied
    self.store = store
    self.retrievalAuthorization = retrievalAuthorization
    self.writeAuthorization = writeAuthorization
    self.now = now
  }

  /// Test/internal seam — lets tests inject a pre-built `OpenAIResponsesAssistant`
  /// (itself already testable via its own internal transport seam) without
  /// a real network. Production code must use the `public init` above.
  /// `store` defaults to `nil` (most tests supply their own
  /// `onLocalTaskMutationApplied` recording closure instead — see this
  /// file's header on the two being alternatives, never both used); pass a
  /// real `LocalGraphStore.openTemporary()` here to test the default
  /// (closure-less) persistence path itself.
  init(
    assistant: OpenAIResponsesAssistant,
    ledger: AssistantTaskMutationProposalLedger,
    remoteWriteReviewClient: (any AssistantRemoteWriteReviewTransport)? = nil,
    taskSnapshotProvider: (any AssistantTaskSnapshotProviding)? = nil,
    store: LocalGraphStore? = nil,
    retrievalAuthorization: @escaping @MainActor () -> AssistantTurnRetrievalAuthorization = { .none },
    writeAuthorization: @escaping @MainActor () -> AssistantTurnWriteAuthorization = { .none },
    now: @escaping @MainActor () -> Date = { Date() },
    onLocalTaskMutationApplied: (@Sendable (AssistantTaskMutationApplyResult) async -> Void)? = nil
  ) {
    self.assistant = assistant
    self.ledger = ledger
    self.remoteWriteReviewClient = remoteWriteReviewClient
    self.taskSnapshotProvider = taskSnapshotProvider
    self.onLocalTaskMutationApplied = onLocalTaskMutationApplied
    self.store = store
    self.retrievalAuthorization = retrievalAuthorization
    self.writeAuthorization = writeAuthorization
    self.now = now
  }

  /// Submits one user turn — the ONLY method that reaches
  /// `OpenAIResponsesAssistant.respond(to:)`. Never itself confirms/applies
  /// anything a tool call proposed; see this file's header.
  public func send(_ utterance: String) async {
    let trimmed = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !isSending else { return }
    isSending = true
    lastError = nil
    messages.append(AssistantConversationMessage(role: .user, text: trimmed))

    let priorTurns = Self.history(from: messages.dropLast())
    let request = AssistantConversationRequest(
      utterance: trimmed,
      priorTurns: priorTurns,
      now: now(),
      retrievalAuthorization: retrievalAuthorization(),
      writeAuthorization: writeAuthorization()
    )
    let outcome = await assistant.respond(to: request)
    switch outcome {
    case .grounded(let response):
      messages.append(
        AssistantConversationMessage(
          role: .assistant, text: response.answer, status: response.status, sources: response.sources))
    case .pendingWriteConfirmation(let summary):
      pendingProposals.append(summary)
      messages.append(
        AssistantConversationMessage(
          id: summary.callID, role: .assistant, text: "\(summary.summary) — awaiting your confirmation."))
    }
    isSending = false
  }

  /// The ONLY method that ever reaches `AssistantTaskMutationApplier.apply`
  /// or `AssistantRemoteWriteReviewTransport.confirmApproval` — always in
  /// direct response to this method being called, which
  /// `AssistantConversationView.swift` only does from a confirm button's
  /// action handler. See this file's header.
  public func confirmProposal(_ summary: AssistantPendingWriteSummary) async {
    guard let index = pendingProposals.firstIndex(of: summary) else { return }
    pendingProposals.remove(at: index)

    if let remoteApproval = summary.remoteApproval {
      guard let remoteWriteReviewClient else {
        lastError = "This proposal cannot be confirmed on this device."
        return
      }
      do {
        _ = try await remoteWriteReviewClient.confirmApproval(
          id: remoteApproval.id, versionToken: remoteApproval.versionToken)
      } catch {
        lastError = "Could not confirm: \(error.localizedDescription)"
      }
      return
    }

    let reviewer = ledger.proposalReviewer
    guard await reviewer.confirm(summary.callID),
      let proposal = await reviewer.consumeConfirmed(summary.callID)
    else {
      lastError = "This proposal is no longer available to confirm."
      return
    }
    do {
      let existingSnapshot = try await Self.existingSnapshot(
        for: proposal, provider: taskSnapshotProvider)
      let result = try AssistantTaskMutationApplier.apply(proposal, existingSnapshot: existingSnapshot)
      if let onLocalTaskMutationApplied {
        await onLocalTaskMutationApplied(result)
      } else if let store {
        try await Self.persistAppliedResult(result, now: now(), into: store)
      }
    } catch {
      lastError = "Could not apply the confirmed change: \(error.localizedDescription)"
    }
  }

  /// The default persistence path for an applied local task mutation (task
  /// #78) — used only when the caller did not supply its own
  /// `onLocalTaskMutationApplied` closure. Persists the REAL CRDT snapshot
  /// (`saveDocumentSnapshot`), not just its derived projection, then writes
  /// the projection (`writeProjection`) — the identical pairing
  /// `PageEditorController.flush()` and `ShareCapture.capture` use for
  /// every other local write path.
  ///
  /// `kind` is always `.free`: `AssistantTaskMutationApplier.applyCreate`
  /// always creates a `.free` page (see that file), and `.update`/
  /// `.complete` never change a page's kind. `createdAt` is preserved from
  /// the page's existing `_local_nodes` row when one exists (an update/
  /// complete must never overwrite the page's real creation time with
  /// "now") and falls back to `now` only for a genuine `.create` (no prior
  /// row can exist yet).
  private static func persistAppliedResult(
    _ result: AssistantTaskMutationApplyResult, now: Date, into store: LocalGraphStore
  ) async throws {
    try await store.saveDocumentSnapshot(pageID: result.pageID, snapshot: result.document, version: result.version)
    let createdAt = try await store.node(for: result.pageID)?.createdAt ?? now
    try await store.writeProjection(
      pageID: result.pageID, kind: .free, createdAt: createdAt, modifiedAt: now, projection: result.projection)
  }

  /// Declines a pending proposal. For a local task proposal this
  /// transitions the ledger entry to `.rejected` (it can never be
  /// confirmed afterward). Remote writes have no reject RPC (per
  /// `AssistantRemoteWriteTools.swift`'s header — only `createEvent`/
  /// `rsvp`/`sendEmail`/`confirmApproval`/`getApproval`/`listPendingApprovals`
  /// exist server-side); simply never confirming it is the safe
  /// equivalent — the server-side approval stays `pending` and is never
  /// executed.
  public func rejectProposal(_ summary: AssistantPendingWriteSummary) async {
    guard let index = pendingProposals.firstIndex(of: summary) else { return }
    pendingProposals.remove(at: index)
    if summary.remoteApproval == nil {
      _ = await ledger.proposalReviewer.reject(summary.callID)
    }
  }

  private static func existingSnapshot(
    for proposal: AssistantTaskMutationProposal, provider: (any AssistantTaskSnapshotProviding)?
  ) async throws -> Data? {
    switch proposal {
    case .create:
      return nil
    case .update(_, let pageID, _, _), .complete(_, let pageID, _):
      return try await provider?.snapshot(for: pageID)
    }
  }

  private static func history(
    from messages: some Sequence<AssistantConversationMessage>
  ) -> [AssistantConversationHistoryTurn] {
    var turns: [AssistantConversationHistoryTurn] = []
    var pendingUser: String?
    for message in messages {
      switch message.role {
      case .user:
        if let pendingUser {
          turns.append(AssistantConversationHistoryTurn(utterance: pendingUser, answer: ""))
        }
        pendingUser = message.text
      case .assistant:
        if let user = pendingUser {
          turns.append(AssistantConversationHistoryTurn(utterance: user, answer: message.text))
          pendingUser = nil
        }
      }
    }
    if let pendingUser {
      turns.append(AssistantConversationHistoryTurn(utterance: pendingUser, answer: ""))
    }
    return turns
  }
}
