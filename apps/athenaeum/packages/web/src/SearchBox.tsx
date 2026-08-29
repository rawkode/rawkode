import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import * as Effect from "effect/Effect"
import { SearchNodesInput, SearchNodesOutput } from "@athenaeum/domain"
import type { DomainError } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { dateStampFromDailyNoteId } from "./daily-note-id.js"

// Retrieval pass (design-review 2026-08-22 finding #1, "Search"): the review's Flow 3 verified
// there was "no search input anywhere in the shell" while the backend has shipped a real,
// role-gated, FTS5-backed `searchNodes` RPC (with its own test suite) all along — this component
// is the missing UI half of that existing RPC, nothing more. Lives in the sidebar (persistent,
// one input, no new route or palette chrome — the review's own findings warn against more
// resident furniture; a ⌘K palette is a direction-level upgrade that can absorb this later).
// Ordinary results still open `/node/:id`, while deterministic daily-note results use the
// date-addressed editor route directly. `NodeRoute` remains a defense-in-depth redirect for old
// links, but retrieval should not make a daily note take an unnecessary detour through it.

const SEARCH_DEBOUNCE_MS = 250

const EMPTY_SEARCH_OUTPUT = new SearchNodesOutput({ results: [] })

/** Returns the canonical web destination for a search result. */
export const searchResultDestination = (nodeId: string): string => {
  const dateStamp = dateStampFromDailyNoteId(nodeId)
  return dateStamp === undefined ? `/node/${nodeId}` : `/notes?date=${dateStamp}`
}

/** Shared retrieval state for the resident sidebar search and the transient command palette. */
export function useNodeSearch(query: string, enabled = true) {
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [retryKey, setRetryKey] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const active = enabled && debouncedQuery.length > 0
  const searchEffect = useMemo<Effect.Effect<SearchNodesOutput, DomainError, WorkspaceRpcClient>>(
    () =>
      active
        ? WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              client.searchNodes(new SearchNodesInput({ workspaceId, query: debouncedQuery, limit: 20 }))
            )
          )
        : Effect.succeed(EMPTY_SEARCH_OUTPUT),
    [active, debouncedQuery, retryKey]
  )
  const state = useEffectQuery(searchEffect, [active, debouncedQuery, retryKey])
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [state.status])
  const retry = useCallback(() => {
    if (retryClaim.current !== undefined || state.status === "loading") return
    retryClaim.current = { sawLoading: false }
    setRetryClaimed(true)
    setRetryKey((key) => key + 1)
  }, [state.status])
  const isRetrying = retryClaimed || state.status === "loading"

  // Consumers must only offer result actions once their own visible query is the query which
  // produced this state. During the debounce window, the previous request may still be successful
  // but it is no longer a safe navigation target.
  const isCurrent = active && debouncedQuery === query.trim()
  return { active, debouncedQuery, isCurrent, state, retry, isRetrying }
}

export function SearchBox({
  onNavigated
}: {
  /** Fired after a result navigates — lets `AppShell` close the mobile sidebar drawer, same as
   *  its own `NavLink`s' `onClick` does. */
  readonly onNavigated?: () => void
}) {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const { isCurrent, state, retry, isRetrying } = useNodeSearch(query)
  const trimmedQuery = query.trim()
  // A prior successful request must never remain keyboard-selectable after the user has typed a
  // different query but before its debounce elapses. Treat that small interval as loading rather
  // than sending the user to a stale result.
  const hasCurrentSearch = isCurrent
  const results = hasCurrentSearch && state.status === "success" ? state.value.results : []

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(results.length - 1, 0)))
  }, [results.length])

  const openResult = (nodeId: string) => {
    // AppShell persists across node routes, so retain this current, typed search session while a
    // person inspects a result. Escape and a subsequent edit remain the explicit clear/change
    // paths, and `hasCurrentSearch` still fails closed during a new debounce window.
    navigate(searchResultDestination(nodeId))
    onNavigated?.()
  }

  const activeResultId = results.length > 0 ? `sidebar-search-option-${selectedIndex}` : undefined

  return (
    <div className="shell-search" role="search">
      <input
        type="search"
        className="ds-field shell-search-input"
        placeholder="Search notes…"
        aria-label="Search notes"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={results.length > 0}
        aria-controls="sidebar-search-results"
        aria-activedescendant={activeResultId}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setSelectedIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            setQuery("")
            setSelectedIndex(0)
          } else if (event.key === "ArrowDown") {
            if (results.length > 0) {
              event.preventDefault()
              setSelectedIndex((index) => (index + 1) % results.length)
            }
          } else if (event.key === "ArrowUp") {
            if (results.length > 0) {
              event.preventDefault()
              setSelectedIndex((index) => (index - 1 + results.length) % results.length)
            }
          } else if (event.key === "Enter") {
            const result = results[selectedIndex]
            if (result !== undefined) {
              event.preventDefault()
              openResult(result.nodeId)
            }
          }
        }}
      />

      {trimmedQuery.length > 0 && (
        <div className="shell-search-results">
          {(!hasCurrentSearch || state.status === "loading") && (
            <p className="shell-search-status" role="status" aria-live="polite" aria-atomic="true">
              Searching…
            </p>
          )}
          {hasCurrentSearch && state.status === "failure" && (
            <div className="shell-search-status shell-search-failure" role="alert">
              <span>Search couldn’t be completed.</span>
              <button type="button" onClick={retry} disabled={isRetrying}>{isRetrying ? "Retrying…" : "Retry"}</button>
            </div>
          )}
          {hasCurrentSearch && state.status === "success" && results.length === 0 && (
            <p className="shell-search-status" role="status" aria-live="polite" aria-atomic="true">
              No matches.
            </p>
          )}
          {results.length > 0 && (
            <ul id="sidebar-search-results" className="shell-search-result-list" role="listbox" aria-label="Search results">
              {results.map((result, index) => (
                <li key={result.nodeId} role="presentation">
                  <button
                    id={`sidebar-search-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={selectedIndex === index}
                    className={`shell-search-result${selectedIndex === index ? " shell-search-result-selected" : ""}`}
                    onMouseEnter={() => setSelectedIndex(index)}
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
