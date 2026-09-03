import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { Link } from "react-router"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import {
  CreateEdgeInput,
  CreateNodeWithIntentInput,
  GetNodeInput,
  HumanUiMutationAttribution,
  ListBacklinksInput,
  ValidationError,
  type DomainError,
  EntityId
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { ensureMentionsRelationDefinition } from "./mentions-relation.js"

// Task item 2 ("Backlinks: on a note/node's detail view, show nodes/edges linking to it, via the
// backend's listBacklinks RPC") plus its own verification affordance ("seeing at least one
// backlink appear after creating a related node/edge via a quick script or a minimal UI
// affordance"). `listBacklinks(nodeId)` returns raw `Edge` rows (edge.ts: no stored inverse
// record, `GraphDataModel.md` Evolution Rule #3) — each is enriched with its source node's title
// via a follow-up `getNode` so the list reads as "X mentions this note", not a table of ids.

interface BacklinkRow {
  readonly edgeId: EntityId
  readonly sourceNodeId: EntityId
  readonly sourceTitle: string
}

interface SuccessfulBacklinksSnapshot {
  readonly nodeId: EntityId
  readonly rows: ReadonlyArray<BacklinkRow>
}

interface BacklinkQueryScope {
  readonly key: string
  readonly nodeId: EntityId
  current: boolean
  nodeChanged: boolean
}

interface BacklinkOperation {
  readonly title: string
  readonly targetNodeId: EntityId
  readonly nodeId: EntityId
  readonly nodeRequestId: string
  readonly edgeRequestId: string
}

const backlinkCreationFailureMessage =
  "We couldn’t confirm that this note was linked. Your title is still here. Retry to continue."

const loadBacklinks = (
  client: WorkspaceRpcClientService,
  nodeId: EntityId
): Effect.Effect<ReadonlyArray<BacklinkRow>, DomainError> =>
  Effect.gen(function* () {
    const { edges } = yield* client.listBacklinks(new ListBacklinksInput({ workspaceId, nodeId }))
    return yield* Effect.forEach(edges, (edge) =>
      client
        .getNode(new GetNodeInput({ workspaceId, nodeId: edge.sourceNodeId }))
        .pipe(
          Effect.map(
            (output): BacklinkRow => ({
              edgeId: edge.id,
              sourceNodeId: edge.sourceNodeId,
              sourceTitle: output.node.title
            })
          )
        )
    )
  })

export function Backlinks({ nodeId }: { nodeId: EntityId }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [readRetryClaimed, setReadRetryClaimed] = useState(false)
  const [title, setTitle] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  // Keep one complete node-plus-edge operation across retries. A failed or uncertain submit
  // must replay the same ledger identities; a changed title or target starts a new operation.
  const pendingOperationRef = useRef<BacklinkOperation | null>(null)
  // `submitting` is rendering feedback; this closes the first-click-before-rerender window.
  const isSubmittingRef = useRef(false)
  const readRetryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)

  const backlinksEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => loadBacklinks(client, nodeId))),
    [nodeId, refreshKey]
  )
  const state = useEffectQuery(backlinksEffect, [nodeId, refreshKey])
  // `useEffectQuery` briefly exposes the preceding settled result while a new node or refresh
  // generation starts. It may remain usable cache for the same node, but must never be adopted
  // as a result for a different node.
  const queryScopeKey = `${nodeId}:${refreshKey}`
  const queryScope = useRef<BacklinkQueryScope | undefined>(undefined)
  if (queryScope.current === undefined) {
    queryScope.current = { key: queryScopeKey, nodeId, current: true, nodeChanged: false }
  } else if (queryScope.current.key !== queryScopeKey) {
    queryScope.current = {
      key: queryScopeKey,
      nodeId,
      current: false,
      nodeChanged: queryScope.current.nodeId !== nodeId
    }
  }
  if (state.status === "loading") queryScope.current.current = true
  const stateIsCurrent = queryScope.current.current
  const stateCouldBelongToPreviousNode = !stateIsCurrent && queryScope.current.nodeChanged
  const currentRows = stateIsCurrent && state.status === "success" ? state.value : undefined
  const [successfulSnapshot, setSuccessfulSnapshot] = useState<SuccessfulBacklinksSnapshot | undefined>(() =>
    currentRows === undefined ? undefined : { nodeId, rows: currentRows }
  )
  useEffect(() => {
    if (stateIsCurrent && state.status === "success") {
      setSuccessfulSnapshot((previous) =>
        previous?.nodeId === nodeId && previous.rows === state.value
          ? previous
          : { nodeId, rows: state.value }
      )
    }
  }, [nodeId, refreshKey, state.status, stateIsCurrent])
  const cachedRows = successfulSnapshot?.nodeId === nodeId ? successfulSnapshot.rows : undefined
  const visibleRows = currentRows ?? cachedRows
  const isLoading = !stateIsCurrent || state.status === "loading"
  const isFailure = state.status === "failure" && !stateCouldBelongToPreviousNode
  useEffect(() => {
    const claim = readRetryClaim.current
    if (claim === undefined) return
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    if (!claim.sawLoading) return
    readRetryClaim.current = undefined
    setReadRetryClaimed(false)
  }, [state.status])
  const retryBacklinks = useCallback(() => {
    if (readRetryClaim.current !== undefined || state.status === "loading") return
    readRetryClaim.current = { sawLoading: false }
    setReadRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [state.status])
  const isRetryingBacklinks = readRetryClaimed || isLoading

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isSubmittingRef.current) return
    const trimmed = title.trim()
    if (trimmed.length === 0) return

    isSubmittingRef.current = true
    setSubmitting(true)
    setLinkError(null)
    // Capture the complete multi-step operation before its first network call. If the node
    // succeeds but the edge response is uncertain, retrying this operation replays the same
    // node and edge ledger identities instead of creating an orphan or duplicate.
    const operation = pendingOperationRef.current?.title === trimmed &&
      pendingOperationRef.current.targetNodeId === nodeId
      ? pendingOperationRef.current
      : (() => {
          const next: BacklinkOperation = {
            title: trimmed,
            targetNodeId: nodeId,
            nodeId: Schema.decodeUnknownSync(EntityId)(crypto.randomUUID()),
            nodeRequestId: crypto.randomUUID(),
            edgeRequestId: crypto.randomUUID()
          }
          pendingOperationRef.current = next
          return next
        })()

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const relationDefinitionId = yield* ensureMentionsRelationDefinition(client, workspaceId)
            const { node } = yield* client.createNodeWithIntent(new CreateNodeWithIntentInput({
              workspaceId,
              id: operation.nodeId,
              title: trimmed,
              requestId: operation.nodeRequestId,
              commitMessage: "Create the node before linking it from this daily note.",
              attribution: new HumanUiMutationAttribution({
                version: "athenaeum.mutation-attribution.v1",
                kind: "humanUi",
                surface: "web-backlinks"
              })
            })).pipe(
              Effect.catchTag("NodeAlreadyExists", () =>
                client.getNode(new GetNodeInput({ workspaceId, nodeId: operation.nodeId })).pipe(
                  Effect.flatMap((existing) => existing.node.title === trimmed
                    ? Effect.succeed(existing)
                    : Effect.fail(new ValidationError({ message: `node id ${operation.nodeId} already belongs to a different node` })))
                )
              )
            )
            yield* client.createEdge(
              new CreateEdgeInput({
                workspaceId,
                relationDefinitionId,
                sourceNodeId: node.id,
                targetNodeId: nodeId,
                requestId: operation.edgeRequestId,
                commitMessage: "Link the new note to this daily note.",
                attribution: new HumanUiMutationAttribution({
                  version: "athenaeum.mutation-attribution.v1",
                  kind: "humanUi",
                  surface: "web-backlinks"
                })
              })
            )
          })
        )
      )
    )
    fiber.addObserver((exit) => {
      isSubmittingRef.current = false
      setSubmitting(false)
      if (Exit.isSuccess(exit)) {
        pendingOperationRef.current = null
        setTitle("")
        setCreateOpen(false)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setLinkError(backlinkCreationFailureMessage)
        // A failed operation retains the complete ledger identities above. Re-open its surface so
        // the retained draft, error, and retry path remain visible instead of looking discarded.
        setCreateOpen(true)
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <section className="backlinks">
      <h3>Backlinks</h3>

      {isLoading && (
        <p role="status" aria-live="polite" aria-atomic="true">
          {cachedRows === undefined ? "Loading…" : "Refreshing backlinks…"}
        </p>
      )}
      {isFailure && (
        <section className="backlinks-load-state" role="alert">
          <div>
            <h4>Backlinks are unavailable</h4>
            <p>
              {cachedRows === undefined
                ? "Backlinks could not be loaded. Nothing has been changed. Retry to check them again."
                : "Backlinks could not be refreshed. Your previously loaded backlink list remains available. Retry to check them again."}
            </p>
          </div>
          <button type="button" onClick={retryBacklinks} disabled={isRetryingBacklinks}>
            {isRetryingBacklinks ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {currentRows !== undefined && currentRows.length === 0 && <p>No backlinks yet.</p>}
      {visibleRows !== undefined && visibleRows.length > 0 && (
        <ul>
          {/* Retrieval pass (design-review 2026-08-22 finding #1): backlink entries are real
              links to the source node's view — they were inert `<strong>` text before, one of the
              review's Flow-3 dead ends. */}
          {visibleRows.map((row) => (
            <li key={row.edgeId}>
              <Link className="backlink-source-link" to={`/node/${row.sourceNodeId}`}>
                {row.sourceTitle}
              </Link>{" "}
              <small>mentions this note</small>
            </li>
          ))}
        </ul>
      )}

      <details
        className="backlinks-create-disclosure"
        open={createOpen}
        onToggle={(event) => {
          // Keep the operation visible while it is in flight. A failure re-opens this surface
          // below; a success is the only path that dismisses the completed form.
          if (submitting && !event.currentTarget.open) {
            event.currentTarget.open = true
            return
          }
          setCreateOpen(event.currentTarget.open)
        }}
      >
        <summary>Add a linked note</summary>
        <form onSubmit={handleSubmit} className="backlinks-create-form">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="New node title — links here as a backlink"
            aria-label="New node title"
            disabled={submitting}
          />
          <button type="submit" disabled={submitting || title.trim().length === 0}>
            {submitting ? "Linking…" : "Create + link"}
          </button>
        </form>
        {linkError !== null && <p className="error" role="alert">{linkError}</p>}
      </details>
    </section>
  )
}
