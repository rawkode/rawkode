import { Link } from "react-router"
import type { StandupPublication } from "@athenaeum/domain"

export type EmployeeUpdatesState =
  | { readonly status: "loading" }
  | { readonly status: "failure" }
  | { readonly status: "success"; readonly publications: readonly StandupPublication[] }

const companionStatusMessage = (status: StandupPublication["companionStatus"]): string => {
  switch (status) {
    case "verified-original": return "Original update verified."
    case "modified": return "This update may have changed since publication."
    case "missing": return "The companion update is no longer available."
    case "unavailable": return "The companion update is currently unavailable."
  }
}

/** A read-only, privacy-safe projection of workforce updates attached to a daily note. */
export function EmployeeUpdates({ state, onRetry }: {
  readonly state: EmployeeUpdatesState
  readonly onRetry?: () => void
}) {
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
      {state.status === "success" && state.publications.length > 0 && (
        <ol className="employee-updates-list">
          {state.publications.map((publication) => (
            <li key={publication.id} className="employee-update">
              <div className="employee-update-labels">
                <span>Employee: {publication.microEmployeeLabel}</span>
                <span>Job: {publication.jobLabel}</span>
                <span>Workflow: {publication.workflowLabel}</span>
                <span>Schedule: {publication.scheduleLabel}</span>
              </div>
              <p className="employee-update-text">{publication.originalText}</p>
              <p className="employee-update-status">
                {companionStatusMessage(publication.companionStatus)}{" "}
                {(publication.companionStatus === "verified-original" || publication.companionStatus === "modified") && (
                  <Link to={`/node/${publication.childNodeId}`}>Open update</Link>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
