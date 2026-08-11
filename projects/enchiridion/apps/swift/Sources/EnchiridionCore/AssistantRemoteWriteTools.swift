// AssistantRemoteWriteTools.swift
// EnchiridionCore
//
// Calendar/Gmail write-tool wrappers (task #67, plan "Assistant (P5)":
// "calendar create/RSVP and Gmail send already go through approval-gated
// RPC methods with version tokens ... the assistant's write tools are thin
// callers of those existing `gatekeeper-google` RPCs, gaining their safety
// for free").
//
// SOURCE OF TRUTH FOR THE WIRE SHAPES: read in full before changing this
// file —
//   - `@enchiridion/gatekeeper-google-rpc-contract` (packages/
//     gatekeeper-google-rpc-contract/src/index.ts) — the READ direction
//     only (`getMessagesForThreads`/`searchEmailMessages`); it does not
//     cover the write-model, which is this file's actual subject.
//   - `workers/gatekeeper-google/src/index.ts`'s `CalendarWriteModel`/
//     `GmailWriteModel` (`WorkerEntrypoint` RPC classes) — the REAL
//     method signatures: `createEvent(CreateEventInput)`,
//     `rsvp(RsvpInput)`, `sendEmail(SendEmailInput)`, plus
//     `confirmApproval(id, versionToken)`/`getApproval(id)`/
//     `listPendingApprovals()`, shared by both.
//   - `workers/gatekeeper-google/src/calendar-write-model.ts`
//     (`CreateEventInput`/`RsvpInput`), `gmail-send.ts` (`SendEmailInput`),
//     `approvals-store.ts` (`PendingApproval`/`ApprovalStatus`/
//     `ConfirmOutcome`), `write-model.ts` (`ConfirmApprovalResult`).
//
// TRANSPORT: `CalendarWriteModel`/`GmailWriteModel` are Workers-RPC
// `WorkerEntrypoint`s, reachable ONLY via a Cloudflare Service Binding
// from another worker (see `workers/gatekeeper-google/src/index.ts`'s
// header: "no generic API passthrough" — this worker deliberately has NO
// public HTTP route for any of these calls). A native app cannot open a
// Service Binding; per the plan's "Native apps ... call vault directly"
// architecture, a device reaches these through a `vault`-side HTTP proxy
// route that forwards into `CalendarWriteModel`/`GmailWriteModel` over its
// own service binding — exactly the same shape `vault`'s `/graphql`
// resolvers already use to reach `GmailReadModel`.
//
// UPDATE (task #96, plan §Live Backend Connectivity (P8) scope item 1):
// THAT PROXY ROUTE NOW EXISTS — task #94 built it
// (`workers/vault/src/gatekeeper-google-write-routes.ts`,
// `handleGatekeeperGoogleWriteRequest`, mounted at `/gatekeeper-google/*`
// in `workers/vault/src/index.ts`). The seven `createEvent`/`rsvp`/
// `sendEmail`/`archiveThread`/`applyLabel`/`removeLabel`/`markRead`/
// `markUnread` paths below (`AssistantRemoteWriteClient`) are updated to
// match that real route's exact contract — verified by reading
// `gatekeeper-google-write-routes.ts` directly, not guessed:
//
//   POST /gatekeeper-google/calendar/create-event
//   POST /gatekeeper-google/calendar/rsvp
//   POST /gatekeeper-google/gmail/archive-thread
//   POST /gatekeeper-google/gmail/apply-label
//   POST /gatekeeper-google/gmail/remove-label
//   POST /gatekeeper-google/gmail/mark-read
//   POST /gatekeeper-google/gmail/mark-unread
//   POST /gatekeeper-google/gmail/send
//
// `confirmApproval`/`getApproval`/`listPendingApprovals`
// (`AssistantRemoteWriteReviewClient` below) are DELIBERATELY, STILL NOT
// proxied by task #94 — that file's own header states this explicitly
// ("out of this task's scope"). The `write/gatekeeper-google/approvals/...`
// paths those three methods still POST/GET against remain THIS file's own
// best-effort prediction, unchanged by this pass and still not a verified
// live route — a real gap, not silently hidden: see
// `AssistantConversationController.confirmProposal(_:)`, which already
// surfaces "This proposal cannot be confirmed on this device" as an honest
// UI message rather than crashing when a remote confirm attempt 404s.
//
// ============================================================================
// THE ASSUMPTION THIS TASK ASKED TO BE VERIFIED, NOT TAKEN ON FAITH
// ============================================================================
//
// Task brief: "the assistant's role here is to submit the RPC — it does
// NOT need a second client-side ledger like Part 1's local writes do ...
// confirm this understanding is correct by reading gatekeeper-google's
// actual approval flow ... and note in your report if you find this
// assumption wrong."
//
// VERIFIED, WITH A CORRECTION: no second client-side LEDGER is needed —
// that half of the assumption is correct. `proposeApproval`
// (`approvals-store.ts`) mints a fresh `pending` row with its own
// server-held version token on every `createEvent`/`rsvp`/`sendEmail`
// call; there is no local state for a ledger to track, and the server's
// `pending_approvals` table already IS the durable proposal record Part
// 1's ledger exists to provide locally.
//
// BUT: `confirmApproval` — the ONLY method that actually reaches Google's
// mutating Calendar/Gmail API — is exposed on the EXACT SAME
// `WorkerEntrypoint` RPC class (`CalendarWriteModel`/`GmailWriteModel`,
// `workers/gatekeeper-google/src/index.ts`) as `createEvent`/`rsvp`/
// `sendEmail` themselves. Nothing server-side stops a caller that can
// reach `createEvent` from also reaching `confirmApproval` on that same
// binding — the "server-side approval gate" is real (the CAS in
// `tryConfirmApproval`, `approvals-store.ts`), but it gates CONCURRENT
// confirmers racing each other, not "can THIS caller confirm at all." If
// this file had built one client type exposing all of
// `createEvent`/`rsvp`/`sendEmail`/`confirmApproval` together, and handed
// that single type to the assistant's tool-dispatch code, the assistant
// would have had exactly the same self-propose-then-self-confirm
// reachable path the gadget-host bug report describes — just one client
// class away from calling both in the same turn, with zero human
// involvement, same as the bug this task's brief warns about by name.
// `gatekeeper-google/src/index.ts`'s own header confirms the human
// confirmation step is NOT built yet ("STILL NOT IMPLEMENTED ... The
// in-app confirmation UI that would actually call
// `CalendarWriteModel.confirmApproval()` from a device — a future
// native-app task") — so today, NOTHING external enforces that only a
// human-driven code path calls `confirmApproval`. That enforcement has to
// live in this client.
//
// FIX (mirrors AssistantWriteTools.swift's Part 1 split exactly, applied
// to this RPC surface instead of the local ledger): `createEvent`/`rsvp`/
// `sendEmail` and `confirmApproval`/`getApproval`/`listPendingApprovals`
// are split across two ENTIRELY SEPARATE concrete types
// (`AssistantRemoteWriteClient` / `AssistantRemoteWriteReviewClient`) with
// no shared base class, no shared protocol conformance, and no possible
// downcast path from one to the other — there is no single wide object to
// downcast FROM. The assistant's tool-dispatch code (task #68) must only
// ever be constructed with an `AssistantRemoteWriteClient` (or,
// generically, `any AssistantRemoteWriteTransport`) — that value has no
// `confirmApproval` member, verified in
// `AssistantRemoteWriteToolsTests.swift`'s
// `testProposeOnlyClientCannotBeTreatedAsAReviewClient`.
// `AssistantRemoteWriteReviewClient` must only be constructed by the
// future human-driven confirmation UI task.
//
// So: no ledger needed (assumption confirmed), but the SAME self-confirm
// discipline as Part 1 still had to be built into this client explicitly
// — the task brief's framing ("it does not need a second client-side
// ledger") could be misread as "so this file needs no special care around
// confirm at all," which would have been wrong. Flagged in the final
// report as requested.

import Foundation

// MARK: - Wire DTOs — calendar

/// Mirrors Google Calendar's `EventDateTime` shape, as
/// `calendar-write-model.ts`'s `CreateEventInput.start`/`.end`
/// (`GoogleCalendarEventDateTime`, re-exported from `calendar-api.ts`)
/// already encode it: exactly one of `dateTime`/`date` is populated,
/// `timeZone` optional.
public struct AssistantCalendarEventDateTime: Codable, Equatable, Hashable, Sendable {
  public var dateTime: String?
  public var date: String?
  public var timeZone: String?

  public init(dateTime: String? = nil, date: String? = nil, timeZone: String? = nil) {
    self.dateTime = dateTime
    self.date = date
    self.timeZone = timeZone
  }
}

/// Mirrors `calendar-write-model.ts`'s `CreateEventInput` field-for-field.
public struct AssistantCreateEventInput: Codable, Equatable, Hashable, Sendable {
  public var calendarId: String?
  public var summary: String
  public var description: String?
  public var location: String?
  public var start: AssistantCalendarEventDateTime
  public var end: AssistantCalendarEventDateTime
  public var attendeeEmails: [String]?

  public init(
    calendarId: String? = nil,
    summary: String,
    description: String? = nil,
    location: String? = nil,
    start: AssistantCalendarEventDateTime,
    end: AssistantCalendarEventDateTime,
    attendeeEmails: [String]? = nil
  ) {
    self.calendarId = calendarId
    self.summary = summary
    self.description = description
    self.location = location
    self.start = start
    self.end = end
    self.attendeeEmails = attendeeEmails
  }
}

