// `MeetingsService` — the Effect Service behind `meeting-rpc.ts`'s five methods
// (startMeeting/endMeeting/appendTranscriptSegment/getMeeting/listMeetings). Same
// `WorkspaceDurableObject`-composed-from-Effect-Services convention as `CalendarService`/`GraphService`
// (plan §"Storage & domain model", God-object mitigation) — backend-internal orchestration, not a
// `@athenaeum/domain` `Context.Tag` (mirrors `CalendarService`'s own placement rationale: this has
// real business logic — meeting lifecycle, the R2/SQLite storage-tier split below — with no home
// in `domain`'s zero-CF/React repository interfaces).
//
// **Storage-tier split (task item 1: "R2 for audio blobs, DO SQLite for structured transcript
// segments/metadata — keep audio blobs out of DO SQLite directly")**: `Meeting`/`Speaker`/
// `TranscriptSegmentRecord` rows (all small, structured) live in `meeting-collections.ts`'s
// `typed-storage-effect` collections, exactly like every other structured entity in this codebase.
// Raw meeting AUDIO never gets a `typed-storage-effect` row at all — `storeAudioChunk`/
// `getAudioChunk` below read/write it directly through `MeetingAudioBucket`, a small Context.Tag
// wrapping a real R2 binding (`env.MEETING_AUDIO`, wired in `workspace-durable-object.ts`), addressed
// by an R2 object key (`meetingAudioKey`) rather than a stored row. Unlike
// `CalendarGatekeeperClient`'s "real Worker, not deployed here, genuinely absent" situation, an R2
// bucket needs no external service/OAuth client to be real and usable in THIS environment — it's
// wired unconditionally in `wrangler.jsonc`'s `r2_buckets`, and `vitest-pool-workers` (via
// miniflare) backs it with a real, locally-simulated R2 implementation, the same way DO SQLite
// itself is real-but-locally-simulated in every test in this suite. `test/meetings.test.ts`
// exercises real `put`/`get` round trips against it — not mocked.
//
// **No public RPC/domain-schema surface for audio yet** (deliberate, matches this stage's scope:
// `meeting-rpc.ts`'s five methods, none of which accept audio bytes — see that file's own header
// comment). `storeAudioChunk`/`getAudioChunk` are real, tested capabilities reached only via
// `WorkspaceDurableObject`'s `ctx.exports`-only debug hooks in this stage (never exposed over Cap'n
// Web) — the same "real capability now, public entrypoint later" scope note
// `CalendarServiceApi.isCalendarContentVisible`/`hiddenCalendarDerivedNodeIds` already established
// for this codebase (real, load-bearing, but reached only from inside `workspace-durable-object.ts`,
// not directly callable by an arbitrary connected client).
//
// **`Meeting.linkedNodeId` observer-visibility (adversarial-review fix, Phase 6)**: unlike
// `CalendarService`, this service itself takes NO position on whether a caller can see the node
// `linkedNodeId` points at — `getMeeting`/`listMeetings` above return the row as stored. The real
// filter lives one layer up, in `workspace-durable-object.ts`'s `getMeeting`/`listMeetings` RPC
// methods (`sanitizeMeetingLinkedNodeId`, right next to `hiddenCalendarDerivedNodeIds`'s existing
// `listNodes`/`getNode`/`runView`/`searchNodes` call sites), the same "RPC-layer gate, service
// stays calendar-agnostic" split those four methods already use — do not move this service to
// depend on `CalendarService` directly. Currently dormant (no RPC sets `linkedNodeId` on a
// `Meeting` yet) but load-bearing the moment one does; see that helper's own doc comment for the
// full reasoning.
//
// **`workspaceId` defense-in-depth**: every method that loads a `Meeting`/segment/speaker by id also
// checks the loaded row's own `workspaceId` matches the caller's — belt-and-suspenders given each
// `WorkspaceDurableObject` instance's SQLite already only ever holds one workspace's rows (there is no
// cross-workspace data in this collection to leak), same discipline `CalendarServiceApi.linkEventToNode`
// already applies to `calendarEvents`. A mismatch (which should be structurally unreachable) folds
// into the same `MeetingNotFound` a genuinely-missing id produces — never a distinguishing oracle.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  EntityId,
  IsoDateTimeString,
  Meeting,
  MeetingNotFound,
  Speaker,
  TranscriptSegmentRecord,
  UnexpectedError,
  type TranscriptSegmentSource,
  type DomainError
} from "@athenaeum/domain"
import {
  makeMeetingCollections,
  reviveMeeting,
  reviveSpeaker,
  reviveTranscriptSegment,
  toUnexpectedError,
  type MeetingCollections
} from "./meeting-collections.js"
import { SyncFeedService } from "./sync-feed-service-live.js"

