export const todayBriefLoadErrorMessage = "Unable to load today’s brief. Please try again."

// RPC/schema failures can contain provider-owned values in their parse-tree message. Today Brief
// is intentionally a privacy-safe projection, so its error boundary must not echo any wire data.
export const formatTodayBriefError = (_error: unknown): string => todayBriefLoadErrorMessage