/// Mirrors `calendar-write-model.ts`'s `RsvpInput.responseStatus` union.
public enum AssistantRsvpResponseStatus: String, Codable, Hashable, Sendable {
  case accepted
  case declined
  case tentative
}

/// Mirrors `calendar-write-model.ts`'s real `RsvpInput` field-for-field, AS
/// OF task #94's real Google event-ID verification (plan §"Live Backend
/// Connectivity (P8)" — see `workers/gatekeeper-google/src/write-model.ts`'s
/// `proposeRsvp`/`resolveEventIdOrThrow` and
/// `workers/vault/src/gatekeeper-google-write-types.ts`'s `RsvpInput`).
///
/// BEFORE task #96, this type carried a client-supplied `eventId`
/// (required) / `calendarId` (optional) — the raw, UNVERIFIED Google IDs
/// `AssistantLocalToolDispatcher.executeProposeRsvp`'s own doc comment used
/// to describe as "no read tool in this codebase currently exposes a real
/// Google eventId/calendarId to the model." That's no longer the real wire
/// contract: `RsvpInput.eventPageID` is the VAULT `PageID` of a
/// materialized Event page (the SAME id space `AssistantReadToolSupport
/// .calendarSourceID(pageID:)`/`.pageID(fromCalendarSourceID:)` already
/// encodes into `findCalendarEvents`/`meetingBrief`'s `AssistantSource.id`
/// values) — `write-model.ts`'s `resolveEventIdOrThrow` resolves it to
/// Google's real `(eventId, calendarId)` SERVER-SIDE, at propose time,
/// throwing `RsvpEventNotFoundError` before any approval row exists if it
/// doesn't resolve. A caller-supplied `eventId`/`calendarId` would be
/// discarded even if sent (`write-model.ts`'s `proposeRsvp`: "Any
/// caller-supplied eventId/calendarId on input is discarded"), so this
/// Swift type simply never sends them — there is no legitimate value a
/// client-side caller could supply for either field anyway.
public struct AssistantRsvpInput: Codable, Equatable, Hashable, Sendable {
  public var eventPageID: String
  public var responseStatus: AssistantRsvpResponseStatus

  public init(eventPageID: String, responseStatus: AssistantRsvpResponseStatus) {
    self.eventPageID = eventPageID
    self.responseStatus = responseStatus
  }
}

// MARK: - Wire DTOs — Gmail

/// Mirrors `gmail-send.ts`'s `SendEmailInput` — deliberately WITHOUT a
/// `messageId` field: the real server mints and persists the RFC 2822
/// `Message-ID` itself at propose time (`write-model.ts`'s
/// `proposeSendEmail`, via `generateGmailMessageId()`), specifically so a
/// caller can never supply (or fail to supply) the idempotency key —
/// see that file's "MESSAGE-ID / IDEMPOTENCY" header note.
public struct AssistantSendEmailInput: Codable, Equatable, Hashable, Sendable {
  public var to: [String]
  public var subject: String
  public var body: String
  public var cc: [String]?
  public var bcc: [String]?