const now = (): IsoDateTimeString => IsoDateTimeString.make(new Date().toISOString())

const describeError = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "object" && cause !== null && "message" in cause
      ? String((cause as { message: unknown }).message)
      : String(cause)

/** The one R2 object key scheme every reader/writer of a meeting's audio must use — never
 *  hand-assembled inline, same "one composite-key builder" discipline `calendar-collections.ts
 *  #calendarObserverKey` follows. `chunkIndex` (not a timestamp) so the on-device chunker's own
 *  sequence numbering (`AudioChunker`, native-side, per docs/meetings-voice-decisions.md §1.3)
 *  maps directly onto object keys with no translation. */
export const meetingAudioKey = (workspaceId: EntityId, meetingId: EntityId, chunkIndex: number): string =>
  `meetings/${workspaceId}/${meetingId}/audio/${String(chunkIndex).padStart(6, "0")}.bin`

/**
 * Thin wrapper over a real `R2Bucket` binding — narrowed to exactly the two operations this
 * service needs (mirrors `HttpFetch`/`WebSocketTransport`'s own "narrow the real platform API to
 * what's actually used" discipline), and Effect-wrapped so callers never touch a raw Promise.
 */
export class MeetingAudioBucket extends Context.Tag("@athenaeum/backend/MeetingAudioBucket")<
  MeetingAudioBucket,
  {
    readonly put: (key: string, bytes: Uint8Array, mimeType: string) => Effect.Effect<void, UnexpectedError>
    readonly get: (key: string) => Effect.Effect<Uint8Array | undefined, UnexpectedError>
  }
>() {}

/** The real Layer — a genuine R2 binding, real `put`/`get` calls, no mocking. Real in every sense
 *  `ModelClientAnthropic`/`CloudTranscriptionClientOpenAI` are NOT: unlike those (which are
 *  genuinely unreachable in this environment for lack of a live API key), an R2 bucket bound in
 *  `wrangler.jsonc` is fully real and fully exercisable here, including in tests — see this file's
 *  header comment. */
export const makeMeetingAudioBucketR2Live = (bucket: R2Bucket): Layer.Layer<MeetingAudioBucket> =>
  Layer.succeed(MeetingAudioBucket, {
    put: (key, bytes, mimeType) =>
      Effect.tryPromise({
        try: async () => {
          await bucket.put(key, bytes, { httpMetadata: { contentType: mimeType } })
        },
        catch: (cause) => new UnexpectedError({ message: `R2 put failed for "${key}": ${describeError(cause)}` })
      }),
    get: (key) =>
      Effect.tryPromise({
        try: async () => {
          const object = await bucket.get(key)
          if (object === null) return undefined
          return new Uint8Array(await object.arrayBuffer())
        },
        catch: (cause) => new UnexpectedError({ message: `R2 get failed for "${key}": ${describeError(cause)}` })
      })
  })

/** Fail-closed fallback for the (should-not-happen-but-defend-anyway) case `env.MEETING_AUDIO` is
 *  unset — same "real client, cleanly unconfigured, fails per call" shape every other optional
 *  binding in this codebase uses (`CalendarGatekeeperClientUnconfigured` is the direct template). */
