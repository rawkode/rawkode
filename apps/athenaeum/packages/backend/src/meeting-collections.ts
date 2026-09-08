// `typed-storage-effect` collections backing `MeetingsService` (`meetings-service-live.ts`) — same
// "one small collections module per repository/service" convention as `calendar-collections.ts`/
// `sharing-collections.ts` (plan §"Storage & domain model", God-object mitigation).
//
// Three collections, matching the plan's storage-tier split literally: `meetings` and
// `transcriptSegments` (plus `speakers`, needed to satisfy `TranscriptSegmentRecord.speakerId`'s
// foreign key even though this stage's RPC surface never creates a `Speaker` row itself — see
// `meeting-rpc.ts`'s own `AppendTranscriptSegmentInput` doc comment: "a separate, not-yet-built
// `identifySpeaker`/clustering-driven method is where `Speaker` rows get created... out of scope
// for this stage") all live in the workspace DO's own SQLite, via `typed-storage-effect`, same as
// every other structured collection in this codebase (plan: "DO SQLite for structured transcript
// segments/metadata"). **Audio blobs deliberately do NOT have a collection here** — per the plan's
// own blob-size discipline ("keep audio blobs out of DO SQLite directly"), raw meeting audio goes
// to R2 instead (`meetings-service-live.ts`'s `MeetingAudioBucket` Context.Tag), addressed by an
// R2 object key, never a `typed-storage-effect` collection row.
//
//   - `meetings` — one row per `Meeting`, keyed by `id`, with a `byWorkspaceId` index
//     (`listMeetings`).
//   - `transcriptSegments` — one row per `TranscriptSegmentRecord`, keyed by `id`, with a
//     `byMeetingId` index (`getMeeting`'s transcript read, in `startOffsetMs` order).
//   - `speakers` — one row per `Speaker`, keyed by `id`, with a `byMeetingId` index
//     (`getMeeting`'s speaker-roster read).

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { Meeting, Speaker, TranscriptSegmentRecord, UnexpectedError, type EntityId } from "@athenaeum/domain"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

const meetingsCollectionSchema = collection<Meeting>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (meeting: Meeting) => meeting.workspaceId
  }
})

const transcriptSegmentsCollectionSchema = collection<TranscriptSegmentRecord>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byMeetingId: (segment: TranscriptSegmentRecord) => segment.meetingId
  }
})

const speakersCollectionSchema = collection<Speaker>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byMeetingId: (speaker: Speaker) => speaker.meetingId
  }
})

export interface MeetingCollections {
  readonly meetings: Collection<Meeting, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<Meeting, EntityId>
  }
  readonly transcriptSegments: Collection<TranscriptSegmentRecord, EntityId> & {
    readonly byMeetingId: NonUniqueIndex<TranscriptSegmentRecord, EntityId>
  }
  readonly speakers: Collection<Speaker, EntityId> & {
    readonly byMeetingId: NonUniqueIndex<Speaker, EntityId>
  }
}

export const makeMeetingCollections = (storage: DurableObjectStorage): MeetingCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: {
      meetings: meetingsCollectionSchema,
      transcriptSegments: transcriptSegmentsCollectionSchema,
      speakers: speakersCollectionSchema
    }
  })
  return {
    meetings: typedStorage.meetings,
    transcriptSegments: typedStorage.transcriptSegments,
    speakers: typedStorage.speakers
  }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** `DurableObjectStorage` round-trips values through structured clone — a record read back is a
 *  plain object, not the `Schema.Class` instance callers need (same concern as every other
 *  `revive*` helper in this codebase — `calendar-collections.ts#reviveCalendarEvent` is this
 *  file's own template). */
export const reviveMeeting = (raw: unknown): Effect.Effect<Meeting, UnexpectedError> =>
  Schema.decodeUnknown(Meeting)(raw).pipe(
    Effect.mapError(
      (parseError) => new UnexpectedError({ message: `corrupt stored meeting: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const reviveTranscriptSegment = (raw: unknown): Effect.Effect<TranscriptSegmentRecord, UnexpectedError> =>
  Schema.decodeUnknown(TranscriptSegmentRecord)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored transcript segment: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const reviveSpeaker = (raw: unknown): Effect.Effect<Speaker, UnexpectedError> =>
  Schema.decodeUnknown(Speaker)(raw).pipe(
    Effect.mapError(
      (parseError) => new UnexpectedError({ message: `corrupt stored speaker: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )
