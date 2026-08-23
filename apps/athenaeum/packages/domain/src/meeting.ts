import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"

// Phase 6 domain-extension task (plan §"Meetings & voice"), items 1-2: `Meeting`,
// `TranscriptSegment`/`Speaker`. Same `Schema.Class`-per-entity convention as calendar-event.ts/
// bookmark.ts. Zero Cloudflare/React deps, per this package's own standing discipline.
//
// **Naming collision, resolved deliberately (the same situation chat.ts's own header comment
// documents for `ChatThread`/`ChatMessage`, and for the identical reason):** the task that
// produced this file was worded against the plan's own vocabulary and asked for a persisted
// entity literally named `TranscriptSegment`. That name is already taken at this package's root
// export surface by `cloud-transcription.ts`'s `TranscriptSegment` — the ephemeral, provider-
// shaped `{text, startSeconds, endSeconds}` result shape `CloudTranscriptionClient.transcribe`
// returns on a single call, already exported and already consumed by
// `packages/backend/src/cloud-transcription-client-openai.ts` (real, shipped, tested code this
// task's own hard constraints forbid renaming: "do not restructure or rewrite what already
// works"). Reusing the name here would either collide at `index.ts`'s export surface or force
// renaming that already-verified file's import, which is exactly what chat.ts's header comment
// ruled out for its own analogous collision. So: `TranscriptSegmentRecord` for the persisted,
// per-meeting storage row below — the `Record` suffix flags "this is the durable log entry," the
// same signal `ChatMessageRecord` gives against `model-client.ts`'s own `ChatMessage` — distinct
// from, but related to, `cloud-transcription.ts`'s `TranscriptSegment`: a future `MeetingsService`
// is what will translate a `CloudTranscriptionClient.transcribe` call's returned
// `TranscriptSegment[]` (or an on-device `SFSpeechRecognizer` result, native-side) into one or
// more persisted `TranscriptSegmentRecord` rows via `appendTranscriptSegment` (meeting-rpc.ts) —
// the two shapes are related but not the same type, exactly as chat.ts's `ChatMessageRecord`/
// `ChatMessage` are.
//
// Field shapes are the task's own exact field lists:
//   Meeting            {id, workspaceId, title, startedAt, endedAt?, linkedNodeId?}
//   TranscriptSegment   {id, meetingId, speakerId?, text, startOffsetMs, endOffsetMs,
//                        source: "on-device"|"cloud"}
//   Speaker             {id, meetingId, label}

/**
 * A recorded/transcribed meeting, per the task's own `{id, workspaceId, title, startedAt, endedAt?,
 * linkedNodeId?}` shape. `endedAt` absent means the meeting is still in progress (mirrors
 * `Meeting`'s own lifecycle: `startMeeting`, meeting-rpc.ts, creates the row with `endedAt`
 * unset; `endMeeting` is the only writer of `endedAt`). `linkedNodeId` mirrors
 * `CalendarEvent.linkedNodeId`/`Bookmark.linkedNodeId`'s identical "optional companion node the
 * user can annotate" shape (calendar-event.ts's header comment) — same discipline, same reason:
 * this schema takes no position on whether that companion node is created eagerly (e.g. one per
 * started meeting) or lazily (only once a user wants to annotate), only on how one is referenced
 * once it exists. Deliberately no `audioRef`/R2-key field here: the plan's own storage-tier split
 * (§"Storage & domain model") puts meeting audio in R2, not the workspace DO's SQLite, and R2 object
 * addressing is a `MeetingsService`-implementation concern (a later stage), not something this
 * schema-only entity needs to carry yet — same "schema-only, no storage/service wiring" scope
 * note every prior Phase 5/6 file in this package states for itself.
 */
export class Meeting extends Schema.Class<Meeting>("Meeting")({
  id: EntityId,
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  startedAt: IsoDateTimeString,
  endedAt: Schema.optional(IsoDateTimeString),
  linkedNodeId: Schema.optional(EntityId)
}) {}

