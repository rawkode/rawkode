import * as Schema from "effect/Schema"
import { Meeting, Speaker, TranscriptSegmentRecord, TranscriptSegmentSource } from "./meeting.js"
import { EntityId, IsoDateTimeString } from "./node.js"

// Phase 6 domain-extension task (plan §"Meetings & voice"), item 4: "RPC schemas: startMeeting,
// endMeeting, appendTranscriptSegment, getMeeting, listMeetings." Same one-`Schema.Class`-input/
// output-pair-per-method convention as rpc.ts/graph-rpc.ts/gatekeeper-rpc.ts/agent-edit-rpc.ts.
// Schema-only, same explicit scope note every prior Phase 4/5 RPC file states for itself: no
// `MeetingsService` implementation lives here, and none of these methods is wired onto
// `WorkspaceDurableObject` yet.
//
// **Every method below is workspace-scoped**, and — per this task's own hard constraint, restated
// from gatekeeper-rpc.ts's identical note (itself quoting `workspace-durable-object.ts`'s established
// Phase 4 discipline) — **every one of these RPC methods, once a real `WorkspaceDurableObject`
// implementation exists, MUST call `requireRoleForGovernedWorkspace` exactly like every other
// governed-workspace RPC method already does; no exceptions, that gap was already found and fixed at
// real security cost twice in this codebase's history (Phase 4's own `requireRoleForGovernedWorkspace`
// fix, and Phase 5's cross-Worker caller-authentication fix) and must not be reintroduced.**
// Recommended role split, following gatekeeper-rpc.ts's exact convention (mutations → `"build"`,
// reads → `"use"`): `startMeeting`/`endMeeting`/`appendTranscriptSegment` are mutations →
// `"build"`; `getMeeting`/`listMeetings` are reads → `"use"`.

/** Starts a new `Meeting` (meeting.ts) — creates the row with `startedAt` set to the caller-
 *  supplied (or, in a real implementation, server-assigned) start time and `endedAt` absent, per
 *  `Meeting`'s own "endedAt absent means still in progress" lifecycle. `id` is server-assigned
 *  (unlike `CreateNodeInput`'s optional caller-supplied `id` — a meeting has no deterministic-id
 *  use case analogous to a daily note's date-derived id), matching `CreateBookmarkOutput`'s
 *  identical convention. */
export class StartMeetingInput extends Schema.Class<StartMeetingInput>("StartMeetingInput")({
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1))
}) {}

export class StartMeetingOutput extends Schema.Class<StartMeetingOutput>("StartMeetingOutput")({
  meeting: Meeting
}) {}

/** Ends an in-progress `Meeting`, setting `endedAt`. Fails with `MeetingNotFound` (errors.ts) if
 *  no meeting with this id exists in the workspace. Deliberately idempotent-in-shape but not
 *  idempotent-in-semantics at this schema-only stage: whether calling `endMeeting` twice on an
 *  already-ended meeting is an error or a no-op is a `MeetingsService`-implementation decision
 *  (a later stage), not fixed by this wire contract — same "schema fixes the shape, the service
 *  fixes the policy" split every prior Phase 5 RPC file in this package follows. */
export class EndMeetingInput extends Schema.Class<EndMeetingInput>("EndMeetingInput")({
  workspaceId: EntityId,
  meetingId: EntityId,
  endedAt: IsoDateTimeString
}) {}

export class EndMeetingOutput extends Schema.Class<EndMeetingOutput>("EndMeetingOutput")({
  meeting: Meeting
}) {}

/** Appends one transcribed segment to an in-progress (or already-ended, per the policy note
 *  above) meeting's transcript — the RPC front end a `MeetingsService` implementation calls from
 *  both the native on-device `SFSpeechRecognizer` pipeline and the `CloudTranscriptionClient`
 *  fallback path (see meeting.ts's own header comment on `TranscriptSegmentRecord.source` for why
 *  a single meeting can legitimately mix both). `id` is server-assigned; `speakerId`, if supplied,
 *  must reference a `Speaker` row already created for this meeting (this schema does not create
 *  one — a separate, not-yet-built `identifySpeaker`/clustering-driven method is where `Speaker`
 *  rows get created, out of scope for this stage exactly as `linkCalendarEventToNode` treats
 *  node creation as someone else's job). Fails with `MeetingNotFound` if no meeting with this id
 *  exists in the workspace. */
export class AppendTranscriptSegmentInput extends Schema.Class<AppendTranscriptSegmentInput>(
  "AppendTranscriptSegmentInput"
)({
  workspaceId: EntityId,
  meetingId: EntityId,
  speakerId: Schema.optional(EntityId),
  text: Schema.String,
  startOffsetMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  endOffsetMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  source: TranscriptSegmentSource
}) {}

export class AppendTranscriptSegmentOutput extends Schema.Class<AppendTranscriptSegmentOutput>(
  "AppendTranscriptSegmentOutput"
)({
  segment: TranscriptSegmentRecord
}) {}

/** Reads one meeting, its full transcript (in `startOffsetMs` order), and every `Speaker`
 *  clustering has identified for it so far. Fails with `MeetingNotFound` if no meeting with this
 *  id exists in the workspace. Mirrors `GetChatOutput`'s identical "one aggregate read, not three
 *  separate round trips" shape (agent-edit-rpc.ts) — a meeting-review UI needs the meeting, its
 *  transcript, and its speaker roster together, the same way a chat UI needs the chat and its
 *  message log together. */
export class GetMeetingInput extends Schema.Class<GetMeetingInput>("GetMeetingInput")({
  workspaceId: EntityId,
  meetingId: EntityId
}) {}

export class GetMeetingOutput extends Schema.Class<GetMeetingOutput>("GetMeetingOutput")({
  meeting: Meeting,
  segments: Schema.Array(TranscriptSegmentRecord),
  speakers: Schema.Array(Speaker)
}) {}

/** Lists this workspace's meetings, most-recently-started first (in a real implementation — this
 *  schema does not itself fix ordering, matching `ListChatsOutput`'s identical scope note).
 *  Deliberately no transcript/speaker payload here (unlike `GetMeetingOutput`) — a listing view
 *  needs only the `Meeting` rows themselves; a caller wanting one meeting's full transcript calls
 *  `getMeeting`, the same "list is lightweight, get is the full aggregate" split
 *  `ListChatsOutput`/`GetChatOutput` already establish. */
export class ListMeetingsInput extends Schema.Class<ListMeetingsInput>("ListMeetingsInput")({
  workspaceId: EntityId
}) {}

export class ListMeetingsOutput extends Schema.Class<ListMeetingsOutput>("ListMeetingsOutput")({
  meetings: Schema.Array(Meeting)
}) {}
