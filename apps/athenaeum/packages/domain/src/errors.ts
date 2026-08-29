import * as Data from "effect/Data"
import type { PageDocumentFormat } from "./page-document-format.js"

// Phase 0 scope (see plan §"Effect-TS integration", `domain/` package): the full error set
// (`NodeNotFound`, `UniqueIndexConflict`, `PendingNameConflict`, `EpochMismatch`, `Unauthorized`,
// `ObserverVerificationFailed`, …) is deferred. These three are the ones the Phase 0 exit
// criterion actually needs to surface through the Cap'n Web throw boundary.

/** The referenced node does not exist (or is not visible) in the workspace. */
export class NodeNotFound extends Data.TaggedError("NodeNotFound")<{
  readonly nodeId: string
}> {}

/** A strict create request attempted to claim an explicit node identity that already exists. */
export class NodeAlreadyExists extends Data.TaggedError("NodeAlreadyExists")<{
  readonly nodeId: string
}> {}

/** Input failed domain validation before reaching storage. */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A catch-all for defects/unexpected failures that must still cross the RPC boundary typed. */
export class UnexpectedError extends Data.TaggedError("UnexpectedError")<{
  readonly message: string
}> {}

/** The union of Phase 0 domain errors — the failure channel of `NodesRepository` operations. */
export type Phase0DomainError = NodeNotFound | ValidationError | UnexpectedError

/**
 * The full `DomainError` union as of the Storage/Views stage (plan task item 10's deferred
 * wiring, now done here): every repository/service failure that can cross the Cap'n Web RPC
 * throw boundary, Phase 0's three plus the eight graph/page errors below. Widening this type
 * (rather than leaving call sites to union the Phase 0 members with graph error tags ad hoc) is
 * what makes `rpc-error.ts`'s `encodeRpcError`/`decodeRpcError` — and `backend`'s
 * `domainErrorFromCause` — exhaustive over one closed set again.
 */
export type DomainError =
  | Phase0DomainError
  | NodeAlreadyExists
  | PageNotFound
  | PageFormatMismatch
  | LoroContentConflict
  | LoroSemanticCommitRequired
  | LoroRequestIdentityConflict
  | TagNotFound
  | FactNotFound
  | EdgeNotFound
  | RelationDefinitionNotFound
  | GraphIssueNotFound
  | CardinalityViolation
  | GraphIssueDetected
  | ChatNotFound
  | ChatBindingNotFound
  | PendingNameConflict
  | ToolNotImplemented
  | Unauthorized
  | WorkspaceAccessDenied
  | WorkspaceNotFound
  | GatekeeperNotConnected
  | OAuthExchangeFailed
  | ObserverVerificationFailed
  | MeetingNotFound
  | VoiceSessionNotFound
  | WorkoutNotFound
  | WorkoutImportConflict
  | AppNotFound
  | AppCodeVersionNotFound
  | AppCodeTooLarge
  | TagFieldDefinitionNotFound

// --- Graph/Views repository errors (plan task item 10) --------------------------------------
//
// One `<Entity>NotFound` error per new repository's `get`, mirroring `NodeNotFound` exactly —
// same `{ readonly <entity>Id: string }` shape, same reason it carries the raw `string` id
// rather than the branded `EntityId` (Data.TaggedError payloads cross the RPC throw boundary as
// plain JSON, per rpc-error.ts's envelope convention; re-validating a branded type on the way
// back out is exactly what `decodeRpcError` already does at the boundary, not something the
// error class itself needs to enforce).
//
// Now wired into `DomainError` (above) and rpc-error.ts's `knownTags`/`encodeRpcError`/
// `decodeRpcError` by the Storage/Views stage, since `GraphServiceLive`/`NotesServiceLive`
// (backend) now really do throw these across the RPC boundary. They were originally added ahead
// of that wiring (plan task item 10) so the `Context.Tag` repository interfaces had a real
// failure channel to declare before the backend stage existed.

