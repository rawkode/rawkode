import { useMemo, useState } from "react"
import { Link } from "react-router"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { AssignTagInput, BaseTagIds, RunViewInput, ViewSpec, type DomainError, type EntityId } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"

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

export function GraphView() {
  const [onlyPerson, setOnlyPerson] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [assigningNodeId, setAssigningNodeId] = useState<string | null>(null)
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

  const rows = state.status === "success" ? (state.value.rows as ReadonlyArray<GraphNodeRow>) : []

  const handleAssignPerson = (nodeId: string) => {
    setAssigningNodeId(nodeId)
    setAssignError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.assignTag(
            new AssignTagInput({ workspaceId, nodeId: nodeId as EntityId, tagId: BaseTagIds.Person })
          )
        )
      )
    )
    fiber.addObserver((exit) => {
      setAssigningNodeId(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setAssignError(formatDomainError(failure))
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <section className="graph-view">
      <header className="graph-view-header">
        <div>
          <span className="graph-view-eyebrow">
            <code>graph_nodes</code> · via <code>runView</code>
          </span>
          <h2>Graph</h2>
        </div>
        {state.status === "success" && (
          <span className="graph-view-count tabular-nums">
            {rows.length} node{rows.length === 1 ? "" : "s"}
            {onlyPerson ? " · tagged Person" : ""}
          </span>
        )}
      </header>

      <div className="graph-view-toolbar">
        <label className="graph-view-filter">
          <input
            type="checkbox"
            checked={onlyPerson}
            onChange={(event) => setOnlyPerson(event.target.checked)}
          />
          Only nodes tagged &ldquo;Person&rdquo;
        </label>
      </div>

      {state.status === "loading" && <p>Loading…</p>}
      {state.status === "failure" && <p className="error">{formatDomainError(state.error)}</p>}
      {assignError !== null && <p className="error">{assignError}</p>}
      {state.status === "success" && (
        <div className="graph-view-table-wrap">
          <table>
            <thead>
              <tr>
                <th className="graph-view-col-id">ID</th>
                <th>Title</th>
                <th className="graph-view-col-created">Created</th>
                <th className="graph-view-col-action">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const created = formatCreatedAt(row.createdAt)
                return (
                  <tr key={row.id}>
                    <td className="graph-view-col-id">
                      <code title={row.id}>{row.id.slice(0, 8)}</code>
                    </td>
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
                      <button
                        onClick={() => handleAssignPerson(row.id)}
                        disabled={assigningNodeId === row.id}
                      >
                        {assigningNodeId === row.id ? "…" : "+ Person"}
                      </button>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td className="graph-view-empty" colSpan={4}>
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
