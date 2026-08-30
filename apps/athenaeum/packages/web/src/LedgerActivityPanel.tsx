import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Effect from "effect/Effect"
import type { EntityId, LedgerActivityEntry } from "@athenaeum/domain"
import { ListRecentLedgerActivityInput, ListRecentLedgerActivityOutput, ListStandupPublicationsInput } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { dailyStandupWindow } from "./daily-standup-window.js"
import { EmployeeUpdates, type EmployeeUpdatesState } from "./EmployeeUpdates.js"

/** Keep the read wide enough for a useful daily picture while the presentation stays calm. */
export const DAILY_STANDUP_FETCH_LIMIT = 20
const DAILY_STANDUP_INITIAL_VISIBLE_ENTRIES = 8

const actorLabel = (actor: LedgerActivityEntry["actor"]): string => {
  if (actor === "you") return "You"
  if (actor === "workspace-member") return "Workspace member"
  return "Anonymous"
}

export type DailyStandupSummary = {
  readonly total: number
  readonly byYou: number
  readonly byWorkspaceMembers: number
  readonly byAnonymous: number
}

export const summarizeDailyStandup = (
  entries: readonly LedgerActivityEntry[]
): DailyStandupSummary => entries.reduce<DailyStandupSummary>((summary, entry) => ({
  total: summary.total + 1,
  byYou: summary.byYou + (entry.actor === "you" ? 1 : 0),
  byWorkspaceMembers: summary.byWorkspaceMembers + (entry.actor === "workspace-member" ? 1 : 0),
  byAnonymous: summary.byAnonymous + (entry.actor === "anonymous" ? 1 : 0)
}), { total: 0, byYou: 0, byWorkspaceMembers: 0, byAnonymous: 0 })

const typeLabel = (type: LedgerActivityEntry["type"]): string => {
  switch (type) {
    case "createNode": return "Created a node"
    case "createNodeWithIntent": return "Created a node with provenance"
    case "acceptChatFork": return "Accepted a note edit"
    case "acceptPageProposal": return "Accepted a page proposal"
    case "agentChangeDecision": return "Decided an agent change"
    case "applySupertag": return "Applied a structured tag"
    case "addFact": return "Updated a workspace fact"
    case "createEdge": return "Created a relationship"
    case "createRelationDefinition": return "Created a relationship definition"
    case "createBookmark": return "Captured a bookmark"
    case "linkCalendarEventToNode": return "Linked a calendar event to a workspace node"
    case "appendTranscriptSegment": return "Captured a transcript segment"
    case "startMeeting": return "Started a meeting"
    case "prepareMeetingInDailyNote": return "Prepared a meeting in the daily note"
    case "createTag": return "Created a Supertag definition"
    case "defineTagField": return "Added a field to a Supertag definition"
    case "assignTag": return "Requested a Supertag membership"
    case "unassignTag": return "Requested removal of a Supertag membership"
    case "syncNoteReferences": return "Reconciled note mentions"
    default: {
      const exhaustive: never = type
      return exhaustive
    }
  }
}

/**
 * The daily note's standup subdocument. This is intentionally backed by the existing, privacy
 * safe ledger projection: until workforce runs exist, the honest thing to show is recorded work
 * and its commit reason, not a synthetic employee report.
 */
