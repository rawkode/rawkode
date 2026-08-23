import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import * as Effect from "effect/Effect"
import { SearchNodesInput } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"

// Retrieval pass (design-review 2026-08-22 finding #1, "Search"): the review's Flow 3 verified
// there was "no search input anywhere in the shell" while the backend has shipped a real,
// role-gated, FTS5-backed `searchNodes` RPC (with its own test suite) all along — this component
// is the missing UI half of that existing RPC, nothing more. Lives in the sidebar (persistent,
// one input, no new route or palette chrome — the review's own findings warn against more
// resident furniture; a ⌘K palette is a direction-level upgrade that can absorb this later).
// Each result links to `/node/:id` (`NodeRoute`), the same destination graph rows, backlinks and
// mentions now share.

const SEARCH_DEBOUNCE_MS = 250

export function SearchBox({
  onNavigated
}: {
  /** Fired after a result navigates — lets `AppShell` close the mobile sidebar drawer, same as
   *  its own `NavLink`s' `onClick` does. */
  readonly onNavigated?: () => void
}) {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [query])

  const active = debouncedQuery.length > 0

  const searchEffect = useMemo(
    () =>
      active
        ? WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              client.searchNodes(new SearchNodesInput({ workspaceId, query: debouncedQuery, limit: 20 }))
            )
          )
        : Effect.succeed({ results: [] as ReadonlyArray<{ nodeId: string; title: string; snippet: string }> }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [debouncedQuery, active]
  )
  const state = useEffectQuery(searchEffect, [debouncedQuery, active])

  const openResult = (nodeId: string) => {
    setQuery("")
    setDebouncedQuery("")
    navigate(`/node/${nodeId}`)
    onNavigated?.()
  }

  return (
    <div className="shell-search" role="search">
      <input
        type="search"
        className="shell-search-input"
        placeholder="Search notes…"
        aria-label="Search notes"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setQuery("")
            setDebouncedQuery("")
          }
          // Enter opens the top hit — the "I typed what I want, take me there" fast path.
          if (event.key === "Enter" && state.status === "success" && state.value.results.length > 0) {
            openResult(state.value.results[0].nodeId)
          }
        }}
      />

      {active && (
        <div className="shell-search-results" aria-live="polite">
          {state.status === "loading" && <p className="shell-search-status">Searching…</p>}
          {state.status === "failure" && (
            <p className="shell-search-status error">{formatDomainError(state.error)}</p>
          )}
          {state.status === "success" && state.value.results.length === 0 && (
            <p className="shell-search-status">No matches.</p>
          )}
          {state.status === "success" && state.value.results.length > 0 && (
            <ul className="shell-search-result-list">
              {state.value.results.map((result) => (
                <li key={result.nodeId}>
                  <button
                    type="button"
                    className="shell-search-result"
                    onClick={() => openResult(result.nodeId)}
                  >
                    <span className="shell-search-result-title">{result.title}</span>
                    {result.snippet.length > 0 && (
                      <span className="shell-search-result-snippet">{result.snippet}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
