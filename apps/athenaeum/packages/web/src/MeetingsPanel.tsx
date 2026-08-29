import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import * as Effect from "effect/Effect"
import {
  GetMeetingInput,
  GetNodeInput,
  ListMeetingsInput,
  type EntityId,
  type Meeting,
  type Speaker,
  type TranscriptSegmentRecord
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { EmptyState } from "./EmptyState.js"

// Web-stage Phase 6 task: "since system-audio capture and the realtime voice mic path are
// native-only per this phase's scope, build the web side as a READ path: a meetings list +
// transcript viewer (with speaker labels), linked to the associated node if any." Meetings are
// captured/transcribed natively (`native/AthenaeumCore/Sources/AthenaeumCore/Meetings/
// MeetingTranscriptionPipeline.swift` chunking real/synthetic audio through on-device ASR or the
// cloud-transcription fallback, per that stage's own report) and persisted via the real
// `startMeeting`/`appendTranscriptSegment`/`endMeeting` RPC methods
// (`packages/backend/src/workspace-durable-object.ts`) — this component only ever calls the two real
// read methods those same RPC methods' data ends up satisfying: `listMeetings` and `getMeeting`
// (`meeting-rpc.ts`). No create/record affordance exists here by design, mirroring the phase's own
// "native-only capture, web is read-only" scope split — unlike `CalendarPanel.tsx`/
// `BookmarksPanel.tsx`, which both have real write flows because Phase 5's capture paths (OAuth
// connect, paste-a-URL) are legitimately reachable from a browser.
//
// List/detail shape and the "list is lightweight, get is the full aggregate" split mirror
// `ChatPanel.tsx`'s existing chat-list/chat-detail pattern and `GetMeetingOutput`'s own doc
// comment. `linkedNodeId`, when present, is resolved via a second real `getNode` call (`rpc.ts` —
// already on `WorkspaceRpcClientService`, unchanged) and rendered as the linked note's title; this app
// has no per-node route to navigate to yet (`App.tsx`'s `Workspace` is a single flat page, same as
// every other panel here), so this is a read-only label, not a link.

const formatOffset = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function TranscriptViewer({ meetingId }: { readonly meetingId: EntityId }) {
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ meetingId: EntityId; sawLoading: boolean } | undefined>(undefined)
  const getMeetingEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getMeeting(new GetMeetingInput({ workspaceId, meetingId })))
      ),
    [meetingId, retryGeneration]
  )
  const state = useEffectQuery(getMeetingEffect, [meetingId, retryGeneration])
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (claim.meetingId !== meetingId) {
      retryClaim.current = undefined
      setRetryClaimed(false)
      return
    }
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A retry-key render initially retains the preceding failure result. Keep the claim until
    // this generation has visibly entered loading, then release it only after it settles.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [meetingId, state.status])
  const retryTranscript = useCallback(() => {
    if (retryClaim.current !== undefined || state.status === "loading") return
    retryClaim.current = { meetingId, sawLoading: false }
    setRetryClaimed(true)
    setRetryGeneration((generation) => generation + 1)
  }, [meetingId, state.status])
  const isRetryingTranscript = retryClaimed || state.status === "loading"

  const linkedNodeId = state.status === "success" ? state.value.meeting.linkedNodeId : undefined

  // Always built (rules-of-hooks), but only actually reaches the RPC when a linked node exists —
  // `Effect.succeed(undefined)`'s `never` requirement context is a subtype of `WorkspaceRpcClient`, so
  // this type-checks against `useEffectQuery`'s signature without a cast.
  const getNodeEffect = useMemo(
    () =>
      linkedNodeId === undefined
        ? Effect.succeed(undefined)
        : WorkspaceRpcClient.pipe(
            Effect.flatMap((client) => client.getNode(new GetNodeInput({ workspaceId, nodeId: linkedNodeId })))
          ),
    [linkedNodeId]
  )
  const nodeState = useEffectQuery(getNodeEffect, [linkedNodeId])

  if (state.status === "loading") {
    return (
      <p className="meetings-transcript-loading" role="status" aria-live="polite" aria-atomic="true">
        Loading transcript…
      </p>
    )
  }
  if (state.status === "failure") {
    if (state.error._tag === "MeetingNotFound") {
      return (
        <section className="meetings-load-state" role="status">
          <p>This meeting is no longer available. Refresh meeting history to update the list.</p>
        </section>
      )
    }
    return (
      <section className="meetings-load-state" role="alert" aria-label="Transcript is unavailable">
        <p>Transcript couldn&rsquo;t be loaded. Nothing has been changed.</p>
        <button type="button" onClick={retryTranscript} disabled={isRetryingTranscript}>
          {isRetryingTranscript ? "Retrying…" : "Retry"}
        </button>
      </section>
    )
  }

  const { meeting, segments, speakers } = state.value
  const speakerLabelById = new Map<EntityId, string>(speakers.map((speaker: Speaker) => [speaker.id, speaker.label]))
  // Defensive re-sort by meeting-relative offset — `GetMeetingOutput`'s doc comment says a real
  // implementation returns segments "in startOffsetMs order," but nothing about the wire schema
  // enforces that, and a viewer rendering an out-of-order transcript is a worse failure mode than
  // one extra client-side sort.
  const orderedSegments = [...segments].sort(
    (a: TranscriptSegmentRecord, b: TranscriptSegmentRecord) => a.startOffsetMs - b.startOffsetMs
  )

  const linkedNodeTitle =
    nodeState.status === "success" && nodeState.value !== undefined ? nodeState.value.node.title : undefined

  return (
    <div className="meetings-transcript">
      <div className="meetings-transcript-header">
        <h3>{meeting.title}</h3>
        <p className="meetings-transcript-meta">
          started {new Date(meeting.startedAt).toLocaleString()}
          {meeting.endedAt !== undefined && ` · ended ${new Date(meeting.endedAt).toLocaleString()}`}
          {meeting.endedAt === undefined && <span className="meetings-in-progress"> · in progress</span>}
        </p>
        {meeting.linkedNodeId !== undefined && (
          <p className="meetings-linked-node">
            {/* Retrieval pass (design-review 2026-08-22 finding #1): the linked note is a real
                link into the node view, same destination every other retrieval surface uses. */}
            Linked note:{" "}
            <Link to={`/node/${meeting.linkedNodeId}`}>
              {linkedNodeTitle ?? <em>{meeting.linkedNodeId}</em>}
            </Link>
            {nodeState.status === "failure" && (
              <span className="error meetings-linked-node-error" role="status">
                {" "}Linked note title couldn’t be loaded. The note link is still available.
              </span>
            )}
          </p>
        )}
        {speakers.length > 0 && (
          <p className="meetings-speakers">
            speakers: {speakers.map((speaker: Speaker) => speaker.label).join(", ")}
          </p>
        )}
      </div>

      {orderedSegments.length === 0 ? (
        <p className="meetings-transcript-empty">No transcript segments yet.</p>
      ) : (
        <ol className="meetings-transcript-segments">
          {orderedSegments.map((segment: TranscriptSegmentRecord) => (
            <li key={segment.id} className="meetings-transcript-segment">
              <span className="meetings-transcript-segment-offset">{formatOffset(segment.startOffsetMs)}</span>
              <span className="meetings-transcript-segment-speaker">
                {segment.speakerId !== undefined ? speakerLabelById.get(segment.speakerId) ?? "Unknown speaker" : "—"}
              </span>
              <span className="meetings-transcript-segment-text">{segment.text}</span>
              <span
                className={
                  segment.source === "on-device"
                    ? "meetings-transcript-segment-source meetings-transcript-segment-source-on-device"
                    : "meetings-transcript-segment-source meetings-transcript-segment-source-cloud"
                }
              >
                {segment.source}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export function MeetingsPanel() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshClaimed, setRefreshClaimed] = useState(false)
  const [selectedMeetingId, setSelectedMeetingId] = useState<EntityId | undefined>(undefined)
  const refreshClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)

  const meetingsEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listMeetings(new ListMeetingsInput({ workspaceId })))),
    [refreshKey]
  )
  const meetingsState = useEffectQuery(meetingsEffect, [refreshKey])
  // `useEffectQuery` keeps its preceding settled result until the next list generation enters
  // loading. Retain that same-workspace list for continuity, but do not let it claim a current
  // empty history while the new generation is still unresolved.
  const activeRefreshKey = useRef(refreshKey)
  useEffect(() => {
    activeRefreshKey.current = refreshKey
  }, [refreshKey])
  const stateIsCurrent = activeRefreshKey.current === refreshKey
  const currentMeetings = stateIsCurrent && meetingsState.status === "success" ? meetingsState.value.meetings : undefined
  const successfulMeetings = useRef<ReadonlyArray<Meeting> | undefined>(currentMeetings)
  if (currentMeetings !== undefined) successfulMeetings.current = currentMeetings
  const cachedMeetings = successfulMeetings.current
  const visibleMeetings = currentMeetings ?? cachedMeetings ?? []
  const isLoadingMeetings = !stateIsCurrent || meetingsState.status === "loading"

  useEffect(() => {
    const claim = refreshClaim.current
    if (claim === undefined) return
    if (meetingsState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A refresh-key render initially retains the preceding result. Keep this presentation claim
    // until the list visibly enters loading, then release it only after that read settles.
    if (!claim.sawLoading) return
    refreshClaim.current = undefined
    setRefreshClaimed(false)
  }, [meetingsState.status])

  const refreshMeetings = useCallback(() => {
    if (refreshClaim.current !== undefined || meetingsState.status === "loading") return
    refreshClaim.current = { sawLoading: false }
    setRefreshClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [meetingsState.status])

  const isRefreshingMeetings = refreshClaimed || isLoadingMeetings

  return (
    <section className="meetings-panel">
      <h2>Meetings</h2>
      <p className="meetings-panel-hint">
        Review conversations captured in the native app. Transcripts, speakers, and linked notes
        become part of your second brain here.
      </p>

      <button type="button" onClick={refreshMeetings} disabled={isRefreshingMeetings}>
        {refreshClaimed || (isLoadingMeetings && cachedMeetings !== undefined)
          ? "Refreshing…"
          : isLoadingMeetings
            ? "Loading…"
            : "Refresh"}
      </button>
      {isRefreshingMeetings && (
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {refreshClaimed || cachedMeetings !== undefined ? "Refreshing meetings…" : "Loading meetings…"}
        </p>
      )}

      {meetingsState.status === "failure" && (
        <section className="meetings-load-state" role="alert" aria-label="Meetings are unavailable">
          <p>
            {cachedMeetings === undefined
              ? "Meetings couldn’t be loaded. Nothing has been changed."
              : "Meetings couldn’t be refreshed. Your previously loaded meetings remain available."}
          </p>
          <button type="button" onClick={refreshMeetings} disabled={isRefreshingMeetings}>
            {isRefreshingMeetings ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {currentMeetings !== undefined && currentMeetings.length === 0 && (
        <EmptyState
          icon="⌁"
          title="Your meeting history starts here"
          message="Start a meeting capture in the macOS app. When it ends, the transcript and people you met will appear here."
          action={<Link className="ds-button" to="/notes">Open today’s note</Link>}
        />
      )}

      <ul className="meetings-list">
        {visibleMeetings.map((meeting) => (
          <li key={meeting.id} className="meetings-list-item">
            <button
              type="button"
              className={
                meeting.id === selectedMeetingId
                  ? "meetings-list-item-button meetings-list-item-button-selected"
                  : "meetings-list-item-button"
              }
              aria-current={meeting.id === selectedMeetingId ? "true" : undefined}
              onClick={() => setSelectedMeetingId(meeting.id)}
            >
              <span className="meetings-list-item-title">{meeting.title}</span>
              <span className="meetings-list-item-meta">
                {new Date(meeting.startedAt).toLocaleString()}
                {meeting.endedAt === undefined && <span className="meetings-in-progress"> · in progress</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selectedMeetingId !== undefined && <TranscriptViewer meetingId={selectedMeetingId} />}
    </section>
  )
}
