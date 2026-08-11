// AssistantLocalToolDispatcher.swift
// EnchiridionUI
//
// Task #68 ("Assistant provider integration + conversation UI"). The REAL
// `AssistantModelToolExecuting` conformance — see
// `EnchiridionCore/AssistantModelToolProtocol.swift`'s header for why it
// lives here (this is the one target with `EnchiridionCore`,
// `EnchiridionStore`, `EnchiridionSync`, and `EnchiridionAPI` all
// available together) and for the full security argument this file exists
// to satisfy.
//
// ============================================================================
// THE SINGLE MOST IMPORTANT PROPERTY IN THIS FILE — READ BEFORE EDITING
// ============================================================================
//
// This type's stored properties for write-tool dispatch are `(any
// AssistantWriteProposalSubmitting)?` and `(any AssistantRemoteWriteTransport)?`
// — the NARROW, propose-only protocols `AssistantWriteTools.swift`/
// `AssistantRemoteWriteTools.swift` built specifically so a value of this
// shape has NO `confirm`/`reject`/`consumeConfirmed`/`confirmApproval`
// member, full stop, not merely an unused one (see those files' headers
// for the full "component that can both propose and confirm its own
// write" bug history this guards against — task #55 and the original
// `graph.propose()` bug in the gadget system).
//
// DO NOT change either stored property's declared type to
// `AssistantTaskMutationProposalLedger` (the wide actor both facades come
// from), `AssistantWriteProposalConfirming`, or
// `AssistantRemoteWriteReviewTransport` — doing so would reopen exactly
// the hole those two files' facade split exists to close, and this type is
// the ONE place in this whole feature that is ever constructed with raw
// model-supplied tool-call arguments in hand. `AssistantLocalToolDispatcherTests.swift`'s
// `testWriteFacadesCannotBeSwappedForReviewerShapedValues` is the
// executable, compile-time proof that this file currently satisfies that
// property — a reviewer should re-run it (and re-read this file's stored
// property declarations) first, before anything else, when auditing this
// task.
//
// The human-driven confirm/reject/apply path (`AssistantConversationController.swift`,
// this module) is constructed with the WIDE facades instead
// (`ledger.proposalReviewer`, `AssistantRemoteWriteReviewClient`) — and
// deliberately never hands them to this type.
//
// ============================================================================
// HONEST CAVEAT: `AssistantTaskSnapshotProviding`'s production wiring
// ============================================================================
//
// `AssistantTaskSnapshotProviding.swift`'s header points here for "the
// honest caveat about how much of that production wiring this task
// actually built versus left for a follow-on" — this is it: NO production,
// `CRDTEngine`-backed conformance of `AssistantTaskSnapshotProviding`
// exists anywhere in this codebase yet. The only conformers today are test
// fakes (`FakeSnapshotProvider` in `AssistantLocalToolDispatcherTests.swift`,
// this target's test target). `AssistantLocalToolDispatcher`'s own
// `taskSnapshotProvider` parameter happily accepts `nil` (which simply
// disables `proposeTaskUpdate`/`proposeTaskComplete`, per this file's
// `init` doc comment) and every call site in this repository currently
// leaves it `nil` in production — a real conformer wrapping
// `EnchiridionSync.CRDTEngine.exportSnapshot(of:)` and handing its bytes to
// `EnchiridionSync.PageDocument.currentVersion(of:)` (the two functions
// `currentVersionToken(for:provider:)` below assumes are snapshot-format
// compatible) has never actually been built or exercised against real
// `CRDTEngine` output. That compatibility assumption is UNVERIFIED — a
// follow-on task building the real conformance should treat it as
// unproven until a test round-trips an actual `CRDTEngine.exportSnapshot(of:)`
// result through `PageDocument.currentVersion(of:)`, not assume it from
// this file's plumbing alone.

import EnchiridionAPI
import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation

/// The real, Store/API-backed tool executor. See this file's header for
/// the security property its stored properties are chosen to guarantee.
public struct AssistantLocalToolDispatcher: AssistantModelToolExecuting {
  private let store: LocalGraphStore
  private let emailClient: (any AssistantEmailSearchClient)?
  private let writeProposalRecorder: (any AssistantWriteProposalSubmitting)?
  private let remoteWriteTransport: (any AssistantRemoteWriteTransport)?
  private let taskSnapshotProvider: (any AssistantTaskSnapshotProviding)?