/** The referenced page (a node's Automerge doc reference) does not exist in the workspace. */
export class PageNotFound extends Data.TaggedError("PageNotFound")<{
  readonly nodeId: string
}> {}

/** A caller attempted to use a page-document protocol incompatible with the active format. */
export class PageFormatMismatch extends Data.TaggedError("PageFormatMismatch")<{
  readonly nodeId: string
  readonly expected: PageDocumentFormat
  readonly actual: PageDocumentFormat
}> {}

/** Safe optimistic-concurrency witnesses for a semantic Loro page command. */
export class LoroContentConflict extends Data.TaggedError("LoroContentConflict")<{
  readonly nodeId: string
  readonly expectedStorageVersion: number
  readonly currentStorageVersion: number
  readonly expectedSnapshotSha256: string
  readonly currentSnapshotSha256: string
  readonly expectedVersionVectorSha256: string
  readonly currentVersionVectorSha256: string
  readonly message: string
}> {}

/** Direct Loro page-content writes are forbidden; use the semantic commit command instead. */
export class LoroSemanticCommitRequired extends Data.TaggedError("LoroSemanticCommitRequired")<{
  readonly nodeId: string
}> {}

/** A semantic Loro request identity was retained for a different command. */
export class LoroRequestIdentityConflict extends Data.TaggedError("LoroRequestIdentityConflict")<{
  readonly nodeId: string
  readonly requestId: string
}> {}

/** The referenced tag does not exist in the workspace. */
export class TagNotFound extends Data.TaggedError("TagNotFound")<{
  readonly tagId: string
}> {}

/** The referenced fact does not exist in the workspace. */
export class FactNotFound extends Data.TaggedError("FactNotFound")<{
  readonly factId: string
}> {}

/** The referenced edge does not exist in the workspace. */
export class EdgeNotFound extends Data.TaggedError("EdgeNotFound")<{
  readonly edgeId: string
}> {}

/** The referenced relation definition does not exist in the workspace. */
export class RelationDefinitionNotFound extends Data.TaggedError("RelationDefinitionNotFound")<{
  readonly relationDefinitionId: string
}> {}

/** The referenced graph issue does not exist in the workspace. */
export class GraphIssueNotFound extends Data.TaggedError("GraphIssueNotFound")<{
  readonly graphIssueId: string
}> {}

/**
 * A structural cardinality rule was violated by a single, non-concurrent mutation — e.g.
 * creating a second edge under a `"one-to-one"` `RelationDefinition` whose source node already
 * has one, with no concurrent write involved. Distinct from `GraphIssueDetected` below: this is
 * a straightforward rejection (the mutation never happens), whereas Evolution Rule #4 (plan
 * §"Storage & domain model") is explicit that *concurrent* conflicting assertions are preserved
 * through merge, not rejected — that path raises `GraphIssueDetected` and records a
 * `GraphIssue`, it does not fail closed like this one does.
 */
export class CardinalityViolation extends Data.TaggedError("CardinalityViolation")<{
  readonly relationDefinitionId: string
  readonly message: string
}> {}

/**
 * Raised when applying a merge (structured-record sync, plan §"Sync protocol") produces more
 * edges under a max-one-cardinality `RelationDefinition` than the cardinality allows, for a
 * node whose prior state didn't have this conflict — i.e. two replicas concurrently created
 * edges the source didn't know about each other. Per Evolution Rule #4 this does **not** mean
 * the merge failed or should be rejected: the conflicting edges are still preserved (see edge.ts
 * / graph-issue.ts's comments), and the caller catching this error is expected to persist a
 * `GraphIssue` row from its fields, not roll back the merge.
 */
export class GraphIssueDetected extends Data.TaggedError("GraphIssueDetected")<{
  readonly relationDefinitionId: string
  readonly nodeId: string
  readonly conflictingEdgeIds: ReadonlyArray<string>
}> {}

