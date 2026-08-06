// AssistantTurnWriteAuthorization.swift
// EnchiridionCore
//
// Task #68 ("Assistant provider integration + conversation UI"). The
// write-side sibling of `AssistantTurnRetrievalAuthorization.swift` — that
// file's own header states its property precisely for reads: "the app
// constructs an immutable `AssistantTurnRetrievalAuthorization` *before*
// the request leaves the device ... A model's tool-call arguments can only
// select from what's already inside this authorization." Neither the plan
// nor #65/#66/#67 defined an equivalent gate for WRITE tool availability,
// because #67's write tools don't need per-argument scope bounds the way
// read tools do (a write only ever RECORDS a one-shot proposal — see
// `AssistantWriteTools.swift`'s header — it never itself reads anything
// sensitive). What was still missing before this task: a turn-scoped,
// app-decided on/off switch per write category, so the app can choose
// (e.g. from current context: is a Google account connected this turn? is
// the assistant surface even allowed to draft calendar/email actions right
// now?) which write TOOLS are even offered to the model this turn — the
// same "app decides what it's willing to let the assistant do this turn,
// not the model" posture the plan's Assistant (P5) section states for
// reads, applied to writes.
//
// This is deliberately much simpler than
// `AssistantTurnRetrievalAuthorization`: there are no query terms, date
// ranges, or result caps to bound for a write — only "is this write
// category available to call at all this turn." The real safety property
// for writes is NOT this type; it's the structural
// propose-only/confirm-only split `AssistantWriteTools.swift` and
// `AssistantRemoteWriteTools.swift` already built (see
// `AssistantModelToolExecuting`'s header in this same file's sibling,
// `AssistantModelToolProtocol.swift`, for how task #68 wires that through).
// This type only controls which write tool NAMES are advertised to the
// model and accepted by the dispatcher at all — it is defense-in-depth,
// not the primary guarantee.
public struct AssistantTurnWriteAuthorization: Equatable, Sendable {
  public let allowTaskCreate: Bool
  public let allowTaskUpdate: Bool
  public let allowTaskComplete: Bool
  public let allowCreateEvent: Bool
  public let allowRsvp: Bool
  public let allowSendEmail: Bool
  /// Gmail triage — archive/label/mark-read-unread. See
  /// `AssistantRemoteWriteTools.swift`'s header: these are propose-only,
  /// same as `allowCreateEvent`/`allowRsvp`/`allowSendEmail`, gated the same
  /// way and structurally incapable of confirming themselves.
  public let allowArchiveEmail: Bool
  public let allowApplyLabel: Bool
  public let allowRemoveLabel: Bool
  public let allowMarkRead: Bool
  public let allowMarkUnread: Bool

  public init(
    allowTaskCreate: Bool = false,
    allowTaskUpdate: Bool = false,
    allowTaskComplete: Bool = false,
    allowCreateEvent: Bool = false,
    allowRsvp: Bool = false,
    allowSendEmail: Bool = false,
    allowArchiveEmail: Bool = false,
    allowApplyLabel: Bool = false,
    allowRemoveLabel: Bool = false,
    allowMarkRead: Bool = false,
    allowMarkUnread: Bool = false
  ) {
    self.allowTaskCreate = allowTaskCreate
    self.allowTaskUpdate = allowTaskUpdate
    self.allowTaskComplete = allowTaskComplete
    self.allowCreateEvent = allowCreateEvent
    self.allowRsvp = allowRsvp
    self.allowSendEmail = allowSendEmail
    self.allowArchiveEmail = allowArchiveEmail
    self.allowApplyLabel = allowApplyLabel
    self.allowRemoveLabel = allowRemoveLabel
    self.allowMarkRead = allowMarkRead
    self.allowMarkUnread = allowMarkUnread
  }

  /// No write tool may be called this turn. The safe default.
  public static let none = AssistantTurnWriteAuthorization()

  /// Every local task write tool, no remote write tools — a common shape
  /// for a turn where the app knows local graph writes are safe (always
  /// true; they only ever produce a locally-confirmed proposal) but has not
  /// separately confirmed a Google account is connected/consented for
  /// calendar or Gmail writes this turn.
  public static let localTasksOnly = AssistantTurnWriteAuthorization(
    allowTaskCreate: true, allowTaskUpdate: true, allowTaskComplete: true)

  /// Which write tools this turn is allowed to call at all. A tool absent
  /// here must never be invoked, regardless of what a model's tool-call
  /// claims — mirrors `AssistantTurnRetrievalAuthorization.allowedTools`.
  public var allowedTools: [AssistantWriteTool] {
    var result: [AssistantWriteTool] = []
    if allowTaskCreate { result.append(.proposeTaskCreate) }
    if allowTaskUpdate { result.append(.proposeTaskUpdate) }
    if allowTaskComplete { result.append(.proposeTaskComplete) }
    if allowCreateEvent { result.append(.proposeCreateEvent) }
    if allowRsvp { result.append(.proposeRsvp) }
    if allowSendEmail { result.append(.proposeSendEmail) }
    if allowArchiveEmail { result.append(.proposeArchiveEmail) }
    if allowApplyLabel { result.append(.proposeApplyLabel) }
    if allowRemoveLabel { result.append(.proposeRemoveLabel) }
    if allowMarkRead { result.append(.proposeMarkRead) }
    if allowMarkUnread { result.append(.proposeMarkUnread) }
    return result
  }
}

/// Identifies one of the assistant's write tools. Naming follows the
/// `propose*` convention deliberately (not `create*`/`update*`) so the
/// tool's own name keeps reminding a reader (and, via its `description` in
/// the request builder, the model) that calling it never itself performs
/// the action — see `AssistantWriteTools.swift`'s header for why proposing
/// and confirming must never be reachable from the same code path.
public enum AssistantWriteTool: String, CaseIterable, Equatable, Hashable, Sendable {
  case proposeTaskCreate
  case proposeTaskUpdate
  case proposeTaskComplete
  case proposeCreateEvent
  case proposeRsvp
  case proposeSendEmail
  case proposeArchiveEmail
  case proposeApplyLabel
  case proposeRemoveLabel
  case proposeMarkRead
  case proposeMarkUnread
}
