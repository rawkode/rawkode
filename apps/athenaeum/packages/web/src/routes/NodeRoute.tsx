import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, Navigate, useParams } from "react-router"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EntityId, GetNodeInput, GetPageDocumentDescriptorInput, GetPageTextInput, type PageDocumentDescriptor } from "@athenaeum/domain"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "../rpc-client.js"
import { useEffectQuery } from "../use-effect-query.js"
import type { EffectState } from "../effect-store.js"
import { workspaceId } from "../workspace-id.js"
import { dateStampFromDailyNoteId } from "../daily-note-id.js"
import { NoteTags } from "../NoteTags.js"
import { Backlinks } from "../Backlinks.js"
import { SupertagFieldPopover, type SupertagFieldPopoverTarget } from "../SupertagFieldPopover.js"
import { convergeLoroPageFromServer } from "../loro-page.js"
import { renderStaticLoroPreview } from "../loro-static-preview.js"

// Retrieval pass (design-review 2026-08-22 finding #1, "Node view"): the minimal destination
// every other retrieval surface (search results, graph rows, backlink entries, Cmd/Ctrl+clicked
// mentions) needed and didn't have — before this route existed there was literally no URL that
// showed any node other than today's daily note. Deliberately thin: title via the existing
// `getNode`, tags + field values via the existing `NoteTags` + `SupertagFieldPopover` pair
// (identical wiring to `DailyNote.tsx` — one data model, N entry points), backlinks via the
// existing `Backlinks` component. Canonical daily-note ids bypass this generic view entirely and
// open their date-addressed editor before this route can issue a generic preview read. Generic
// pages are descriptor-routed and remain read-only; no preview creates an editor or a writer.

export type PageWitness = Readonly<{
  variant: "legacy" | "migratedLoro" | "nativeLoro"
  nodeId: string
  activeFormat: "automerge-v1" | "loro-v1"
  storageVersion: number
  schemaVersion?: number
  snapshotSha256?: string
}>

export const pageWitness = (descriptor: PageDocumentDescriptor): PageWitness => ({
  variant: descriptor.activeFormat === "automerge-v1"
    ? "legacy"
    : descriptor.automerge === undefined ? "nativeLoro" : "migratedLoro",
  nodeId: descriptor.nodeId,
  activeFormat: descriptor.activeFormat,
  storageVersion: descriptor.storageVersion,
  ...(descriptor.activeFormat === "loro-v1" ? {
    schemaVersion: descriptor.loro.schemaVersion,
    snapshotSha256: descriptor.loro.snapshotSha256
  } : {})
})

export const samePageWitness = (left: PageWitness, right: PageWitness): boolean =>
  left.variant === right.variant && left.nodeId === right.nodeId && left.activeFormat === right.activeFormat &&
  left.storageVersion === right.storageVersion && left.schemaVersion === right.schemaVersion &&
  left.snapshotSha256 === right.snapshotSha256

export type NodePagePreviewState =
  | { readonly kind: "missing" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "stale" }
  | { readonly kind: "failed" }
  | { readonly kind: "empty" }
  | { readonly kind: "legacy"; readonly text: string }
  | { readonly kind: "loro"; readonly html: string }

