import { useMemo, useState, type FormEvent } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { CreateBookmarkInput, ListBookmarksInput, type Bookmark, type BookmarkUrl } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"

// Web-stage task item 3: "A bookmarks capture affordance (paste-a-URL-and-save is sufficient;
// share-sheet integration is native-only, out of scope for web)." Talks to the real
// `createBookmark`/`listBookmarks` RPC methods (`gatekeeper-rpc.ts`, already role-gated and
// covered by backend tests from the prior stage — this component is purely the web UI for
// already-real backend behavior). No live subscription exists for bookmarks (mirrors
// `SharePanel.tsx`'s own `refreshKey`-bump-after-mutation convention — there is no
// `subscribeToBookmarks` RPC method, only `subscribeToNodes`).

export function BookmarksPanel() {
  const [refreshKey, setRefreshKey] = useState(0)

  const bookmarksEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listBookmarks(new ListBookmarksInput({ workspaceId })))),
    [refreshKey]
  )
  const bookmarksState = useEffectQuery(bookmarksEffect, [refreshKey])

  const [url, setUrl] = useState("")
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedUrl = url.trim()
    if (trimmedUrl.length === 0) return
    setBusy(true)
    setError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.createBookmark(
            new CreateBookmarkInput({
              workspaceId,
              url: trimmedUrl as BookmarkUrl,
              ...(title.trim().length > 0 ? { title: title.trim() } : {})
            })
          )
        )
      )
    )
    fiber.addObserver((exit) => {
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        setUrl("")
        setTitle("")
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setError("Failed to save bookmark — make sure the URL starts with http:// or https://")
        console.error(exit.cause.toString())
      }
    })
  }

  const bookmarks: ReadonlyArray<Bookmark> = bookmarksState.status === "success" ? bookmarksState.value.bookmarks : []

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
      {error !== null && <p className="error">{error}</p>}

      {bookmarksState.status === "loading" && <p>Loading…</p>}
      {bookmarksState.status === "failure" && <p className="error">{formatDomainError(bookmarksState.error)}</p>}
      {bookmarksState.status === "success" && bookmarks.length === 0 && (
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
