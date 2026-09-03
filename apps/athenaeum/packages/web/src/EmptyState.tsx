import type { ReactNode } from "react"

type EmptyStateProps = {
  readonly icon: string
  readonly title: string
  readonly message: string
  readonly action?: ReactNode
}

/** A quiet, actionable empty state for secondary workspace surfaces. */
export function EmptyState({ icon, title, message, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      <p>{message}</p>
      {action}
    </div>
  )
}