  public init(to: [String], subject: String, body: String, cc: [String]? = nil, bcc: [String]? = nil) {
    self.to = to
    self.subject = subject
    self.body = body
    self.cc = cc
    self.bcc = bcc
  }
}

// MARK: - Wire DTOs — Gmail triage

/// Mirrors `GmailWriteModel.archiveThread`'s `{ threadPageID: string }`
/// input (`workers/gatekeeper-google/src`, landing concurrently with this
/// file — see this file's header, "WIRE CONTRACT"). `threadPageID` is the
/// VAULT `PageID` of the `EmailThread` page — the same value as
/// `AssistantEmailMessage.threadPageID`/`AssistantEmailThreadResults.threadPageIDs`
/// (`AssistantReadToolModels.swift`), never a raw Gmail thread id.
public struct AssistantArchiveThreadInput: Codable, Equatable, Hashable, Sendable {
  public var threadPageID: String

  public init(threadPageID: String) {
    self.threadPageID = threadPageID
  }
}

/// Mirrors `GmailWriteModel.applyLabel`'s `{ threadPageID: string; label:
/// string }` input. `label` is an opaque Gmail label-ID string (e.g.
/// `"IMPORTANT"`, `"STARRED"`, or a user label id) — no validation beyond
/// non-empty/bounded-length is expected client-side; the server validates
/// further.
public struct AssistantApplyLabelInput: Codable, Equatable, Hashable, Sendable {
  public var threadPageID: String
  public var label: String

  public init(threadPageID: String, label: String) {
    self.threadPageID = threadPageID
    self.label = label
  }
}

/// Mirrors `GmailWriteModel.removeLabel`'s `{ threadPageID: string; label:
/// string }` input — see `AssistantApplyLabelInput`'s doc comment.
public struct AssistantRemoveLabelInput: Codable, Equatable, Hashable, Sendable {
  public var threadPageID: String
  public var label: String

  public init(threadPageID: String, label: String) {
    self.threadPageID = threadPageID
    self.label = label
  }
}

/// Mirrors `GmailWriteModel.markRead`'s `{ threadPageID: string }` input —
/// see `AssistantArchiveThreadInput`'s doc comment.
public struct AssistantMarkReadInput: Codable, Equatable, Hashable, Sendable {
  public var threadPageID: String

  public init(threadPageID: String) {
    self.threadPageID = threadPageID
  }
}

/// Mirrors `GmailWriteModel.markUnread`'s `{ threadPageID: string }` input —
/// see `AssistantArchiveThreadInput`'s doc comment.
public struct AssistantMarkUnreadInput: Codable, Equatable, Hashable, Sendable {
  public var threadPageID: String

  public init(threadPageID: String) {
    self.threadPageID = threadPageID
  }
}

// MARK: - Wire DTOs — pending approval / confirmation result

/// Mirrors `approvals-store.ts`'s `ApprovalActionType`.
public enum AssistantPendingApprovalActionType: String, Codable, Hashable, Sendable {
  case createEvent
  case rsvp
  case sendEmail
  case archiveThread
  case applyLabel
  case removeLabel
  case markRead
  case markUnread
}

/// Mirrors `approvals-store.ts`'s `ApprovalStatus` — including `"unknown"`,
/// the distinct terminal status a stuck `sendEmail` approval reconciles to
/// (never `"failed"`, specifically so nothing downstream mistakes it for
/// "safe to retry" — see that file's Fix 2 header comment).
public enum AssistantPendingApprovalStatus: String, Codable, Hashable, Sendable {
  case pending
  case confirmed
  case executed
  case failed
  case unknown
}

