import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { MutationRequestId, type EntityId } from "@athenaeum/domain"

export type PendingBookmarkIntent = {
  readonly requestId: string
  readonly url: string
  readonly title?: string
}

export const pendingBookmarkStorageKey = (workspaceId: EntityId): string =>
  `athenaeum:pendingBookmark:${workspaceId}`

const storage = (): Storage | null => {
  try { return window.localStorage } catch { return null }
}

/** Reads only a structurally valid pending intent. Malformed browser state is discarded so a bad
 * request id can never be retried forever or reach the ledger boundary. */
export const readPendingBookmarkIntent = (workspaceId: EntityId): PendingBookmarkIntent | null => {
  const persisted = storage()?.getItem(pendingBookmarkStorageKey(workspaceId))
  if (persisted === null || persisted === undefined) return null
  try {
    const parsed: unknown = JSON.parse(persisted)
    if (typeof parsed !== "object" || parsed === null) return null
    const candidate = parsed as { requestId?: unknown; url?: unknown; title?: unknown }
    if (typeof candidate.requestId !== "string" || Option.isNone(Schema.decodeUnknownOption(MutationRequestId)(candidate.requestId))) return null
    if (typeof candidate.url !== "string" || candidate.url.length === 0) return null
    if (candidate.title !== undefined && typeof candidate.title !== "string") return null
    return { requestId: candidate.requestId, url: candidate.url, ...(candidate.title !== undefined ? { title: candidate.title } : {}) }
  } catch {
    return null
  }
}

/** Reuses one request identity while the semantic capture intent is unchanged. This is the UI
 * half of replay safety: a lost response followed by retry sends the same ledger command. */
export const resolveBookmarkIntent = (
  url: string,
  title: string,
  pending: PendingBookmarkIntent | null,
  mintRequestId: () => string = () => crypto.randomUUID()
): PendingBookmarkIntent => {
  const semanticTitle = title.length > 0 ? title : undefined
  if (pending !== null && pending.url === url && pending.title === semanticTitle) return pending
  return { requestId: mintRequestId(), url, ...(semanticTitle !== undefined ? { title: semanticTitle } : {}) }
}

export const persistPendingBookmarkIntent = (workspaceId: EntityId, intent: PendingBookmarkIntent): void => {
  try { storage()?.setItem(pendingBookmarkStorageKey(workspaceId), JSON.stringify(intent)) } catch { /* best effort */ }
}

export const clearPendingBookmarkIntent = (workspaceId: EntityId): void => {
  try { storage()?.removeItem(pendingBookmarkStorageKey(workspaceId)) } catch { /* best effort */ }
}
