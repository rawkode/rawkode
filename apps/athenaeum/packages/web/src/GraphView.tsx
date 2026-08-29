import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { AssignTagInput, BaseTagIds, HumanUiMutationAttribution, RunViewInput, ViewSpec, type EntityId } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"

// Task item 3 ("At least one read-only graph view UI: render the result of a runView call... e.g.
// 'all nodes tagged Person'"). Renders the real `graph_nodes` read-only view (`RunViewInput`'s
// `viewName`/`viewSpec` pair — see graph-rpc.ts's doc comment for why both fields exist together)
// compiled server-side by `ViewsService`/`read-model.ts`'s `compileRunView`, with a live toggle
// between "all nodes" and a `hasTag` filter against the seeded `BaseTagIds.Person` Base Tag —
// exercising both the unfiltered and the tag-closure-filtered path of the same real RPC, plus an
// "assign Person tag" affordance (`assignTag`) so the filter has something to actually show.

/** `RunViewOutput.rows` is `Schema.Array(Schema.Unknown)` — `runView` is a general compiler over
 *  ten different views (view-spec.ts's `GraphViewName`), so the wire schema can't know the exact
 *  row shape for one specific view ahead of time. This is the client's own knowledge of
 *  `graph_nodes`'s real columns (`read-model.ts`: `graph_nodes AS SELECT id, workspaceId, title,
 *  createdAt FROM rm_nodes`), applied by a narrowing cast at the one place this UI reads rows. */
interface GraphNodeRow {
  readonly id: string
  readonly title: string
  readonly createdAt: string
}

/** Presentation-only split of `createdAt`'s ISO string into a compact date/time pair for the
 *  data-dense table — falls back to the raw string untouched if it isn't parseable, so a
 *  surprising server value degrades to "showing something" rather than "NaN NaN". */
const formatCreatedAt = (iso: string): { readonly date: string; readonly time: string } => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return { date: iso, time: "" }
  return {
    date: parsed.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }),
    time: parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  }
}

const personAssignmentFailureMessage =
  "We couldn’t confirm that this entity was tagged Person. Review the graph before taking another action."

