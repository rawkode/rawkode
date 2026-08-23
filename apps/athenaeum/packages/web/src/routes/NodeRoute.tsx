import { useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EntityId, GetNodeInput } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "../rpc-client.js"
import { useEffectQuery } from "../use-effect-query.js"
import { workspaceId } from "../workspace-id.js"
import { formatDomainError } from "../format-domain-error.js"
import { dateStampFromDailyNoteId } from "../daily-note-id.js"
import { NoteTags } from "../NoteTags.js"
import { Backlinks } from "../Backlinks.js"
import { SupertagFieldPopover, type SupertagFieldPopoverTarget } from "../SupertagFieldPopover.js"

// Retrieval pass (design-review 2026-08-22 finding #1, "Node view"): the minimal destination
// every other retrieval surface (search results, graph rows, backlink entries, Cmd/Ctrl+clicked
// mentions) needed and didn't have — before this route existed there was literally no URL that
// showed any node other than today's daily note. Deliberately thin: title via the existing
// `getNode`, tags + field values via the existing `NoteTags` + `SupertagFieldPopover` pair
// (identical wiring to `DailyNote.tsx` — one data model, N entry points), backlinks via the
// existing `Backlinks` component, and — when the id is a daily-note id — a link into the daily
// editor for that day. Zero new RPCs, zero new data shapes; this is routing over what already
// works. Anything richer (rendering the node's page body, per-tag field tables) is
// direction-level work the review reserves for David's call.

function NodeView({ nodeId }: { readonly nodeId: EntityId }) {
  const [activeTag, setActiveTag] = useState<SupertagFieldPopoverTarget | null>(null)
  const [tagsRefreshKey, setTagsRefreshKey] = useState(0)

  const nodeEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getNode(new GetNodeInput({ workspaceId, nodeId })))
      ),
    [nodeId]
  )
  const state = useEffectQuery(nodeEffect, [nodeId])

  const dailyStamp = dateStampFromDailyNoteId(nodeId)

  return (
    <section className="node-view">
      {state.status === "loading" && <p className="node-view-loading">Loading node…</p>}
      {state.status === "failure" && <p className="error">{formatDomainError(state.error)}</p>}
      {state.status === "success" && (
        <>
          <header className="node-view-header">
            <span className="node-view-eyebrow">{dailyStamp !== undefined ? "Daily note" : "Node"}</span>
            <h1>{state.value.node.title}</h1>
            {dailyStamp !== undefined && (
              <Link
                className="node-view-open-daily"
                to={`/notes?date=${dailyStamp}`}
              >
                Open in the daily-note editor →
              </Link>
            )}
          </header>

          <NoteTags nodeId={nodeId} refreshKey={tagsRefreshKey} onSelectTag={setActiveTag} />
          <Backlinks nodeId={nodeId} />

          {activeTag !== null && (
            <SupertagFieldPopover
              nodeId={nodeId}
              tag={activeTag}
              onClose={() => setActiveTag(null)}
              onSaved={() => setTagsRefreshKey((k) => k + 1)}
            />
          )}
        </>
      )}
    </section>
  )
}

export function NodeRoute() {
  const { nodeId } = useParams()
  // The param is user-controlled URL text — decode it through the real `EntityId` schema before
  // it goes anywhere near an RPC, same defensive-decode discipline `RichNoteEditor`'s
  // reference-sync applies to mark payloads.
  const decoded = Schema.decodeUnknownOption(EntityId)(nodeId)

  return (
    <div className="route-view node-route">
      {decoded._tag === "None" ? (
        <>
          <h1 className="sr-only">Node not found</h1>
          <p className="error">
            Not a valid node id. <Link to="/notes">Back to today&rsquo;s note</Link>
          </p>
        </>
      ) : (
        // Keyed by id so navigating node → node (e.g. via a backlink on this very page) fully
        // remounts — fresh query state, closed popover — instead of leaking the previous node's.
        <NodeView key={decoded.value} nodeId={decoded.value} />
      )}
    </div>
  )
}