/// A minimal, hand-rolled JSON value tree mirroring TS's `unknown` for
/// `PendingApproval.payload`/`PendingApproval.result`
/// (`approvals-store.ts`, around lines 97-116) — the actual shape varies
/// per `actionType` (see `write-model.ts`'s per-kind input/result shapes),
/// so there is no single fixed Swift type to decode into, only "some
/// JSON-shaped value". Same problem, and the same decode-by-trying-each-
/// case shape, as `OpenAIResponsesWireProtocol.swift`'s `OpenAIJSONValue`
/// — deliberately a SEPARATE type rather than reusing that one: it is
/// `internal` (module-private) and scoped to the OpenAI Responses wire
/// format specifically, and isn't `Hashable` (this file's
/// `AssistantPendingApproval` needs to be).
public enum AssistantPendingApprovalJSONValue: Codable, Equatable, Hashable, Sendable {
  case object([String: AssistantPendingApprovalJSONValue])
  case array([AssistantPendingApprovalJSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([AssistantPendingApprovalJSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: AssistantPendingApprovalJSONValue].self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }
}

/// Mirrors `approvals-store.ts`'s `PendingApproval` — the response shape
/// `createEvent`/`rsvp`/`sendEmail` all return (a freshly proposed,
/// still-`pending` row) and `getApproval`/`listPendingApprovals` also
/// return.
///
/// `payload`/`result`/`providerMessageId` (adversarial-review fix): the
/// ONLY reason `sendEmail`'s `"unknown"` approval status (see
/// `AssistantPendingApprovalStatus`'s doc comment) is actually useful to a
/// human reviewer is that `result` and
/// `providerMessageId` are inspectable — `result.error` names the
/// Message-ID, and `providerMessageId` carries it directly (see
/// `approvals-store.ts`'s Fix 2 header comment and
/// `reconcileStuckConfirmedApprovals`). Without these fields, this Swift
/// mirror had no way to surface that information to the only two call
/// sites (`AssistantRemoteWriteReviewClient.getApproval`/
/// `.listPendingApprovals`) that will ever show an approval to a human.
public struct AssistantPendingApproval: Codable, Equatable, Hashable, Sendable {
  public var id: String
  public var actionType: AssistantPendingApprovalActionType
  /// Decoded JSON payload — the action's input (shape depends on
  /// `actionType`; see `write-model.ts`). Mirrors TS's
  /// `payload: unknown` (`approvals-store.ts`'s `PendingApproval.payload`).
  public var payload: AssistantPendingApprovalJSONValue
  public var versionToken: String
  public var status: AssistantPendingApprovalStatus
  /// Decoded JSON outcome — populated once `status` is `executed` (the
  /// created/updated event or sent-message result), `failed` (an error
  /// message), or `unknown` (see `AssistantPendingApprovalStatus`'s doc
  /// comment). Mirrors TS's `result: unknown`
  /// (`approvals-store.ts`'s `PendingApproval.result`), absent (`nil`)
  /// until a terminal state is reached, same as TS's `undefined`.
  public var result: AssistantPendingApprovalJSONValue?
  public var createdAt: Date
  public var updatedAt: Date
  /// RFC 2822 `Message-ID` this approval's outgoing Gmail message carries
  /// (or will carry) — populated only for `sendEmail` approvals, at
  /// propose time. Mirrors TS's `providerMessageId?: string`
  /// (`approvals-store.ts`'s `PendingApproval.providerMessageId`); see
  /// that file's Fix 2 comment and `schema.ts`'s `provider_message_id`
  /// column comment.
  public var providerMessageId: String?

  public init(
    id: String,
    actionType: AssistantPendingApprovalActionType,
    payload: AssistantPendingApprovalJSONValue = .null,
    versionToken: String,
    status: AssistantPendingApprovalStatus,
    result: AssistantPendingApprovalJSONValue? = nil,
    createdAt: Date,
    updatedAt: Date,
    providerMessageId: String? = nil
  ) {
    self.id = id
    self.actionType = actionType
    self.payload = payload
    self.versionToken = versionToken
    self.status = status
    self.result = result
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.providerMessageId = providerMessageId
  }

  private enum CodingKeys: String, CodingKey {
    case id, actionType, payload, versionToken, status, result, createdAt, updatedAt, providerMessageId
  }

  // Epoch-millisecond `Double` timestamps, matching every other server
  // timestamp convention already established in this codebase's generated
  // Swift types (see `EnchiridionSchema/Generated/CoreSupertags.swift`'s
  // `CoreTask.init(from:)`), and `approvals-store.ts`'s own
  // `createdAt: number`/`updatedAt: number` (epoch ms, from `Date.now()`
  // at the DO call site).
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    actionType = try container.decode(AssistantPendingApprovalActionType.self, forKey: .actionType)
    payload = try container.decode(AssistantPendingApprovalJSONValue.self, forKey: .payload)
    versionToken = try container.decode(String.self, forKey: .versionToken)
    status = try container.decode(AssistantPendingApprovalStatus.self, forKey: .status)
    result = try container.decodeIfPresent(AssistantPendingApprovalJSONValue.self, forKey: .result)
    createdAt = Date(timeIntervalSince1970: try container.decode(Double.self, forKey: .createdAt) / 1000)
    updatedAt = Date(timeIntervalSince1970: try container.decode(Double.self, forKey: .updatedAt) / 1000)
    providerMessageId = try container.decodeIfPresent(String.self, forKey: .providerMessageId)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(actionType, forKey: .actionType)
    try container.encode(payload, forKey: .payload)
    try container.encode(versionToken, forKey: .versionToken)
    try container.encode(status, forKey: .status)
    try container.encodeIfPresent(result, forKey: .result)
    try container.encode(createdAt.timeIntervalSince1970 * 1000, forKey: .createdAt)
    try container.encode(updatedAt.timeIntervalSince1970 * 1000, forKey: .updatedAt)
    try container.encodeIfPresent(providerMessageId, forKey: .providerMessageId)
  }
}

/// Mirrors `write-model.ts`'s `ConfirmApprovalResult` union
/// (`{status:"executed"}` / `{status:"failed", reason}` /
/// `{status:"conflict", reason}`) — a stale/racing version token, or a
/// racing "already confirmed/executed/failed" status, decodes to
/// `.conflict(reason:)` here, never silently coerced into `.executed` or
/// retried. See this file's header for who is allowed to observe this at
/// all (`AssistantRemoteWriteReviewClient` only).
public enum AssistantRemoteWriteConfirmationResult: Equatable, Sendable {
  case executed
  case failed(reason: String)
  case conflict(reason: String)
}

extension AssistantRemoteWriteConfirmationResult: Decodable {
  private enum CodingKeys: String, CodingKey {
    case status, reason
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let status = try container.decode(String.self, forKey: .status)
    switch status {
    case "executed":
      self = .executed
    case "failed":
      self = .failed(reason: try container.decodeIfPresent(String.self, forKey: .reason) ?? "unknown failure")
    case "conflict":
      self = .conflict(reason: try container.decodeIfPresent(String.self, forKey: .reason) ?? "unknown conflict")
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .status, in: container,
        debugDescription: "unrecognized confirmation status \"\(status)\"")
    }
  }
}

