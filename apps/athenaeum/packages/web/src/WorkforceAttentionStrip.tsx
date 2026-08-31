import type { EntityId } from "@athenaeum/domain"
import {
  workforceAttentionPresentation,
  type EmployeeUpdatesState
} from "./EmployeeUpdates.js"
import { DAILY_STANDUP_ANCHOR_ID } from "./LedgerActivityPanel.js"

/** A compact Today-only cue. The full workforce report remains below the writing canvas. */
export function WorkforceAttentionStrip({
  state,
  onRetry,
  onReviewItem
}: {
  readonly state: EmployeeUpdatesState | { readonly status: "idle" }
  readonly onRetry: () => void
  /** The DailyNote owns the current-route check and in-document focus side effect. */
  readonly onReviewItem?: (publicationId: EntityId) => void
}) {
  const presentation = workforceAttentionPresentation(state)
  if (presentation.kind === "hidden") return null
  if (presentation.kind === "failure") {
    return (
      <section className="workforce-attention-strip workforce-attention-strip-failure" aria-label="Workforce update status" role="status">
        <span>Employee updates couldn’t be loaded.</span>
        <button type="button" onClick={onRetry}>Retry</button>
      </section>
    )
  }
  if (presentation.kind === "all-clear") {
    return (
      <section className="workforce-attention-strip workforce-attention-strip-clear" aria-label="Workforce update status">
        <span>{presentation.routineCount} {presentation.routineCount === 1 ? "employee update" : "employee updates"} · no exceptions</span>
        <a href={`#${DAILY_STANDUP_ANCHOR_ID}`}>Review standup</a>
      </section>
    )
  }
  return (
    <section className="workforce-attention-strip workforce-attention-strip-alert" aria-labelledby="workforce-attention-title">
      <div className="workforce-attention-heading">
        <strong id="workforce-attention-title">{presentation.totalAttentionCount} {presentation.totalAttentionCount === 1 ? "employee update needs" : "employee updates need"} attention</strong>
        <a href={`#${DAILY_STANDUP_ANCHOR_ID}`}>Review standup</a>
      </div>
      <ul className="workforce-attention-list">
        {presentation.disclosures.map((item, index) => (
          <li key={`${item.outcome}:${item.employee}:${item.job}:${index}`}>
            <span className="workforce-attention-outcome">{item.outcome}</span>
            <span>{item.employee} · {item.job}</span>
            {onReviewItem !== undefined && (
              <button
                type="button"
                onClick={() => onReviewItem(item.publicationId)}
                aria-label={`Review ${item.outcome} update from ${item.employee} for ${item.job}`}
              >
                Review
              </button>
            )}
          </li>
        ))}
      </ul>
      {presentation.remainderCount > 0 && <p>And {presentation.remainderCount} more in the standup.</p>}
    </section>
  )
}
