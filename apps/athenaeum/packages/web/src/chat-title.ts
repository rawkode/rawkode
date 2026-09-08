/**
 * Turns the first message in a composer-first chat into a compact, useful title.
 * Keeping this deterministic means a retry cannot create a differently named chat for the
 * same initial prompt, and the title always satisfies CreateChatInput's non-empty contract.
 */
export const chatTitleFromMessage = (message: string): string => {
  const normalized = message.replace(/\s+/g, " ").trim()
  if (normalized.length === 0) return "New chat"
  if (normalized.length <= 48) return normalized
  return `${normalized.slice(0, 47).trimEnd()}…`
}