// --- Phase 3 agent-editing errors ------------------------------------------------------------
//
// Four `Data.TaggedError`s for the chat/pending/binding mechanism (chat.ts, changes-message.ts,
// chat-binding.ts, agent-tools.ts, node.ts/fact.ts/edge.ts's `pending` field). Originally declared
// but deliberately left unwired (see git history / prior doc comment here) while only the schema
// layer existed. Now wired into `DomainError` (above) and `rpc-error.ts`'s `knownTags`/
// `encodeRpcError`/`decodeRpcError` by the `AgentEditService` stage (backend/agent-edit-service-
// live.ts), which really does throw all four across the RPC boundary — same pattern the graph/page
// errors followed when `GraphServiceLive`/`NotesServiceLive` were built.

/** The referenced `Chat` (chat.ts) does not exist in the workspace. */
export class ChatNotFound extends Data.TaggedError("ChatNotFound")<{
  readonly chatId: string
}> {}

/** A chat-local binding name (chat-binding.ts's `ChatBindingName`) was referenced but has no
 *  entry in the chat's binding map — e.g. an agent tool call names a `binding` the naming
 *  chokepoint never assigned, or that was released by a revert. Distinct from a decode failure
 *  on `ChatBindingName` itself (a *malformed* name, caught by `Schema.decodeUnknown` at the RPC
 *  boundary before any of this ever runs) — this is "well-formed name, nothing bound to it." */
export class ChatBindingNotFound extends Data.TaggedError("ChatBindingNotFound")<{
  readonly chatId: string
  readonly name: string
}> {}

/**
 * A binding name (or, per `multi-gadget.md` §Q15/Part 2, a gadget/node `bindingName`) is already
 * claimed — pending, unaccepted — by a *different* chat. Mirrors `multi-gadget.md`'s "this name
 * is pending in another chat" error verbatim (§Q15: conflicting `createGadget` in another chat;
 * Part 2 §"Provisional binding additions": conflicting `addedBindings` entry): a pending record
 * is real in its owning chat's storage the moment it's created, so the name it claims is
 * reserved from that moment — not just from acceptance — until the claiming chat's changes are
 * accepted or reverted.
 */
export class PendingNameConflict extends Data.TaggedError("PendingNameConflict")<{
  readonly name: string
  readonly claimedByChatId: string
}> {}

/** Raised by any Phase 3 tool that has no real implementation yet — currently only
 *  `linkCalendarEvent` (agent-tools.ts's `LinkCalendarEventToolInput`/`Output`; see that file's
 *  doc comment for why: calendar doesn't exist as a concept until Phase 5). A generic
 *  `{toolName, message}` shape (rather than one `ToolNotImplemented` variant per unimplemented
 *  tool) so future Phase-4/5-gated tools can reuse it without a new error class each time. */
export class ToolNotImplemented extends Data.TaggedError("ToolNotImplemented")<{
  readonly toolName: string
  readonly message: string
}> {}

// --- Phase 4 auth/sharing prerequisite (see auth.ts's header comment) -----------------------
//
// One of the three-tag Phase 0 placeholder list this file's own header comment named up front
// ("NodeNotFound, UniqueIndexConflict, PendingNameConflict, EpochMismatch, Unauthorized,
// ObserverVerificationFailed") and deferred every phase since — now real: the dev-auth
// prerequisite stage (`backend/src/dev-auth.ts`, `domain/src/auth.ts`) needs a single closed
// failure mode for "no/invalid/expired credential" that crosses the Cap'n Web RPC throw
// boundary exactly like every other `DomainError`. Deliberately one variant, not one per failure
// reason (malformed token / bad signature / expired / wrong audience) — a caller-facing
// authentication failure should never leak *why* verification failed beyond a human-readable
// `message`, and every internal cause already folds into this one tag before crossing any
// boundary (see `dev-auth.ts`'s `verifyDevCredential`).

