// OpenAIResponsesAssistant.swift
// EnchiridionCore
//
// Task #68 ("Assistant provider integration + conversation UI"). The turn
// lifecycle state machine — ported shape (not code) from the old app's
// `AssistantConversationSession.swift`/`AssistantConversationRuntime.swift`
// and `OpenAIResponsesAssistant.swift`, trimmed to what this package's
// grounding contract actually needs (no route/provider selection, no
// token-usage/receipt bookkeeping, no voice modality — see the plan's
// Assistant (P5) section: "OpenAI Responses API only for P5 ... Voice ...
// explicitly P6 work").
//
// THE LOOP, PRECISELY (plan's Assistant (P5) section: "a turn goes user
// input -> model call -> (loop: tool call -> tool executor -> grounding
// policy validates final answer OR another tool call) -> GroundedAssistantResponse
// rendered, OR a pending write proposal surfaced for human confirm"):
//
//   1. Build a request (`OpenAIResponsesRequestBuilder.makeBody`) advertising
//      only the tools this turn's `AssistantTurnRetrievalAuthorization`/
//      `AssistantTurnWriteAuthorization` allow.
//   2. Send it, decode the terminal response.
//   3. At most one tool call per model turn (matches the old app's
//      `guard calls.count <= 1`) — if present, dispatch it through the
//      injected `AssistantModelToolExecuting`:
//        - a READ tool result is fed back to the model as a
//          `function_call_output` and the loop continues (step 1 again,
//          same authorization, accumulated tool history) — capped at 4
//          tool calls total (`tooManyToolCalls`), matching the old app.
//        - a WRITE tool result ends the turn IMMEDIATELY with
//          `.pendingWriteConfirmation` — the loop deliberately never asks
//          the model for a further text reply about its own write
//          proposal. Two reasons: (a) nothing about "please confirm this"
//          is a factual claim `AssistantGroundingPolicy` could validate,
//          so there is no safe way to let the model author that text
//          anyway; (b) it removes an entire class of "model claims the
//          write already happened" risk by construction — the ONLY text
//          the person ever sees about a pending write is the trusted,
//          app-authored `AssistantWriteToolOutput.summary` built from the
//          already-validated draft/input fields (see
//          `AssistantModelToolProtocol.swift`).
//   4. No tool call: the model's structured `{answer, factIDs}` output
//      resolves through `AssistantGroundingPolicy.groundedResponse` when
//      any tool ran this turn (factIDs select from this turn's REAL
//      results only — the same "sources+facts or reject" contract #65
//      already built and this file never reimplements); a genuinely
//      tool-free conversational reply (factIDs empty, no tool call made at
//      all) is allowed through as freeform prose, matching the old app's
//      `toolCallCount == 0` case — greetings and brainstorming were never
//      meant to be "grounded" in local facts. That reply is tagged
//      `.ungrounded`, not `.answered` (`resolvedResponse`'s
//      `.answer where toolCallCount == 0` branch) — it is genuine,
//      allowed prose, but nothing retrieved this turn backs it, and the
//      UI owes the person a visible "unverified" signal for that.
//
// WHY THIS ACTOR CAN LIVE IN `EnchiridionCore` (unlike the concrete tool
// executor): see `AssistantModelToolProtocol.swift`'s header — this file
// only ever calls the `AssistantModelToolExecuting` PROTOCOL, never a
// concrete Store/Sync/API-backed type. The turn loop is provider-glue and
// grounding-contract enforcement; it has no reason to import anything
// EnchiridionStore/EnchiridionSync/EnchiridionAPI define, and doing so
// would be circular regardless (same argument as
// `AssistantReadToolModels.swift`'s header).

import Foundation

// MARK: - Request/response shapes

/// One already-completed user/answer pair of prior conversation —
/// provider-neutral, deliberately much smaller than the old app's
/// `AssistantConversationTurn` (no per-turn metadata/provenance/modality;
/// P5 is text-only, OpenAI-only).
public struct AssistantConversationHistoryTurn: Equatable, Sendable {
  public var utterance: String
  public var answer: String

  public init(utterance: String, answer: String) {
    self.utterance = utterance
    self.answer = answer
  }
}

/// One conversation turn's input. `retrievalAuthorization`/
/// `writeAuthorization` are built by app/UI code before this is submitted
/// — see this file's header and `AssistantTurnRetrievalAuthorization.swift`
/// / `AssistantTurnWriteAuthorization.swift`'s headers for why neither is
/// ever derived from anything the model says.
public struct AssistantConversationRequest: Sendable {
  public var utterance: String
  public var priorTurns: [AssistantConversationHistoryTurn]
  public var now: Date
  public var retrievalAuthorization: AssistantTurnRetrievalAuthorization
  public var writeAuthorization: AssistantTurnWriteAuthorization