/** Descriptor-before-content routing with a full exact witness recheck after every read. */
export const resolveNodePagePreview = (
  client: WorkspaceRpcClientService,
  nodeId: EntityId
): Effect.Effect<NodePagePreviewState, never> =>
  Effect.gen(function* () {
    // A missing descriptor means the entity has never had a page. Once a descriptor has been
    // selected, the same absence is a concurrent deletion/replacement and must be surfaced as
    // stale so the caller can retry rather than being told that the page never existed.
    const initial = yield* client.getPageDocumentDescriptor(new GetPageDocumentDescriptorInput({ workspaceId, nodeId })).pipe(
      Effect.map((value) => ({ kind: "ok" as const, value })),
      Effect.catchTag("PageNotFound", () => Effect.succeed({ kind: "missing" as const }))
    )
    if (initial.kind === "missing") return { kind: "missing" } as const

    const witness = pageWitness(initial.value.descriptor)
    if (initial.value.descriptor.activeFormat === "loro-v1") {
      const docRead = yield* convergeLoroPageFromServer(client, workspaceId, nodeId).pipe(
        Effect.map((doc) => ({ kind: "ok" as const, doc })),
        Effect.catchTag("PageNotFound", () => Effect.succeed({ kind: "stale" as const })),
        Effect.catchTag("PageFormatMismatch", () => Effect.succeed({ kind: "stale" as const }))
      )
      if (docRead.kind === "stale") return { kind: "stale" } as const
      const currentRead = yield* client.getPageDocumentDescriptor(new GetPageDocumentDescriptorInput({ workspaceId, nodeId })).pipe(
        Effect.map((value) => ({ kind: "ok" as const, value })),
        Effect.catchTag("PageNotFound", () => Effect.succeed({ kind: "stale" as const })),
        Effect.catchTag("PageFormatMismatch", () => Effect.succeed({ kind: "stale" as const }))
      )
      if (currentRead.kind === "stale") return { kind: "stale" } as const
      if (!samePageWitness(witness, pageWitness(currentRead.value.descriptor))) return { kind: "stale" } as const
      const rendered = renderStaticLoroPreview(docRead.doc)
      return rendered.kind === "content" ? { kind: "loro", html: rendered.html } as const
        : rendered.kind === "empty" ? { kind: "empty" } as const : { kind: "unsupported" } as const
    }
    const pageRead = yield* client.getPageText(new GetPageTextInput({ workspaceId, nodeId })).pipe(
      Effect.map((page) => ({ kind: "ok" as const, page })),
      Effect.catchTag("PageNotFound", () => Effect.succeed({ kind: "stale" as const })),
      Effect.catchTag("PageFormatMismatch", () => Effect.succeed({ kind: "stale" as const }))
    )
    if (pageRead.kind === "stale") return { kind: "stale" } as const
    const currentRead = yield* client.getPageDocumentDescriptor(new GetPageDocumentDescriptorInput({ workspaceId, nodeId })).pipe(
      Effect.map((value) => ({ kind: "ok" as const, value })),
      Effect.catchTag("PageNotFound", () => Effect.succeed({ kind: "stale" as const })),
      Effect.catchTag("PageFormatMismatch", () => Effect.succeed({ kind: "stale" as const }))
    )
    if (currentRead.kind === "stale") return { kind: "stale" } as const
    if (!samePageWitness(witness, pageWitness(currentRead.value.descriptor))) return { kind: "stale" } as const
    return pageRead.page.text.trim().length === 0 ? { kind: "empty" } as const : { kind: "legacy", text: pageRead.page.text } as const
  }).pipe(
    Effect.catchAll(() => Effect.succeed({ kind: "failed" } as const))
  )

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
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => resolveNodePagePreview(client, nodeId))),
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
  readonly state: EffectState<NodePagePreviewState, never>
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
  if (state.status === "failure" || (state.status === "success" && state.value.kind === "failed")) {
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
  if (state.value.kind === "missing") return <PageMessage title="No page content yet" message="This entity has not been given a page document." />
  if (state.value.kind === "unsupported") return <PageMessage title="This page format can’t be previewed" message="This entity’s content is preserved, but this read-only preview can’t render it safely." />
  if (state.value.kind === "stale") return <PageRetry onRetry={onRetry} isRetrying={isRetrying} title="This page changed while loading" message="Retry to load its current content." />
  if (state.value.kind === "empty") return <PageMessage title="Content" message="This entity has an empty page." />
  return (
    <section className="node-view-page" aria-labelledby="node-page-title">
      <span className="node-view-eyebrow">Page</span>
      <h2 id="node-page-title">Content</h2>
      {state.value.kind === "legacy" && <div className="node-view-page-text">{state.value.text}</div>}
      {state.value.kind === "loro" && <div className="node-view-page-rich" dangerouslySetInnerHTML={{ __html: state.value.html }} />}
    </section>
  )
}

function PageMessage({ title, message }: { readonly title: string; readonly message: string }) {
  return <section className="node-view-page" aria-labelledby="node-page-title"><span className="node-view-eyebrow">Page</span><h2 id="node-page-title">{title}</h2><p className="node-view-page-empty">{message}</p></section>
}
function PageRetry({ title, message, onRetry, isRetrying }: { readonly title: string; readonly message: string; readonly onRetry: () => void; readonly isRetrying: boolean }) {
  return <section className="node-view-page" aria-labelledby="node-page-title"><span className="node-view-eyebrow">Page</span><div className="node-view-load-state node-view-page-load-state" role="alert"><div><h2 id="node-page-title">{title}</h2><p>{message}</p></div><button type="button" onClick={onRetry} disabled={isRetrying}>{isRetrying ? "Retrying…" : "Retry"}</button></div></section>
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
