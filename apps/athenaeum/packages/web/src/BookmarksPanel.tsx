import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { CreateBookmarkInput, HumanUiMutationAttribution, ListBookmarksInput, type Bookmark, type BookmarkUrl } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { clearPendingBookmarkIntent, persistPendingBookmarkIntent, readPendingBookmarkIntent, resolveBookmarkIntent, type PendingBookmarkIntent } from "./bookmark-intent.js"

// Web-stage task item 3: "A bookmarks capture affordance (paste-a-URL-and-save is sufficient;
// share-sheet integration is native-only, out of scope for web)." Talks to the real
// `createBookmark`/`listBookmarks` RPC methods (`gatekeeper-rpc.ts`, already role-gated and
// covered by backend tests from the prior stage — this component is purely the web UI for
// already-real backend behavior). No live subscription exists for bookmarks (mirrors
// `SharePanel.tsx`'s own `refreshKey`-bump-after-mutation convention — there is no
// `subscribeToBookmarks` RPC method, only `subscribeToNodes`).

const bookmarkCaptureFailureMessage =
  "We couldn’t confirm that this bookmark was saved. Your capture details are still here. Review your bookmarks before trying again."

export function BookmarksPanel() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)

  const bookmarksEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listBookmarks(new ListBookmarksInput({ workspaceId })))),
    [refreshKey]
  )
  const bookmarksState = useEffectQuery(bookmarksEffect, [refreshKey])
  const currentBookmarks = bookmarksState.status === "success" ? bookmarksState.value.bookmarks : undefined
  // `useEffectQuery` may show the preceding settled value briefly after a refresh-key change.
  // Treat it as cached data, not the result for the new generation, until that generation has
  // visibly entered loading.
  const bookmarkQueryScope = useRef<{ readonly key: number; current: boolean } | undefined>(undefined)
  if (bookmarkQueryScope.current === undefined) {
    bookmarkQueryScope.current = { key: refreshKey, current: true }
  } else if (bookmarkQueryScope.current.key !== refreshKey) {
    bookmarkQueryScope.current = { key: refreshKey, current: false }
  }
  if (bookmarksState.status === "loading") bookmarkQueryScope.current.current = true
  const bookmarksStateIsCurrent = bookmarkQueryScope.current.current
  // Keep the last confirmed list in this mounted panel while a later read is in flight or
  // unavailable. The archive stays usable without treating an unresolved read as an empty list.
  const [lastSuccessfulBookmarks, setLastSuccessfulBookmarks] = useState<ReadonlyArray<Bookmark> | undefined>(
    () => currentBookmarks
  )
  useEffect(() => {
    if (bookmarksStateIsCurrent && bookmarksState.status === "success") {
      setLastSuccessfulBookmarks(bookmarksState.value.bookmarks)
    }
  }, [bookmarksState.status, bookmarksStateIsCurrent, refreshKey])

  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (bookmarksState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The refresh-key render initially still presents the preceding failure. Keep the
    // presentation claim until this list read visibly loads and then reaches a terminal state.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [bookmarksState.status])

  const retryBookmarks = useCallback(() => {
    if (retryClaim.current !== undefined || bookmarksState.status === "loading") return
    retryClaim.current = { sawLoading: false }
    setRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [bookmarksState.status])

  const isRetryingBookmarks = retryClaimed || bookmarksState.status === "loading"

  const [pendingIntent, setPendingIntent] = useState<PendingBookmarkIntent | null>(() => readPendingBookmarkIntent(workspaceId))
  const [url, setUrl] = useState(() => pendingIntent?.url ?? "")
  const [title, setTitle] = useState(() => pendingIntent?.title ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isCapturingRef = useRef(false)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedUrl = url.trim()
    if (trimmedUrl.length === 0) return
    if (isCapturingRef.current) return
    isCapturingRef.current = true
    const intent = resolveBookmarkIntent(trimmedUrl, title.trim(), pendingIntent)
    setPendingIntent(intent)
    persistPendingBookmarkIntent(workspaceId, intent)
    setBusy(true)
    setError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.createBookmark(
            new CreateBookmarkInput({
              workspaceId,
              url: intent.url as BookmarkUrl,
              ...(intent.title !== undefined ? { title: intent.title } : {}),
              requestId: intent.requestId,
              commitMessage: "Capture this bookmark in the workspace.",
              attribution: new HumanUiMutationAttribution({
                version: "athenaeum.mutation-attribution.v1",
                kind: "humanUi",
                surface: "web-bookmarks"
              })
            })
          )
        )
      )
    )
    fiber.addObserver((exit) => {
      isCapturingRef.current = false
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        setUrl("")
        setTitle("")
        setPendingIntent(null)
        clearPendingBookmarkIntent(workspaceId)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setError(bookmarkCaptureFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  const bookmarks: ReadonlyArray<Bookmark> = currentBookmarks ?? lastSuccessfulBookmarks ?? []

  return (
    <section className="bookmarks-panel">
      <h2>Bookmarks</h2>

      <form onSubmit={handleSubmit} className="bookmarks-form">
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/interesting-thing"
          aria-label="Bookmark URL"
          disabled={busy}
        />
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title (optional)"
          aria-label="Bookmark title (optional)"
          disabled={busy}
        />
        <button type="submit" disabled={busy || url.trim().length === 0}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {error !== null && <p className="error" role="alert">{error}</p>}

      {bookmarksState.status === "loading" && (
        <p role="status" aria-live="polite" aria-atomic="true">
          {lastSuccessfulBookmarks === undefined ? "Loading…" : "Refreshing bookmarks…"}
        </p>
      )}
      {bookmarksState.status === "failure" && (
        <section className="bookmarks-load-state" role="alert" aria-label="Bookmarks are unavailable">
          <p>
            {lastSuccessfulBookmarks === undefined
              ? "Bookmarks couldn’t be loaded. Your capture form is still ready."
              : "Bookmarks couldn’t be refreshed. Your previously loaded bookmarks remain available. Retry to check them again."}
          </p>
          <button type="button" onClick={retryBookmarks} disabled={isRetryingBookmarks}>
            {isRetryingBookmarks ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {currentBookmarks !== undefined && currentBookmarks.length === 0 && (
        <p className="bookmarks-empty">No bookmarks yet — paste a URL above.</p>
      )}
      <ul className="bookmarks-list">
        {bookmarks.map((bookmark) => (
          <li key={bookmark.id} className="bookmarks-list-item">
            <a href={bookmark.url} target="_blank" rel="noreferrer">
              {bookmark.title ?? bookmark.url}
            </a>
            <span className="bookmarks-captured-at">{new Date(bookmark.capturedAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