/** No valid caller identity is available for an operation that requires one — a missing,
 *  malformed, tampered, or expired Bearer credential, or (future stages) a caller whose
 *  permission-graph role does not reach far enough. */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{
  readonly message: string
}> {}

// --- Phase 4 sharing/multi-workspace (see sharing.ts's header comment) --------------------------
//
// Ported verbatim from docs/sharing.md §Authorization model: "Authorization is enforced at
// open(): the method computes the caller's effective role from the permission graph... A caller
// with no effective role receives WORKSPACE_ACCESS_DENIED, while an uninitialized or deleted
// gadget receives WORKSPACE_NOT_FOUND. This distinction acknowledges that an initialized
// workspace exists, but the denial exposes no workspace name, owner, or content." `gadget` →
// `workspace` (this port's uniform substitution, per sharing.ts's header comment). Two separate tags,
// not one — collapsing them would leak "does this workspaceId exist at all" to a caller who has no
// business knowing, exactly the distinction docs/sharing.md calls out by name.

/** The referenced workspace does not exist, or existed but has been deleted — never raised for a
 *  workspace that exists but the caller cannot access (see `WorkspaceAccessDenied` for that case).
 *  Carries only `workspaceId` (the id the caller already supplied), never a title/owner/content —
 *  "the denial exposes no workspace name, owner, or content" applies to this tag too, not just
 *  `WorkspaceAccessDenied`, since a not-found response must be indistinguishable in its payload
 *  shape from an access-denied one to avoid leaking existence through a side channel. */
export class WorkspaceNotFound extends Data.TaggedError("WorkspaceNotFound")<{
  readonly workspaceId: string
}> {}

/** The workspace exists, but the caller has no effective role in its permission graph — computed
 *  live via the fixed-point role-propagation algorithm (docs/sharing.md §Effective-role
 *  algorithm), never from stale/cached membership. Distinct from `Unauthorized`: `Unauthorized`
 *  is "no verified identity at all" (an anonymous connection, `requireAuthenticatedUser`'s own
 *  failure mode in auth.ts), whereas this is "a real, authenticated identity that the permission
 *  graph simply does not reach" — the same distinction docs/sharing.md draws between "a caller
 *  with no effective role" (this tag) and `UseOverseerInterface`'s separate `Unauthorized` throw
 *  for "a *valid* use collaborator calling a build-only method... that's a different case, where
 *  existence is already known and only the operation is denied." */
export class WorkspaceAccessDenied extends Data.TaggedError("WorkspaceAccessDenied")<{
  readonly workspaceId: string
}> {}

// --- Phase 5 gatekeeper/observer prerequisite (see gatekeeper-rpc.ts's header comment) -------
//
// This task's own item 6: "New Data.TaggedErrors as needed (GatekeeperNotConnected,
// OAuthExchangeFailed, ObserverVerificationFailed)." Widened into `DomainError` (above) and
// rpc-error.ts's `knownTags`/`encodeRpcError`/`decodeRpcError` now, following the exact precedent
// every prior stage set (see this file's own "Storage/Views stage"/"AgentEditService stage"/
// "Phase 4 sharing/multi-workspace" header comments above) — schema-only in this stage (no
// `GatekeeperService`/`WorkspaceDurableObject` RPC method actually throws these yet, mirroring
// sharing.ts's own "schema surface it attaches to later" scope note), but wired into the full
// envelope round trip now so the backend stage that DOES throw them has nothing left to add here.

/** A `gatekeeper-rpc.ts` method that requires an active `GatekeeperBinding` (gatekeeper-
 *  binding.ts) was called against a workspace/kind with none connected — e.g. `syncGoogleCalendar`,
 *  `listCalendarEvents`, or `disconnectGoogleCalendar` called before `googleCalendarOAuthCallback`
 *  ever completed successfully, or called again after a prior `disconnectGoogleCalendar` already
 *  removed the binding. Carries `gatekeeperKind` (gatekeeper-binding.ts's `GatekeeperKind`) rather
 *  than a bound-specific `bindingId`, since by definition no binding exists to name. */