  /// - Parameters:
  ///   - store: always required — every read tool needs it.
  ///   - emailClient: `nil` disables `searchEmailThreads` regardless of
  ///     what `AssistantTurnRetrievalAuthorization.emailSearch` says (an
  ///     extra, independent gate — the tool is unreachable with no client
  ///     to call, not just unauthorized).
  ///   - writeProposalRecorder: `nil` disables all three local task write
  ///     tools. MUST be obtained via
  ///     `AssistantTaskMutationProposalLedger.proposalRecorder` — see this
  ///     file's header.
  ///   - remoteWriteTransport: `nil` disables all three remote write
  ///     tools. MUST be an `AssistantRemoteWriteClient` (or another
  ///     conformer of ONLY `AssistantRemoteWriteTransport`) — see this
  ///     file's header.
  ///   - taskSnapshotProvider: `nil` disables `proposeTaskUpdate`/
  ///     `proposeTaskComplete` specifically (they need a page's current
  ///     version token; `proposeTaskCreate` doesn't and stays available).
  public init(
    store: LocalGraphStore,
    emailClient: (any AssistantEmailSearchClient)? = nil,
    writeProposalRecorder: (any AssistantWriteProposalSubmitting)? = nil,
    remoteWriteTransport: (any AssistantRemoteWriteTransport)? = nil,
    taskSnapshotProvider: (any AssistantTaskSnapshotProviding)? = nil
  ) {
    self.store = store
    self.emailClient = emailClient
    self.writeProposalRecorder = writeProposalRecorder
    self.remoteWriteTransport = remoteWriteTransport
    self.taskSnapshotProvider = taskSnapshotProvider
  }

  public func execute(
    _ call: AssistantModelToolCall,
    now: Date,
    eligibleCalendarSourceIDs: Set<String>,
    eligibleTaskPageIDs: Set<String>,
    eligibleEmailThreadIDs: Set<String>,
    calendarContextEstablishedThisTurn: Bool,
    retrievalAuthorization: AssistantTurnRetrievalAuthorization,
    writeAuthorization: AssistantTurnWriteAuthorization
  ) async throws -> AssistantModelToolExecutionResult {
    switch call.name {
    case "searchPages":
      return try executeSearchPages(call, retrievalAuthorization)
    case "findCalendarEvents":
      return try executeFindCalendarEvents(call, retrievalAuthorization)
    case "meetingBrief":
      return try executeMeetingBrief(call, retrievalAuthorization, eligibleCalendarSourceIDs)
    case "searchTasks":
      return try executeSearchTasks(call, retrievalAuthorization, now)
    case "searchEmailThreads":
      return try await executeSearchEmailThreads(call, retrievalAuthorization)
    case "proposeTaskCreate":
      return try await executeProposeTaskCreate(call, writeAuthorization)
    case "proposeTaskUpdate":
      return try await executeProposeTaskUpdate(call, writeAuthorization, eligibleTaskPageIDs)
    case "proposeTaskComplete":
      return try await executeProposeTaskComplete(call, writeAuthorization, eligibleTaskPageIDs)
    case "proposeCreateEvent":
      return try await executeProposeCreateEvent(call, writeAuthorization)
    case "proposeRsvp":
      return try await executeProposeRsvp(
        call, writeAuthorization, eligibleCalendarSourceIDs, calendarContextEstablishedThisTurn)
    case "proposeSendEmail":
      return try await executeProposeSendEmail(call, writeAuthorization)
    case "proposeArchiveEmail":
      return try await executeProposeArchiveEmail(call, writeAuthorization, eligibleEmailThreadIDs)
    case "proposeApplyLabel":
      return try await executeProposeApplyLabel(call, writeAuthorization, eligibleEmailThreadIDs)
    case "proposeRemoveLabel":
      return try await executeProposeRemoveLabel(call, writeAuthorization, eligibleEmailThreadIDs)
    case "proposeMarkRead":
      return try await executeProposeMarkRead(call, writeAuthorization, eligibleEmailThreadIDs)
    case "proposeMarkUnread":
      return try await executeProposeMarkUnread(call, writeAuthorization, eligibleEmailThreadIDs)
    default:
      throw AssistantModelToolError.unknownTool
    }
  }

  // MARK: - Read tools

  private struct SearchPagesArgs: Decodable { let query: String; let limit: Int }

  private func executeSearchPages(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnRetrievalAuthorization
  ) throws -> AssistantModelToolExecutionResult {
    guard let rule = authorization.pageSearch else { throw AssistantModelToolError.toolNotAuthorizedThisTurn }
    let args = try Self.decode(SearchPagesArgs.self, from: call.arguments, requiredKeys: ["query", "limit"])
    let result = try Self.mapReadToolError { try store.searchPages(authorization: rule, candidateQuery: args.query) }
    return .retrieval(
      try Self.retrievalOutput(
        result, sources: result.sources, facts: result.evidence, ambiguousTitles: result.ambiguousTitles,
        trustedEmptyAnswer: "I couldn't find a matching page."))
  }

