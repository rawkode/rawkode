import { useEffect, useState } from "react"
import type { EntityId, LedgerActivityEntry } from "@athenaeum/domain"
import { EmployeeUpdates } from "./EmployeeUpdates.js"
import { DAILY_STANDUP_FETCH_LIMIT, type DailyStandupController } from "./use-daily-standup.js"
export { DAILY_STANDUP_FETCH_LIMIT } from "./use-daily-standup.js"

/** Keep the read wide enough for a useful daily picture while the presentation stays calm. */
const DAILY_STANDUP_INITIAL_VISIBLE_ENTRIES = 8

type PublicActivityEntry = LedgerActivityEntry & {
  readonly actorDetail?: { readonly kind: "user" | "employee" | "system"; readonly label: string }
  readonly target?: { readonly kind: "node" | "tag"; readonly id: EntityId }
}

const actorLabel = (entry: PublicActivityEntry): string => {
  const detail = entry.actorDetail
  if (detail !== undefined && (detail.kind === "user" || detail.kind === "employee" || detail.kind === "system") && detail.label.trim() !== "") {
    return detail.label
  }
  if (entry.actor === "you") return "You"
  if (entry.actor === "workspace-member") return "Workspace member"
  return "Anonymous"
}

const actorClass = (entry: PublicActivityEntry): string => {
  const kind = entry.actorDetail?.kind
  if (kind === "employee" || kind === "system" || kind === "user") return `ledger-activity-actor-${kind}`
  return `ledger-activity-actor-${entry.actor}`
}

const validTarget = (entry: PublicActivityEntry): { readonly kind: "node" | "tag"; readonly id: EntityId } | undefined => {
  const target = entry.target
  if ((target?.kind !== "node" && target?.kind !== "tag") || typeof target.id !== "string") return undefined
  // Keep malformed forward-compatible payloads inert even when a caller bypasses the domain
  // decoder (for example a stale RPC fixture or an untyped integration).
  const id = target.id
  const validUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  const validULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)
  return validUUID || validULID ? target : undefined
}

export type DailyStandupSummary = {
  readonly total: number
  readonly byYou: number
  readonly byWorkspaceMembers: number
  readonly byAnonymous: number
}

export const summarizeDailyStandup = (
  entries: readonly LedgerActivityEntry[]
): DailyStandupSummary => entries.reduce<DailyStandupSummary>((summary, entry) => {
  const actorKind = entry.actorDetail?.kind
  return {
    total: summary.total + 1,
    byYou: summary.byYou + (actorKind !== undefined ? (actorKind === "user" ? 1 : 0) : (entry.actor === "you" ? 1 : 0)),
    byWorkspaceMembers: summary.byWorkspaceMembers + (actorKind !== undefined ? (actorKind === "employee" ? 1 : 0) : (entry.actor === "workspace-member" ? 1 : 0)),
    byAnonymous: summary.byAnonymous + (actorKind !== undefined ? (actorKind === "system" ? 1 : 0) : (entry.actor === "anonymous" ? 1 : 0))
  }
}, { total: 0, byYou: 0, byWorkspaceMembers: 0, byAnonymous: 0 })

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
    case "migrateLegacyPage": return "Migrated a legacy note"
    case "createTag": return "Created a Supertag definition"
    case "updateTag": return "Updated a Supertag definition"
    case "defineTagField": return "Added a field to a Supertag definition"
    case "assignTag": return "Requested a Supertag membership"
    case "unassignTag": return "Requested removal of a Supertag membership"
    case "syncNoteReferences": return "Reconciled note mentions"
    case "commitLoroPageContent": return "Updated a note"
    case "ensureLoroPage": return "Prepared a note"
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
const emptyStandup: DailyStandupController = {
  snapshot: { isToday: false, generation: 0 },
  employeeUpdates: { status: "idle" }, ledger: { status: "idle" }, isRefreshing: false, refresh: () => undefined
}

export function DailyStandup({ standup = emptyStandup }: { readonly standup?: DailyStandupController } = {}) {
  const [showAllEntries, setShowAllEntries] = useState(false)
  const visibleEntries = standup.ledger.status === "success" ? standup.ledger.value : undefined
  const displayedEntries = showAllEntries ? visibleEntries : visibleEntries?.slice(0, DAILY_STANDUP_INITIAL_VISIBLE_ENTRIES)
  const additionalEntryCount = visibleEntries === undefined ? 0 : Math.max(visibleEntries.length - DAILY_STANDUP_INITIAL_VISIBLE_ENTRIES, 0)
  const isLoadingActivity = standup.ledger.status === "loading"
  const activityLoadFailed = standup.ledger.status === "failure"

  useEffect(() => setShowAllEntries(false), [standup.snapshot.dailyNoteId, standup.snapshot.generation])

  return (
    <>
      {standup.employeeUpdates.status !== "idle" && <EmployeeUpdates state={standup.employeeUpdates} onRetry={standup.refresh} />}
      {standup.snapshot.isToday && (
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
                onClick={standup.refresh}
                disabled={standup.isRefreshing}
                aria-label="Refresh recorded work"
              >
                {standup.isRefreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
          <p className="ledger-activity-intro">Recent recorded changes today (up to {DAILY_STANDUP_FETCH_LIMIT}). Every entry has an actor and a commit reason.</p>

          {isLoadingActivity && (
            <p className="ledger-activity-state" role="status">
              Loading activity…
            </p>
          )}
          {activityLoadFailed && (
            <p className="ledger-activity-state" role="alert">
              Recorded activity couldn&rsquo;t be loaded. Nothing has been changed. Refresh to check this workspace again.
            </p>
          )}
          {visibleEntries !== undefined && visibleEntries.length === 0 && (
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
                      <span className={`ledger-activity-actor ${actorClass(entry as PublicActivityEntry)}`}>{actorLabel(entry as PublicActivityEntry)}</span>
                      <time dateTime={entry.occurredAt}>{formatActivityTime(entry.occurredAt)}</time>
                    </div>
                    <div className="ledger-activity-reason">
                      <span>Commit reason</span>
                      <p>{entry.message}</p>
                    </div>
                    {validTarget(entry as PublicActivityEntry) !== undefined && (
                      <a
                        className="ledger-activity-target"
                        href={validTarget(entry as PublicActivityEntry)!.kind === "tag"
                          ? "/supertags"
                          : `/node/${validTarget(entry as PublicActivityEntry)!.id}`}
                      >
                        {validTarget(entry as PublicActivityEntry)!.kind === "tag" ? "Open affected Supertag" : "Open affected note"}
                      </a>
                    )}
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