// MARK: - Errors

public enum AssistantRemoteWriteError: Error, LocalizedError, Equatable, Sendable {
  case transportFailure(String)
  case decodingFailure(String)
  case httpStatus(Int)

  public var errorDescription: String? {
    switch self {
    case .transportFailure(let message): "The request could not be sent: \(message)"
    case .decodingFailure(let message): "The response could not be understood: \(message)"
    case .httpStatus(let code): "The server rejected the request (HTTP \(code))."
    }
  }
}

// MARK: - Narrow protocols

/// The ONLY capability the assistant's tool-call dispatch code may be
/// constructed with — exactly the three PROPOSE-only calls. See this
/// file's header for the full security argument;
/// `AssistantRemoteWriteReviewTransport` below is where `confirmApproval`
/// actually lives, and it is a structurally unrelated protocol.
public protocol AssistantRemoteWriteTransport: Sendable {
  func createEvent(_ input: AssistantCreateEventInput) async throws -> AssistantPendingApproval
  func rsvp(_ input: AssistantRsvpInput) async throws -> AssistantPendingApproval
  func sendEmail(_ input: AssistantSendEmailInput) async throws -> AssistantPendingApproval
  func archiveThread(_ input: AssistantArchiveThreadInput) async throws -> AssistantPendingApproval
  func applyLabel(_ input: AssistantApplyLabelInput) async throws -> AssistantPendingApproval
  func removeLabel(_ input: AssistantRemoveLabelInput) async throws -> AssistantPendingApproval
  func markRead(_ input: AssistantMarkReadInput) async throws -> AssistantPendingApproval
  func markUnread(_ input: AssistantMarkUnreadInput) async throws -> AssistantPendingApproval
}