  private struct FindCalendarEventsArgs: Decodable {
    let query: String
    let start: String
    let end: String
    let limit: Int
    let includeOngoing: Bool
  }

  private func executeFindCalendarEvents(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnRetrievalAuthorization
  ) throws -> AssistantModelToolExecutionResult {
    guard let rule = authorization.calendarSearch else { throw AssistantModelToolError.toolNotAuthorizedThisTurn }
    let args = try Self.decode(
      FindCalendarEventsArgs.self, from: call.arguments,
      requiredKeys: ["query", "start", "end", "limit", "includeOngoing"])
    let result = try Self.mapReadToolError {
      try store.findCalendarEvents(authorization: rule, candidateQuery: args.query)
    }
    let eligible = Set(result.events.map(\.source.id))
    return .retrieval(
      try Self.retrievalOutput(
        result, sources: result.sources, facts: result.evidence,
        trustedEmptyAnswer: "I couldn't find a matching calendar event.", eligibleCalendarSourceIDs: eligible))
  }

  private struct MeetingBriefArgs: Decodable { let sourceID: String; let peopleLimit: Int }

  private func executeMeetingBrief(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnRetrievalAuthorization,
    _ eligibleCalendarSourceIDs: Set<String>
  ) throws -> AssistantModelToolExecutionResult {
    guard let rule = authorization.meetingBrief else { throw AssistantModelToolError.toolNotAuthorizedThisTurn }
    let args = try Self.decode(
      MeetingBriefArgs.self, from: call.arguments, requiredKeys: ["sourceID", "peopleLimit"])
    // Defense in depth beyond `rule.allowedSourceIDs` (already checked one
    // layer down by `LocalGraphStore.meetingBrief`): the source must have
    // actually been RETURNED this turn by `findCalendarEvents`, not merely
    // be a member of the turn's pre-authorized allowlist — matches the old
    // app's identical `eligibleCalendarSourceIDs` discipline (see
    // `AssistantModelToolProtocol.swift`'s doc comment on this field).
    guard eligibleCalendarSourceIDs.contains(args.sourceID) else {
      throw AssistantModelToolError.candidateNotEligibleThisTurn
    }
    let result = try Self.mapReadToolError {
      try store.meetingBrief(authorization: rule, candidateSourceID: args.sourceID)
    }
    return .retrieval(
      try Self.retrievalOutput(
        result, sources: [result.event.source] + result.people, facts: result.evidence))
  }

  private struct SearchTasksArgs: Decodable { let scope: String; let query: String; let limit: Int }

  private func executeSearchTasks(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnRetrievalAuthorization, _ now: Date
  ) throws -> AssistantModelToolExecutionResult {
    guard let rule = authorization.taskSearch else { throw AssistantModelToolError.toolNotAuthorizedThisTurn }
    let args = try Self.decode(
      SearchTasksArgs.self, from: call.arguments, requiredKeys: ["scope", "query", "limit"])
    guard let scope = AssistantTaskScope(rawValue: args.scope) else {
      throw AssistantModelToolError.invalidArguments
    }
    let result = try Self.mapReadToolError {
      try store.searchTasks(authorization: rule, candidateScope: scope, candidateQuery: args.query, now: now)
    }
    let eligible = Set(result.sources.map(\.id))
    return .retrieval(
      try Self.retrievalOutput(
        result, sources: result.sources, facts: result.evidence, trustedEmptyAnswer: scope.emptyAnswer,
        eligibleTaskPageIDs: eligible))
  }

  private struct SearchEmailThreadsArgs: Decodable { let query: String; let limit: Int }

  private func executeSearchEmailThreads(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnRetrievalAuthorization
  ) async throws -> AssistantModelToolExecutionResult {
    guard let rule = authorization.emailSearch else { throw AssistantModelToolError.toolNotAuthorizedThisTurn }
    guard let emailClient else { throw AssistantModelToolError.toolNotAuthorizedThisTurn }
    let args = try Self.decode(
      SearchEmailThreadsArgs.self, from: call.arguments, requiredKeys: ["query", "limit"])
    let result: AssistantEmailThreadResults
    do {
      result = try await EnchiridionCore.searchEmailThreads(
        authorization: rule, candidateQuery: args.query, client: emailClient)
    } catch is AssistantTurnRetrievalAuthorizationError {
      throw AssistantModelToolError.invalidArguments
    }
    return .retrieval(
      try Self.retrievalOutput(
        result, sources: result.sources, facts: result.evidence,
        trustedEmptyAnswer: "I couldn't find a matching email.",
        eligibleEmailThreadIDs: result.threadPageIDs))
  }