export class GatekeeperNotConnected extends Data.TaggedError("GatekeeperNotConnected")<{
  readonly workspaceId: string
  readonly gatekeeperKind: string
}> {}

/** The OAuth authorization-code-for-tokens exchange (`googleCalendarOAuthCallback`, gatekeeper-
 *  rpc.ts) failed — a categorized failure at the `GoogleCalendarClient.exchangeAuthorizationCode`
 *  layer (`gatekeeper-google-calendar`'s own `GoogleCalendarAuthFailed`/
 *  `GoogleCalendarRequestFailed`, per docs/gatekeeper-google-calendar-decisions.md §1) surfaced
 *  one layer up, at the workspace-facing RPC boundary this package's errors cross. Deliberately one
 *  flat `message` field, not a re-exported copy of that package's own reason enum
 *  (`"invalidGrant" | "policyBlocked" | "other"`) — `@athenaeum/domain` has zero dependency on any
 *  gatekeeper package (this file's own header-comment discipline, and gatekeeper-binding.ts's
 *  header comment on the same point), so this error's job is only to say "the exchange failed,
 *  here is why" to a workspace-facing caller, not to preserve a foreign package's internal
 *  categorization across the boundary. */
export class OAuthExchangeFailed extends Data.TaggedError("OAuthExchangeFailed")<{
  readonly message: string
}> {}

/** A gatekeeper's `addObserver()`-equivalent check denied this observer — the thrown-error
 *  counterpart to `gatekeeper.ts`'s `ObserverVerificationDenied` wire result (see that class's own
 *  doc comment for why both a typed result AND a thrown error exist: a synchronous "can this
 *  observer open the workspace right now" check needs to fail closed like every other
 *  `DomainError`, while a result value is what a UI renders when previewing/explaining a denial
 *  without necessarily blocking anything). `observerId` is the opaque handle
 *  `docs/observers.md` §3 defines ("a random, opaque string the overseer generates... deliberately
 *  do not use profile.id... to avoid tempting gatekeeper authors to parse identity out of it") —
 *  never an `Email`/`profileId`, for the identical reason that doc gives. */
export class ObserverVerificationFailed extends Data.TaggedError("ObserverVerificationFailed")<{
  readonly observerId: string
  readonly message: string
}> {}

// --- Phase 6 meetings/voice (see meeting-rpc.ts's and voice-session-rpc.ts's header comments) -
//
// This task's own item 5: "New Data.TaggedErrors as needed." Same `<Entity>NotFound` shape as
// every prior stage's own additions (`ChatNotFound`, `PageNotFound`, etc.) — one per new
// persisted entity this stage's RPC surface can fail to find. Wired into `DomainError` (above)
// and rpc-error.ts's `knownTags`/`encodeRpcError`/`decodeRpcError` now, schema-only in this stage
// (no `MeetingsService`/`VoiceService` implementation exists yet to actually throw these — same
// "schema-only, wired into the envelope round trip so the backend stage that DOES throw them has
// nothing left to add here" scope note the Phase 5 gatekeeper/observer errors' own header comment
// states, and every prior Phase 4/5 stage followed identically).

/** The referenced `Meeting` (meeting.ts) does not exist in the workspace — `getMeeting`,
 *  `endMeeting`, or `appendTranscriptSegment` (meeting-rpc.ts) called with a `meetingId` that was
 *  never created by `startMeeting`, or that belongs to a different workspace than the caller
 *  supplied. */
export class MeetingNotFound extends Data.TaggedError("MeetingNotFound")<{
  readonly meetingId: string
}> {}