export function GraphView() {
  const [onlyPerson, setOnlyPerson] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ onlyPerson: boolean; sawLoading: boolean } | undefined>(undefined)
  const [assigningNodeId, setAssigningNodeId] = useState<string | null>(null)
  // State drives the visible disabled/"…" treatment; the ref closes the narrow interval before
  // React has re-rendered a just-clicked control, so a rapid second activation cannot mint a
  // second independently identified assignment request.
  const assigningNodeIdRef = useRef<string | null>(null)
  const [assignError, setAssignError] = useState<string | null>(null)

  const viewEffect = useMemo(() => {
    const viewSpec = new ViewSpec({
      ...(onlyPerson ? { filter: { op: "hasTag" as const, tagId: BaseTagIds.Person } } : {}),
      sortColumn: "createdAt",
      sortDescending: true,
      view: "table",
      visibleColumns: ["id", "title", "createdAt"],
      rowLimit: 50
    })
    return WorkspaceRpcClient.pipe(
      Effect.flatMap((client) =>
        client.runView(new RunViewInput({ workspaceId, viewName: "graph_nodes", viewSpec }))
      )
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyPerson, refreshKey])
  const state = useEffectQuery(viewEffect, [onlyPerson, refreshKey])
  // `useEffectQuery` retains the prior result until its effect starts the query for a changed
  // filter. Do not label an unfiltered result or error as the People-only query during that gap.
  const activeFilter = useRef(onlyPerson)
  useEffect(() => {
    activeFilter.current = onlyPerson
  }, [onlyPerson])
  const stateMatchesFilter = activeFilter.current === onlyPerson
  const isLoadingGraph = !stateMatchesFilter || state.status === "loading"
  const currentRows =
    stateMatchesFilter && state.status === "success" ? (state.value.rows as ReadonlyArray<GraphNodeRow>) : undefined
  const graphLoadFailed = stateMatchesFilter && state.status === "failure"
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (claim.onlyPerson !== onlyPerson) {
      retryClaim.current = undefined
      setRetryClaimed(false)
      return
    }
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The refresh-key render can still contain the earlier failure. Keep the presentation claim
    // until this retry visibly enters loading and then reaches its terminal graph-read state.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [onlyPerson, state.status])
  const retryGraph = useCallback(() => {
    if (retryClaim.current !== undefined || state.status === "loading") return
    retryClaim.current = { onlyPerson, sawLoading: false }
    setRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [onlyPerson, state.status])
  const isRetryingGraph = retryClaimed || isLoadingGraph
  const shouldShowRefresh =
    currentRows !== undefined || (retryClaimed && stateMatchesFilter && !graphLoadFailed)

  const handleAssignPerson = (nodeId: string) => {
    if (assigningNodeIdRef.current !== null) return
    assigningNodeIdRef.current = nodeId
    setAssigningNodeId(nodeId)
    setAssignError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.assignTag(
            new AssignTagInput({
              workspaceId,
              nodeId: nodeId as EntityId,
              tagId: BaseTagIds.Person,
              requestId: crypto.randomUUID(),
              commitMessage: "Mark this graph entity as a person.",
              attribution: new HumanUiMutationAttribution({
                version: "athenaeum.mutation-attribution.v1",
                kind: "humanUi",
                surface: "web-graph-view"
              })
            })
          )
        )
      )
    )
    fiber.addObserver((exit) => {
      assigningNodeIdRef.current = null
      setAssigningNodeId(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setAssignError(personAssignmentFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <section className="graph-view">
      <header className="graph-view-header">
        <div>
          <span className="graph-view-eyebrow">Browseable entities</span>
          <h2>All entities</h2>
        </div>
        {currentRows !== undefined && (
          <span className="graph-view-count tabular-nums">
            {currentRows.length} node{currentRows.length === 1 ? "" : "s"}
            {onlyPerson ? " · tagged Person" : ""}
          </span>
        )}
        {shouldShowRefresh && (
          <button
            type="button"
            onClick={retryGraph}
            disabled={isRetryingGraph || assigningNodeId !== null}
            aria-label="Refresh the current graph filter"
          >
            {isRetryingGraph ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </header>

      <div className="graph-view-toolbar">
          <label className="graph-view-filter">
            <input
              type="checkbox"
              checked={onlyPerson}
              onChange={(event) => setOnlyPerson(event.target.checked)}
            />
            Show people only
        </label>
      </div>

      {isLoadingGraph && (
        <p role="status" aria-live="polite" aria-atomic="true">
          Loading…
        </p>
      )}
      {graphLoadFailed && (
        <section className="graph-view-load-state" role="alert" aria-label="Nodes are unavailable">
          <div>
            <p className="graph-view-load-title">Nodes are unavailable</p>
            <p>The node list could not be loaded. Nothing has been changed. Retry to check it again.</p>
          </div>
          <button type="button" onClick={retryGraph} disabled={isRetryingGraph}>
            {isRetryingGraph ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {assignError !== null && <p className="error" role="alert">{assignError}</p>}
      {currentRows !== undefined && (
        <div className="graph-view-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th className="graph-view-col-created">Created</th>
                <th className="graph-view-col-action">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {currentRows.map((row) => {
                const created = formatCreatedAt(row.createdAt)
                return (
                  <tr key={row.id}>
                    {/* Retrieval pass (design-review 2026-08-22 finding #1): titles were plain
                        StaticText — you could see a node existed and not open it (Flow 3's
                        `flow-3-graph-no-links.png`). Now a real link to the node view. */}
                    <td>
                      <Link className="graph-view-title-link" to={`/node/${row.id}`}>
                        {row.title}
                      </Link>
                    </td>
                    <td className="graph-view-col-created tabular-nums">
                      <span className="graph-view-created-date">{created.date}</span>
                      {created.time !== "" && (
                        <span className="graph-view-created-time">{created.time}</span>
                      )}
                    </td>
                    <td className="graph-view-col-action">
                      {!onlyPerson && (
                        <button
                          onClick={() => handleAssignPerson(row.id)}
                          disabled={assigningNodeId !== null || isRetryingGraph}
                        >
                          {assigningNodeId === row.id ? "Tagging…" : "+ Person"}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {currentRows.length === 0 && (
                <tr>
                  <td className="graph-view-empty" colSpan={3}>
                    No nodes{onlyPerson ? " tagged Person" : ""} yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