/// The capability explicit, human-driven confirmation UI code may be
/// constructed with — MUST NEVER be handed to the assistant's tool-call
/// dispatch path. See this file's header.
public protocol AssistantRemoteWriteReviewTransport: Sendable {
  func confirmApproval(id: String, versionToken: String) async throws -> AssistantRemoteWriteConfirmationResult
  func getApproval(id: String) async throws -> AssistantPendingApproval?
  func listPendingApprovals() async throws -> [AssistantPendingApproval]
}

// MARK: - HTTP transport seam (test-injectable)

/// The minimal slice of `URLSession` this file needs — lets tests inject a
/// fake without needing `URLProtocol` registration tricks.
/// `URLSession.data(for:)` (iOS 15+/macOS 12+) already matches this
/// signature exactly, so the conformance below is a free win, not a
/// reimplementation.
public protocol AssistantRemoteWriteHTTPSession: Sendable {
  func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: AssistantRemoteWriteHTTPSession {}

/// Where this file's future `vault` HTTP proxy is expected to live — see
/// this file's header, "TRANSPORT."
public struct AssistantRemoteWriteEndpoint: Sendable {
  public var baseURL: URL

  public init(baseURL: URL) {
    self.baseURL = baseURL
  }
}

/// Cloudflare Access service-token credential — a client id/secret PAIR,
/// not a bearer token (verified against Cloudflare's docs; see
/// `EnchiridionSync/VaultSyncClient.swift`'s `AccessServiceTokenCredential`
/// for the full citation). Deliberately a separate declaration here rather
/// than reusing that type: `EnchiridionCore` cannot depend on
/// `EnchiridionSync` (see AssistantWriteTools.swift's header for the
/// identical layering argument applied to `PageDocumentVersion`).
public struct AssistantRemoteWriteCredential: Sendable, Equatable {
  public let clientId: String
  public let clientSecret: String

  public init(clientId: String, clientSecret: String) {
    self.clientId = clientId
    self.clientSecret = clientSecret
  }
}

/// Shared request-building/response-decoding logic used internally by both
/// concrete client types below. Deliberately NOT public and NOT a shared
/// base class either concrete client inherits from — it is composed
/// PRIVATELY into each, so there is still no single object either client
/// type's holder could upcast/downcast through to reach the other's
/// methods. See this file's header, "FIX."
private struct AssistantRemoteWriteHTTP: Sendable {
  let endpoint: AssistantRemoteWriteEndpoint
  let credential: @Sendable () async throws -> AssistantRemoteWriteCredential
  let session: any AssistantRemoteWriteHTTPSession

  func send<Response: Decodable>(method: String = "GET", path: String) async throws -> Response {
    try await perform(method: method, path: path, bodyData: nil)
  }

  func send<Body: Encodable, Response: Decodable>(
    method: String = "POST", path: String, body: Body
  ) async throws -> Response {
    let bodyData: Data
    do {
      bodyData = try JSONEncoder().encode(body)
    } catch {
      throw AssistantRemoteWriteError.decodingFailure("failed to encode request body: \(error)")
    }
    return try await perform(method: method, path: path, bodyData: bodyData)
  }

  /// Like `send(method:path:)`, but a `404` decodes to `nil` instead of
  /// throwing `.httpStatus(404)` — used by `getApproval`, whose contract
  /// is "absent means not found," not an error.
  func sendOptional<Response: Decodable>(
    method: String = "GET", path: String
  ) async throws -> Response? {
    do {
      return try await perform(method: method, path: path, bodyData: nil)
    } catch AssistantRemoteWriteError.httpStatus(404) {
      return nil
    }
  }