export function DailyStandup({ dailyNoteId, includeLedger = true }: {
  readonly dailyNoteId?: EntityId
  readonly includeLedger?: boolean
} = {}) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshClaimed, setRefreshClaimed] = useState(false)
  const [showAllEntries, setShowAllEntries] = useState(false)
  const refreshClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)
  const dayWindow = useMemo(() => dailyStandupWindow(), [refreshKey])
  // Historical notes still own their employee updates, but the ledger is a Today-only projection.
  // Avoid issuing a build-role ledger request for a historical note just because the shared
  // standup composition is mounted there.
  const ledgerEffect = includeLedger
    ? WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.listRecentLedgerActivity(new ListRecentLedgerActivityInput({
            workspaceId,
            limit: DAILY_STANDUP_FETCH_LIMIT,
            from: dayWindow.from,
            to: dayWindow.to
          }))
        )
      )
    : Effect.succeed(new ListRecentLedgerActivityOutput({ entries: [] }))
  const query = useEffectQuery(
    ledgerEffect,
    [refreshKey, includeLedger]
  )
  // `useEffectQuery` publishes the preceding settled result until the next generation enters
  // loading. Do not let that older result claim the new generation or its day window.
  const activeRefreshKey = useRef(refreshKey)
  useEffect(() => {
    activeRefreshKey.current = refreshKey
  }, [refreshKey])
  const stateIsCurrent = activeRefreshKey.current === refreshKey
  const currentEntries = stateIsCurrent && query.status === "success" ? query.value.entries : undefined
  const successfulEntries = useRef<{
    readonly from: string
    readonly to: string
    readonly entries: readonly LedgerActivityEntry[]
  } | undefined>(undefined)
  if (currentEntries !== undefined) {
    successfulEntries.current = { from: dayWindow.from, to: dayWindow.to, entries: currentEntries }
  }
  // A daily note must never show yesterday's recorded work after the local day window changes.
  const cachedEntries = successfulEntries.current?.from === dayWindow.from && successfulEntries.current.to === dayWindow.to
    ? successfulEntries.current.entries
    : undefined
  const visibleEntries = currentEntries ?? cachedEntries
  const displayedEntries = showAllEntries
    ? visibleEntries
    : visibleEntries?.slice(0, DAILY_STANDUP_INITIAL_VISIBLE_ENTRIES)
  const additionalEntryCount = visibleEntries === undefined
    ? 0
    : Math.max(visibleEntries.length - DAILY_STANDUP_INITIAL_VISIBLE_ENTRIES, 0)
  const isLoadingActivity = !stateIsCurrent || query.status === "loading"
  const activityLoadFailed = stateIsCurrent && query.status === "failure"

  useEffect(() => {
    // A refresh may reveal a larger result set. Start that new generation collapsed so the
    // daily note remains quiet and the reader can choose to expand it again.
    setShowAllEntries(false)
  }, [refreshKey, dayWindow.from, dayWindow.to])

  useEffect(() => {
    const claim = refreshClaim.current
    if (claim === undefined) return
    if (query.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A refresh-key render still sees the prior settled result. Release only after its claimed
    // generation has entered loading and subsequently reached its terminal query state.
    if (!claim.sawLoading) return
    refreshClaim.current = undefined
    setRefreshClaimed(false)
  }, [query.status])

  const refresh = useCallback(() => {
    if (refreshClaim.current !== undefined || query.status === "loading") return
    refreshClaim.current = { sawLoading: false }
    setRefreshClaimed(true)
    setRefreshKey((value) => value + 1)
  }, [query.status])

  useEffect(() => {
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [refresh])

  const isRefreshing = refreshClaimed || isLoadingActivity

  return (
    <>
      {dailyNoteId !== undefined && (
        <EmployeeUpdatesLoader dailyNoteId={dailyNoteId} refreshKey={refreshKey} onRetry={refresh} />
      )}
      {includeLedger && (
        <section className="daily-note-standup" aria-labelledby="daily-standup-title">
          <div className="ledger-activity-heading">
            <div>
              <span className="section-kicker">Daily standup</span>
              <h2 id="daily-standup-title">Recorded work</h2>
            </div>
            <div className="ledger-activity-heading-actions">
              <span className="ledger-activity-badge">ledger</span>
              <button
                type="button"
                className="ledger-activity-refresh"
                onClick={refresh}
                disabled={isRefreshing}
                aria-label="Refresh recorded work"
              >
                {isRefreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
          <p className="ledger-activity-intro">Recent recorded changes today (up to {DAILY_STANDUP_FETCH_LIMIT}). Every entry has an actor and a commit reason.</p>

          {isLoadingActivity && (
            <p className="ledger-activity-state" role="status">
              {cachedEntries === undefined ? "Loading activity…" : "Refreshing activity…"}
            </p>
          )}
          {activityLoadFailed && (
            <p className="ledger-activity-state" role="alert">
              Recorded activity couldn&rsquo;t be loaded. Nothing has been changed. Refresh to check this workspace again.
            </p>
          )}
          {currentEntries !== undefined && currentEntries.length === 0 && (
            <p className="ledger-activity-state">No ledgered changes yet.</p>
          )}
          {visibleEntries !== undefined && visibleEntries.length > 0 && (
            <>
              <StandupSummary summary={summarizeDailyStandup(visibleEntries)} />
              <ol id="daily-standup-activity-list" className="ledger-activity-list">
                {displayedEntries?.map((entry, index) => (
                  <li key={`${entry.occurredAt}-${entry.type}-${index}`} className="ledger-activity-entry">
                    <div className="ledger-activity-entry-meta">
                      <span className="ledger-activity-kind">{typeLabel(entry.type)}</span>
                      <span className={`ledger-activity-actor ledger-activity-actor-${entry.actor}`}>{actorLabel(entry.actor)}</span>
                      <time dateTime={entry.occurredAt}>{formatActivityTime(entry.occurredAt)}</time>
                    </div>
                    <div className="ledger-activity-reason">
                      <span>Commit reason</span>
                      <p>{entry.message}</p>
                    </div>
                  </li>
                ))}
              </ol>
              {additionalEntryCount > 0 && (
                <button
                  type="button"
                  className="ledger-activity-disclosure"
                  aria-controls="daily-standup-activity-list"
                  aria-expanded={showAllEntries}
                  onClick={() => setShowAllEntries((expanded) => !expanded)}
                >
                  {showAllEntries ? "Show fewer recorded changes" : `Show ${additionalEntryCount} more recorded ${additionalEntryCount === 1 ? "change" : "changes"}`}
                </button>
              )}
            </>
          )}
        </section>
      )}
    </>
  )
}

function EmployeeUpdatesLoader({ dailyNoteId, refreshKey, onRetry }: {
  readonly dailyNoteId: EntityId
  readonly refreshKey: number
  readonly onRetry: () => void
}) {
  const query = useEffectQuery(
    WorkspaceRpcClient.pipe(Effect.flatMap((client) =>
      client.listStandupPublications(new ListStandupPublicationsInput({ workspaceId, dailyNoteId }))
    )),
    [dailyNoteId, refreshKey]
  )
  const generation = `${dailyNoteId}:${refreshKey}`
  const activeGeneration = useRef(generation)
  useEffect(() => {
    activeGeneration.current = generation
  }, [generation])
  const stateIsCurrent = activeGeneration.current === generation
  let state: EmployeeUpdatesState
  if (!stateIsCurrent || query.status === "loading") state = { status: "loading" }
  else if (query.status === "failure") state = { status: "failure" }
  else state = { status: "success", publications: query.value.publications }
  return <EmployeeUpdates state={state} onRetry={onRetry} />
}

function StandupSummary({ summary }: { readonly summary: DailyStandupSummary }) {
  const parts = [
    `${summary.total} ${summary.total === 1 ? "change" : "changes"}`,
    summary.byYou > 0 ? `${summary.byYou} by you` : undefined,
    summary.byWorkspaceMembers > 0 ? `${summary.byWorkspaceMembers} by workspace members` : undefined,
    summary.byAnonymous > 0 ? `${summary.byAnonymous} automated` : undefined
  ].filter((part): part is string => part !== undefined)

  return <p className="ledger-activity-summary" aria-label="Daily standup summary">{parts.join(" · ")}</p>
}

/** Kept as a compatibility export for surfaces that still use the old contextual name. */
export const LedgerActivityPanel = DailyStandup

function formatActivityTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
}