export const MeetingAudioBucketUnconfigured: Layer.Layer<MeetingAudioBucket> = Layer.succeed(MeetingAudioBucket, {
  put: () =>
    Effect.fail(new UnexpectedError({ message: "MEETING_AUDIO R2 bucket is not configured on this deployment." })),
  get: () =>
    Effect.fail(new UnexpectedError({ message: "MEETING_AUDIO R2 bucket is not configured on this deployment." }))
})

export interface AppendTranscriptSegmentArgs {
  readonly speakerId?: EntityId
  readonly text: string
  readonly startOffsetMs: number
  readonly endOffsetMs: number
  readonly source: TranscriptSegmentSource
}

export interface MeetingsServiceApi {
  readonly startMeeting: (workspaceId: EntityId, title: string) => Effect.Effect<Meeting, DomainError>
  readonly endMeeting: (
    workspaceId: EntityId,
    meetingId: EntityId,
    endedAt: IsoDateTimeString
  ) => Effect.Effect<Meeting, DomainError>
  readonly appendTranscriptSegment: (
    workspaceId: EntityId,
    meetingId: EntityId,
    args: AppendTranscriptSegmentArgs
  ) => Effect.Effect<TranscriptSegmentRecord, DomainError>
  readonly getMeeting: (
    workspaceId: EntityId,
    meetingId: EntityId
  ) => Effect.Effect<
    { meeting: Meeting; segments: ReadonlyArray<TranscriptSegmentRecord>; speakers: ReadonlyArray<Speaker> },
    DomainError
  >
  readonly listMeetings: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<Meeting>, DomainError>

  /**
   * Sets `Meeting.linkedNodeId` — no RPC calls this yet (see this file's own header comment on
   * the `linkedNodeId` observer-visibility fix, and `meeting-rpc.ts`'s own scope note), reached
   * only via `WorkspaceDurableObject#debugLinkMeetingToNode` (`ctx.exports`-only, same access rule as
   * `storeAudioChunk`/`getAudioChunk` above). Exists specifically so `test/meetings.test.ts` can
   * genuinely exercise the `linkedNodeId` observer-visibility filter end-to-end rather than
   * asserting only that it's vacuously true today. Mirrors `CalendarService#linkEventToNode`'s
   * shape, minus that method's node-existence check (`NodesRepository.get`) — deliberately not
   * added as a new `MeetingsService` dependency for a test-only capability; a real public
   * `linkMeeting`-style RPC, when one ships, should add that check the same way.
   */
  readonly linkMeetingToNode: (
    workspaceId: EntityId,
    meetingId: EntityId,
    nodeId: EntityId
  ) => Effect.Effect<Meeting, DomainError>

  // --- Storage-tier split (R2 audio blobs) — see this file's header comment. ---------------------
  readonly storeAudioChunk: (
    workspaceId: EntityId,
    meetingId: EntityId,
    chunkIndex: number,
    audio: Uint8Array,
    mimeType: string
  ) => Effect.Effect<{ r2Key: string }, DomainError>
  readonly getAudioChunk: (
    workspaceId: EntityId,
    meetingId: EntityId,
    chunkIndex: number
  ) => Effect.Effect<Uint8Array | undefined, DomainError>
}

export class MeetingsService extends Context.Tag("@athenaeum/backend/MeetingsService")<
  MeetingsService,
  MeetingsServiceApi
>() {}