/** The referenced `VoiceSession` (voice-session.ts) does not exist in the workspace — `endVoiceSession`
 *  (voice-session-rpc.ts) called with a `voiceSessionId` that was never created by
 *  `startVoiceSession`, or that belongs to a different workspace than the caller supplied. */
export class VoiceSessionNotFound extends Data.TaggedError("VoiceSessionNotFound")<{
  readonly voiceSessionId: string
}> {}

// --- Phase 7 workouts (see workout-rpc.ts's header comment) --------------------------------
//
// This task's own item 4: "Any new Data.TaggedErrors." Same two-shape split every prior phase's
// own error additions follow: an `<Entity>NotFound` (mirroring `MeetingNotFound`/`ChatNotFound`
// exactly) for `getWorkout` naming a `nodeId` that isn't a workout root in the caller's workspace,
// plus one entity-specific structural-conflict tag (mirroring `PendingNameConflict`'s own
// "well-known conflict, not a generic validation failure" precedent) for the one workout-specific
// business rule `workout.ts`'s `WorkoutImportReceipt` doc comment already names: re-importing an
// already-seen `sourceWorkoutId` with DIFFERENT content than the receipt on file. Wired into
// `DomainError` (above) and `rpc-error.ts`'s `knownTags`/`encodeRpcError`/`decodeRpcError` now,
// schema-only in this stage — no `WorkoutsService` method is changed to throw
// `WorkoutImportConflict` instead of the generic `ValidationError` it uses today, and no
// `WorkspaceDurableObject` method throws `WorkoutNotFound` yet, matching every prior Phase 5/6 RPC
// file's identical "wired into the envelope round trip so the backend stage that DOES throw them
// has nothing left to add here" scope note.

/** `getWorkout` (workout-rpc.ts) was called with a `nodeId` that either does not exist in the
 *  workspace, or exists but is not tagged `Workout` (workout.ts's `WorkoutTagIds.Workout`, directly
 *  or transitively via `Strength Workout`/`Cardio Workout`) — i.e. it is some other node
 *  entirely, not a workout root. Deliberately a distinct tag from the generic `NodeNotFound`
 *  (which `GraphService`'s own node-lookup primitives already raise for "no node with this id
 *  at all") for the same reason `PageNotFound` is kept distinct from `NodeNotFound`: "the node
 *  doesn't exist" and "the node exists but isn't the kind of thing this method reads" are
 *  different failures a caller may want to handle differently (e.g. a UI retry makes sense for
 *  neither, but only the latter is a genuine caller bug worth logging as such). */
export class WorkoutNotFound extends Data.TaggedError("WorkoutNotFound")<{
  readonly nodeId: string
}> {}

/** A workout import (`importWorkout`/`importWorkouts`, workout-rpc.ts) supplied a
 *  `sourceWorkoutId` that already has a `WorkoutImportReceipt` on file (workout.ts), but this
 *  call's content hashes to something different than that receipt's `payloadHash` — e.g. the
 *  same `HKWorkout` re-synced after HealthKit itself let the user edit its duration or energy
 *  total, or (more concerningly) two genuinely different workouts colliding on the same
 *  `sourceWorkoutId` due to a data-source bug. Distinct from a same-content re-import, which is
 *  NOT an error (`ImportWorkoutOutput.duplicate: true`, a successful idempotent no-op) — this tag
 *  fires only on the "different content under the same identity" case, mirroring
 *  `PendingNameConflict`'s own "this identity is already claimed, by something else" shape one
 *  layer over in the agent-editing error set. `message` carries a human-readable explanation
 *  (which payload fields differed, or simply that they did) for the same reason
 *  `CardinalityViolation.message`/`OAuthExchangeFailed.message` do — a caller-facing conflict
 *  should be explainable without a second round trip. */
export class WorkoutImportConflict extends Data.TaggedError("WorkoutImportConflict")<{
  readonly sourceWorkoutId: string
  readonly message: string
}> {}