/**
 * Clustering output for one distinguishable voice detected within a meeting's audio — per the
 * task's own scope note, "no cross-meeting identity resolution needed for Phase 6": `label` is a
 * per-meeting-local display name (e.g. `"Speaker 1"`, or a user-supplied rename), never an
 * account identity, `Email`, or any handle that would imply "this is the same real person as
 * speaker X in a different meeting." That correlation — voiceprint-based speaker identity carried
 * across meetings — is explicitly out of scope for this stage (native's real-time speaker
 * clustering, `AthenaeumCore`'s `Meetings/` module per docs/meetings-voice-decisions.md §1.3,
 * clusters within one meeting's audio only; nothing in this schema or that native code claims
 * more). `id` is this row's own stable id within its meeting — what `TranscriptSegmentRecord
 * .speakerId` below references — not a cross-meeting voiceprint key.
 */
export class Speaker extends Schema.Class<Speaker>("Speaker")({
  id: EntityId,
  meetingId: EntityId,
  label: Schema.String.pipe(Schema.minLength(1))
}) {}

/** Which pipeline produced a `TranscriptSegmentRecord` — on-device `SFSpeechRecognizer` (the
 *  primary path, native-only, per the plan's hard constraint that on-device ASR is primary) or
 *  the `CloudTranscriptionClient` fallback (cloud-transcription.ts) a caller reaches for only
 *  when on-device transcription is unavailable/unauthorized/low-confidence on a given chunk —
 *  same distinction that file's own header comment draws. Kept on every row (not just inferred
 *  from which service call produced it) because a single meeting can legitimately mix sources
 *  chunk-by-chunk (on-device drops out mid-meeting, cloud fallback picks up the next chunk, then
 *  on-device resumes) and a client rendering/reviewing a transcript has a real use for knowing,
 *  per segment, which pipeline produced it. */
export const TranscriptSegmentSource = Schema.Literal("on-device", "cloud")
export type TranscriptSegmentSource = typeof TranscriptSegmentSource.Type

/**
 * One persisted segment of a meeting's transcript, per the task's own `{id, meetingId,
 * speakerId?, text, startOffsetMs, endOffsetMs, source}` shape. See this file's header comment
 * for why this is named `TranscriptSegmentRecord`, not `TranscriptSegment`.
 *
 * `startOffsetMs`/`endOffsetMs` are milliseconds relative to the meeting's own `startedAt` (the
 * meeting's own timeline), deliberately **not** the same unit as `cloud-transcription.ts`'s
 * `TranscriptSegment.startSeconds`/`endSeconds` (which are seconds relative to whichever audio
 * *chunk* was sent to the cloud fallback for that one call, per that file's own doc comment) — a
 * `MeetingsService` appending a cloud-transcription result via `appendTranscriptSegment`
 * (meeting-rpc.ts) is responsible for translating chunk-relative seconds into meeting-relative
 * milliseconds before constructing this row; this schema does not (and structurally cannot) do
 * that translation itself, since it has no notion of which chunk-offset-within-the-meeting a
 * given cloud call covered.
 *
 * `speakerId` optional: a segment is only attributable to a `Speaker` once native's speaker-
 * clustering pipeline (or a future manual-relabeling flow) has run and produced one — an
 * in-progress transcript may append segments with no `speakerId` yet, same "real but not yet
 * resolved" shape `Node.pending`/`CalendarEvent.linkedNodeId` use elsewhere in this package for
 * "this field's value doesn't exist yet, not that it doesn't apply."
 */
export class TranscriptSegmentRecord extends Schema.Class<TranscriptSegmentRecord>(
  "TranscriptSegmentRecord"
)({
  id: EntityId,
  meetingId: EntityId,
  speakerId: Schema.optional(EntityId),
  text: Schema.String,
  startOffsetMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  endOffsetMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  source: TranscriptSegmentSource
}) {}