  private func perform<Response: Decodable>(
    method: String, path: String, bodyData: Data?
  ) async throws -> Response {
    var request = URLRequest(url: endpoint.baseURL.appendingPathComponent(path))
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    let resolvedCredential = try await credential()
    request.setValue(resolvedCredential.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
    request.setValue(resolvedCredential.clientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
    request.httpBody = bodyData

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw AssistantRemoteWriteError.transportFailure(String(describing: error))
    }
    guard let httpResponse = response as? HTTPURLResponse else {
      throw AssistantRemoteWriteError.transportFailure("non-HTTP response")
    }
    guard (200..<300).contains(httpResponse.statusCode) else {
      throw AssistantRemoteWriteError.httpStatus(httpResponse.statusCode)
    }
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw AssistantRemoteWriteError.decodingFailure(String(describing: error))
    }
  }
}

// MARK: - Concrete clients

/// Assistant-tool-dispatch-facing client. Implements ONLY
/// `AssistantRemoteWriteTransport` — this type has no `confirmApproval`
/// method, full stop. See this file's header.
public struct AssistantRemoteWriteClient: AssistantRemoteWriteTransport {
  private let http: AssistantRemoteWriteHTTP

  public init(
    endpoint: AssistantRemoteWriteEndpoint,
    credential: @escaping @Sendable () async throws -> AssistantRemoteWriteCredential,
    session: any AssistantRemoteWriteHTTPSession = URLSession.shared
  ) {
    self.http = AssistantRemoteWriteHTTP(endpoint: endpoint, credential: credential, session: session)
  }

  public func createEvent(_ input: AssistantCreateEventInput) async throws -> AssistantPendingApproval {
    try await http.send(path: "gatekeeper-google/calendar/create-event", body: input)
  }

  public func rsvp(_ input: AssistantRsvpInput) async throws -> AssistantPendingApproval {
    try await http.send(path: "gatekeeper-google/calendar/rsvp", body: input)
  }

  public func sendEmail(_ input: AssistantSendEmailInput) async throws -> AssistantPendingApproval {
    try await http.send(path: "gatekeeper-google/gmail/send", body: input)
  }

  public func archiveThread(_ input: AssistantArchiveThreadInput) async throws -> AssistantPendingApproval {
    try await http.send(path: "gatekeeper-google/gmail/archive-thread", body: input)
  }

  public func applyLabel(_ input: AssistantApplyLabelInput) async throws -> AssistantPendingApproval {
    try await http.send(path: "gatekeeper-google/gmail/apply-label", body: input)
  }

  public func removeLabel(_ input: AssistantRemoveLabelInput) async throws -> AssistantPendingApproval {
    try await http.send(path: "gatekeeper-google/gmail/remove-label", body: input)
  }

  public func markRead(_ input: AssistantMarkReadInput) async throws -> AssistantPendingApproval {
    try await http.send(path: "gatekeeper-google/gmail/mark-read", body: input)
  }

  public func markUnread(_ input: AssistantMarkUnreadInput) async throws -> AssistantPendingApproval {
    try await http.send(path: "gatekeeper-google/gmail/mark-unread", body: input)
  }
}

/// Human-UI-facing client. Implements ONLY
/// `AssistantRemoteWriteReviewTransport` — structurally unrelated to
/// `AssistantRemoteWriteClient` above (no shared base type, no shared
/// protocol), so there is no downcast path between them. MUST only ever
/// be constructed by explicit, human-driven confirmation UI code. See
/// this file's header.
public struct AssistantRemoteWriteReviewClient: AssistantRemoteWriteReviewTransport {
  private let http: AssistantRemoteWriteHTTP

  public init(
    endpoint: AssistantRemoteWriteEndpoint,
    credential: @escaping @Sendable () async throws -> AssistantRemoteWriteCredential,
    session: any AssistantRemoteWriteHTTPSession = URLSession.shared
  ) {
    self.http = AssistantRemoteWriteHTTP(endpoint: endpoint, credential: credential, session: session)
  }

  private struct ConfirmApprovalBody: Encodable {
    let versionToken: String
  }

  public func confirmApproval(
    id: String, versionToken: String
  ) async throws -> AssistantRemoteWriteConfirmationResult {
    try await http.send(
      path: "write/gatekeeper-google/approvals/\(id)/confirm",
      body: ConfirmApprovalBody(versionToken: versionToken))
  }

  public func getApproval(id: String) async throws -> AssistantPendingApproval? {
    try await http.sendOptional(path: "write/gatekeeper-google/approvals/\(id)")
  }

  public func listPendingApprovals() async throws -> [AssistantPendingApproval] {
    try await http.send(path: "write/gatekeeper-google/approvals")
  }
}
