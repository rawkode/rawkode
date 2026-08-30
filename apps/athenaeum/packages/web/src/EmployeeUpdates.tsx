import { Link } from "react-router"
import type { StandupPublication, StandupPublicationResultKindType } from "@athenaeum/domain"

export type EmployeeUpdateResultKind = StandupPublicationResultKindType
export type EmployeeUpdatePublication = StandupPublication & {
  /** Optional while older publications are read during the resultKind rollout. */
  readonly resultKind?: EmployeeUpdateResultKind
}

export type EmployeeUpdatesState =
  | { readonly status: "loading" }
  | { readonly status: "failure" }
  | { readonly status: "success"; readonly publications: readonly EmployeeUpdatePublication[] }

export type EmployeeUpdatePartitions = {
  readonly needsAttention: readonly EmployeeUpdatePublication[]
  readonly updates: readonly EmployeeUpdatePublication[]
}

/**
 * Partitions publications without changing their source order. In particular, no timestamp
 * sort belongs here: publication order is the server's deliberate order, and stable partitioning
 * keeps equal timestamps deterministic while still separating exceptions from routine updates.
 */
export const partitionEmployeeUpdates = (
  publications: readonly EmployeeUpdatePublication[],
): EmployeeUpdatePartitions => {
  const needsAttention: EmployeeUpdatePublication[] = []
  const updates: EmployeeUpdatePublication[] = []
  for (const publication of publications) {
    if (publication.resultKind === "blocked" || publication.resultKind === "failed") {
      needsAttention.push(publication)
    } else {
      updates.push(publication)
    }
  }
  return { needsAttention, updates }
}

const companionStatusMessage = (status: StandupPublication["companionStatus"]): string => {
  switch (status) {
    case "verified-original": return "Original update verified."
    case "modified": return "This update may have changed since publication."
    case "missing": return "The companion update is no longer available."
    case "unavailable": return "The companion update is currently unavailable."
  }
}

const resultKindPresentation: Record<EmployeeUpdateResultKind, { readonly label: string; readonly icon: string }> = {
  completed: { label: "Completed", icon: "✓" },
  blocked: { label: "Blocked", icon: "!" },
  failed: { label: "Failed", icon: "×" },
  skipped: { label: "Skipped", icon: "–" },
}

export const canOpenCompanion = (publication: EmployeeUpdatePublication): boolean =>
  publication.companionStatus === "verified-original" || publication.companionStatus === "modified"

export type WorkforceAttentionDisclosure = {
  readonly outcome: "Blocked" | "Failed"
  readonly employee: string
  readonly job: string
  /** Deliberately optional: missing/unavailable companion documents must remain inert. */
  readonly destination?: string
}

export type WorkforceAttentionPresentation =
  | { readonly kind: "hidden" }
  | { readonly kind: "failure" }
  | { readonly kind: "all-clear"; readonly routineCount: number }
  | {
      readonly kind: "attention"
      readonly totalAttentionCount: number
      readonly disclosures: readonly WorkforceAttentionDisclosure[]
      readonly remainderCount: number
    }

/**
 * Small, deliberately redacted above-editor projection. Keep the detailed report in the lower
 * standup subdocument; this contract cannot accidentally carry report text, ids, schedules, or
 * other operational detail into the writing surface.
 */
export const workforceAttentionPresentation = (
  state: EmployeeUpdatesState | { readonly status: "idle" },
  cap = 3
): WorkforceAttentionPresentation => {
  if (state.status === "idle" || state.status === "loading") return { kind: "hidden" }
  if (state.status === "failure") return { kind: "failure" }
  const attention = partitionEmployeeUpdates(state.publications).needsAttention
  if (attention.length === 0) {
    return state.publications.length === 0 ? { kind: "hidden" } : { kind: "all-clear", routineCount: state.publications.length }
  }
  const displayed = attention.slice(0, Math.max(0, cap)).map((publication): WorkforceAttentionDisclosure => ({
    outcome: publication.resultKind === "failed" ? "Failed" : "Blocked",
    employee: publication.microEmployeeLabel,
    job: publication.jobLabel,
    ...(canOpenCompanion(publication) ? { destination: `/node/${publication.childNodeId}` } : {})
  }))
  return {
    kind: "attention",
    totalAttentionCount: attention.length,
    disclosures: displayed,
    remainderCount: attention.length - displayed.length
  }
}

/** A read-only, privacy-safe projection of workforce updates attached to a daily note. */
export function EmployeeUpdates({ state, onRetry }: {
  readonly state: EmployeeUpdatesState
  readonly onRetry?: () => void
}) {
  const partitions = state.status === "success" ? partitionEmployeeUpdates(state.publications) : undefined

  const renderPublication = (publication: EmployeeUpdatePublication) => {
    const result = publication.resultKind === undefined ? undefined : resultKindPresentation[publication.resultKind]
    return (
      <li key={publication.id} className="employee-update">
        <div className="employee-update-labels">
          <span>Employee: {publication.microEmployeeLabel}</span>
          <span>Job: {publication.jobLabel}</span>
          <span>Workflow: {publication.workflowLabel}</span>
          <span>Schedule: {publication.scheduleLabel}</span>
        </div>
        <p className="employee-update-text">{publication.originalText}</p>
        <div className="employee-update-status">
          {result !== undefined && (
            <span className={`employee-update-outcome employee-update-outcome-${publication.resultKind}`}>
              <span aria-hidden="true">{result.icon}</span>{" "}{result.label}
            </span>
          )}
          <span>{companionStatusMessage(publication.companionStatus)}</span>
          {canOpenCompanion(publication) && (
            <Link to={`/node/${publication.childNodeId}`}>Open update</Link>
          )}
        </div>
      </li>
    )
  }

  return (
    <section className="employee-updates" aria-labelledby="employee-updates-title">
      <div className="employee-updates-heading">
        <div>
          <span className="section-kicker">Standup</span>
          <h2 id="employee-updates-title">Employee updates</h2>
        </div>
      </div>

      {state.status === "loading" && <p className="ledger-activity-state" role="status">Loading employee updates…</p>}
      {state.status === "failure" && (
        <div className="ledger-activity-state" role="alert">
          <p>Employee updates couldn&rsquo;t be loaded. Retry to check this daily note again.</p>
          {onRetry !== undefined && <button type="button" onClick={onRetry}>Retry</button>}
        </div>
      )}
      {state.status === "success" && state.publications.length === 0 && (
        <p className="ledger-activity-state">No published employee updates for this note yet.</p>
      )}
      {state.status === "success" && partitions !== undefined && partitions.needsAttention.length > 0 && (
        <div className="employee-updates-group employee-updates-group-attention">
          <h3 id="employee-updates-attention-title">Needs attention</h3>
          <ol className="employee-updates-list" aria-labelledby="employee-updates-attention-title">
            {partitions.needsAttention.map(renderPublication)}
          </ol>
        </div>
      )}
      {state.status === "success" && partitions !== undefined && partitions.updates.length > 0 && (
        <div className="employee-updates-group employee-updates-group-updates">
          <h3 id="employee-updates-updates-title">Updates</h3>
          <ol className="employee-updates-list" aria-labelledby="employee-updates-updates-title">
            {partitions.updates.map(renderPublication)}
          </ol>
        </div>
      )}
    </section>
  )
}