  public init(
    utterance: String,
    priorTurns: [AssistantConversationHistoryTurn] = [],
    now: Date = Date(),
    retrievalAuthorization: AssistantTurnRetrievalAuthorization = .none,
    writeAuthorization: AssistantTurnWriteAuthorization = .none
  ) {
    self.utterance = utterance
    self.priorTurns = priorTurns
    self.now = now
    self.retrievalAuthorization = retrievalAuthorization
    self.writeAuthorization = writeAuthorization
  }
}

/// A trusted, app-authored (never model-authored) description of one
/// recorded write proposal, ready for a human-confirm UI to render. See
/// `AssistantModelToolProtocol.swift`'s `AssistantWriteToolOutput`.
public struct AssistantPendingWriteSummary: Equatable, Sendable {
  public let callID: AssistantToolCallID
  public let summary: String
  /// See `AssistantWriteToolOutput.remoteApproval`'s doc comment — `nil`
  /// for a local task proposal (confirmed via `callID` +
  /// `AssistantWriteProposalConfirming`), set for a remote write (confirmed
  /// via this value's own `id`/`versionToken` +
  /// `AssistantRemoteWriteReviewTransport`).
  public let remoteApproval: AssistantPendingApproval?

  public init(callID: AssistantToolCallID, summary: String, remoteApproval: AssistantPendingApproval? = nil) {
    self.callID = callID
    self.summary = summary
    self.remoteApproval = remoteApproval
  }
}

/// What one turn produced. Never both — see this file's header, step 3.
public enum AssistantConversationTurnOutcome: Sendable {
  case grounded(GroundedAssistantResponse)
  case pendingWriteConfirmation(AssistantPendingWriteSummary)
}

// MARK: - Turn-scoped collector

/// Accumulates every READ tool result across one turn's tool-call loop —
/// ported concept from the old app's `OpenAITurnCollector`
/// (`OpenAILocalToolExecutor.swift`). Deliberately never records write-tool
/// results: a write ends the turn immediately (this file's header, step 3),
/// so there is nothing for a later loop iteration to accumulate.
private struct AssistantTurnCollector {
  private(set) var sources: [AssistantSource] = []
  private(set) var facts: [AssistantEvidenceFact] = []
  private(set) var ambiguousTitles: [String] = []
  private(set) var trustedEmptyAnswer: String?
  private(set) var eligibleCalendarSourceIDs: Set<String> = []
  private(set) var eligibleTaskPageIDs: Set<String> = []
  private(set) var eligibleEmailThreadIDs: Set<String> = []
  /// Whether `findCalendarEvents` or `meetingBrief` has actually been
  /// called (and completed as a retrieval) earlier in this turn — see
  /// `AssistantModelToolExecuting.execute`'s `calendarContextEstablishedThisTurn`
  /// parameter doc comment.
  private(set) var calendarContextEstablished = false
  private var sourceIDs: Set<String> = []
  private var factIDs: Set<String> = []

  mutating func markCalendarContextEstablished() {
    calendarContextEstablished = true
  }

  mutating func record(_ output: AssistantRetrievalToolOutput) {
    for source in output.sources where sourceIDs.insert(source.id).inserted {
      sources.append(source)
    }
    for fact in output.facts where factIDs.insert(fact.id).inserted {
      facts.append(fact)
    }
    for title in output.ambiguousTitles where !ambiguousTitles.contains(title) {
      ambiguousTitles.append(title)
    }
    eligibleCalendarSourceIDs.formUnion(output.eligibleCalendarSourceIDs)
    eligibleTaskPageIDs.formUnion(output.eligibleTaskPageIDs)
    eligibleEmailThreadIDs.formUnion(output.eligibleEmailThreadIDs)
    if output.facts.isEmpty, let empty = output.trustedEmptyAnswer {
      trustedEmptyAnswer = empty
    }
  }
}

// MARK: - The assistant

