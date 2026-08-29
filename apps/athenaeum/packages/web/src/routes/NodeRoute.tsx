import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, Navigate, useParams } from "react-router"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EntityId, GetNodeInput, GetPageTextInput, GetPageTextOutput, type DomainError } from "@athenaeum/domain"
import { WorkspaceRpcClient } from "../rpc-client.js"
import { useEffectQuery } from "../use-effect-query.js"
import type { EffectState } from "../effect-store.js"
import { workspaceId } from "../workspace-id.js"
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
// existing `Backlinks` component. Canonical daily-note ids bypass this generic view entirely and
// open their date-addressed editor before this route can issue the legacy-only `getPageText` RPC.
// The page body below therefore remains a useful generic-node preview without becoming a second
// document-format or edit path.

function NodeView({ nodeId }: { readonly nodeId: EntityId }) {
  const [activeTag, setActiveTag] = useState<SupertagFieldPopoverTarget | null>(null)
  const [tagsRefreshKey, setTagsRefreshKey] = useState(0)
  const [nodeRefreshKey, setNodeRefreshKey] = useState(0)
  const [pageRefreshKey, setPageRefreshKey] = useState(0)
  const [nodeRetryClaimed, setNodeRetryClaimed] = useState(false)
  const [pageRetryClaimed, setPageRetryClaimed] = useState(false)
  const nodeRetryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)
  const pageRetryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)

  const nodeEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getNode(new GetNodeInput({ workspaceId, nodeId })))
      ),
    [nodeId]
  )
  const state = useEffectQuery(nodeEffect, [nodeId, nodeRefreshKey])
  useEffect(() => {
    const claim = nodeRetryClaim.current
    if (claim === undefined) return
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    if (!claim.sawLoading) return
    nodeRetryClaim.current = undefined
    setNodeRetryClaimed(false)
  }, [state.status])
  const retryNode = useCallback(() => {
    if (nodeRetryClaim.current !== undefined || state.status === "loading") return
    nodeRetryClaim.current = { sawLoading: false }
    setNodeRetryClaimed(true)
    setNodeRefreshKey((key) => key + 1)
  }, [state.status])
  const isRetryingNode = nodeRetryClaimed || state.status === "loading"

  const pageEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getPageText(new GetPageTextInput({ workspaceId, nodeId })))
      ),
    [nodeId]
  )
  const pageState = useEffectQuery(pageEffect, [nodeId, pageRefreshKey])
  useEffect(() => {
    const claim = pageRetryClaim.current
    if (claim === undefined) return
    if (pageState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A refresh-key render still sees the preceding failed preview. Release only after the
    // claimed generation enters loading and reaches its terminal page-read result.
    if (!claim.sawLoading) return
    pageRetryClaim.current = undefined
    setPageRetryClaimed(false)
  }, [pageState.status])
  const retryPage = useCallback(() => {
    if (pageRetryClaim.current !== undefined || pageState.status === "loading") return
    pageRetryClaim.current = { sawLoading: false }
    setPageRetryClaimed(true)
    setPageRefreshKey((key) => key + 1)
  }, [pageState.status])
  const isRetryingPage = pageRetryClaimed || pageState.status === "loading"

  return (
    <section className="node-view">
      {state.status === "loading" && (
        <p className="node-view-loading" role="status" aria-live="polite" aria-atomic="true">
          Loading node…
        </p>
      )}
      {state.status === "failure" && (
        <section className="node-view-load-state" role="alert">
          <div>
            <p className="node-view-load-title">This node couldn’t be loaded.</p>
            <p>Retry to continue opening this entity.</p>
          </div>
          <button type="button" onClick={retryNode} disabled={isRetryingNode}>
            {isRetryingNode ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {state.status === "success" && (
        <>
          <header className="node-view-header">
            <span className="node-view-eyebrow">Node</span>
            <h1>{state.value.node.title}</h1>
          </header>

          <NodePagePreview state={pageState} onRetry={retryPage} isRetrying={isRetryingPage} />
          <NoteTags
            nodeId={nodeId}
            refreshKey={tagsRefreshKey}
            onSelectTag={(chip, anchorRect, anchorRectSource) => setActiveTag({ ...chip, anchorRect, anchorRectSource })}
          />
          <Backlinks nodeId={nodeId} />

          {activeTag !== null && (
            <SupertagFieldPopover
              key={nodeId + ":" + activeTag.tagId}
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

function NodePagePreview({
  state,
  onRetry,
  isRetrying
}: {
  readonly state: EffectState<GetPageTextOutput, DomainError>
  readonly onRetry: () => void
  readonly isRetrying: boolean
}) {
  if (state.status === "loading") {
    return (
      <section className="node-view-page" aria-labelledby="node-page-title">
        <span className="node-view-eyebrow">Page</span>
        <h2 id="node-page-title">Loading content…</h2>
      </section>
    )
  }
  if (state.status === "failure") {
    if (state.error._tag === "PageNotFound") {
      return (
        <section className="node-view-page" aria-labelledby="node-page-title">
          <span className="node-view-eyebrow">Page</span>
          <h2 id="node-page-title">No page content yet</h2>
          <p className="node-view-page-empty">This entity has not been given a page document.</p>
        </section>
      )
    }
    return (
      <section className="node-view-page" aria-labelledby="node-page-title">
        <span className="node-view-eyebrow">Page</span>
        <div className="node-view-load-state node-view-page-load-state" role="alert">
          <div>
            <h2 id="node-page-title">Page content couldn’t be loaded.</h2>
            <p>Retry to continue loading this entity’s page content.</p>
          </div>
          <button type="button" onClick={onRetry} disabled={isRetrying}>{isRetrying ? "Retrying…" : "Retry"}</button>
        </div>
      </section>
    )
  }
  if (state.status !== "success") return null

  const text = state.value.text.trim()
  return (
    <section className="node-view-page" aria-labelledby="node-page-title">
      <span className="node-view-eyebrow">Page</span>
      <h2 id="node-page-title">Content</h2>
      {text.length === 0 ? (
        <p className="node-view-page-empty">This entity has an empty page.</p>
      ) : (
        <div className="node-view-page-text">{state.value.text}</div>
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

  // A daily note is a typed Loro editor route, not an ordinary node-page preview. Redirect before
  // `NodeView` mounts so retrieval sources that still use `/node/:id` (search, palette, graph,
  // backlinks, direct URLs) cannot invoke its legacy `getPageText` read and display an empty body.
  const dailyStamp = decoded._tag === "Some" ? dateStampFromDailyNoteId(decoded.value) : undefined
  if (dailyStamp !== undefined) return <Navigate to={`/notes?date=${dailyStamp}`} replace />

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