export const makeMeetingsServiceLive = (
  collections: MeetingCollections
): Layer.Layer<MeetingsService, never, SyncFeedService | MeetingAudioBucket> =>
  Layer.effect(
    MeetingsService,
    Effect.gen(function* () {
      const syncFeed = yield* SyncFeedService
      const audioBucket = yield* MeetingAudioBucket

      const findMeeting = (workspaceId: EntityId, meetingId: EntityId): Effect.Effect<Meeting, DomainError> =>
        Effect.gen(function* () {
          const raw = yield* collections.meetings.get(meetingId).pipe(Effect.mapError(toUnexpectedError))
          if (raw === undefined) return yield* Effect.fail(new MeetingNotFound({ meetingId }))
          const meeting = yield* reviveMeeting(raw)
          if (meeting.workspaceId !== workspaceId) return yield* Effect.fail(new MeetingNotFound({ meetingId }))
          return meeting
        })

      const startMeeting: MeetingsServiceApi["startMeeting"] = (workspaceId, title) =>
        Effect.gen(function* () {
          const meeting = new Meeting({
            id: crypto.randomUUID() as EntityId,
            workspaceId,
            title,
            startedAt: now()
          })
          yield* collections.meetings.put(meeting).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("meeting", meeting.id, "put", meeting)
          return meeting
        })

      const endMeeting: MeetingsServiceApi["endMeeting"] = (workspaceId, meetingId, endedAt) =>
        Effect.gen(function* () {
          const existing = yield* findMeeting(workspaceId, meetingId)
          const updated = new Meeting({ ...existing, endedAt })
          yield* collections.meetings.put(updated).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("meeting", updated.id, "put", updated)
          return updated
        })

      const appendTranscriptSegment: MeetingsServiceApi["appendTranscriptSegment"] = (workspaceId, meetingId, args) =>
        Effect.gen(function* () {
          yield* findMeeting(workspaceId, meetingId)
          const segment = new TranscriptSegmentRecord({
            id: crypto.randomUUID() as EntityId,
            meetingId,
            ...(args.speakerId !== undefined ? { speakerId: args.speakerId } : {}),
            text: args.text,
            startOffsetMs: args.startOffsetMs,
            endOffsetMs: args.endOffsetMs,
            source: args.source
          })
          yield* collections.transcriptSegments.put(segment).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("transcriptSegment", segment.id, "put", segment)
          return segment
        })

      const getMeeting: MeetingsServiceApi["getMeeting"] = (workspaceId, meetingId) =>
        Effect.gen(function* () {
          const meeting = yield* findMeeting(workspaceId, meetingId)
          const segmentRows = yield* collections.transcriptSegments.byMeetingId
            .get(meetingId)
            .pipe(Effect.mapError(toUnexpectedError))
          const segments = yield* Effect.forEach(segmentRows, reviveTranscriptSegment)
          const speakerRows = yield* collections.speakers.byMeetingId
            .get(meetingId)
            .pipe(Effect.mapError(toUnexpectedError))
          const speakers = yield* Effect.forEach(speakerRows, reviveSpeaker)
          return {
            meeting,
            segments: [...segments].sort((a, b) => a.startOffsetMs - b.startOffsetMs),
            speakers
          }
        })

      const listMeetings: MeetingsServiceApi["listMeetings"] = (workspaceId) =>
        collections.meetings.byWorkspaceId.get(workspaceId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((rows) => Effect.forEach(rows, reviveMeeting)),
          Effect.map((meetings) => [...meetings].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)))
        )

      const linkMeetingToNode: MeetingsServiceApi["linkMeetingToNode"] = (workspaceId, meetingId, nodeId) =>
        Effect.gen(function* () {
          const existing = yield* findMeeting(workspaceId, meetingId)
          const updated = new Meeting({ ...existing, linkedNodeId: nodeId })
          yield* collections.meetings.put(updated).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("meeting", updated.id, "put", updated)
          return updated
        })

      const storeAudioChunk: MeetingsServiceApi["storeAudioChunk"] = (workspaceId, meetingId, chunkIndex, audio, mimeType) =>
        Effect.gen(function* () {
          yield* findMeeting(workspaceId, meetingId)
          const key = meetingAudioKey(workspaceId, meetingId, chunkIndex)
          yield* audioBucket.put(key, audio, mimeType)
          return { r2Key: key }
        })

      const getAudioChunk: MeetingsServiceApi["getAudioChunk"] = (workspaceId, meetingId, chunkIndex) =>
        Effect.gen(function* () {
          yield* findMeeting(workspaceId, meetingId)
          return yield* audioBucket.get(meetingAudioKey(workspaceId, meetingId, chunkIndex))
        })

      return {
        startMeeting,
        endMeeting,
        appendTranscriptSegment,
        getMeeting,
        listMeetings,
        linkMeetingToNode,
        storeAudioChunk,
        getAudioChunk
      } satisfies MeetingsServiceApi
    })
  )