/// Runs one OpenAI Responses API conversation turn at a time. Holds only
/// provider-wire-protocol state (transport, credential) plus the injected
/// `AssistantModelToolExecuting` seam — see this file's header for why it
/// never sees a concrete Store/Sync/API type.
public actor OpenAIResponsesAssistant {
  /// Hard cap on tool calls within one turn — matches the old app's
  /// `toolCallCount <= 4`. A model that keeps calling tools past this is
  /// treated as a failure, not an infinite local loop.
  static let maximumToolCallsPerTurn = 4

  private let modelID: String
  private let credential: @Sendable () async throws -> String
  private let executor: any AssistantModelToolExecuting
  private let transport: any OpenAIResponsesTransporting

  public init(
    modelID: String,
    executor: any AssistantModelToolExecuting,
    credential: @escaping @Sendable () async throws -> String
  ) {
    self.modelID = modelID
    self.executor = executor
    self.credential = credential
    self.transport = NativeOpenAIResponsesTransport()
  }

  /// Test/internal seam — lets tests inject a fake transport without
  /// touching the network. Production code must use the `public init`
  /// above, which always uses the real `NativeOpenAIResponsesTransport`.
  init(
    modelID: String,
    executor: any AssistantModelToolExecuting,
    credential: @escaping @Sendable () async throws -> String,
    transport: any OpenAIResponsesTransporting
  ) {
    self.modelID = modelID
    self.executor = executor
    self.credential = credential
    self.transport = transport
  }

  public func respond(to request: AssistantConversationRequest) async -> AssistantConversationTurnOutcome {
    let runtimeCredential: String
    do {
      runtimeCredential = try await credential()
    } catch {
      return .grounded(failureResponse(.credentialUnavailable))
    }
    return await performAttempt(request, credential: runtimeCredential)
  }

  private func performAttempt(
    _ request: AssistantConversationRequest, credential: String
  ) async -> AssistantConversationTurnOutcome {
    var continuationItems: [OpenAIJSONValue] = []
    var toolCallCount = 0
    var collector = AssistantTurnCollector()
    let history = request.priorTurns.map {
      OpenAIResponsesRequestBuilder.HistoryTurn(utterance: $0.utterance, answer: $0.answer)
    }

    do {
      while true {
        try Task.checkCancellation()
        let body = try OpenAIResponsesRequestBuilder.makeBody(
          utterance: request.utterance,
          priorTurns: history,
          modelID: modelID,
          continuationItems: continuationItems,
          retrievalAuthorization: request.retrievalAuthorization,
          writeAuthorization: request.writeAuthorization
        )
        let result = try await transport.send(body: body, credential: credential)
        if let failure = OpenAIResponsesErrorClassifier.failure(for: result) { throw failure }

        let terminal = try OpenAIResponsesCodec.terminalResponse(from: result.events)
        guard let actualModelID = OpenAIResponsesCodec.sanitizedIdentifier(terminal.model),
          actualModelID == modelID
        else { throw OpenAIResponsesAssistantError.invalidResponse }
        switch terminal.status {
        case .completed: break
        case .incomplete: throw OpenAIResponsesAssistantError.incomplete
        case .failed: throw OpenAIResponsesAssistantError.failed
        }

        let calls = try OpenAIResponsesCodec.toolCalls(in: terminal.output)
        guard calls.count <= 1 else { throw OpenAIResponsesAssistantError.invalidResponse }

        if let call = calls.first {
          toolCallCount += 1
          guard toolCallCount <= Self.maximumToolCallsPerTurn else {
            throw OpenAIResponsesAssistantError.tooManyToolCalls
          }
          let execution = try await executor.execute(
            call,
            now: request.now,
            eligibleCalendarSourceIDs: collector.eligibleCalendarSourceIDs,
            eligibleTaskPageIDs: collector.eligibleTaskPageIDs,
            eligibleEmailThreadIDs: collector.eligibleEmailThreadIDs,
            calendarContextEstablishedThisTurn: collector.calendarContextEstablished,
            retrievalAuthorization: request.retrievalAuthorization,
            writeAuthorization: request.writeAuthorization
          )
          switch execution {
          case .retrieval(let output):
            collector.record(output)
            if call.name == "findCalendarEvents" || call.name == "meetingBrief" {
              collector.markCalendarContextEstablished()
            }
            continuationItems.append(contentsOf: terminal.output)
            continuationItems.append(
              .object([
                "type": .string("function_call_output"),
                "call_id": .string(call.callID.rawValue),
                "output": .string(output.jsonOutput),
              ]))
            continue
          case .writeProposed(let callID, let writeOutput):
            return .pendingWriteConfirmation(
              AssistantPendingWriteSummary(
                callID: callID, summary: writeOutput.summary, remoteApproval: writeOutput.remoteApproval))
          }
        }

        let content = try OpenAIResponsesCodec.content(in: terminal.output)
        return .grounded(try resolvedResponse(content: content, toolCallCount: toolCallCount, collector: collector))
      }
    } catch is CancellationError {
      return .grounded(failureResponse(.networkUnavailable))
    } catch let error as OpenAIResponsesAssistantError {
      return .grounded(failureResponse(error))
    } catch is URLError {
      return .grounded(failureResponse(.networkUnavailable))
    } catch {
      return .grounded(failureResponse(.invalidResponse))
    }
  }

  private func resolvedResponse(
    content: OpenAIResponseContent, toolCallCount: Int, collector: AssistantTurnCollector
  ) throws -> GroundedAssistantResponse {
    switch content {
    case .refusal(let refusal) where toolCallCount == 0:
      return GroundedAssistantResponse(answer: refusal, status: .answered)
    case .refusal:
      // Once local tool output has crossed the provider boundary, model
      // prose is untrusted for presentation even when labelled a refusal.
      return GroundedAssistantResponse(answer: "I can’t help with that request.", status: .answered)
    case .answer(let structuredAnswer) where toolCallCount == 0:
      let answer = structuredAnswer.answer.trimmingCharacters(in: .whitespacesAndNewlines)
      guard structuredAnswer.factIDs.isEmpty, !answer.isEmpty, answer.count <= 1_200 else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      // Genuinely tool-free — no retrieval backed this answer, so it must
      // never be labelled `.answered` (which implies grounded-or-trusted
      // provenance). See this file's header, step 4, and
      // `AssistantResponseStatus.ungrounded`'s doc comment.
      return GroundedAssistantResponse(answer: answer, status: .ungrounded)
    case .answer(let structuredAnswer):
      return Self.resolveGroundedTurn(selectedFactIDs: structuredAnswer.factIDs, collector: collector)
    case .none where !collector.facts.isEmpty:
      return Self.resolveGroundedTurn(selectedFactIDs: collector.facts.map(\.id), collector: collector)
    case .none:
      guard let trustedEmptyAnswer = collector.trustedEmptyAnswer else {
        throw OpenAIResponsesAssistantError.invalidResponse
      }
      return GroundedAssistantResponse(answer: trustedEmptyAnswer, status: .noResults)
    }
  }

  /// The ONLY place a model's `factIDs` selection ever turns into
  /// `answer` text — via `AssistantGroundingPolicy`, never by trusting
  /// `structuredAnswer.answer` itself once tools have run this turn. A
  /// selection that fails validation (hallucinated ID, empty, too many)
  /// degrades to a safe trusted fallback rather than surfacing the raw
  /// `AssistantGroundingError` to the person — the failure is the model's,
  /// not something the user needs to see as a app error.
  private static func resolveGroundedTurn(
    selectedFactIDs: [String], collector: AssistantTurnCollector
  ) -> GroundedAssistantResponse {
    do {
      return try AssistantGroundingPolicy.groundedResponse(
        selectedFactIDs: selectedFactIDs,
        availableFacts: collector.facts,
        availableSources: collector.sources,
        ambiguousTitles: collector.ambiguousTitles
      )
    } catch {
      if let trustedEmptyAnswer = collector.trustedEmptyAnswer {
        return GroundedAssistantResponse(answer: trustedEmptyAnswer, status: .noResults)
      }
      return AssistantGroundingPolicy.noResults()
    }
  }

  private func failureResponse(_ error: OpenAIResponsesAssistantError) -> GroundedAssistantResponse {
    let message: String
    switch error {
    case .credentialUnavailable:
      message = "Add or verify your OpenAI API key in Settings before sending this message."
    case .authorizationRejected:
      message = "OpenAI could not authorize this request. Check your API key in Settings."
    case .accessDenied:
      message = "OpenAI denied this request. Review the provider settings."
    case .rateLimited(let seconds):
      message =
        seconds.map { "OpenAI rate-limited this request. Try again in \($0) seconds." }
        ?? "OpenAI rate-limited this request. Wait, then try again."
    case .billingRequired:
      message = "OpenAI could not bill this request. Check the API project's billing and limits."
    case .serviceUnavailable:
      message = "OpenAI is temporarily unavailable. Try again later."
    case .networkUnavailable:
      message = "The request did not complete. Check your connection and try again."
    case .incomplete:
      message = "OpenAI could not finish this response. You can retry when ready."
    case .failed, .invalidResponse, .tooManyToolCalls:
      message = "OpenAI could not complete this response safely. You can retry when ready."
    }
    return GroundedAssistantResponse(answer: message, status: .unavailable)
  }
}