  // MARK: - Local write tools

  private struct ProposeTaskCreateArgs: Decodable {
    let title: String
    let notes: String?
    let priority: String?
    let placement: String?
    let estimatedMinutes: Int?
  }

  private func executeProposeTaskCreate(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowTaskCreate, let recorder = writeProposalRecorder else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeTaskCreateArgs.self, from: call.arguments,
      requiredKeys: ["title", "notes", "priority", "placement", "estimatedMinutes"])
    let draft = try Self.taskDraft(
      title: args.title, notes: args.notes, priority: args.priority, placement: args.placement,
      estimatedMinutes: args.estimatedMinutes)
    let proposal = AssistantTaskMutationProposal.create(callID: call.callID, draft: draft)
    guard await recorder.record(proposal) else { throw AssistantModelToolError.invalidArguments }
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: Self.acknowledgement(callID: call.callID),
        summary: "Create task \u{201C}\(draft.title)\u{201D}"))
  }

  private struct ProposeTaskUpdateArgs: Decodable {
    let pageID: String
    let title: String?
    let notes: String?
    let priority: String?
    let placement: String?
    let estimatedMinutes: Int?
  }

  private func executeProposeTaskUpdate(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization,
    _ eligibleTaskPageIDs: Set<String>
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowTaskUpdate, let recorder = writeProposalRecorder else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeTaskUpdateArgs.self, from: call.arguments,
      requiredKeys: ["pageID", "title", "notes", "priority", "placement", "estimatedMinutes"])
    let pageID = try Self.taskPageID(from: args.pageID, eligibleTaskPageIDs: eligibleTaskPageIDs)
    let version = try await Self.currentVersionToken(for: pageID, provider: taskSnapshotProvider)
    let patch = try Self.taskPatch(
      title: args.title, notes: args.notes, priority: args.priority, placement: args.placement,
      estimatedMinutes: args.estimatedMinutes)
    let proposal = AssistantTaskMutationProposal.update(
      callID: call.callID, pageID: pageID, version: version, patch: patch)
    guard await recorder.record(proposal) else { throw AssistantModelToolError.invalidArguments }
    let summary = patch.title.map { "Update task \u{201C}\($0)\u{201D}" } ?? "Update task \(pageID.rawValue)"
    return .writeProposed(
      call.callID, AssistantWriteToolOutput(jsonOutput: Self.acknowledgement(callID: call.callID), summary: summary))
  }

  private struct ProposeTaskCompleteArgs: Decodable { let pageID: String }

  private func executeProposeTaskComplete(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization,
    _ eligibleTaskPageIDs: Set<String>
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowTaskComplete, let recorder = writeProposalRecorder else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeTaskCompleteArgs.self, from: call.arguments, requiredKeys: ["pageID"])
    let pageID = try Self.taskPageID(from: args.pageID, eligibleTaskPageIDs: eligibleTaskPageIDs)
    let version = try await Self.currentVersionToken(for: pageID, provider: taskSnapshotProvider)
    let proposal = AssistantTaskMutationProposal.complete(callID: call.callID, pageID: pageID, version: version)
    guard await recorder.record(proposal) else { throw AssistantModelToolError.invalidArguments }
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: Self.acknowledgement(callID: call.callID), summary: "Complete task \(pageID.rawValue)"))
  }

  // MARK: - Remote write tools

  private struct DateTimeArgs: Decodable { let dateTime: String?; let date: String?; let timeZone: String? }

  private struct ProposeCreateEventArgs: Decodable {
    let summary: String
    let description: String?
    let location: String?
    let start: DateTimeArgs
    let end: DateTimeArgs
    let attendeeEmails: [String]?
  }

  private func executeProposeCreateEvent(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowCreateEvent, let transport = remoteWriteTransport else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeCreateEventArgs.self, from: call.arguments,
      requiredKeys: ["summary", "description", "location", "start", "end", "attendeeEmails"])
    let summary = try Self.boundedNonEmpty(args.summary, maximum: 200)
    let attendeeEmails = try Self.boundedStringArray(args.attendeeEmails, maxItems: 20, maxLength: 200)
    let input = AssistantCreateEventInput(
      summary: summary,
      description: try Self.boundedOptional(args.description, maximum: 2_000),
      location: try Self.boundedOptional(args.location, maximum: 200),
      start: AssistantCalendarEventDateTime(
        dateTime: args.start.dateTime, date: args.start.date, timeZone: args.start.timeZone),
      end: AssistantCalendarEventDateTime(dateTime: args.end.dateTime, date: args.end.date, timeZone: args.end.timeZone),
      attendeeEmails: attendeeEmails
    )
    let approval = try await transport.createEvent(input)
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: try Self.encode(approval), summary: "Create calendar event \u{201C}\(summary)\u{201D}",
        remoteApproval: approval))
  }

  private struct ProposeRsvpArgs: Decodable { let eventSourceID: String; let responseStatus: String }

  /// UPDATED (task #96, plan §Live Backend Connectivity (P8) scope item 2):
  /// before this task, this tool had no equivalent real "eligible this
  /// turn" set to check its event argument against — no read tool exposed
  /// a real Google `eventId`, only the unrelated local
  /// `calendar:<base64(PageID)>` canonical source ID, so the best available
  /// guard was requiring `findCalendarEvents`/`meetingBrief` to have run
  /// earlier this turn (`calendarContextEstablishedThisTurn`) and pushing
  /// the raw, unverified id into the human confirm summary.
  ///
  /// Task #94 closed the real gap SERVER-SIDE: `RsvpInput.eventPageID` (the
  /// VAULT PageID of a materialized Event page) is resolved to Google's
  /// real `(eventId, calendarId)` by `write-model.ts`'s
  /// `resolveEventIdOrThrow`, at propose time, throwing
  /// `RsvpEventNotFoundError` (surfaced here as `AssistantRemoteWriteError
  /// .httpStatus(502)`) if it doesn't resolve — see
  /// `AssistantRsvpInput`'s doc comment (`AssistantRemoteWriteTools.swift`).
  /// This function now closes the matching CLIENT-side gap: `eventSourceID`
  /// must be a member of `eligibleCalendarSourceIDs` — the SAME
  /// `calendar:<base64(PageID)>` source-ID space `findCalendarEvents`/
  /// `meetingBrief` actually returned earlier THIS turn (mirrors
  /// `taskPageID(from:eligibleTaskPageIDs:)`'s identical discipline for
  /// local task writes) — before decoding it (`AssistantReadToolSupport
  /// .pageID(fromCalendarSourceID:)`) into the `eventPageID` the real RPC
  /// now expects. A model can therefore no longer invent a
  /// syntactically-plausible event reference; it must reference an event it
  /// actually looked up this turn, and the server independently re-verifies
  /// that reference resolves to a real materialized event before an
  /// approval row is even created. `calendarContextEstablishedThisTurn` is
  /// kept as a cheap, redundant early-reject (a non-empty
  /// `eligibleCalendarSourceIDs` already implies it), matching this
  /// codebase's "defense in depth" convention elsewhere in this file.
  private func executeProposeRsvp(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization,
    _ eligibleCalendarSourceIDs: Set<String>, _ calendarContextEstablishedThisTurn: Bool
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowRsvp, let transport = remoteWriteTransport else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    guard calendarContextEstablishedThisTurn else {
      throw AssistantModelToolError.noCalendarContextThisTurn
    }
    let args = try Self.decode(
      ProposeRsvpArgs.self, from: call.arguments, requiredKeys: ["eventSourceID", "responseStatus"])
    guard let status = AssistantRsvpResponseStatus(rawValue: args.responseStatus) else {
      throw AssistantModelToolError.invalidArguments
    }
    guard eligibleCalendarSourceIDs.contains(args.eventSourceID) else {
      throw AssistantModelToolError.candidateNotEligibleThisTurn
    }
    guard let eventPageID = AssistantReadToolSupport.pageID(fromCalendarSourceID: args.eventSourceID) else {
      throw AssistantModelToolError.invalidArguments
    }
    let input = AssistantRsvpInput(eventPageID: eventPageID, responseStatus: status)
    let approval = try await transport.rsvp(input)
    let summary = "Respond \(status.rawValue) to the calendar event you looked up this turn."
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(jsonOutput: try Self.encode(approval), summary: summary, remoteApproval: approval))
  }

  private struct ProposeSendEmailArgs: Decodable {
    let to: [String]
    let subject: String
    let body: String
    let cc: [String]?
    let bcc: [String]?
  }

  private func executeProposeSendEmail(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowSendEmail, let transport = remoteWriteTransport else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeSendEmailArgs.self, from: call.arguments, requiredKeys: ["to", "subject", "body", "cc", "bcc"])
    let to = try Self.boundedStringArray(args.to, maxItems: 10, maxLength: 200) ?? []
    guard !to.isEmpty else { throw AssistantModelToolError.invalidArguments }
    let input = AssistantSendEmailInput(
      to: to,
      subject: try Self.boundedNonEmpty(args.subject, maximum: 200),
      body: try Self.boundedNonEmpty(args.body, maximum: 5_000),
      cc: try Self.boundedStringArray(args.cc, maxItems: 10, maxLength: 200),
      bcc: try Self.boundedStringArray(args.bcc, maxItems: 10, maxLength: 200)
    )
    let approval = try await transport.sendEmail(input)
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: try Self.encode(approval),
        summary: "Send email \u{201C}\(input.subject)\u{201D} to \(to.joined(separator: ", "))",
        remoteApproval: approval))
  }

  // MARK: - Gmail triage write tools
  //
  // Each of the 5 tools below follows `executeProposeCreateEvent`'s
  // remote-write shape (transport call -> `.writeProposed`) PLUS
  // `executeProposeTaskUpdate`'s eligibility-check shape
  // (`eligibleTaskPageIDs.contains(candidatePageID)` before trusting a
  // model-supplied ID — see `taskPageID(from:eligibleTaskPageIDs:)`): a
  // triage action must only ever target a thread `searchEmailThreads`
  // actually returned earlier in the SAME turn, never a
  // syntactically-plausible ID the model invented.

  private struct ProposeArchiveEmailArgs: Decodable { let threadPageID: String }

  private func executeProposeArchiveEmail(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization,
    _ eligibleEmailThreadIDs: Set<String>
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowArchiveEmail, let transport = remoteWriteTransport else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeArchiveEmailArgs.self, from: call.arguments, requiredKeys: ["threadPageID"])
    let threadPageID = try Self.threadPageID(from: args.threadPageID, eligibleEmailThreadIDs: eligibleEmailThreadIDs)
    let approval = try await transport.archiveThread(AssistantArchiveThreadInput(threadPageID: threadPageID))
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: try Self.encode(approval), summary: "Archive email thread", remoteApproval: approval))
  }

  private struct ProposeApplyLabelArgs: Decodable { let threadPageID: String; let label: String }

  private func executeProposeApplyLabel(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization,
    _ eligibleEmailThreadIDs: Set<String>
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowApplyLabel, let transport = remoteWriteTransport else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeApplyLabelArgs.self, from: call.arguments, requiredKeys: ["threadPageID", "label"])
    let threadPageID = try Self.threadPageID(from: args.threadPageID, eligibleEmailThreadIDs: eligibleEmailThreadIDs)
    let label = try Self.boundedNonEmpty(args.label, maximum: 200)
    let approval = try await transport.applyLabel(AssistantApplyLabelInput(threadPageID: threadPageID, label: label))
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: try Self.encode(approval), summary: "Apply label \u{201C}\(label)\u{201D} to email thread",
        remoteApproval: approval))
  }

  private struct ProposeRemoveLabelArgs: Decodable { let threadPageID: String; let label: String }

  private func executeProposeRemoveLabel(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization,
    _ eligibleEmailThreadIDs: Set<String>
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowRemoveLabel, let transport = remoteWriteTransport else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeRemoveLabelArgs.self, from: call.arguments, requiredKeys: ["threadPageID", "label"])
    let threadPageID = try Self.threadPageID(from: args.threadPageID, eligibleEmailThreadIDs: eligibleEmailThreadIDs)
    let label = try Self.boundedNonEmpty(args.label, maximum: 200)
    let approval = try await transport.removeLabel(AssistantRemoveLabelInput(threadPageID: threadPageID, label: label))
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: try Self.encode(approval), summary: "Remove label \u{201C}\(label)\u{201D} from email thread",
        remoteApproval: approval))
  }

  private struct ProposeMarkReadArgs: Decodable { let threadPageID: String }

  private func executeProposeMarkRead(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization,
    _ eligibleEmailThreadIDs: Set<String>
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowMarkRead, let transport = remoteWriteTransport else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeMarkReadArgs.self, from: call.arguments, requiredKeys: ["threadPageID"])
    let threadPageID = try Self.threadPageID(from: args.threadPageID, eligibleEmailThreadIDs: eligibleEmailThreadIDs)
    let approval = try await transport.markRead(AssistantMarkReadInput(threadPageID: threadPageID))
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: try Self.encode(approval), summary: "Mark email thread as read", remoteApproval: approval))
  }

  private struct ProposeMarkUnreadArgs: Decodable { let threadPageID: String }

  private func executeProposeMarkUnread(
    _ call: AssistantModelToolCall, _ authorization: AssistantTurnWriteAuthorization,
    _ eligibleEmailThreadIDs: Set<String>
  ) async throws -> AssistantModelToolExecutionResult {
    guard authorization.allowMarkUnread, let transport = remoteWriteTransport else {
      throw AssistantModelToolError.toolNotAuthorizedThisTurn
    }
    let args = try Self.decode(
      ProposeMarkUnreadArgs.self, from: call.arguments, requiredKeys: ["threadPageID"])
    let threadPageID = try Self.threadPageID(from: args.threadPageID, eligibleEmailThreadIDs: eligibleEmailThreadIDs)
    let approval = try await transport.markUnread(AssistantMarkUnreadInput(threadPageID: threadPageID))
    return .writeProposed(
      call.callID,
      AssistantWriteToolOutput(
        jsonOutput: try Self.encode(approval), summary: "Mark email thread as unread", remoteApproval: approval))
  }

  // MARK: - Shared helpers

  private static func taskDraft(
    title: String, notes: String?, priority: String?, placement: String?, estimatedMinutes: Int?
  ) throws -> AssistantTaskDraft {
    let trimmedTitle = try boundedNonEmpty(title, maximum: 200)
    return AssistantTaskDraft(
      title: trimmedTitle,
      notes: try boundedOptional(notes, maximum: 2_000),
      priority: try parseOptionalEnum(priority, as: TaskPriority.self),
      placement: try parseOptionalEnum(placement, as: AssistantTaskPlacement.self),
      estimatedMinutes: try boundedOptionalInt(estimatedMinutes, minimum: 1, maximum: 600)
    )
  }

  private static func taskPatch(
    title: String?, notes: String?, priority: String?, placement: String?, estimatedMinutes: Int?
  ) throws -> AssistantTaskMutationPatch {
    AssistantTaskMutationPatch(
      title: try boundedOptional(title, maximum: 200),
      notes: try boundedOptional(notes, maximum: 2_000),
      priority: try parseOptionalEnum(priority, as: TaskPriority.self),
      placement: try parseOptionalEnum(placement, as: AssistantTaskPlacement.self),
      estimatedMinutes: try boundedOptionalInt(estimatedMinutes, minimum: 1, maximum: 600)
    )
  }

  /// `candidatePageID` must be an `AssistantSource.id` this turn's
  /// `searchTasks` actually returned (`task:<nodeID>`) — never a
  /// syntactically-plausible page ID the model invented. See this file's
  /// `executeMeetingBrief` for the identical discipline applied to
  /// calendar source IDs.
  private static func taskPageID(from candidatePageID: String, eligibleTaskPageIDs: Set<String>) throws -> PageID {
    guard eligibleTaskPageIDs.contains(candidatePageID) else {
      throw AssistantModelToolError.candidateNotEligibleThisTurn
    }
    let prefix = "task:"
    guard candidatePageID.hasPrefix(prefix) else { throw AssistantModelToolError.invalidArguments }
    return PageID(rawValue: String(candidatePageID.dropFirst(prefix.count)))
  }

  /// `candidateThreadPageID` must be a member of
  /// `AssistantEmailThreadResults.threadPageIDs` this turn's
  /// `searchEmailThreads` actually returned — never a
  /// syntactically-plausible thread page ID the model invented. See this
  /// file's `taskPageID(from:eligibleTaskPageIDs:)` for the identical
  /// discipline applied to local task write tools.
  private static func threadPageID(
    from candidateThreadPageID: String, eligibleEmailThreadIDs: Set<String>
  ) throws -> String {
    guard eligibleEmailThreadIDs.contains(candidateThreadPageID) else {
      throw AssistantModelToolError.candidateNotEligibleThisTurn
    }
    return try boundedNonEmpty(candidateThreadPageID, maximum: 200)
  }

  private static func currentVersionToken(
    for pageID: PageID, provider: (any AssistantTaskSnapshotProviding)?
  ) async throws -> AssistantPageVersionToken {
    guard let provider else { throw AssistantModelToolError.toolNotAuthorizedThisTurn }
    guard let snapshot = try await provider.snapshot(for: pageID) else {
      throw AssistantModelToolError.invalidArguments
    }
    do {
      let version = try PageDocument.currentVersion(of: snapshot)
      return AssistantPageVersionToken(encoded: version.encoded)
    } catch {
      throw AssistantModelToolError.invalidArguments
    }
  }

  private static func parseOptionalEnum<T: RawRepresentable>(_ raw: String?, as type: T.Type) throws -> T?
  where T.RawValue == String {
    guard let raw else { return nil }
    guard let value = T(rawValue: raw) else { throw AssistantModelToolError.invalidArguments }
    return value
  }

  private static func boundedNonEmpty(_ value: String, maximum: Int) throws -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= maximum else { throw AssistantModelToolError.invalidArguments }
    return trimmed
  }

  /// Bounds `value`'s length but never collapses an explicit empty string
  /// to `nil` — for `AssistantTaskMutationPatch`, `nil` means "leave this
  /// field untouched" while `""` means "clear it" (see
  /// `AssistantTaskMutationApplier.applyUpdate`'s title-clearing branch and
  /// `propertyUpdates`'s `notes.isEmpty ? [] : [.text(notes)]`) — those are
  /// two different, both-legitimate model intents that must stay
  /// distinguishable through this layer.
  private static func boundedOptional(_ value: String?, maximum: Int) throws -> String? {
    guard let value else { return nil }
    guard value.count <= maximum else { throw AssistantModelToolError.invalidArguments }
    return value
  }

  private static func boundedOptionalInt(_ value: Int?, minimum: Int, maximum: Int) throws -> Int? {
    guard let value else { return nil }
    guard (minimum...maximum).contains(value) else { throw AssistantModelToolError.invalidArguments }
    return value
  }

  private static func boundedStringArray(_ values: [String]?, maxItems: Int, maxLength: Int) throws -> [String]? {
    guard let values else { return nil }
    guard values.count <= maxItems,
      values.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= maxLength })
    else { throw AssistantModelToolError.invalidArguments }
    return values
  }

  private static func acknowledgement(callID: AssistantToolCallID) -> String {
    "{\"proposed\":true,\"callID\":\"\(callID.rawValue)\"}"
  }

  private static func encode(_ approval: AssistantPendingApproval) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(approval)
    return String(decoding: data, as: UTF8.self)
  }

  /// Read tools throw either `AssistantDataAccessError` or
  /// `AssistantTurnRetrievalAuthorizationError` one layer down
  /// (`EnchiridionStore.AssistantReadTools.swift`) — both map to
  /// `.invalidArguments` here rather than propagating a Store-specific
  /// error type up through the provider-neutral turn loop.
  private static func mapReadToolError<T>(_ body: () throws -> T) throws -> T {
    do {
      return try body()
    } catch is AssistantDataAccessError {
      throw AssistantModelToolError.invalidArguments
    } catch is AssistantTurnRetrievalAuthorizationError {
      throw AssistantModelToolError.invalidArguments
    }
  }

  private static func retrievalOutput<Value: Encodable>(
    _ value: Value,
    sources: [AssistantSource],
    facts: [AssistantEvidenceFact],
    ambiguousTitles: [String] = [],
    trustedEmptyAnswer: String? = nil,
    eligibleCalendarSourceIDs: Set<String> = [],
    eligibleTaskPageIDs: Set<String> = [],
    eligibleEmailThreadIDs: Set<String> = []
  ) throws -> AssistantRetrievalToolOutput {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    encoder.dateEncodingStrategy = .iso8601
    let data: Data
    do {
      data = try encoder.encode(value)
    } catch {
      throw AssistantModelToolError.outputTooLarge
    }
    guard data.count <= 64 * 1_024 else { throw AssistantModelToolError.outputTooLarge }
    return AssistantRetrievalToolOutput(
      jsonOutput: String(decoding: data, as: UTF8.self),
      sources: sources,
      facts: facts,
      ambiguousTitles: ambiguousTitles,
      trustedEmptyAnswer: facts.isEmpty ? trustedEmptyAnswer : nil,
      eligibleCalendarSourceIDs: eligibleCalendarSourceIDs,
      eligibleTaskPageIDs: eligibleTaskPageIDs,
      eligibleEmailThreadIDs: eligibleEmailThreadIDs
    )
  }

  /// Bounded, exact-key JSON argument decoding — matches the old app's
  /// `OpenAILocalToolExecutor.requireKeys(exactly:)` discipline (reject
  /// missing OR extra keys outright, never best-effort parse).
  private static func decode<T: Decodable>(
    _ type: T.Type, from raw: String, requiredKeys: Set<String>
  ) throws -> T {
    guard raw.utf8.count <= 16 * 1_024, let data = raw.data(using: .utf8) else {
      throw AssistantModelToolError.invalidArguments
    }
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == requiredKeys
    else { throw AssistantModelToolError.invalidArguments }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw AssistantModelToolError.invalidArguments
    }
  }
}
