export const todayBriefLoadErrorMessage = "Unable to load today’s brief. Please try again."

export type TodayBriefFailurePresentation = {
  readonly title: string
  readonly message: string
  readonly retryLabel: string
  readonly retryingLabel: string
  readonly retryHint: string
}

export const todayBriefFailurePresentation = (isToday: boolean): TodayBriefFailurePresentation => isToday
  ? {
      title: "Today’s brief is unavailable",
      message: "We couldn’t resolve today’s calendar context. Retry to load it safely.",
      retryLabel: "Retry today’s brief",
      retryingLabel: "Retrying today’s brief…",
      retryHint: "Retries loading today’s calendar context."
    }
  : {
      title: "Daily brief is unavailable",
      message: "We couldn’t resolve this calendar context. Retry to load it safely.",
      retryLabel: "Retry daily brief",
      retryingLabel: "Retrying daily brief…",
      retryHint: "Retries loading this calendar context."
    }

// RPC/schema failures can contain provider-owned values in their parse-tree message. Today Brief
// is intentionally a privacy-safe projection, so its error boundary must not echo any wire data.
export const formatTodayBriefError = (_error: unknown): string => todayBriefLoadErrorMessage