// --- App Library (agent-authored sandboxed apps, see app.ts's header comment) ----------------
//
// This task's own item 6: "New Data.TaggedError types as needed (AppNotFound, AppCodeTooLarge,
// etc.)." Same two-shape split every prior phase's own error additions follow (see e.g.
// `WorkoutNotFound`/`WorkoutImportConflict`'s own header comment immediately above): a plain
// `<Entity>NotFound` per new persisted entity this stage's RPC surface can fail to find
// (`AppNotFound`, `AppCodeVersionNotFound`), plus one entity-specific structural-conflict tag
// (`AppCodeTooLarge`) for the one App-specific business rule `app.ts`'s `MAX_APP_CODE_BYTES`
// comment already names. Wired into `DomainError` (above) and rpc-error.ts's
// `knownTags`/`encodeRpcError`/`decodeRpcError` now, schema-only in this stage — no `AppService`/
// `WorkspaceDurableObject` method exists yet to actually throw these, matching every prior domain-
// extension stage's identical "wired into the envelope round trip so the backend stage that DOES
// throw them has nothing left to add here" scope note.

/** The referenced `App` (app.ts) does not exist in the workspace — `getApp`/`updateAppCode`/
 *  `deleteApp`/`getAppCode` (app-rpc.ts) called with an `appId` that was never created by
 *  `createApp`/`createApp` tool, or that belongs to a different workspace than the caller
 *  supplied. */
export class AppNotFound extends Data.TaggedError("AppNotFound")<{
  readonly appId: string
}> {}

/** `getAppCode` (app-rpc.ts) was called for a `(appId, kind)` pair with no code yet (the App's
 *  matching pointer is still `0` and no explicit `version` was given), or for an explicit
 *  `version` number that was never written (never exceeds the current pointer, or the App's own
 *  pending ahead-of-pointer row, by more than one — see app.ts's `AppCodeVersion` doc comment).
 *  Deliberately distinct from the generic `AppNotFound` (whether the *App itself* exists) for the
 *  same reason `PageNotFound` is kept distinct from `NodeNotFound`: "the node doesn't exist" and
 *  "the node exists but isn't the kind of thing this method reads" are different failures. */
export class AppCodeVersionNotFound extends Data.TaggedError("AppCodeVersionNotFound")<{
  readonly appId: string
  readonly kind: string
  readonly version: number
}> {}

/** A `createApp`/`updateAppCode` (mainline) or `updateAppCode` agent tool call (agent-tools.ts)
 *  supplied `code` whose UTF-8-encoded byte length exceeds `MAX_APP_CODE_BYTES` (app.ts). Carries
 *  both the measured size and the limit so a caller-facing UI can render "your app's server code
 *  is 312 KiB; the limit is 256 KiB" without a second round trip — the same "explainable without
 *  re-deriving it" precedent `CardinalityViolation.message`/`OAuthExchangeFailed.message` set,
 *  made structured here (rather than a single `message` string) because both numbers are
 *  independently useful to a caller (e.g. a client deciding how much to trim). */
export class AppCodeTooLarge extends Data.TaggedError("AppCodeTooLarge")<{
  readonly appId: string
  readonly kind: string
  readonly sizeBytes: number
  readonly maxBytes: number
}> {}

// Supertag-centering pass (docs/supertag-centering-decisions.md §1): the one new error this
// pass's field-definition surface (`tag-field-definition.ts`, graph-rpc.ts's
// `DefineTagFieldInput`/`ListTagFieldsInput`) needs. Same `<Entity>NotFound` shape as
// `TagNotFound`/`FactNotFound` above — carries the raw `string` id, not the branded `EntityId`,
// for the same reason those do (rpc-error.ts's envelope convention).

/** The referenced `TagFieldDefinition` does not exist in the workspace. */
export class TagFieldDefinitionNotFound extends Data.TaggedError("TagFieldDefinitionNotFound")<{
  readonly fieldId: string
}> {}
